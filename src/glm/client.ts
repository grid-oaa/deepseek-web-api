/** Minimal chatglm.cn HTTP client: fetch access_token and open one SSE chat stream. */
import crypto from "node:crypto";

import { GLM_ASSISTANT_ID, GLM_BASE_URL, GLM_USER_AGENT } from "../config/constants.js";
import { HttpError } from "../utils/errors.js";
import { asString, isRecord } from "../utils/json.js";
import { buildSign } from "./sign.js";

/** Overridable options; tests inject fetchImpl so no real network call happens. */
export interface GlmClientOptions {
  baseUrl?: string;
  assistantId?: string;
  accessToken?: string;
  refreshToken?: string;
  deviceId?: string;
  userAgent?: string;
  /** Called with each rotated refresh token so it can be persisted by the owner. */
  onRefreshToken?: (token: string) => void;
  fetchImpl?: typeof fetch;
}

/** Auth pair for one conversation; the refresh token survives for reuse. */
export interface GlmToken {
  accessToken: string;
  refreshToken: string | null;
}

function randomHex(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Build a plausible client IP; upstream applies light anti-bot checks on it. */
function randomForwardedFor(): string {
  while (true) {
    const first = Math.floor(Math.random() * 223) + 1;
    if ([10, 127, 169, 172, 192].includes(first)) continue;
    const rest = Array.from({ length: 3 }, () => Math.floor(Math.random() * 256));
    return [first, ...rest].join(".");
  }
}

/**
 * chatglm.cn client: owns token lifecycle and chat requests; response parsing is left
 * to iterGlmUpdates. An account refresh token is required; there is no guest fallback.
 */
export class GlmClient {
  private readonly baseUrl: string;
  private readonly assistantId: string;
  private readonly userAgent: string;
  private readonly deviceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onRefreshToken: ((token: string) => void) | undefined;
  private accessToken: string | null;
  private refreshToken: string | null;

  constructor(options: GlmClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? GLM_BASE_URL).replace(/\/$/, "");
    this.assistantId = options.assistantId ?? GLM_ASSISTANT_ID;
    this.userAgent = options.userAgent ?? GLM_USER_AGENT;
    this.deviceId = options.deviceId ?? randomHex();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onRefreshToken = options.onRefreshToken;
    this.accessToken = options.accessToken?.trim() || null;
    this.refreshToken = options.refreshToken?.trim() || null;
  }

  /** Adopt a token resolved later by the login flow, dropping any stale cache. */
  adoptRefreshToken(token: string): void {
    if (token === this.refreshToken) return;
    this.refreshToken = token;
    this.accessToken = null;
  }

  /** Return a usable access_token, refreshing from the account token when the cache is cold. */
  async ensureToken(): Promise<GlmToken> {
    if (this.accessToken) {
      return { accessToken: this.accessToken, refreshToken: this.refreshToken };
    }
    if (!this.refreshToken) throw new HttpError(401, "GLM 未登录：缺少 GLM_REFRESH_TOKEN");
    return this.fetchByRefreshToken();
  }

  /**
   * Open one chat stream and return the raw SSE response for iterGlmUpdates.
   * An expired access_token surfaces as 401; drop the cache and retry exactly once.
   */
  async streamChat(prompt: string, conversationId = "", signal?: AbortSignal): Promise<Response> {
    const first = await this.ensureToken();
    const response = await this.postChat(first.accessToken, prompt, conversationId, signal);
    if (response.status !== 401) return response;
    console.log("[GLM] access_token expired, dropping cache and retrying once");
    this.accessToken = null;
    const retry = await this.ensureToken();
    return this.postChat(retry.accessToken, prompt, conversationId, signal);
  }

  /** Account mode: exchange refresh_token and keep the rotated refresh_token. */
  private async fetchByRefreshToken(): Promise<GlmToken> {
    const response = await this.fetchImpl(`${this.baseUrl}/user-api/user/refresh`, {
      method: "POST",
      headers: this.buildHeaders(this.refreshToken, false),
      body: "{}",
    });
    return this.readToken(response, "GLM refresh token");
  }

  /** Parse a token response; any HTTP failure or missing access_token is upstream error. */
  private async readToken(response: Response, label: string): Promise<GlmToken> {
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(502, `${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HttpError(502, `${label} returned non-JSON: ${text.slice(0, 300)}`);
    }
    const result = isRecord(payload) && isRecord(payload.result) ? payload.result : {};
    const accessToken = asString(result.access_token);
    if (!accessToken) {
      const code = isRecord(payload) ? payload.code ?? payload.status ?? "unknown" : "unknown";
      throw new HttpError(502, `${label} missing access_token (code=${String(code)})`);
    }
    this.accessToken = accessToken;
    const next = asString(result.refresh_token);
    // Upstream rotates the refresh token on every exchange, so a changed value must be
    // persisted or the next process start would authenticate with a spent token.
    if (next && next !== this.refreshToken) {
      this.refreshToken = next;
      this.onRefreshToken?.(next);
    }
    return { accessToken, refreshToken: this.refreshToken };
  }

  /** Build the chatglm.cn chat payload and POST it to the stream endpoint. */
  postChat(accessToken: string, prompt: string, conversationId = "", signal?: AbortSignal): Promise<Response> {
    const body = {
      assistant_id: this.assistantId,
      conversation_id: conversationId,
      project_id: "",
      chat_type: "user_chat",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      meta_data: {
        channel: "",
        chat_mode: "",
        draft_id: "",
        if_plus_model: true,
        input_question_type: "xxxx",
        is_networking: false,
        is_test: false,
        platform: "pc",
        quote_log_id: "",
        cogview: { rm_label_watermark: false },
      },
    };
    return this.fetchImpl(`${this.baseUrl}/backend-api/assistant/stream`, {
      method: "POST",
      headers: this.buildHeaders(accessToken, true),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  /** Assemble every auth/anti-bot header; the X-Sign triple is recomputed per request. */
  private buildHeaders(
    accessToken: string | null,
    stream: boolean,
    appFr = "browser_extension",
  ): Record<string, string> {
    const { timestamp, nonce, sign } = buildSign();
    const headers: Record<string, string> = {
      Accept: stream ? "text/event-stream" : "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "App-Name": "chatglm",
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      Origin: "https://chatglm.cn",
      Pragma: "no-cache",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "User-Agent": this.userAgent,
      "X-App-Fr": appFr,
      "X-App-Platform": "pc",
      "X-App-Version": "0.0.1",
      "X-Device-Id": this.deviceId,
      "X-Forwarded-For": randomForwardedFor(),
      "X-Lang": "zh",
      "X-Nonce": nonce,
      "X-Request-Id": randomHex(),
      "X-Sign": sign,
      "X-Timestamp": timestamp,
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return headers;
  }
}
