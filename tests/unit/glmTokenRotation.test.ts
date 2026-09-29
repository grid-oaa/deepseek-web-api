/** Verifies a rotated refresh token is reported to the owner for persistence. */
import { describe, expect, it } from "vitest";

import { GlmClient } from "../../src/glm/client.js";

function stubFetch(body: unknown): typeof fetch {
  const impl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return impl;
}

describe("GlmClient refresh token rotation", () => {
  it("reports a rotated refresh token to the owner", async () => {
    const seen: string[] = [];
    const client = new GlmClient({
      baseUrl: "https://glm.test/chatglm",
      refreshToken: "old-refresh",
      fetchImpl: stubFetch({ result: { access_token: "a1", refresh_token: "new-refresh" } }),
      onRefreshToken: (token) => seen.push(token),
    });
    const token = await client.ensureToken();
    expect(seen).toEqual(["new-refresh"]);
    expect(token.refreshToken).toBe("new-refresh");
  });

  it("does not report when the upstream returns the same token", async () => {
    const seen: string[] = [];
    const client = new GlmClient({
      baseUrl: "https://glm.test/chatglm",
      refreshToken: "same-refresh",
      fetchImpl: stubFetch({ result: { access_token: "a1", refresh_token: "same-refresh" } }),
      onRefreshToken: (token) => seen.push(token),
    });
    await client.ensureToken();
    expect(seen).toEqual([]);
  });
});