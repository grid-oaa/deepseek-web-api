/** Verifies the glm tool-call path: text protocol in, standard tool_calls out. */
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/env.js";
import type { GlmLoginManager } from "../../src/glm/login.js";
import { GlmService } from "../../src/glm/service.js";

const EXEC_TOOL = {
  type: "function",
  function: {
    name: "execute_command",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

function config(): AppConfig {
  return {
    port: 8787,
    host: "127.0.0.1",
    cdpEndpoint: "http://127.0.0.1:9333",
    dataDir: ".",
    authFile: "auth.json",
    apiKeyFile: ".api-key",
    sessionsFile: "sessions.json",
    chromeProfileDir: "chrome-profile",
    powWorkerUrl: "https://example.com/pow.js",
    baseUrl: "https://chat.deepseek.com",
    debug: false,
    toolReasoning: "hidden",
    showBrowser: false,
    startupLogin: "glm",
    dotEnvFile: ".env",
    glmBaseUrl: "https://glm.test/chatglm",
    glmAssistantId: "assistant",
    glmUserAgent: "ua",
  };
}

function stubLogin(token = "refresh-token"): GlmLoginManager {
  return {
    ensureLoggedIn: async () => token,
    currentToken: () => token,
  } as unknown as GlmLoginManager;
}

function sse(payloads: unknown[]): string {
  return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
}

function initFrame(): Record<string, unknown> {
  return { status: "init", conversation_id: "conv-1", id: "resp-1", assistant_id: "assistant" };
}

function textPart(text: string, finished = true): Record<string, unknown> {
  return { logic_id: "p1", status: finished ? "finish" : "in_progress", content: [{ type: "text", text }] };
}

function serviceWith(stream: string): GlmService {
  const service = new GlmService(config(), stubLogin());
  (service as unknown as { client: { fetchImpl: typeof fetch } }).client.fetchImpl = (async (
    url: string | URL | Request,
  ) =>
    String(url).includes("/user-api/")
      ? new Response(JSON.stringify({ result: { access_token: "test-access" } }), { status: 200 })
      : new Response(stream, { status: 200 })) as unknown as typeof fetch;
  return service;
}

const CALL_BLOCK = [
  "<tool_call>",
  '{"name":"execute_command","arguments":{"command":"pwd"}}',
  "</tool_call>",
].join("\n");

describe("GLM tool calling", () => {
  it("parses a tool_call block into Responses function_call items", async () => {
    const service = serviceWith(sse([initFrame(), { parts: [textPart(CALL_BLOCK)] }, { status: "finish" }]));
    const result = await service.completeResponses({
      model: "glm-5.3",
      input: "what is the current directory",
      tools: [EXEC_TOOL],
    });

    const call = result.output.find((item) => item.type === "function_call") as
      | { name: string; arguments: string; status: string }
      | undefined;
    expect(call).toBeDefined();
    expect(call?.name).toBe("execute_command");
    expect(JSON.parse(call?.arguments ?? "{}")).toEqual({ command: "pwd" });
    expect(call?.status).toBe("completed");
    expect(result.metadata.tool_call_count).toBe(1);
    expect(result.metadata.tool_compatibility).toBe(true);
  });

  it("strips the protocol block out of the visible output text", async () => {
    const service = serviceWith(sse([initFrame(), { parts: [textPart(CALL_BLOCK)] }, { status: "finish" }]));
    const result = await service.completeResponses({ model: "glm-5.3", input: "pwd", tools: [EXEC_TOOL] });
    expect(result.output_text ?? "").not.toContain("tool_call");
  });

  it("keeps a normal answer untouched when no tool_call block appears", async () => {
    const service = serviceWith(sse([initFrame(), { parts: [textPart("just an answer")] }, { status: "finish" }]));
    const result = await service.completeResponses({ model: "glm-5.3", input: "hi", tools: [EXEC_TOOL] });
    expect(result.output_text).toBe("just an answer");
    expect(result.metadata.tool_call_count).toBe(0);
  });

  it("finishes a chat completion with tool_calls and the parsed delta", async () => {
    const service = serviceWith(sse([initFrame(), { parts: [textPart(CALL_BLOCK)] }, { status: "finish" }]));
    const chunks: Array<{ choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> }> = [];
    await service.streamChat(
      { model: "glm-5.3", messages: [{ role: "user", content: "pwd" }], tools: [EXEC_TOOL] },
      (chunk) => chunks.push(chunk as never),
    );

    const callChunk = chunks.find((chunk) => Array.isArray(chunk.choices[0]?.delta.tool_calls));
    const calls = (callChunk?.choices[0]?.delta.tool_calls ?? []) as Array<{
      id: string;
      function: { name: string };
    }>;
    expect(calls[0]?.function.name).toBe("execute_command");
    expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("reports tool_compatibility false when the request carries no tools", async () => {
    const service = serviceWith(sse([initFrame(), { parts: [textPart("plain")] }, { status: "finish" }]));
    const result = await service.completeResponses({ model: "glm-5.3", input: "hi" });
    expect(result.metadata.tool_compatibility).toBe(false);
  });
});
