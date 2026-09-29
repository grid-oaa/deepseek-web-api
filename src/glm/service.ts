/** Serves glm-* requests through the chatglm.cn upstream in OpenAI-compatible shapes. */
import type { AppConfig } from "../config/env.js";
import { envTokenWriter } from "../config/dotenvWriter.js";
import type { ChatStreamChunk } from "../deepseek/chatStream.js";
import type { OpenAIResponse } from "../deepseek/mapResponses.js";
import { instructionText, requestConversationTurns, toolState } from "../deepseek/promptBuild.js";
import { ResponseEventWriter, type ResponseEmitter } from "../deepseek/responseEvents.js";
import { resolveToolTurn } from "../deepseek/toolOutcome.js";
import type { RequestBody } from "../deepseek/types.js";
import { HttpError } from "../utils/errors.js";
import { GlmClient } from "./client.js";
import type { GlmLoginManager } from "./login.js";
import { resolveGlmModel } from "./models.js";
import { iterGlmUpdates } from "./updates.js";

interface GlmTurn {
  reasoning: string;
  outputText: string;
}

/**
 * Flatten instructions, the tool protocol, and conversation turns into one prompt.
 * chatglm.cn has no function-calling channel, so tools are described in text and the
 * model answers with tool_call blocks that the caller parses back out.
 */
function renderPrompt(body: RequestBody): string {
  const parts: string[] = [];
  const instructions = instructionText(body);
  if (instructions) parts.push(instructions);
  const tools = toolState(body);
  if (tools.hasTools) parts.push(tools.text);
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

  /** Drain one upstream stream into reasoning and visible text. */
  private async readTurn(upstream: Response): Promise<GlmTurn> {
    const turn: GlmTurn = { reasoning: "", outputText: "" };
    for await (const update of iterGlmUpdates(upstream)) {
      if (update.type === "reasoning" && update.delta) turn.reasoning += update.delta;
      else if (update.type === "output" && update.delta) turn.outputText += update.delta;
      else if (update.type === "error") throw new HttpError(502, update.message);
    }
    return turn;
  }

  /** Stream chat.completion.chunk deltas; an upstream error frame aborts the stream. */
  async streamChat(body: RequestBody, emit: (chunk: ChatStreamChunk) => void): Promise<void> {
    const model = resolveGlmModel(body);
    const prompt = renderPrompt(body);
    if (!prompt) throw new HttpError(400, "empty input");
    const tools = toolState(body);
    const turn = await this.readTurn(await this.openStream(prompt));
    const outcome = tools.hasTools
      ? resolveToolTurn(turn.outputText, turn.reasoning, `chatcmpl_glm_${Date.now()}`)
      : null;
    const content = outcome?.parsed.content ?? turn.outputText;
    const toolCalls = outcome?.parsed.toolCalls ?? [];
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
    // The first delta carries the role, and thinking stays in its own field so it never
    // leaks into content. Tool parsing only ever consumes the output channel.
    if (turn.reasoning) send({ role: "assistant", reasoning_content: turn.reasoning });
    send(turn.reasoning ? { content } : { role: "assistant", content });
    toolCalls.forEach((call, index) => {
      send({ tool_calls: [{ index, id: call.id, type: "function", function: call.function }] });
    });
    emit({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        { index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" },
      ],
      conversation: id,
    });
  }

  /** Buffer one glm stream into a Responses object, emitting the same SSE events as DeepSeek. */
  async completeResponses(body: RequestBody, emit?: ResponseEmitter): Promise<OpenAIResponse> {
    const model = resolveGlmModel(body);
    const prompt = renderPrompt(body);
    if (!prompt) throw new HttpError(400, "empty input");
    const tools = toolState(body);
    const turn = await this.readTurn(await this.openStream(prompt));
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
    const outcome = tools.hasTools
      ? resolveToolTurn(turn.outputText, turn.reasoning, id)
      : null;
    const parsed = outcome?.parsed;
    const content = parsed ? parsed.content : turn.outputText;
    const toolCalls = parsed?.toolCalls ?? [];

    if (turn.reasoning) writer.emitReasoningDelta(turn.reasoning);
    if (content || toolCalls.length === 0) writer.emitOutputDelta(content);

    const output: Array<Record<string, unknown>> = [];
    writer.finishReasoning(turn.reasoning, output);
    writer.finishMessage(content, output);
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
      output_text: content,
      metadata: {
        ...base.metadata,
        reasoning_chars: turn.reasoning.length,
        tool_call_count: toolCalls.length,
        tool_compatibility: tools.hasTools,
      },
    };
    writer.emit("response.completed", { type: "response.completed", response: final });
    return final;
  }
}