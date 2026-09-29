/** Dependency contract injected into the HTTP routing layer. */
import type { DeepSeekClient } from "../deepseek/client.js";
import type { GlmService } from "../glm/service.js";

export interface ServerDependencies {
  client: DeepSeekClient;
  glm: GlmService;
  apiKeys: readonly string[];
  debug: boolean;
}