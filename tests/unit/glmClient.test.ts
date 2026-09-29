/** Verifies GLM client token exchange, header assembly, and the 401 retry path. */
import { describe, expect, it } from "vitest";

import { GlmClient } from "../../src/glm/client.js";

interface StubCall {
  url: string;
  init: RequestInit;
}

/** Pop preset responses in order and record calls, so unit tests never hit the network. */
function stubFetch(responses: Response[]) {
  const calls: StubCall[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("stubFetch ran out of preset responses");
    return next;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(call: StubCall | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

describe("GLM client", () => {
  it("fetches a guest token once and reuses the cache", async () => {
    const { calls, impl } = stubFetch([jsonResponse({ result: { access_token: "guest-token" } })]);
    const client = new GlmClient({ baseUrl: "https://glm.test/chatglm", fetchImpl: impl, deviceId: "dev" });

    await expect(client.ensureToken()).resolves.toEqual({ accessToken: "guest-token", refreshToken: null });
    expect(calls[0]?.url).toBe("https://glm.test/chatglm/user-api/guest/access");
    await client.ensureToken();
    expect(calls).toHaveLength(1);
  });

  it("refreshes an account token and keeps the rotated refresh token", async () => {
    const { calls, impl } = stubFetch([jsonResponse({ result: { access_token: "a2", refresh_token: "r2" } })]);
    const client = new GlmClient({ baseUrl: "https://glm.test/chatglm", fetchImpl: impl, refreshToken: "r1" });

    await expect(client.ensureToken()).resolves.toEqual({ accessToken: "a2", refreshToken: "r2" });
    expect(calls[0]?.url).toBe("https://glm.test/chatglm/user-api/user/refresh");
    expect(headersOf(calls[0]).Authorization).toBe("Bearer r1");
  });

  it("sends signature headers, device id, and Authorization on chat", async () => {
    const { calls, impl } = stubFetch([
      jsonResponse({ result: { access_token: "t1" } }),
      new Response("data: {}\n\n", { status: 200 }),
    ]);
    const client = new GlmClient({ baseUrl: "https://glm.test/chatglm", fetchImpl: impl, deviceId: "dev" });

    await client.streamChat("hi");
    expect(calls[1]?.url).toBe("https://glm.test/chatglm/backend-api/assistant/stream");
    const headers = headersOf(calls[1]);
    expect(headers.Authorization).toBe("Bearer t1");
    expect(headers["X-Sign"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["X-Device-Id"]).toBe("dev");
    expect(headers.Accept).toBe("text/event-stream");
    const body = JSON.parse(String(calls[1]?.init.body)) as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(body.messages[0]?.content[0]?.text).toBe("hi");
  });

  it("drops a stale token on 401 and retries exactly once", async () => {
    const { calls, impl } = stubFetch([
      jsonResponse({ result: { access_token: "stale" } }),
      new Response("unauthorized", { status: 401 }),
      jsonResponse({ result: { access_token: "fresh" } }),
      new Response("data: {}\n\n", { status: 200 }),
    ]);
    const client = new GlmClient({ baseUrl: "https://glm.test/chatglm", fetchImpl: impl, deviceId: "dev" });

    const response = await client.streamChat("hi");
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(4);
    expect(headersOf(calls[3]).Authorization).toBe("Bearer fresh");
  });

  it("throws an upstream error when the token payload has no access_token", async () => {
    const { impl } = stubFetch([jsonResponse({ code: 10061, result: {} })]);
    const client = new GlmClient({ baseUrl: "https://glm.test/chatglm", fetchImpl: impl });

    await expect(client.ensureToken()).rejects.toThrow(/missing access_token/);
  });
});