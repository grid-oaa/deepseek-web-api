/** Verifies the documented behavior of the corresponding production module. */
import { describe, expect, it } from "vitest";

import { buildSign, buildTimestamp, signTimestamp, verifyTimestamp } from "../../src/glm/sign.js";

describe("GLM request signature", () => {
  it("replaces the second-to-last digit with a checksum", () => {
    expect(buildTimestamp(1234567890123)).toBe("1234567890193");
  });

  it("accepts checksummed timestamps and rejects raw clocks", () => {
    expect(verifyTimestamp("1234567890193")).toBe(true);
    expect(verifyTimestamp("1234567890123")).toBe(false);
    expect(verifyTimestamp("12345678901")).toBe(false);
  });

  it("hashes timestamp-nonce-secret with md5", () => {
    expect(signTimestamp("1234567890193", "abc")).toBe("eff472ddf923eb02c5f93c1c675ae795");
  });

  it("builds a self-consistent signature triple", () => {
    const signature = buildSign(1234567890123);
    expect(signature.timestamp).toBe("1234567890193");
    expect(signature.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(signature.sign).toBe(signTimestamp(signature.timestamp, signature.nonce));
  });
});