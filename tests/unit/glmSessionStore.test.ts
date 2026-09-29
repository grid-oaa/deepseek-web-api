/** Covers the bounded conversation-id map used to continue a chatglm.cn thread. */
import { describe, expect, it } from "vitest";

import { GlmSessionStore } from "../../src/glm/sessionStore.js";

describe("GlmSessionStore", () => {
  it("returns null for an unknown key", () => {
    expect(new GlmSessionStore().latest("missing")).toBeNull();
  });

  it("returns the id it was given", () => {
    const store = new GlmSessionStore();
    store.remember("k", "conv-1");
    expect(store.latest("k")).toBe("conv-1");
  });

  it("replaces the id when the same key advances", () => {
    const store = new GlmSessionStore();
    store.remember("k", "conv-1");
    store.remember("k", "conv-2");
    expect(store.latest("k")).toBe("conv-2");
  });

  it("ignores an empty key", () => {
    const store = new GlmSessionStore();
    store.remember("", "conv-1");
    expect(store.latest("")).toBeNull();
  });

  it("evicts the oldest entry once the limit is exceeded", () => {
    const store = new GlmSessionStore();
    store.remember("a", "c1");
    store.remember("b", "c2");
    store.remember("c", "c3", 2);
    expect(store.latest("a")).toBeNull();
    expect(store.latest("b")).toBe("c2");
    expect(store.latest("c")).toBe("c3");
  });
});