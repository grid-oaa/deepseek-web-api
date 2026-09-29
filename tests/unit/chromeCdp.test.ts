/** Covers the CDP endpoint helpers that decide whether a browser is reusable. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { cdpIsHeadless, localDebugPort, profileOwnerPid } from "../../src/browser/chromeCdp.js";

function emptyProfile(): string {
  return mkdtempSync(path.join(tmpdir(), "chrome-cdp-test-"));
}

describe("CDP endpoint helpers", () => {
  it("reports no profile owner when the profile directory is empty", () => {
    expect(profileOwnerPid(emptyProfile())).toBeNull();
  });

  it("recognizes only local http endpoints as debug ports", () => {
    expect(localDebugPort("http://127.0.0.1:9333")).toBe(9333);
    expect(localDebugPort("http://localhost:9333/")).toBe(9333);
    expect(localDebugPort("https://example.com:9333")).toBeNull();
    expect(localDebugPort("not a url")).toBeNull();
  });

  it("treats an unreachable endpoint as not headless so it is still probed", async () => {
    // Port 1 is closed, so cdpIsHeadless must fail closed instead of throwing.
    await expect(cdpIsHeadless("http://127.0.0.1:1")).resolves.toBe(false);
  });
});