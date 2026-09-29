/** Parses the native tool-call dialect DeepSeek Web emits instead of documented JSON blocks. */

import { isRecord } from "../utils/json.js";
import { collectJsonObjects } from "./toolCallJson.js";

export interface NativeRange {
  start: number;
  end: number;
}

export interface NativeCall {
  order: number;
  consume: NativeRange;
  payload: { name: string; arguments: Record<string, unknown> };
}

interface NativeTag extends NativeRange {
  closing: boolean;
  name: string;
  attributes: string;
}

interface NativeBlock extends NativeRange {
  bodyStart: number;
  bodyEnd: number;
  attributes: string;
}

// Native dialect tags are ASCII "<" plus full-width bars (U+FF5C) around an optional DSML prefix.
const NATIVE_TAG = /<\s*(\/?)\s*\uFF5C+[\s\uFF5C]*?(?:DSML)?[\s\uFF5C]*([A-Za-z_][\w-]*)([^>]*)>/gi;
// The wrapper tag is sometimes emitted without its delimiter decoration, so match it loosely.
const NATIVE_WRAPPER = /<\s*\/?\s*(?:tool[_-]?)?calls\s*>/gi;

function nativeTags(text: string): NativeTag[] {
  NATIVE_TAG.lastIndex = 0;
  return [...text.matchAll(NATIVE_TAG)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    closing: Boolean(match[1]),
    name: (match[2] ?? "").toLowerCase(),
    attributes: match[3] ?? "",
  }));
}

function attribute(attributes: string, key: string): string {
  return attributes.match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1]?.trim() ?? "";
}

// Native blocks nest, so each open tag pairs with the next closing tag of the same name.
function blocksOf(text: string, tags: readonly NativeTag[], name: string): NativeBlock[] {
  const blocks: NativeBlock[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    const open = tags[index];
    if (!open || open.name !== name || open.closing) continue;
    const close = tags.slice(index + 1).find((tag) => tag.name === name && tag.closing);
    blocks.push({
      start: open.start,
      end: close?.end ?? text.length,
      bodyStart: open.end,
      bodyEnd: close?.start ?? text.length,
      attributes: open.attributes,
    });
    if (close) index = tags.indexOf(close);
  }
  return blocks;
}

function decodeParameter(raw: string, asJson: boolean): unknown {
  const value = raw.trim();
  if (!asJson || !value) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function argumentsOf(text: string, tags: readonly NativeTag[], block: NativeBlock): Record<string, unknown> {
  const inner = tags.filter((tag) => tag.start >= block.bodyStart && tag.end <= block.bodyEnd);
  const args: Record<string, unknown> = {};
  for (const parameter of blocksOf(text, inner, "parameter")) {
    const key = attribute(parameter.attributes, "name");
    if (!key) continue;
    const asJson = attribute(parameter.attributes, "string").toLowerCase() === "false";
    args[key] = decodeParameter(text.slice(parameter.bodyStart, parameter.bodyEnd), asJson);
  }
  // Some turns put one plain JSON object in the invoke body instead of parameter tags.
  if (Object.keys(args).length > 0) return args;
  const body = text.slice(block.bodyStart, block.bodyEnd);
  const object = collectJsonObjects(body, true).find((candidate) => isRecord(candidate.value));
  return isRecord(object?.value) ? object.value : args;
}

function wrapperRanges(text: string): NativeRange[] {
  NATIVE_WRAPPER.lastIndex = 0;
  return [...text.matchAll(NATIVE_WRAPPER)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/** Collect native invoke calls and every dialect range so leftovers can be removed from content. */
export function parseNativeToolCalls(text: string): { calls: NativeCall[]; ranges: NativeRange[] } {
  const tags = nativeTags(text);
  if (tags.length === 0) return { calls: [], ranges: [] };
  const calls: NativeCall[] = [];
  for (const block of blocksOf(text, tags, "invoke")) {
    const name = attribute(block.attributes, "name");
    if (!name) continue;
    calls.push({
      order: block.start,
      consume: { start: block.start, end: block.end },
      payload: { name, arguments: argumentsOf(text, tags, block) },
    });
  }
  return { calls, ranges: [...tags, ...wrapperRanges(text)] };
}