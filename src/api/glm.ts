/** HTTP adapter that routes glm-* requests to the chatglm.cn upstream. */
import type { ServerResponse } from "node:http";

import type { RequestBody } from "../deepseek/types.js";
import type { GlmService } from "../glm/service.js";
import { errorMessage, errorStatus } from "../utils/errors.js";
import { writeJson, writeSse, writeSseHeaders } from "../utils/http.js";

/** Chat Completions for glm models; mirrors the DeepSeek handler's stream shape. */
export async function handleGlmChatCompletions(
  response: ServerResponse,
  body: RequestBody,
  service: GlmService,
): Promise<void> {
  if (body.stream === true) {
    writeSseHeaders(response);
    try {
      await service.streamChat(body, (chunk) => {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      });
      response.write("data: [DONE]\n\n");
      response.end();
    } catch (error) {
      response.write(`data: ${JSON.stringify({ error: { message: errorMessage(error) } })}\n\n`);
      response.end();
    }
    return;
  }

  try {
    const result = await service.completeResponses(body);
    const text = result.output_text ?? "";
    writeJson(response, 200, {
      id: result.id,
      object: "chat.completion",
      created: result.created_at,
      model: result.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (error) {
    writeJson(response, errorStatus(error), { error: { message: errorMessage(error) } });
  }
}

/** Responses API for glm models, including named SSE event framing. */
export async function handleGlmResponses(
  response: ServerResponse,
  body: RequestBody,
  service: GlmService,
): Promise<void> {
  if (body.stream === true) {
    writeSseHeaders(response);
    try {
      await service.completeResponses(body, (event, data) => writeSse(response, event, data));
      response.write("data: [DONE]\n\n");
      response.end();
    } catch (error) {
      writeSse(response, "error", {
        type: "error",
        code: "glm_upstream_error",
        message: errorMessage(error),
        param: null,
      });
      response.end();
    }
    return;
  }

  try {
    writeJson(response, 200, await service.completeResponses(body));
  } catch (error) {
    writeJson(response, errorStatus(error), { error: { message: errorMessage(error) } });
  }
}