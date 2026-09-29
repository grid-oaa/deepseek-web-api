/** Converts chatglm.cn SSE frames into stable reasoning/output update events. */
import { HttpError } from "../utils/errors.js";
import { asString, isRecord } from "../utils/json.js";
import type { DeepSeekSseEvent } from "../deepseek/types.js";
import { SseParser } from "../deepseek/sse.js";

export type GlmUpdate =
  | { type: "ready"; conversationId: string; responseId: string; assistantId: string }
  | { type: "reasoning"; delta: string }
  | { type: "output"; delta: string }
  | { type: "error"; message: string }
  | { type: "close"; status: "finish" | "intervene" | "closed" };

type Channel = "reasoning" | "output";

interface PartState {
  text: string;
  channel: Channel;
}

function parts(data: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(data.parts) ? data.parts.filter(isRecord) : [];
}

function contentItems(part: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(part.content) ? part.content.filter(isRecord) : [];
}

/** Pick the text channel a part belongs to; null when the frame carries neither. */
function detectChannel(items: Record<string, unknown>[]): Channel | null {
  let channel: Channel | null = null;
  for (const item of items) {
    if (item.type === "think") return "reasoning";
    if (item.type === "text") channel = "output";
  }
  return channel;
}

/** Join one channel text inside a single frame; the other channel is ignored. */
function channelText(items: Record<string, unknown>[], channel: Channel): string {
  const field = channel === "reasoning" ? "think" : "text";
  let text = "";
  for (const item of items) {
    if (item.type !== field) continue;
    const value = item[field];
    if (typeof value === "string") text += value;
  }
  return text;
}

/**
 * Fold one part into its running state. chatglm.cn sends deltas while a part is open
 * and the full text once it flips to "finish", so the finish frame may only emit the
 * remainder; emitting the snapshot again would duplicate the answer.
 */
function consumePart(states: Map<string, PartState>, part: Record<string, unknown>): GlmUpdate | null {
  const key = asString(part.logic_id) ?? asString(part.id);
  if (!key) return null;
  const previous = states.get(key) ?? { text: "", channel: "output" as Channel };
  const items = contentItems(part);
  const channel = detectChannel(items) ?? previous.channel;
  const text = channelText(items, channel);
  if (!text) {
    states.set(key, { text: previous.text, channel });
    return null;
  }
  const finished = String(part.status ?? "").toLowerCase() === "finish";
  let delta = text;
  let accumulated = previous.text + text;
  if (finished) {
    delta = text.length > previous.text.length ? text.slice(previous.text.length) : "";
    accumulated = text;
  }
  states.set(key, { text: accumulated, channel });
  if (!delta) return null;
  return channel === "reasoning" ? { type: "reasoning", delta } : { type: "output", delta };
}

function describeError(error: Record<string, unknown>): string {
  const code = error.error_code ?? error.code;
  const message = asString(error.err_msg) ?? asString(error.message) ?? "GLM upstream error";
  return code === undefined ? message : `code=${String(code)} ${message}`;
}

/** Surface the first failure carried by a frame, if any. */
function frameFailure(data: Record<string, unknown>): string | null {
  const lastError = isRecord(data.last_error) ? data.last_error : null;
  if (lastError && Object.keys(lastError).length > 0) return describeError(lastError);
  for (const part of parts(data)) {
    if (isRecord(part.error) && Object.keys(part.error).length > 0) return describeError(part.error);
    if (String(part.status ?? "").toLowerCase() === "error") return "GLM part error";
  }
  return null;
}

function closeStatus(status: string): "finish" | "intervene" | "closed" {
  if (status === "finish" || status === "intervene") return status;
  return "closed";
}

/** Convert a Fetch Response body into validated chatglm.cn SSE events. */
async function* iterGlmEvents(response: Response): AsyncGenerator<DeepSeekSseEvent> {
  if (!response.ok) {
    const message = (await response.text()).slice(0, 500);
    throw new HttpError(502, `GLM upstream ${response.status}: ${message}`);
  }
  if (!response.body) throw new HttpError(502, "GLM upstream returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
  }
  for (const event of parser.push(decoder.decode())) yield event;
  for (const event of parser.finish()) yield event;
}

/**
 * Walk a chatglm.cn chat stream and emit ready/reasoning/output/error/close in order.
 * Thinking parts carry their own logic_id, so reasoning never leaks into output text.
 */
export async function* iterGlmUpdates(response: Response): AsyncGenerator<GlmUpdate> {
  const states = new Map<string, PartState>();
  let ready = false;
  let closed = false;

  for await (const event of iterGlmEvents(response)) {
    const data = event.data;
    if (!ready) {
      const conversationId = asString(data.conversation_id);
      if (conversationId) {
        ready = true;
        yield {
          type: "ready",
          conversationId,
          responseId: asString(data.id) ?? "",
          assistantId: asString(data.assistant_id) ?? "",
        };
      }
    }
    for (const part of parts(data)) {
      const update = consumePart(states, part);
      if (update) yield update;
    }
    const failure = frameFailure(data);
    if (failure) yield { type: "error", message: failure };
    const status = String(data.status ?? "").toLowerCase();
    if (status === "finish" || status === "intervene" || status === "error") {
      closed = true;
      yield { type: "close", status: closeStatus(status) };
      break;
    }
  }
  if (!closed) yield { type: "close", status: "closed" };
}