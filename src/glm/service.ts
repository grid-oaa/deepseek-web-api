/** Serves glm-* requests through the chatglm.cn upstream in OpenAI-compatible shapes. */
import type { AppConfig } from "../config/env.js";
import { envTokenWriter } from "../config/dotenvWriter.js";
import type { ChatStreamChunk } from "../deepseek/chatStream.js";
import type { OpenAIResponse } from "../deepseek/mapResponses.js";
import {
  buildToolRecoveryPrompt,
  instructionText,
  requestConversationTurns,
  toolState,
} from "../deepseek/promptBuild.js";
import { ResponseEventWriter, type ResponseEmitter } from "../deepseek/responseEvents.js";
import { fingerprint } from "../deepseek/sessionTurns.js";
import { resolveToolTurn, type ToolTurnOutcome } from "../deepseek/toolOutcome.js";
import type { ParsedToolCalls } from "../deepseek/toolCalls.js";
import type { MessageTurn, RequestBody } from "../deepseek/types.js";
import { HttpError } from "../utils/errors.js";
import { GlmClient } from "./client.js";
import type { GlmLoginManager } from "./login.js";
import { resolveGlmModel } from "./models.js";
import { GlmSessionStore } from "./sessionStore.js";
import { iterGlmUpdates } from "./updates.js";

interface GlmTurn {
  reasoning: string;
  outputText: string;
  conversationId: string;
}

interface GlmThread {
  /** Fingerprint of the full history; the key a store call writes under. */
  key: string;
  /** Id found for this request, empty when the thread is new. */
  conversationId: string;
}

/** Flatten instructions, the tool protocol, and turns into one prompt. chatglm.cn has no
 * function-calling channel, so tools are described in text and the model answers with
 * tool_call blocks that the caller parses back out. */
function renderPrompt(body: RequestBody, resumed = false): string {
  const parts: string[] = [];
  const instructions = instructionText(body);
  if (instructions) parts.push(instructions);
  const tools = toolState(body);
  if (tools.hasTools) parts.push(tools.text);
  const turns = requestConversationTurns(body);
  // A resumed thread holds the earlier exchanges upstream, so only the new turn is sent.
  // Replaying the whole history would pay for the same tokens twice.
  for (const turn of resumed ? turns.slice(-1) : turns) parts.push(`${turn.role}:\n${turn.content}`);
  return parts.join("\n\n").trim();
}

/** The last user turn, reused when a tool turn has to be retried. */
function latestUserText(turns: MessageTurn[]): string {
  return [...turns].reverse().find((turn) => turn.role === "user")?.content ?? "";
}

/** Owns one GlmClient and adapts its updates to the shared OpenAI shapes. */
export class GlmService {
  private readonly client: GlmClient;
  private readonly sessions = new GlmSessionStore();

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
  private async openStream(prompt: string, conversationId: string): Promise<Response> {
    await this.login.ensureLoggedIn();
    const token = this.login.currentToken();
    if (token) this.client.adoptRefreshToken(token);
    return this.client.streamChat(prompt, conversationId);
  }

  /** Resolve the upstream thread. The id is stored under the full history, but a lookup drops
   * the trailing exchange: the next request repeats this history plus one more exchange. */
  private resolveThread(body: RequestBody): GlmThread {
    const turns = requestConversationTurns(body);
    const end = turns.at(-1)?.role === "user" ? turns.length - 2 : turns.length - 1;
    const prior = fingerprint(turns.slice(0, Math.max(0, end)));
    return { key: fingerprint(turns), conversationId: this.sessions.latest(prior) ?? "" };
  }

  /** Remember the id the upstream assigned so the next turn can continue the thread. */
  private rememberThread(turn: GlmTurn, key: string): void {
    if (turn.conversationId) this.sessions.remember(key, turn.conversationId);
  }

  /** Drain one upstream stream. onDelta fires per frame so a tool-free request streams as
   * the model writes; a tool request passes no callback because the text protocol can only
   * be split into calls after the whole turn is known. */
  private async readTurn(
    upstream: Response,
    onDelta?: (update: { reasoning?: string; output?: string }) => void,
  ): Promise<GlmTurn> {
    const turn: GlmTurn = { reasoning: "", outputText: "", conversationId: "" };
    for await (const update of iterGlmUpdates(upstream)) {
      if (update.type === "ready" && update.conversationId) {
        turn.conversationId = update.conversationId;
      } else if (update.type === "reasoning" && update.delta) {
        turn.reasoning += update.delta;
        onDelta?.({ reasoning: update.delta });
      } else if (update.type === "output" && update.delta) {
        turn.outputText += update.delta;
        onDelta?.({ output: update.delta });
      } else if (update.type === "error") {
        throw new HttpError(502, update.message);
      }
    }
    return turn;
  }

