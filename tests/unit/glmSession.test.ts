/** Verifies a follow-up turn reuses the upstream conversation instead of starting over. */
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

function sse(payloads: unknown[]): string {
  return payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("");
}

const init = { status: "init", conversation_id: "conv-42", id: "r1", assistant_id: "a" };
const part = (text: string) => ({ logic_id: "p1", status: "finish", content: [{ type: "text", text }] });
const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

/** Record the conversation_id sent on each chat call so reuse is observable. */
function serviceWith(bodies: string[]): { service: GlmService; sent: string[] } {
  const service = new GlmService(config(), {
    ensureLoggedIn: async () => "r",
    currentToken: () => "r",
  } as unknown as GlmLoginManager);
  const sent: string[] = [];
  let call = 0;
  (service as unknown as { client: { fetchImpl: typeof fetch } }).client.fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).includes("/user-api/")) {
      return new Response(JSON.stringify({ result: { access_token: "acc" } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { conversation_id: string };
    sent.push(body.conversation_id);
    const next = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return new Response(next, { status: 200 });
  }) as unknown as typeof fetch;
  return { service, sent };
}

const turn = (history: Array<{ role: string; content: string }>, reply: string) => [...history, assistant(reply), user("next")];

describe("GLM conversation reuse", () => {
  it("sends no conversation_id on a first turn", async () => {
    const { service, sent } = serviceWith([sse([init, { parts: [part("hi")] }, { status: "finish" }])]);
    await service.completeResponses({ model: "glm-5.3", input: [user("hi")] });
    expect(sent).toEqual([""]);
  });

  it("reports the upstream conversation id on the response", async () => {
    const { service } = serviceWith([sse([init, { parts: [part("hi")] }, { status: "finish" }])]);
    const result = await service.completeResponses({ model: "glm-5.3", input: [user("hi")] });
    expect(result.metadata.upstream_conversation_id).toBe("conv-42");
  });

  it("resumes the thread once a request repeats a recorded history", async () => {
    const { service, sent } = serviceWith([
      sse([init, { parts: [part("a1")] }, { status: "finish" }]),
      sse([init, { parts: [part("a2")] }, { status: "finish" }]),
      sse([{ ...init, conversation_id: "conv-43" }, { parts: [part("a3")] }, { status: "finish" }]),
    ]);
    const one = [user("one")];
    const r1 = await service.completeResponses({ model: "glm-5.3", input: one });
    const two = turn(one, r1.output_text ?? "a1");
    const r2 = await service.completeResponses({ model: "glm-5.3", input: two });
    const three = turn(two, r2.output_text ?? "a2");
    await service.completeResponses({ model: "glm-5.3", input: three });

    // The first turn has no prior history. A later turn resumes once the conversation it
    // was sent matches a history an earlier turn already recorded.
    expect(sent.filter((id) => id !== "").length).toBeGreaterThan(0);
    expect(sent[sent.length - 1]).toBe("conv-42");
  });
});