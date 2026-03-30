/**
 * Message polling loop — long-polls the iLink API and dispatches to MCP.
 */

import fs from "node:fs";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { MSG_TYPE_USER, type AccountData } from "./types.js";
import { loadProfileConfig, isPaused } from "./profile.js";
import { extractContent, getUpdates, sendTextMessage } from "./message.js";
import { buildCdnDownloadUrl, resolveMediaDownloadInfo, downloadMediaToFile } from "./cdn.js";
import { doQRLoginWithWebServer } from "./login.js";
import { type ContextTokenCache, onUserMessage } from "./state.js";

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

// ── Dependencies interface ────────────────────────────────────────────────

export interface PollingDeps {
  mcp: Server;
  profileName: string;
  paths: {
    credentialsFile: string;
    profileConfigFile: string;
    syncBufFile: string;
    mediaDir: string;
    pausedFile: string;
    lastActivityFile: string;
  };
  contextTokens: ContextTokenCache;
  setActiveAccount: (account: AccountData) => void;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

// ── Polling loop ──────────────────────────────────────────────────────────

export async function startPolling(account: AccountData, deps: PollingDeps): Promise<never> {
  const { mcp, profileName, paths, contextTokens, setActiveAccount, log, logError } = deps;
  let { baseUrl, token } = account;
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;
  let mcpFailures = 0;

  // Restore sync state
  try {
    if (fs.existsSync(paths.syncBufFile)) {
      getUpdatesBuf = fs.readFileSync(paths.syncBufFile, "utf-8");
      log(`恢复同步状态 (${getUpdatesBuf.length} bytes)`);
    }
  } catch {}

  // Hot-reload account
  function reloadAccountIfChanged(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(paths.credentialsFile, "utf-8"));
      if (raw.token && raw.token !== token) {
        log("检测到 token 更新");
        token = raw.token;
        baseUrl = raw.baseUrl || baseUrl;
        setActiveAccount(raw);
      }
    } catch {}
  }

  // Exit notification
  async function sendExitNotification(reason: string): Promise<void> {
    try {
      const profileConfig = loadProfileConfig(paths.profileConfigFile);
      const recipient = profileConfig.allow_from?.[0];
      const ct = contextTokens.get(recipient || "");
      if (!recipient || !ct) return;
      await sendTextMessage(baseUrl, token, recipient, reason, ct);
    } catch {}
  }

  process.stdin.on("end", () => {
    sendExitNotification(`[${profileName}] Claude CLI 已断开`).finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    sendExitNotification(`[${profileName}] 服务已停止`).finally(() => process.exit(0));
  });

  log("开始监听微信消息...");

  while (true) {
    try {
      reloadAccountIfChanged();
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      const isError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        consecutiveFailures++;
        logError(`getUpdates 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);

        const isAuthError = resp.errcode === 401 || resp.errcode === 403 || resp.errcode === -14
          || resp.ret === -1
          || (resp.errmsg ?? "").toLowerCase().includes("token")
          || (resp.errmsg ?? "").toLowerCase().includes("session");

        if (isAuthError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logError("Token 过期，启动重新登录...");
          const newAccount = await doQRLoginWithWebServer(baseUrl, profileName, paths.credentialsFile, log);
          if (newAccount) {
            token = newAccount.token;
            baseUrl = newAccount.baseUrl;
            setActiveAccount(newAccount);
            getUpdatesBuf = "";
            contextTokens.clear();
            try { fs.writeFileSync(paths.syncBufFile, "", "utf-8"); } catch {}
            consecutiveFailures = 0;
            log("Token 刷新完成");
            continue;
          }
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
        } else {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;
      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        try { fs.writeFileSync(paths.syncBufFile, getUpdatesBuf, "utf-8"); } catch {}
      }

      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;
        if (!msg.from_user_id) continue;

        const extracted = extractContent(msg);
        if (!extracted) continue;

        // Download media
        if (extracted.mediaItem) {
          const mi = extracted.mediaItem as Record<string, unknown>;
          const { encryptQueryParam, aesKeyBase64 } = resolveMediaDownloadInfo(mi);
          if (encryptQueryParam && aesKeyBase64) {
            const cdnUrl = buildCdnDownloadUrl(encryptQueryParam);
            let fileName = extracted.msgType === "file" && typeof mi.file_name === "string" ? mi.file_name
              : extracted.msgType === "image" ? "image.jpg"
              : extracted.msgType === "video" ? "video.mp4"
              : `media_${extracted.msgType}`;
            const localPath = await downloadMediaToFile(cdnUrl, aesKeyBase64, fileName, paths.mediaDir, log);
            if (localPath) {
              extracted.localPath = localPath;
              extracted.text = `[${extracted.msgType} 已保存到 ${localPath}]`;
            }
          }
        }

        // Hot-reload profile and check pause
        const profileConfig = loadProfileConfig(paths.profileConfigFile);
        if (isPaused(paths.pausedFile)) continue;

        const senderId = msg.from_user_id;
        const groupId = msg.group_id;
        const isGroup = Boolean(groupId);

        // Whitelist check
        const allowList = Array.isArray(profileConfig.allow_from) ? profileConfig.allow_from : [];
        if (allowList.length > 0) {
          const senderBare = senderId.split("@")[0] || senderId;
          const allowed = allowList.some(id => id === senderId || id === senderBare);
          if (!allowed) { log(`拒绝: ${senderId}`); continue; }
        }

        // Cache context token
        const contextKey = groupId ?? senderId;
        log(`context_token: ${msg.context_token ? "有(" + msg.context_token.slice(0, 20) + "...)" : "无"} key=${contextKey}`);
        if (msg.context_token) {
          contextTokens.set(contextKey, msg.context_token);
          if (isGroup) contextTokens.set(senderId, msg.context_token);
        } else {
          log(`消息缺少 context_token: from=${senderId}`);
        }

        const canReply = Boolean(contextTokens.get(contextKey));
        const senderShort = senderId.split("@")[0] || senderId;
        log(`收到${isGroup ? "群" : "私"}消息 [${extracted.msgType}]: from=${senderShort} can_reply=${canReply}`);

        // Track state
        try { fs.writeFileSync(paths.lastActivityFile, String(Date.now())); } catch {}
        if (canReply && msg.context_token) {
          onUserMessage(baseUrl, token, senderId, msg.context_token, contextKey);
        }

        // Dispatch to Claude
        const meta: Record<string, string> = {
          sender: senderShort,
          sender_id: isGroup ? (groupId as string) : senderId,
          msg_type: extracted.msgType,
          can_reply: String(canReply),
        };
        if (isGroup) {
          meta.is_group = "true";
          meta.group_id = groupId as string;
          meta.from_sender_id = senderId;
        }

        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: { content: extracted.text, meta },
          });
          mcpFailures = 0;
        } catch (mcpErr) {
          mcpFailures++;
          logError(`MCP 通知失败 (${mcpFailures}/3): ${mcpErr}`);
          if (mcpFailures >= 3) { logError("MCP 连接断开，退出。"); process.exit(1); }
        }
      }
    } catch (err) {
      consecutiveFailures++;
      logError(`轮询异常: ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
      } else {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
}
