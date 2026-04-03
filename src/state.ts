/**
 * Conversation state and context_token cache.
 */

import fs from "node:fs";
import { showTypingIndicator } from "./message.js";

// ── Context token cache (persisted to disk) ────────────────────────────────

const MAX_CACHE_ENTRIES = 500;

function log(msg: string) { process.stderr.write(`[state] ${msg}\n`); }

export class ContextTokenCache {
  private cache: Map<string, string>;
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.cache = new Map();
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      for (const [k, v] of Object.entries(JSON.parse(raw))) {
        if (typeof v === "string") this.cache.set(k, v);
      }
    } catch { /* first run */ }
  }

  set(key: string, token: string): void {
    this.cache.set(key, token);
    // Prune if too large (keep most recent entries)
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const entries = [...this.cache.entries()];
      this.cache = new Map(entries.slice(-Math.floor(MAX_CACHE_ENTRIES / 2)));
    }
    // Debounced write (100ms) to avoid I/O storm on burst messages
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        this.flush();
      }, 100);
    }
  }

  get(key: string): string | undefined {
    // 1. Exact match — fastest path
    const exact = this.cache.get(key);
    if (exact) return exact;

    // 2. Try bare-id match (strip @im.wechat suffix or match against bare keys)
    //    sender_id format can differ between message receipt and tool call
    const bareKey = key.split("@")[0];
    for (const [k, v] of this.cache) {
      if (k.split("@")[0] === bareKey) return v;
    }

    // 3. Single-user fallback: if only one entry, it's almost certainly the right one.
    //    This covers format mismatches for single-user (most common for external users).
    if (this.cache.size === 1) {
      const [, token] = [...this.cache.entries()][0];
      log(`context_token: 单用户 fallback (key=${key}, cache有 ${[...this.cache.keys()][0]})`);
      return token;
    }

    return undefined;
  }

  clear(): void {
    this.cache.clear();
    try { fs.writeFileSync(this.filePath, "{}", "utf-8"); } catch {}
  }

  private flush(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(Object.fromEntries(this.cache), null, 2),
        "utf-8",
      );
      try { fs.chmodSync(this.filePath, 0o600); } catch {}
    } catch { /* best-effort */ }
  }
}

// ── Conversation state tracking ────────────────────────────────────────────

interface ConversationState {
  lastUserMsgAt: number;
  lastBotReplyAt: number;
  baseUrl: string;
  token: string;
  toUserId: string;
  contextToken: string;
}

const conversations = new Map<string, ConversationState>();
const TYPING_INTERVAL_MS = 5_000;
const PROGRESS_MAX_MS = 5 * 60 * 1000;
const CONV_EXPIRE_MS = 30 * 60 * 1000;

// Global ticker for typing indicators (unref so it doesn't prevent process exit)
const typingTicker = setInterval(() => {
  const now = Date.now();
  for (const [key, conv] of conversations) {
    const lastActive = Math.max(conv.lastUserMsgAt, conv.lastBotReplyAt);
    if (now - lastActive > CONV_EXPIRE_MS) {
      conversations.delete(key);
      continue;
    }
    const userWaiting = conv.lastUserMsgAt > conv.lastBotReplyAt;
    const elapsed = now - conv.lastUserMsgAt;
    if (!userWaiting || elapsed > PROGRESS_MAX_MS) continue;
    showTypingIndicator(conv.baseUrl, conv.token, conv.toUserId, conv.contextToken).catch(() => {});
  }
}, TYPING_INTERVAL_MS);
typingTicker.unref();

export function onUserMessage(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
  contextKey: string,
): void {
  let conv = conversations.get(contextKey);
  if (!conv) {
    conv = { lastUserMsgAt: 0, lastBotReplyAt: 0, baseUrl, token, toUserId, contextToken };
    conversations.set(contextKey, conv);
  }
  conv.lastUserMsgAt = Date.now();
  conv.baseUrl = baseUrl;
  conv.token = token;
  conv.toUserId = toUserId;
  conv.contextToken = contextToken;
  showTypingIndicator(baseUrl, token, toUserId, contextToken).catch(() => {});
}

export function onBotReply(contextKey: string): void {
  const conv = conversations.get(contextKey);
  if (conv) conv.lastBotReplyAt = Date.now();
}
