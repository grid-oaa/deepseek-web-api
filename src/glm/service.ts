/** Serves glm-* requests through the chatglm.cn upstream in OpenAI-compatible shapes. */
import type { AppConfig } from "../config/env.js";
import { envTokenWriter } from "../config/dotenvWriter.js";
import type { ChatStreamChunk } from "../deepseek/chatStream.js";
import type { OpenAIResponse } from "../deepseek/mapResponses.js";
import { requestConversationTurns } from "../deepseek/promptBuild.js";
import { ResponseEventWriter, type ResponseEmitter } from "../deepseek/responseEvents.js";
import type { RequestBody } from "../deepseek/types.js";
import { HttpError } from "../utils/errors.js";
import { GlmClient } from "./client.js";
import type { GlmLoginManager } from "./login.js";
import { resolveGlmModel } from "./models.js";
import { iterGlmUpdates } from "./updates.js";

/** Flatten instructions and conversation turns into one chatglm.cn prompt string. */
function renderPrompt(body: RequestBody): string {
  const parts: string[] = [];
  for (const value of [body.instructions, body.system]) {
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  }
  for (const turn of requestConversationTurns(body)) parts.push(`${turn.role}:\n${turn.content}`);
  return parts.join("\n\n").trim();
}

/** Owns one GlmClient and adapts its updates to the shared OpenAI shapes. */
export class GlmService {
  private readonly client: GlmClient;

  constructor(config: AppConfig, private readonly login: GlmLoginManager) {
    const persist = envTokenWriter("GLM_REFRESH_TOKEN", config.dotEnvFile, (error: unknown) => {
      console.warn(`[GLM] 无法写回 GLM_REFRESH_TOKEN：${String(error)}`);
    });
    this.client = new GlmClient({
      baseUrl: config.glmBaseUrl,
      assistantId: config.glmAssistantId,
      userAgent: config.glmUserAgent,
      ...(config.glmAccessToken ? { accessToken: config.glmAccessToken } : {}),
      ...(config.glmRefreshToken ? { refreshToken: config.glmRefreshToken } : {}),
      ...(persist ? { onRefreshToken: persist } : {}),
    });
  }

  /** Resolve the login first so a browser-only token is picked up on the very first call. */
  private async openStream(prompt: string): Promise<Response> {
    await this.login.ensureLoggedIn();
    const token = this.login.currentToken();
    if (token) this.client.adoptRefreshToken(token);
    return this.client.streamChat(prompt);
  }

  /** Stream chat.completion.chunk deltas; an upstream error frame aborts the stream. */
  async streamChat(body: RequestBody, emit: (chunk: ChatStreamChunk) => void): Promise<void> {
    const model = resolveGlmModel(body);
    const prompt = renderPrompt(body);
    if (!prompt) throw new HttpError(400, "empty input");
    const upstream = await this.openStream(prompt);
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl_glm_${created}`;
    let roleSent = false;
    let reasoningSent = false;
    let reasoningText = "";
    const write = (delta: Record<string, unknown>): void => {
      const withRole = roleSent ? delta : { role: "assistant", ...delta };
      roleSent = true;
      emit({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: withRole, finish_reason: null }],
      });
    };
    for await (const update of iterGlmUpdates(upstream)) {
      if (update.type === "reasoning" && update.delta) reasoningText += update.delta;
      else if (update.type === "output" && update.delta) {
        if (!reasoningSent && reasoningText) {
          write({ reasoning_content: reasoningText });
          reasoningSent = true;
        }
        write({ content: update.delta });
      } else if (update.type === "error") throw new HttpError(502, update.message);
    }
    if (!roleSent) write({ content: "" });
    emit({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      conversation: id,
    });
  }

  /** Buffer one glm stream into a Responses object, emitting the same SSE events as DeepSeek. */
  async completeResponses(body: RequestBody, emit?: ResponseEmitter): Promise<OpenAIResponse> {
    const model = resolveGlmModel(body);
    const prompt = renderPrompt(body);
    if (!prompt) throw new HttpError(400, "empty input");
    const upstream = await this.openStream(prompt);
    const createdAt = Math.floor(Date.now() / 1000);
    const id = `resp_glm_${createdAt}`;
    const writer = new ResponseEventWriter(emit, `${id}_reasoning`, `${id}_message`);
    const base: OpenAIResponse = {
      id,
      object: "response",
      created_at: createdAt,
      status: "in_progress",
      model,
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      metadata: { chat_session_id: id, source: "chatglm.cn" },
    };
    writer.start(base);
    let reasoning = "";
    let outputText = "";
    for await (const update of iterGlmUpdates(upstream)) {
      if (update.type === "reasoning" && update.delta) {
        reasoning += update.delta;
        if (!writer.messageOpened) writer.emitReasoningDelta(update.delta);
      } else if (update.type === "output" && update.delta) {
        if (!writer.messageOpened && reasoning) writer.emitReasoningDelta(reasoning);
        outputText += update.delta;
        writer.emitOutputDelta(update.delta);
      } else if (update.type === "error") throw new HttpError(502, update.message);
    }
    if (reasoning && !writer.reasoningOpened) writer.emitReasoningDelta(reasoning);
    if (!writer.messageOpened && !outputText) writer.emitOutputDelta("");
    const output: Array<Record<string, unknown>> = [];
    writer.finishReasoning(reasoning, output);
    writer.finishMessage(outputText, output);
    const final: OpenAIResponse = {
      ...base,
      status: "completed",
      output,
      output_text: outputText,
      metadata: { ...base.metadata, reasoning_chars: reasoning.length },
    };
    writer.emit("response.completed", { type: "response.completed", response: final });
    return final;
  }
}