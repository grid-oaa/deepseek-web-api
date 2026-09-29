/** Tracks chatglm.cn conversation ids so a follow-up turn reuses the upstream thread. */
export interface GlmSessionEntry {
  conversationId: string;
  updatedAt: number;
}

/** Bounded in-memory map; the upstream owns the history, so only the id is kept. */
export class GlmSessionStore {
  private readonly sessions = new Map<string, GlmSessionEntry>();

  /** Latest conversation for a conversation id key, or null when unknown. */
  latest(key: string): string | null {
    return this.sessions.get(key)?.conversationId ?? null;
  }

  /** Record the id the upstream just assigned, evicting the oldest entry when full. */
  remember(key: string, conversationId: string, limit = 256): void {
    if (!key) return;
    this.sessions.delete(key);
    this.sessions.set(key, { conversationId, updatedAt: Date.now() });
    while (this.sessions.size > limit) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
  }
}