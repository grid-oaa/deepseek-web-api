/** Locks in live streaming for tool-free turns and the single tool-turn retry. */
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/env.js";
import type { GlmLoginManager } from "../../src/glm/login.js";
import { GlmService } from "../../src/glm/service.js";

function config(): AppConfig {
  return {
    port: 8787, host: "127.0.0.1", cdpEndpoint: "http://127.0.0.1:9333", dataDir: ".",
    authFile: "auth.json", apiKeyFile: ".api-key", sessionsFile: "sessions.json",
    chromeProfileDir: "chrome-profile", powWorkerUrl: "https://example.com/pow.js",
    baseUrl: "https://chat.deepseek.com", debug: false, toolReasoning: "hidden",
    showBrowser: false, startupLogin: "glm", dotEnvFile: ".env",
    glmBaseUrl: "https://glm.test/chatglm", glmAssistantId: "assistant", glmUserAgent: "ua",
  };
}

function stubLogin(): GlmLoginManager {
  return {
    ensureLoggedIn: async () => "refresh-token",
    currentToken: () => "refresh-token",
  } as unknown as GlmLoginManager;
}

function sse(payloads: unknown[]): string {
  return payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("");
}

const init = { status: "init", conversation_id: "c1", id: "r1", assistant_id: "a" };
const part = (text: string, finished = false) => ({
  logic_id: "p1",
  status: finished ? "finish" : "in_progress",
  content: [{ type: "text", text }],
});
const CALL = '<tool_call>\n{"name":"execute_command","arguments":{"command":"pwd"}}\n</tool_call>';

const TOOL = {
  type: "function",
  function: {
    name: "execute_command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

/** Feed a list of SSE bodies, one per upstream call, so retries can be observed. */
function serviceWith(bodies: string[]): GlmService {
  const service = new GlmService(config(), stubLogin());
  let call = 0;
  (service as unknown as { client: { fetchImpl: typeof fetch } }).client.fetchImpl = (async (
    url: string | URL | Request,
  ) => {
    if (String(url).includes("/user-api/")) {
      return new Response(JSON.stringify({ result: { access_token: "acc" } }), { status: 200 });
    }
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return service;
}

describe("GLM live streaming", () => {
  it("emits each frame as it arrives when no tools are present", async () => {
    const service = serviceWith([sse([init, { parts: [part("Hel")] }, { parts: [part("Hello", true)] }, { status: "finish" }])]);
    const chunks: Array<{ choices: Array<{ delta: Record<string, unknown> }> }> = [];
    await service.streamChat(
      { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
      (chunk) => chunks.push(chunk as never),
    );
    const deltas = chunks.map((c) => c.choices[0]?.delta ?? {});
    // One delta per upstream frame proves the stream is not buffered.
    expect(deltas.filter((d) => typeof d.content === "string").length).toBe(2);
    expect(deltas.filter((d) => typeof d.content === "string").map((d) => d.content).join("")).toBe("Hello");
  });

  it("keeps the first delta carrying the role", async () => {
    const service = serviceWith([sse([init, { parts: [part("hi", true)] }, { status: "finish" }])]);
    const chunks: Array<{ choices: Array<{ delta: Record<string, unknown> }> }> = [];
    await service.streamChat(
      { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
      (chunk) => chunks.push(chunk as never),
    );
    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
  });
});

describe("GLM tool turn retry", () => {
  it("retries once when the first turn produced neither a call nor an answer", async () => {
    const service = serviceWith([
      sse([init, { parts: [part("   ")] }, { status: "finish" }]),
      sse([init, { parts: [part(CALL, true)] }, { status: "finish" }]),
    ]);
    const result = await service.completeResponses({
      model: "glm-5.3",
      input: "what directory am I in",
      tools: [TOOL],
    });
    expect(result.metadata.tool_call_count).toBe(1);
  });

  it("does not retry when the first turn already answered", async () => {
    const service = serviceWith([sse([init, { parts: [part("just an answer", true)] }, { status: "finish" }])]);
    const result = await service.completeResponses({ model: "glm-5.3", input: "hi", tools: [TOOL] });
    expect(result.output_text).toBe("just an answer");
    expect(result.metadata.tool_call_count).toBe(0);
  });
});