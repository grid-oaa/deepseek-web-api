#!/usr/bin/env node
/**
 * Probe chatglm.cn: verify the X-Sign algorithm locally and, when credentials are
 * available, open one SSE chat stream end to end.
 *
 * Usage:
 *   node scripts/glm-probe.mjs --sign-only
 *   node scripts/glm-probe.mjs --prompt "hi"
 *   node scripts/glm-probe.mjs --refresh <refresh_token>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** Signing secret lifted from the chatglm.cn web client. */
const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";
const DEFAULT_BASE_URL = "https://chatglm.cn/chatglm";
const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

function loadDotEnv(cwd) {
  const file = path.join(cwd, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function randomHex() {
  return crypto.randomUUID().replaceAll("-", "");
}

function randomForwardedFor() {
  while (true) {
    const first = Math.floor(Math.random() * 223) + 1;
    if ([10, 127, 169, 172, 192].includes(first)) continue;
    const rest = Array.from({ length: 3 }, () => Math.floor(Math.random() * 256));
    return [first, ...rest].join(".");
  }
}

/**
 * Reproduce the chatglm.cn X-Sign header. The millisecond timestamp has its
 * second-to-last digit replaced by a checksum derived from the other digits.
 */
export function buildSign() {
  const now = String(Date.now());
  const digits = [...now].map((char) => Number(char));
  const sum = digits.reduce((total, digit) => total + digit, 0);
  const checksum = (sum - digits[digits.length - 2]) % 10;
  const timestamp = now.slice(0, -2) + String(checksum) + now.slice(-1);
  const nonce = randomHex();
  const sign = crypto
    .createHash("md5")
    .update(`${timestamp}-${nonce}-${SIGN_SECRET}`, "utf8")
    .digest("hex");
  return { timestamp, nonce, sign };
}

/** Recompute the checksum the server is expected to validate. */
export function verifySign(timestamp) {
  const digits = [...timestamp].map((char) => Number(char));
  const sum = digits.reduce((total, digit) => total + digit, 0);
  return digits[digits.length - 2] === (sum - digits[digits.length - 2]) % 10;
}

function buildHeaders({ accessToken, appFr = "browser_extension", stream = true, deviceId }) {
  const { timestamp, nonce, sign } = buildSign();
  const headers = {
    Accept: stream ? "text/event-stream" : "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "App-Name": "chatglm",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    Origin: "https://chatglm.cn",
    Pragma: "no-cache",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "User-Agent": process.env.GLM_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    "X-App-Fr": appFr,
    "X-App-Platform": "pc",
    "X-App-Version": "0.0.1",
    "X-Device-Id": deviceId || randomHex(),
    "X-Forwarded-For": randomForwardedFor(),
    "X-Lang": "zh",
    "X-Nonce": nonce,
    "X-Request-Id": randomHex(),
    "X-Sign": sign,
    "X-Timestamp": timestamp,
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

async function readJson(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 返回非 JSON: ${text.slice(0, 300)}`);
  }
}

function unwrapToken(payload, label) {
  const code = payload.code ?? payload.status;
  const result = payload.result ?? {};
  if (!result.access_token) {
    throw new Error(`${label} 未返回 access_token | code=${code} payload=${JSON.stringify(payload).slice(0, 300)}`);
  }
  return {
    accessToken: String(result.access_token),
    refreshToken: result.refresh_token ? String(result.refresh_token) : null,
  };
}

async function fetchGuestToken(baseUrl, deviceId) {
  const response = await fetch(`${baseUrl}/user-api/guest/access`, {
    method: "POST",
    headers: {
      ...buildHeaders({ appFr: "default", stream: false, deviceId }),
      Referer: "https://chatglm.cn/",
    },
    body: "",
  });
  return unwrapToken(await readJson(response, "游客 token"), "游客 token");
}

async function fetchRefreshToken(baseUrl, refreshToken, deviceId) {
  const response = await fetch(`${baseUrl}/user-api/user/refresh`, {
    method: "POST",
    headers: buildHeaders({ accessToken: refreshToken, stream: false, deviceId }),
    body: "{}",
  });
  return unwrapToken(await readJson(response, "刷新 token"), "刷新 token");
}

/** Split an SSE byte stream into parsed JSON events, honouring [DONE]. */
async function* iterSse(response) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replaceAll("\r\n", "\n");
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const payload = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (payload === "[DONE]") return;
      if (payload) {
        try {
          yield JSON.parse(payload);
        } catch {
          console.log(`[跳过] 无法解析的 SSE 片段: ${payload.slice(0, 120)}`);
        }
      }
      index = buffer.indexOf("\n\n");
    }
  }
}

/** Join every text segment inside one part; think segments are ignored. */
function collectPartText(part) {
  if (!Array.isArray(part?.content)) return "";
  const texts = [];
  for (const item of part.content) {
    if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
  }
  return texts.join("");
}

async function streamChat({
  baseUrl,
  accessToken,
  prompt,
  assistantId,
  raw,
  timeoutMs,
  deviceId,
  dumpPath,
}) {
  const body = {
    assistant_id: assistantId,
    conversation_id: "",
    project_id: "",
    chat_type: "user_chat",
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    meta_data: {
      channel: "",
      chat_mode: "",
      draft_id: "",
      if_plus_model: true,
      input_question_type: "xxxx",
      is_networking: false,
      is_test: false,
      platform: "pc",
      quote_log_id: "",
      cogview: { rm_label_watermark: false },
    },
  };
  if (dumpPath) fs.writeFileSync(dumpPath, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/backend-api/assistant/stream`, {
      method: "POST",
      headers: buildHeaders({ accessToken, deviceId }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`chat stream HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    let events = 0;
    const buckets = new Map();
    const appendPart = (part) => {
      const key = String(part?.logic_id ?? part?.id ?? "default");
      const bucket = buckets.get(key) ?? { text: "", finished: false };
      const partStatus = String(part?.status ?? "").toLowerCase();
      const chunk = collectPartText(part);
      if (partStatus === "finish") {
        if (chunk) bucket.text = chunk;
        bucket.finished = true;
      } else if (chunk) {
        bucket.text += chunk;
      }
      buckets.set(key, bucket);
    };
    const flush = (status) => {
      let chars = 0;
      for (const [key, bucket] of buckets) {
        console.log(`\n[part ${key}] finished=${bucket.finished} chars=${bucket.text.length}`);
        console.log(bucket.text);
        chars += bucket.text.length;
      }
      console.log(`\n[流结束] status=${status} events=${events} chars=${chars}`);
      return { events, chars, status };
    };
    for await (const event of iterSse(response)) {
      events += 1;
      if (dumpPath) fs.appendFileSync(dumpPath, `${JSON.stringify(event)}\n`);
      if (raw) console.log(`[event ${events}] ${JSON.stringify(event)}`);
      const status = String(event.status ?? "").toLowerCase();
      for (const part of Array.isArray(event.parts) ? event.parts : []) appendPart(part);
      if (status === "error") {
        console.log(`\n[错误事件] ${JSON.stringify(event.last_error ?? event.parts ?? {})}`);
      }
      if (status === "finish" || status === "intervene") return flush(status);
    }
    return flush("closed");
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const args = {
    prompt: "你好，请用一句话介绍你自己",
    refresh: null,
    accessToken: null,
    deviceId: null,
    dump: null,
    raw: false,
    signOnly: false,
    timeout: 60,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--raw") args.raw = true;
    else if (item === "--sign-only") args.signOnly = true;
    else if (item === "--refresh") args.refresh = argv[++i] ?? null;
    else if (item === "--access-token") args.accessToken = argv[++i] ?? null;
    else if (item === "--device-id") args.deviceId = argv[++i] ?? null;
    else if (item === "--dump") args.dump = argv[++i] ?? null;
    else if (item === "--prompt") args.prompt = argv[++i] ?? args.prompt;
    else if (item === "--timeout") args.timeout = Number(argv[++i] ?? "60") || 60;
    else console.log(`[警告] 忽略未知参数: ${item}`);
  }
  return args;
}

async function main() {
  loadDotEnv(process.cwd());
  const args = parseArgs(process.argv.slice(2));

  const probe = buildSign();
  console.log("=== 签名自检 ===");
  console.log(`timestamp=${probe.timestamp} nonce=${probe.nonce}`);
  console.log(`sign=${probe.sign}`);
  const valid = verifySign(probe.timestamp);
  console.log(`checksum_valid=${valid}`);
  if (!valid) {
    console.error("签名校验位计算失败，脚本与上游算法不一致");
    process.exit(1);
  }
  if (args.signOnly) {
    console.log("仅自检模式，退出。");
    return;
  }

  const baseUrl = (process.env.GLM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  const assistantId = process.env.GLM_ASSISTANT_ID?.trim() || DEFAULT_ASSISTANT_ID;
  const refreshToken = args.refresh ?? process.env.GLM_REFRESH_TOKEN?.trim() ?? null;
  const directToken = args.accessToken ?? process.env.GLM_ACCESS_TOKEN?.trim() ?? null;
  const deviceId = args.deviceId ?? process.env.GLM_DEVICE_ID?.trim() ?? null;

  console.log("\n=== 获取 access_token ===");
  let token;
  let mode;
  if (directToken) {
    token = { accessToken: directToken, refreshToken: null };
    mode = "直连 access_token";
  } else if (refreshToken) {
    token = await fetchRefreshToken(baseUrl, refreshToken, deviceId);
    mode = "账号 refresh_token";
  } else {
    token = await fetchGuestToken(baseUrl, deviceId);
    mode = "游客";
  }
  console.log(`模式=${mode} access_token=${token.accessToken.slice(0, 12)}...`);
  if (token.refreshToken) console.log(`新的 refresh_token=${token.refreshToken.slice(0, 12)}...`);

  console.log(`\n=== 发起对话 base=${baseUrl} ===`);
  const result = await streamChat({
    baseUrl,
    accessToken: token.accessToken,
    prompt: args.prompt,
    assistantId,
    raw: args.raw,
    timeoutMs: args.timeout * 1000,
    deviceId,
    dumpPath: args.dump,
  });
  console.log(`=== 完成 status=${result.status} events=${result.events} chars=${result.chars} ===`);
}

main().catch((error) => {
  console.error(`\n[失败] ${error?.message ?? error}`);
  if (error?.cause) console.error(`[原因] ${error.cause?.message ?? error.cause}`);
  process.exit(1);
});