  /** Run a tool turn, retrying once when the model produced no usable call or answer. */
  private async readToolTurn(
    body: RequestBody,
    turns: MessageTurn[],
    idSeed: string,
    thread: GlmThread,
  ): Promise<{ outcome: ToolTurnOutcome; turn: GlmTurn }> {
    const prompt = renderPrompt(body, thread.conversationId !== "");
    if (!prompt) throw new HttpError(400, "empty input");
    const firstTurn = await this.readTurn(await this.openStream(prompt, thread.conversationId));
    this.rememberThread(firstTurn, thread.key);
    const first = resolveToolTurn(firstTurn.outputText, firstTurn.reasoning, idSeed);
    if (first.parsed.toolCalls.length > 0 || first.parsed.content.trim()) {
      return { outcome: first, turn: firstTurn };
    }
    const recovery = buildToolRecoveryPrompt(body, turns, latestUserText(turns)).trim();
    if (!recovery) return { outcome: first, turn: firstTurn };
    const retryTurn = await this.readTurn(await this.openStream(recovery, firstTurn.conversationId));
    this.rememberThread(retryTurn, thread.key);
    const retry = resolveToolTurn(retryTurn.outputText, retryTurn.reasoning, `${idSeed}_retry`);
    const usable = retry.parsed.toolCalls.length > 0 || retry.parsed.content.trim().length > 0;
    return { outcome: usable ? retry : first, turn: usable ? retryTurn : firstTurn };
  }

  /** Stream chat.completion.chunk deltas; an upstream error frame aborts the stream. */
  async streamChat(body: RequestBody, emit: (chunk: ChatStreamChunk) => void): Promise<void> {
    const model = resolveGlmModel(body);
    const tools = toolState(body);
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl_glm_${created}`;
    const send = (delta: Record<string, unknown>): void => {
      emit({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      });
    };
    const finish = (reason: "stop" | "tool_calls"): void => {
      emit({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
        conversation: id,
      });
    };

    const thread = this.resolveThread(body);
    if (tools.hasTools) {
      // The tool protocol can only be parsed once the whole turn is known, so this path
      // buffers; a tool-free request below is the one that streams live.
      const { outcome } = await this.readToolTurn(body, requestConversationTurns(body), id, thread);
      send({ role: "assistant", content: outcome.parsed.content });
      outcome.parsed.toolCalls.forEach((call, index) => {
        send({ tool_calls: [{ index, id: call.id, type: "function", function: call.function }] });
      });
      finish(outcome.parsed.toolCalls.length > 0 ? "tool_calls" : "stop");
      return;
    }

    const prompt = renderPrompt(body, thread.conversationId !== "");
    if (!prompt) throw new HttpError(400, "empty input");
    let roleSent = false;
    let pendingReasoning = "";
    const turn = await this.readTurn(await this.openStream(prompt, thread.conversationId), (delta) => {
      if (delta.reasoning) {
        pendingReasoning += delta.reasoning;
        if (roleSent) send({ reasoning_content: delta.reasoning });
        return;
      }
      if (!roleSent && pendingReasoning) {
        send({ role: "assistant", reasoning_content: pendingReasoning });
        roleSent = true;
        pendingReasoning = "";
      }
      send({ role: roleSent ? undefined : "assistant", ...(delta.output ? { content: delta.output } : {}) });
      roleSent = true;
    });
    this.rememberThread(turn, thread.key);
    if (!roleSent) {
      send({ role: "assistant", reasoning_content: turn.reasoning, content: turn.outputText });
    } else if (turn.outputText.trim() === "" && pendingReasoning) {
      send({ content: pendingReasoning });
    }
    finish("stop");
  }

  /** Buffer one glm stream into a Responses object, emitting the same SSE events as DeepSeek. */
  async completeResponses(body: RequestBody, emit?: ResponseEmitter): Promise<OpenAIResponse> {
    const thread = this.resolveThread(body);
    const model = resolveGlmModel(body);
    const tools = toolState(body);
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
    let parsed: ParsedToolCalls | null = null;
    let conversationId = thread.conversationId;

    if (tools.hasTools) {
      const { outcome, turn } = await this.readToolTurn(body, requestConversationTurns(body), id, thread);
      parsed = outcome.parsed;
      reasoning = outcome.reasoningText;
      outputText = outcome.outputText;
      conversationId = turn.conversationId;
    } else {
      const prompt = renderPrompt(body, thread.conversationId !== "");
      if (!prompt) throw new HttpError(400, "empty input");
      const turn = await this.readTurn(await this.openStream(prompt, thread.conversationId), (delta) => {
        if (delta.reasoning) {
          reasoning += delta.reasoning;
          writer.emitReasoningDelta(delta.reasoning);
        } else if (delta.output) {
          outputText += delta.output;
          writer.emitOutputDelta(delta.output);
        }
      });
      this.rememberThread(turn, thread.key);
      conversationId = turn.conversationId;
      if (outputText.trim() === "" && reasoning) writer.emitOutputDelta(reasoning);
    }

    const content = parsed ? parsed.content : outputText;
    const toolCalls = parsed?.toolCalls ?? [];
    if (tools.hasTools) {
      if (reasoning) writer.emitReasoningDelta(reasoning);
      writer.emitOutputDelta(content);
    }

    const output: Array<Record<string, unknown>> = [];
    writer.finishReasoning(reasoning, output);
    writer.finishMessage(content || reasoning, output);
    for (const call of toolCalls) {
      const item = {
        type: "function_call",
        id: `fc_${call.id.slice(5)}`,
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: "completed",
      };
      const outputIndex = output.length;
      output.push(item);
      writer.emitFunctionCall(item, outputIndex);
    }

    const final: OpenAIResponse = {
      ...base,
      status: "completed",
      output,
      output_text: content || reasoning,
      metadata: {
        ...base.metadata,
        reasoning_chars: reasoning.length,
        tool_call_count: toolCalls.length,
        tool_compatibility: tools.hasTools,
        upstream_conversation_id: conversationId,
      },
    };
    writer.emit("response.completed", { type: "response.completed", response: final });
    return final;
  }
}