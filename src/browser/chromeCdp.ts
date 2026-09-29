/** CDP endpoint probing, free-port allocation, and managed-profile lock recovery. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { errorMessage } from "../utils/errors.js";

export function localDebugPort(endpoint: string): number | null {
  try {
    const url = new URL(endpoint);
    const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    const port = Number(url.port);
    return local && url.protocol.startsWith("http") && Number.isInteger(port) && port > 0
      ? port
      : null;
  } catch {
    return null;
  }
}

export async function cdpVersionOk(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Playwright crashes on chrome-extension service_worker targets.
 * Only reuse a CDP endpoint when it has no extension targets.
 */
export async function cdpIsExtensionFree(endpoint: string): Promise<boolean> {
  try {
    if (!(await cdpVersionOk(endpoint))) return false;
    const list = await fetch(`${endpoint.replace(/\/$/, "")}/json/list`);
    if (!list.ok) return false;
    const targets: unknown = await list.json();
    if (!Array.isArray(targets)) return false;
    return !targets.some((target) => {
      if (typeof target !== "object" || target === null) return false;
      const url = "url" in target ? String(target.url) : "";
      const type = "type" in target ? String(target.type) : "";
      return url.startsWith("chrome-extension://") || type === "service_worker";
    });
  } catch {
    return false;
  }
}

export async function waitForCdp(endpoint: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Chrome CDP 启动超时 (${endpoint}): ${lastError}`);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地端口"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/** A headless browser can never show a window, so it cannot satisfy a visible request. */
export async function cdpIsHeadless(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`);
    if (!response.ok) return false;
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null) return false;
    const agent = "User-Agent" in data ? String(data["User-Agent"]) : "";
    return /headless/i.test(agent);
  } catch {
    return false;
  }
}

/** PID of the live Chrome owning chromeProfileDir, or null when the profile is free. */
export function profileOwnerPid(profileDir: string): number | null {
  try {
    const lock = fs.readlinkSync(path.join(profileDir, "SingletonLock"));
    const pid = Number(lock.split("-").pop());
    return Number.isInteger(pid) && pid > 0 && processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Stop the managed Chrome so a visible instance can take over the same profile. */
export function killManagedChrome(profileDir: string): boolean {
  const pid = profileOwnerPid(profileDir);
  if (pid === null) return false;
  try {
    process.kill(pid);
  } catch {
    return false;
  }
  return true;
}

/**
 * Stop any Chrome still bound to a CDP port, ignoring profile locks.
 * Windows keeps a lockfile rather than a SingletonLock symlink, so a leftover headless
 * instance stays invisible to profileOwnerPid and would block a visible replacement.
 */
export async function killChromeOnPort(endpoint: string, timeoutMs = 20_000): Promise<boolean> {
  const port = localDebugPort(endpoint);
  if (port === null) return false;
  try {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
    const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "im");
    const match = output.match(pattern);
    const pid = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid);
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await cdpVersionOk(endpoint))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Wait until the previous owner has fully exited. Chrome drops SingletonLock before the
 * process ends, so checking the lock alone would race and let the replacement fail to start.
 */
export async function waitForProfileRelease(
  profileDir: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const pid = profileOwnerPid(profileDir);
  if (pid === null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Recover CDP URL from a live Chrome that already owns chromeProfileDir. */
export function existingManagedEndpoint(profileDir: string): string | null {
  const pid = profileOwnerPid(profileDir);
  if (pid === null) return null;
  const command = processCommand(pid);
  if (!command) return null;
  const match = command.match(/--remote-debugging-port=(\d+)/);
  return match ? `http://127.0.0.1:${match[1]}` : null;
}
/** Drop Singleton* files only when the owning PID is dead. */
export function clearStaleProfileLocks(profileDir: string): void {
  const lockPath = path.join(profileDir, "SingletonLock");
  try {
    if (fs.existsSync(lockPath)) {
      const lock = fs.readlinkSync(lockPath);
      const pid = Number(lock.split("-").pop());
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) return;
    }
  } catch {
    // treat as stale
  }
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.unlinkSync(path.join(profileDir, name));
    } catch {
      // ignore
    }
  }
}

export function readSavedCdp(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const value = fs.readFileSync(file, "utf8").trim();
    return value.startsWith("http") ? value : null;
  } catch {
    return null;
  }
}

export function writeSavedCdp(file: string, endpoint: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${endpoint}\n`, { encoding: "utf8", mode: 0o600 });
}
