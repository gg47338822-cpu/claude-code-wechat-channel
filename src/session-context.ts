/**
 * Session context preservation — survives restarts.
 *
 * 每个profile一个小本本（session-snapshot.md），记录最近30次对谈（一来一回算一次）。
 * 每次收到或发出消息时实时写入，环状覆盖。
 * CLI重启后通过hook读取小本本，接上上下文。
 *
 * v2: 30条消息 → 30次对谈(60条消息)，定时器 → 实时写入，读后不删除
 */

import fs from "node:fs";

// ── Message ring buffer ──────────────────────────────────────────────────

interface MessageEntry {
  time: string;       // ISO timestamp
  direction: "in" | "out";
  sender: string;     // sender short id or "bot"
  msgType: string;
  text: string;       // truncated to keep snapshot manageable
}

const MAX_MESSAGES = 60; // 30次对谈 × 2条消息（一来一回）
const messages: MessageEntry[] = [];
let snapshotPath = "";
let lastSessionPath = "";
let profileName = "";

// ── Init ──────────────────────────────────────────────────────────────────

export function initSessionContext(opts: {
  snapshotFile: string;
  lastSessionFile: string;
  profile: string;
}): void {
  snapshotPath = opts.snapshotFile;
  lastSessionPath = opts.lastSessionFile;
  profileName = opts.profile;
  // v2: 不再用定时器，每条消息实时写入
}

// ── Record messages ───────────────────────────────────────────────────────

export function recordIncoming(sender: string, msgType: string, text: string): void {
  messages.push({
    time: new Date().toISOString(),
    direction: "in",
    sender,
    msgType,
    text: text.slice(0, 500),
  });
  if (messages.length > MAX_MESSAGES) messages.shift();
  writeSnapshot(); // v2: 实时写入，不等定时器
}

export function recordOutgoing(recipientShort: string, text: string): void {
  messages.push({
    time: new Date().toISOString(),
    direction: "out",
    sender: "bot",
    msgType: "text",
    text: text.slice(0, 500),
  });
  if (messages.length > MAX_MESSAGES) messages.shift();
  writeSnapshot(); // v2: 实时写入，不等定时器
}

// ── Snapshot (periodic, crash fallback) ───────────────────────────────────

function formatMessages(): string {
  if (messages.length === 0) return "(no messages in this session)";
  return messages.map(m => {
    const time = m.time.slice(11, 19); // HH:MM:SS
    const arrow = m.direction === "in" ? ">>" : "<<";
    const label = m.direction === "in" ? m.sender : `bot -> ${m.sender}`;
    const typeTag = m.msgType !== "text" ? ` [${m.msgType}]` : "";
    return `${time} ${arrow} ${label}${typeTag}: ${m.text}`;
  }).join("\n");
}

function writeSnapshot(): void {
  if (!snapshotPath) return;
  try {
    const content = [
      `# Session Snapshot (${profileName})`,
      `Updated: ${new Date().toISOString()}`,
      `Message count: ${messages.length}`,
      "",
      "## Recent Messages",
      formatMessages(),
      "",
    ].join("\n");
    fs.writeFileSync(snapshotPath, content, "utf-8");
  } catch { /* best-effort */ }
}

// ── Full summary (graceful stop) ─────────────────────────────────────────

export function writeSessionSummary(): void {
  if (!lastSessionPath || messages.length === 0) return;
  try {
    const first = messages[0];
    const last = messages[messages.length - 1];
    const content = [
      `# Last Session Context (${profileName})`,
      `Session period: ${first.time} ~ ${last.time}`,
      `Total messages: ${messages.length}`,
      "",
      "## Full Conversation",
      formatMessages(),
      "",
    ].join("\n");
    fs.writeFileSync(lastSessionPath, content, "utf-8");
    // Clean up snapshot since we have a full summary
    try { fs.unlinkSync(snapshotPath); } catch {}
  } catch { /* best-effort */ }
}

// ── Restore (on startup) ─────────────────────────────────────────────────

export function loadSessionContext(snapshotFile: string, lastSessionFile: string): string | null {
  // Priority: last-session.md > session-snapshot.md
  // v2: 读后不删除，CLI hook需要持续读取
  for (const file of [lastSessionFile, snapshotFile]) {
    try {
      if (fs.existsSync(file)) {
        return fs.readFileSync(file, "utf-8");
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

export function stopSessionContext(): void {
  // v2: 没有定时器需要清理，直接写最终摘要
  writeSessionSummary();
}
