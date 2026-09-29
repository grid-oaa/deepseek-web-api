/** Resolves the glm-* public model ids served by the chatglm.cn upstream. */
import type { PublicModel, RequestBody } from "../deepseek/types.js";

/** True when the request targets chatglm.cn instead of DeepSeek Web. */
export function isGlmRequest(body: RequestBody): boolean {
  return String(body.model ?? "")
    .toLowerCase()
    .startsWith("glm");
}

/** Pick the public glm id; unknown glm names fall back to the flash tier. */
export function resolveGlmModel(body: RequestBody): PublicModel {
  const raw = String(body.model ?? "").toLowerCase();
  return raw.includes("plus") || raw.includes("pro") ? "glm-4-plus" : "glm-4-flash";
}