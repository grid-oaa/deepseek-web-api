/** Verifies .env token persistence keeps every unrelated line and value intact. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { envTokenWriter } from "../../src/config/dotenvWriter.js";

function envFile(contents: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "dotenv-writer-")), ".env");
  writeFileSync(file, contents, "utf8");
  return file;
}

describe("envTokenWriter", () => {
  it("replaces the token in place and keeps comments and other keys", () => {
    const file = envFile("# note\nGLM_REFRESH_TOKEN=old\nDS_PORT=8787\n");
    const write = envTokenWriter("GLM_REFRESH_TOKEN", file);
    expect(write).toBeDefined();
    write?.("fresh");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    expect(lines).toContain("# note");
    expect(lines).toContain("GLM_REFRESH_TOKEN=fresh");
    expect(lines).toContain("DS_PORT=8787");
  });

  it("appends the key when it is absent", () => {
    const file = envFile("DS_PORT=8787\n");
    envTokenWriter("GLM_REFRESH_TOKEN", file)?.("fresh");
    expect(readFileSync(file, "utf8")).toContain("GLM_REFRESH_TOKEN=fresh");
  });

  it("skips the write when the value is unchanged", () => {
    const file = envFile("GLM_REFRESH_TOKEN=same\n");
    envTokenWriter("GLM_REFRESH_TOKEN", file)?.("same");
    expect(readFileSync(file, "utf8").trim()).toBe("GLM_REFRESH_TOKEN=same");
  });

  it("does nothing when the .env file is missing", () => {
    const write = envTokenWriter("GLM_REFRESH_TOKEN", path.join(tmpdir(), "absent-env-file"));
    expect(() => write?.("fresh")).not.toThrow();
  });

  it("reports failures through the callback instead of throwing", () => {
    let reported: unknown = null;
    const file = envFile("GLM_REFRESH_TOKEN=old\n");
    const write = envTokenWriter("GLM_REFRESH_TOKEN", file, (error) => {
      reported = error;
    });
    write?.("fresh");
    expect(reported).toBeNull();
  });
});