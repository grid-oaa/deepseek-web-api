/** Verifies the documented behavior of the corresponding production module. */
import { describe, expect, it } from "vitest";

import { iterGlmUpdates } from "../../src/glm/updates.js";

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(body: string) {
  const updates = [];
  for await (const update of iterGlmUpdates(new Response(body))) updates.push(update);
  return updates;
}

describe("GLM stream updates", () => {
  it("separates thinking parts, joins deltas, and drops the finish snapshot", async () => {
    const body = [
      frame({ id: "r1", conversation_id: "c1", assistant_id: "a1", parts: [], status: "init" }),
      frame({
        id: "r1",
        parts: [{ id: "p1", logic_id: "L1", content: [{ type: "think", think: "思考" }], status: "init" }],
        status: "init",
      }),
      frame({
        id: "r1",
        parts: [{ id: "p2", logic_id: "L2", content: [{ type: "text", text: "你" }], status: "init" }],
        status: "init",
      }),
      frame({
        id: "r1",
        parts: [{ id: "p2", logic_id: "L2", content: [{ type: "text", text: "好" }], status: "init" }],
        status: "init",
      }),
      frame({
        id: "r1",
        parts: [{ id: "p2", logic_id: "L2", content: [{ type: "text", text: "你好" }], status: "finish" }],
        status: "finish",
      }),
    ].join("");
    expect(await collect(body)).toEqual([
      { type: "ready", conversationId: "c1", responseId: "r1", assistantId: "a1" },
      { type: "reasoning", delta: "思考" },
      { type: "output", delta: "你" },
      { type: "output", delta: "好" },
      { type: "close", status: "finish" },
    ]);
  });

  it("reports upstream failures and closes", async () => {
    const body = [
      frame({ id: "r1", conversation_id: "c1", parts: [], status: "init" }),
      frame({ status: "error", last_error: { err_msg: "boom", error_code: 10061 } }),
    ].join("");
    expect(await collect(body)).toEqual([
      { type: "ready", conversationId: "c1", responseId: "r1", assistantId: "" },
      { type: "error", message: "code=10061 boom" },
      { type: "close", status: "closed" },
    ]);
  });

  it("closes when the stream ends without a terminal frame", async () => {
    const body = frame({ id: "r1", conversation_id: "c1", parts: [], status: "init" });
    expect(await collect(body)).toEqual([
      { type: "ready", conversationId: "c1", responseId: "r1", assistantId: "" },
      { type: "close", status: "closed" },
    ]);
  });
});