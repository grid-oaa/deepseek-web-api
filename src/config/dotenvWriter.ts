/** Rewrites one KEY=VALUE entry in the local .env file, preserving every other line. */
import fs from "node:fs";
import path from "node:path";

/** Return a writer that persists a rotated refresh token, or undefined when unavailable. */
export function envTokenWriter(
  key: string,
  file: string,
  onError?: (error: unknown) => void,
): ((token: string) => void) | undefined {
  const target = path.resolve(file);
  return (token: string): void => {
    try {
      if (!fs.existsSync(target)) return;
      const lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
      const prefix = `${key}=`;
      const index = lines.findIndex((line) => line.startsWith(prefix));
      const next = `${prefix}${token}`;
      if (index >= 0) {
        if (lines[index] === next) return;
        lines[index] = next;
      } else {
        lines.push(next);
      }
      fs.writeFileSync(target, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      onError?.(error);
    }
  };
}