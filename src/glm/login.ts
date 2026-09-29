/** Resolves a chatglm.cn login by reusing a saved token, the browser, or an interactive wait. */
import type { Page } from "playwright-core";

import { envTokenWriter } from "../config/dotenvWriter.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../utils/logger.js";
import type { ChromeManager } from "../browser/chrome.js";
import { GlmClient } from "./client.js";

/** Cookie the chatglm.cn web client stores the account refresh token in. */
export const GLM_REFRESH_COOKIE = "chatglm_refresh_token";

/** Read the chatglm.cn cookies without touching any other origin. */
export async function readRefreshToken(page: Page, baseUrl: string): Promise<string | null> {
  const cookies = await page.context().cookies([baseUrl]);
  const value = cookies.find((cookie) => cookie.name === GLM_REFRESH_COOKIE)?.value?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Mirrors LoginManager for DeepSeek: try the stored refresh token first, then a login
 * already present in the managed Chrome profile, and only then wait for a human.
 */
export class GlmLoginManager {
  private refreshToken: string | null = null;

  constructor(
    private readonly chrome: ChromeManager,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /** Persist a token so the next start can skip the browser entirely. */
  private save(token: string): void {
    this.refreshToken = token;
    const write = envTokenWriter("GLM_REFRESH_TOKEN", this.config.dotEnvFile, (error: unknown) => {
      this.logger.warn("无法写回 GLM_REFRESH_TOKEN", { error: String(error) });
    });
    write?.(token);
  }

  /** Exchange the token once; a rejected token proves the browser login is required. */
  private async works(token: string): Promise<boolean> {
    const client = new GlmClient({
      baseUrl: this.config.glmBaseUrl,
      assistantId: this.config.glmAssistantId,
      userAgent: this.config.glmUserAgent,
      refreshToken: token,
    });
    try {
      await client.ensureToken();
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve a usable refresh token, opening a visible browser only as a last resort. */
  async ensureLoggedIn(): Promise<string> {
    const saved = this.config.glmRefreshToken?.trim() || null;
    if (saved && (await this.works(saved))) {
      this.refreshToken = saved;
      this.logger.info("已复用 .env 中的 chatglm.cn 登录态（无需打开浏览器）");
      return saved;
    }

    const page = await this.chrome.pageFor(this.config.glmBaseUrl);
    const existing = await readRefreshToken(page, this.config.glmBaseUrl);
    if (existing && (await this.works(existing))) {
      this.save(existing);
      this.logger.info("已复用 Chrome 中的 chatglm.cn 登录态");
      return existing;
    }

    await page.bringToFront().catch(() => undefined);
    this.logger.info("请在打开的浏览器中登录 chatglm.cn… 登录成功后自动继续");
    while (true) {
      await page.waitForTimeout(1_500);
      const token = await readRefreshToken(page, this.config.glmBaseUrl);
      if (!token) continue;
      if (!(await this.works(token))) continue;
      this.save(token);
      this.logger.info("chatglm.cn 登录成功，已保存认证信息", { file: this.config.dotEnvFile });
      return token;
    }
  }

  /** The token resolved by ensureLoggedIn, or the configured one before it runs. */
  currentToken(): string | null {
    return this.refreshToken ?? this.config.glmRefreshToken?.trim() ?? null;
  }
}