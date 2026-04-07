/**
 * Mailbox watcher — monitors ~/.claude/mailbox.jsonl and forwards
 * notifications to Jason's WeChat via the active iLink account.
 */

import fs from "node:fs";
import path from "node:path";
import { sendTextMessage } from "./message.js";
import type { AccountData } from "./types.js";
import type { ContextTokenCache } from "./state.js";

const MAILBOX_PATH = path.join(process.env.HOME || "", ".claude", "mailbox.jsonl");
const PUSHED_PATH = path.join(process.env.HOME || "", ".claude", "mailbox-pushed.jsonl");
const POLL_INTERVAL_MS = 3_000;

interface MailboxEntry {
  from: string;
  time: string;
  type: string;
  level: "info" | "warn" | "error";
  task_id?: string;
  msg: string;
  cc?: string[];
}

function formatMailboxMsg(entry: MailboxEntry): string {
  const prefix = entry.level === "error" ? "【紧急】" : "";
  return `${prefix}【${entry.from}】${entry.msg}`;
}

export function startMailboxWatcher(
  getAccount: () => AccountData | null,
  contextTokens: ContextTokenCache,
  recipientId: string | null,
  log: (msg: string) => void,
  profileName?: string,
): void {
  if (profileName && profileName !== "jason") {
    log(`mailbox-watcher: 非jason profile（${profileName}），跳过`);
    return;
  }
  if (!recipientId) {
    log("mailbox-watcher: 无发送目标（allow_from为空），跳过");
    return;
  }

  let offset = 0;

  // Initialize offset to end of file (only watch new entries)
  try {
    if (fs.existsSync(MAILBOX_PATH)) {
      const stat = fs.statSync(MAILBOX_PATH);
      offset = stat.size;
    }
  } catch { /* file doesn't exist yet, offset stays 0 */ }

  log(`mailbox-watcher: 启动监听 (offset=${offset})`);

  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(MAILBOX_PATH)) return;

      const stat = fs.statSync(MAILBOX_PATH);

      // File was truncated or replaced — reset offset
      if (stat.size < offset) {
        offset = 0;
      }

      if (stat.size <= offset) return;

      // Read new bytes
      const fd = fs.openSync(MAILBOX_PATH, "r");
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = stat.size;

      const newContent = buf.toString("utf-8");
      const lines = newContent.split("\n").filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as MailboxEntry;

          // Only forward entries cc'd to 小衣服
          if (!entry.cc?.includes("小衣服")) continue;

          const account = getAccount();
          if (!account) {
            log("mailbox-watcher: 未登录，跳过通知");
            continue;
          }

          const ct = contextTokens.get(recipientId);
          if (!ct) {
            log("mailbox-watcher: 无 context_token，跳过通知");
            continue;
          }

          const text = formatMailboxMsg(entry);
          sendTextMessage(account.baseUrl, account.token, recipientId, text, ct)
            .then(() => {
              log(`mailbox-watcher: 已推送 [${entry.from}] ${entry.task_id || ""}`);
              try {
                fs.appendFileSync(PUSHED_PATH, JSON.stringify({ ...entry, pushed_at: new Date().toISOString() }) + "\n");
              } catch {}
            })
            .catch(err => log(`mailbox-watcher: 推送失败: ${String(err)}`));
        } catch {
          // Malformed JSON line, skip silently
        }
      }
    } catch (err) {
      // File read error — don't crash, just log
      log(`mailbox-watcher: 读取异常: ${String(err)}`);
    }
  }, POLL_INTERVAL_MS);

  timer.unref();
}
