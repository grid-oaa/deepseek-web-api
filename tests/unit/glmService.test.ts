/** End-to-end coverage of the glm service mapping layer over a stubbed upstream. */
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/env.js";
import type { ChatStreamChunk } from "../../src/deepseek/chatStream.js";
import { GlmService } from "../../src/glm/service.js";

const GUEST = { result: { access_token: "guest-token" } };

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
    glmBaseUrl: "https://glm.test/chatglm",
    glmAssistantId: "assistant",
    glmUserAgent: "ua",
  };
}

/** Wrap a real stream in the token call the client makes before every chat request. */
function stubUpstream(stream: string): typeof fetch {
  const impl = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/guest/access")) {
      return new Response(JSON.stringify(GUEST), { status: 200 });
    }
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return impl;
}

function sse(payloads: unknown[]): string {
  return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
}

function initFrame(): Record<string, unknown> {
  return { status: "init", conversation_id: "conv-1", id: "resp-1", assistant_id: "assistant" };
}

function textPart(text: string, finished = false): Record<string, unknown> {
  return {
    logic_id: "p1",
    status: finished ? "finish" : "in_progress",
    content: [{ type: "text", text }],
  };
}

function serviceWith(stream: string): GlmService {
  const service = new GlmService(config());
  // Inject the stub through the private client so no test touches the network.
  (service as unknown as { client: { fetchImpl: typeof fetch } }).client.fetchImpl = stubUpstream(stream);
  return service;
}

describe("GLM service mapping", () => {
  it("streams deltas and finishes with a stop chunk", async () => {
    const service = serviceWith(
      sse([
        initFrame(),
        { parts: [textPart("Hel")] },
        { parts: [textPart("Hello", true)] },
        { status: "finish" },
      ]),
    );
    const chunks: ChatStreamChunk[] = [];
    await service.streamChat({ model: "glm-4-plus", messages: [{ role: "user", content: "hi" }] }, (chunk) => chunks.push(chunk));

    const contents = chunks
      .map((chunk) => chunk.choices[0]?.delta.content)
      .filter((value): value is string => typeof value === "string");
    expect(contents.join("")).toBe("Hello");
    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
    expect(chunks[0]?.model).toBe("glm-4-plus");
    expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe("stop");
  });

  it("keeps thinking parts out of the visible content", async () => {
    const service = serviceWith(
      sse([
        initFrame(),
        { parts: [{ logic_id: "p0", content: [{ type: "think", think: "pondering" }] }] },
        { parts: [textPart("answer", true)] },
        { status: "finish" },
      ]),
    );
    const chunks: ChatStreamChunk[] = [];
    await service.streamChat({ model: "glm-4-flash", messages: [{ role: "user", content: "hi" }] }, (chunk) => chunks.push(chunk));

    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content).join("")).toBe("answer");
    const reasoning = chunks
      .map((chunk) => (chunk.choices[0]?.delta as Record<string, unknown> | undefined)?.reasoning_content)
      .filter((value): value is string => typeof value === "string");
    expect(reasoning.join("")).toBe("pondering");
  });

  it("buffers a completed Responses object with the glm model and source", async () => {
    const service = serviceWith(
      sse([initFrame(), { parts: [textPart("done", true)] }, { status: "finish" }]),
    );
    const result = await service.completeResponses({ model: "glm-4-flash", input: "hello" });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("glm-4-flash");
    expect(result.output_text).toBe("done");
    expect(result.metadata.source).toBe("chatglm.cn");
  });

  it("raises 502 when the upstream stream carries an error frame", async () => {
    const service = serviceWith(
      sse([initFrame(), { status: "error", last_error: { error_code: 10061, err_msg: "no quota" } }]),
    );
    await expect(
      service.completeResponses({ model: "glm-4-flash", input: "hello" }),
    ).rejects.toThrow(/10061/);
  });

  it("rejects a request whose input carries no text", async () => {
    const service = serviceWith(sse([initFrame(), { status: "finish" }]));
    await expect(service.completeResponses({ model: "glm-4-flash", input: [] })).rejects.toThrow(
      /empty input/,
    );
  });
});