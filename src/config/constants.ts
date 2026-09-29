/** Shared DeepSeek Web protocol constants used by browser and Node-side requests. */
export const DEEPSEEK_BASE_URL = "https://chat.deepseek.com";
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9333";
export const DEFAULT_POW_WORKER_URL =
  "https://fe-static.deepseek.com/chat/static/76608.8f2a9fa413.js";
export const COMPLETION_PATH = "/api/v0/chat/completion";
export const CLIENT_HEADERS = {
  "x-client-platform": "web",
  "x-client-version": "2.2.0",
  "x-client-locale": "zh_CN",
  "x-client-bundle-id": "com.deepseek.chat",
} as const;

/** Default endpoint, assistant id, and UA for the optional chatglm.cn upstream (glm-* models only). */
export const GLM_BASE_URL = "https://chatglm.cn/chatglm";
export const GLM_ASSISTANT_ID = "65940acff94777010aa6b796";
/** Browsable chatglm.cn site; GLM_BASE_URL is the API prefix and returns 404 in a browser. */
export const GLM_WEB_URL = "https://chatglm.cn/";
export const GLM_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";