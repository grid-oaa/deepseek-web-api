/** Reproduces the chatglm.cn request signature used by every authenticated call. */
import crypto from "node:crypto";

/** Signing secret embedded in the chatglm.cn web client bundle. */
export const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";

export interface GlmSignature {
  timestamp: string;
  nonce: string;
  sign: string;
}

function randomHex(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * Rewrite a millisecond timestamp so its second-to-last digit carries a checksum
 * over the remaining digits. chatglm.cn rejects signatures built from a raw clock.
 */
export function buildTimestamp(nowMs: number): string {
  const raw = String(nowMs);
  const digits = [...raw].map((char) => Number(char));
  const others = digits.filter((_, index) => index !== digits.length - 2);
  const checksum = others.reduce((total, digit) => total + digit, 0) % 10;
  return raw.slice(0, -2) + String(checksum) + raw.slice(-1);
}

/** Check that a timestamp still satisfies the checksum rule above. */
export function verifyTimestamp(timestamp: string): boolean {
  if (!/^\d{13}$/.test(timestamp)) return false;
  const digits = [...timestamp].map((char) => Number(char));
  const others = digits.filter((_, index) => index !== digits.length - 2);
  return digits[digits.length - 2] === others.reduce((total, digit) => total + digit, 0) % 10;
}

/** MD5 over timestamp-nonce-secret, the exact string the upstream expects. */
export function signTimestamp(timestamp: string, nonce: string): string {
  return crypto
    .createHash("md5")
    .update(`${timestamp}-${nonce}-${SIGN_SECRET}`, "utf8")
    .digest("hex");
}

/** Build a complete X-Sign triple. Pass nowMs in tests to keep output deterministic. */
export function buildSign(nowMs: number = Date.now()): GlmSignature {
  const timestamp = buildTimestamp(nowMs);
  const nonce = randomHex();
  return { timestamp, nonce, sign: signTimestamp(timestamp, nonce) };
}