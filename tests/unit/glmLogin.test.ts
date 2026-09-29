/** Covers the chatglm.cn login ladder without opening a real browser. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/env.js";
import { GlmLoginManager, readRefreshToken } from "../../src/glm/login.js";
import { createLogger } from "../../src/utils/logger.js";
import type { Page } from "playwright-core";

/** Page stub: only context.cookies is touched, plus optional wait callbacks. */
function stubPage(cookies: Record<string, string>, wait?: () => void): Page {
  return {
    context: () => ({
      cookies: async () => Object.entries(cookies).map(([name, value]) => ({ name, value })),
    }),
    bringToFront: async () => undefined,
    waitForTimeout: async () => {
      wait?.();
    },
  } as unknown as Page;
}

function baseConfig(dir: string): AppConfig {
  return {
    port: 8787,
    host: "127.0.0.1",
    cdpEndpoint: "http://127.0.0.1:9333",
    dataDir: dir,
    authFile: path.join(dir, "auth.json"),
    apiKeyFile: path.join(dir, ".api-key"),
    sessionsFile: path.join(dir, "sessions.json"),
    chromeProfileDir: path.join(dir, "chrome-profile"),
    powWorkerUrl: "https://example.com/pow.js",
    baseUrl: "https://chat.deepseek.com",
    debug: false,
    toolReasoning: "hidden",
    showBrowser: false,
    dotEnvFile: path.join(dir, ".env"),
    glmBaseUrl: "https://chatglm.cn/chatglm",
    glmAssistantId: "assistant",
    glmUserAgent: "ua",
  };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "glm-login-"));
}

describe("readRefreshToken", () => {
  it("returns the chatglm_refresh_token cookie when present", async () => {
    const page = stubPage({ chatglm_refresh_token: "jwt-value", chatglm_token: "other" });
    await expect(readRefreshToken(page, "https://chatglm.cn/chatglm")).resolves.toBe("jwt-value");
  });

  it("returns null when the cookie is absent or blank", async () => {
    await expect(readRefreshToken(stubPage({}), "https://chatglm.cn/chatglm")).resolves.toBeNull();
    await expect(
      readRefreshToken(stubPage({ chatglm_refresh_token: "  " }), "https://chatglm.cn/chatglm"),
    ).resolves.toBeNull();
  });
});

describe("GlmLoginManager", () => {
  it("exposes the configured token before any login runs", () => {
    const dir = tempDir();
    const config = { ...baseConfig(dir), glmRefreshToken: "r-config" };
    const manager = new GlmLoginManager(
      { pageFor: async () => stubPage({}) } as never,
      config,
      createLogger(false),
    );
    expect(manager.currentToken()).toBe("r-config");
  });

  it("returns null when no token is configured", () => {
    const manager = new GlmLoginManager(
      { pageFor: async () => stubPage({}) } as never,
      baseConfig(tempDir()),
      createLogger(false),
    );
    expect(manager.currentToken()).toBeNull();
  });
});