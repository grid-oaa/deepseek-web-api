/** Resolves the glm-* public model ids served by the chatglm.cn upstream. */
import type { PublicModel, RequestBody } from "../deepseek/types.js";

/** True when the request targets chatglm.cn instead of DeepSeek Web. */
export function isGlmRequest(body: RequestBody): boolean {
  return String(body.model ?? "")
    .toLowerCase()
    .startsWith("glm");
}

/**
 * Pick the public glm id. The full id (glm-5.3) is the stronger tier, so only an
 * explicit flash marker selects the smaller one; unknown glm names get the full model.
 */
export function resolveGlmModel(body: RequestBody): PublicModel {
  const raw = String(body.model ?? "").toLowerCase();
  return raw.includes("flash") ? "glm-5.3-flash" : "glm-5.3";
}