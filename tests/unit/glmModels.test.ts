/** Covers glm model dispatch and the flash/full tier selection. */
import { describe, expect, it } from "vitest";

import { isGlmRequest, resolveGlmModel } from "../../src/glm/models.js";

describe("glm model resolution", () => {
  it("routes only glm-prefixed model names to chatglm.cn", () => {
    expect(isGlmRequest({ model: "glm-5.3" })).toBe(true);
    expect(isGlmRequest({ model: "GLM-5.3-Flash" })).toBe(true);
    expect(isGlmRequest({ model: "deepseek-v4-flash" })).toBe(false);
    expect(isGlmRequest({})).toBe(false);
  });

  it("selects the flash tier only when the name carries the flash marker", () => {
    expect(resolveGlmModel({ model: "glm-5.3-flash" })).toBe("glm-5.3-flash");
    expect(resolveGlmModel({ model: "glm-5.3" })).toBe("glm-5.3");
  });

  it("treats an unknown glm name as the full model", () => {
    expect(resolveGlmModel({ model: "glm-anything" })).toBe("glm-5.3");
    expect(resolveGlmModel({})).toBe("glm-5.3");
  });
});