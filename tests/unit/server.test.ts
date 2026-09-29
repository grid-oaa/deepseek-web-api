/** Verifies the documented behavior of the corresponding production module. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { ChromeManager } from "../../src/browser/chrome.js";
import { LoginManager } from "../../src/browser/login.js";
import type { AppConfig } from "../../src/config/env.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import { SessionStore } from "../../src/deepseek/sessionStore.js";
import type { GlmLoginManager } from "../../src/glm/login.js";
import { GlmService } from "../../src/glm/service.js";
import { createServer } from "../../src/server/createServer.js";
import { createLogger } from "../../src/utils/logger.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Login stub so the server test never opens a browser. */
function stubLogin(token = "refresh-token"): GlmLoginManager {
  return {
    ensureLoggedIn: async () => token,
    currentToken: () => token,
  } as unknown as GlmLoginManager;
}

function testDependencies(): { client: DeepSeekClient; glm: GlmService } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "deepseek-web-api-test-"));
  const config: AppConfig = {
    port: 8787,
    host: "127.0.0.1",
    cdpEndpoint: "http://127.0.0.1:9333",
    dataDir,
    authFile: path.join(dataDir, "auth.json"),
    apiKeyFile: path.join(dataDir, ".api-key"),
    sessionsFile: path.join(dataDir, "sessions.json"),
    chromeProfileDir: path.join(dataDir, "chrome-profile"),
    powWorkerUrl: "https://example.com/pow.js",
    baseUrl: "https://chat.deepseek.com",
    debug: false,
    toolReasoning: "hidden",
    showBrowser: false,
    glmBaseUrl: "https://glm.test/chatglm",
    glmAssistantId: "assistant",
    glmUserAgent: "ua",
    startupLogin: "glm" as const,
    dotEnvFile: path.join(dataDir, ".env"),
  };
  const logger = createLogger(false);
  const chrome = new ChromeManager(config, logger);
  const login = new LoginManager(chrome, config, logger);
  return {
    client: new DeepSeekClient(config, login, new SessionStore(), logger),
    glm: new GlmService(config, stubLogin()),
  };
}

async function baseUrl(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("HTTP server routes", () => {
  it("keeps health open and protects /v1 routes", async () => {
    const server = createServer({ ...testDependencies(), apiKeys: ["secret", "also-secret"], debug: false });
    const url = await baseUrl(server);
    expect(await fetch(`${url}/health`).then((response) => response.json())).toEqual({ ok: true });
    expect((await fetch(`${url}/v1/models`)).status).toBe(401);
    const models = await fetch(`${url}/v1/models`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({ object: "list" });
    const alt = await fetch(`${url}/v1/models`, { headers: { "x-api-key": "also-secret" } });
    expect(alt.status).toBe(200);
  });

  it("lists the glm public models served by the chatglm.cn upstream", async () => {
    const server = createServer({ ...testDependencies(), apiKeys: ["secret"], debug: false });
    const url = await baseUrl(server);
    const response = await fetch(`${url}/v1/models`, {
      headers: { authorization: "Bearer secret" },
    });
    const payload = (await response.json()) as { data: Array<{ id: string; owned_by: string }> };
    expect(payload.data.map((entry) => entry.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "glm-4-flash",
      "glm-4-plus",
    ]);
    expect(payload.data.filter((entry) => entry.id.startsWith("glm-")).every((entry) => entry.owned_by === "chatglm-cn")).toBe(true);
  });
});