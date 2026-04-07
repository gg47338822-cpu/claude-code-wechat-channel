/**
 * WeChat Channel MCP Server — entry point.
 * Bridges WeChat messages into Claude Code via the Channels MCP protocol.
 */

import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { CHANNEL_NAME, CHANNEL_VERSION, DEFAULT_BASE_URL, type AccountData, type ProfileConfig } from "./src/types.js";
import { resolveProfileName, getProfilePaths, ensureDirectories, loadCredentials, loadProfileConfig, isPaused, acquireLock, releaseLock, cleanOldMedia, loadAllMemory } from "./src/profile.js";
import { sendTextMessage, sendImageMessage, sendFileMessage } from "./src/message.js";
import { doQRLogin, doQRLoginWithWebServer } from "./src/login.js";
import { ContextTokenCache, onBotReply } from "./src/state.js";
import { startPolling } from "./src/polling.js";
import { startMailboxWatcher } from "./src/mailbox.js";
import { initSessionContext, recordOutgoing, stopSessionContext, loadSessionContext } from "./src/session-context.js";

// ── Profile resolution ─────────────────────────────────────────────────────

const PROFILE_NAME = resolveProfileName();
const paths = getProfilePaths(PROFILE_NAME);
ensureDirectories(paths);
const lockResult = acquireLock(paths.pidFile);
process.on("exit", () => {
  stopSessionContext();
  releaseLock(paths.pidFile);
});
cleanOldMedia(paths.mediaDir);

const contextTokens = new ContextTokenCache(paths.contextTokenFile);

function log(msg: string) { process.stderr.write(`[wechat:${PROFILE_NAME}] ${msg}\n`); }
function logError(msg: string) { process.stderr.write(`[wechat:${PROFILE_NAME}] ERROR: ${msg}\n`); }

// ── Instructions builder ───────────────────────────────────────────────────

function buildInstructions(): string {
  const profileConfig = loadProfileConfig(paths.profileConfigFile);
  const hasCredentials = fs.existsSync(paths.credentialsFile);
  const parts: string[] = [];

  // ── First-time setup guide (no credentials yet) ──
  if (!hasCredentials) {
    parts.push(
      "# WeChat Channel -- First-Time Setup",
      "",
      "No WeChat account connected yet.",
      "",
      "## Step 1: Connect WeChat (in terminal)",
      "Tell user: scanning QR code to connect WeChat...",
      "IMMEDIATELY call `wechat_login` tool. Browser opens QR page.",
      "Tell user: please scan with WeChat app.",
      "",
      "## Step 2: Onboarding ON WECHAT (use wechat_reply tool for ALL replies)",
      "After login succeeds, the scanned user's WeChat ID is automatically added to the allow list.",
      "From here, talk to user ONLY through WeChat using `wechat_reply` tool.",
      "Do NOT type responses in terminal. Use wechat_reply for every message.",
      "",
      "2a. wechat_reply: Hi! I'm your WeChat assistant. What role should I play? (e.g. personal assistant, tutor, friend) And what language/style do you prefer?",
      "2b. After user answers, wechat_reply: Where should I store our conversation memory? Your home folder, or a specific project folder?",
      "2c. After user answers, wechat_reply: Got it. I'll only respond to messages from you. Want to add anyone else?",
      "",
      "## Step 3: Save config (silently)",
      `Write to: ${paths.profileConfigFile}`,
      `The allow_from already contains the user's ID from login. Add identity, rules, workdir from the conversation.`,
      `Ensure dirs: ${paths.memoryDir}, ${paths.mediaDir}`,
      "",
      "## Step 4: Confirm on WeChat",
      "wechat_reply: All set! Just chat with me here from now on.",
      "In terminal: show config summary.",
      "",
      "## Rules",
      "- Step 1: terminal. Steps 2-4: WeChat via wechat_reply.",
      "- All WeChat messages must be plain text, no markdown.",
      "- Speak Chinese. Be warm and concise.",
    );
    return parts.join("\n");
  }

  // ── Normal operation (already connected) ──

  if (profileConfig.identity) {
    parts.push(`## Your Identity\n${profileConfig.identity}\n`);
  }
  if (profileConfig.rules) {
    parts.push(`## Behavior Rules (MUST follow)\n${profileConfig.rules}\n`);
  }

  parts.push(
    "Messages from WeChat users arrive as <channel source=\"wechat\" ...> tags.",
    "",
    `Active profile: "${PROFILE_NAME}"`,
    `Profile directory: ${paths.credentialsDir}`,
    `Memory directory: ${paths.memoryDir}`,
    "",
    "## WeChat Protocol",
    "",
    "Tag attributes:",
    "  sender       — display name (xxx part of xxx@im.wechat)",
    "  sender_id    — full user ID (xxx@im.wechat) — REQUIRED for all reply tools",
    "  msg_type     — text | voice | image | file | video | unknown",
    "  can_reply    — 'true': reply normally; 'false': no session token, tell the user to send another message",
    "  is_group     — 'true' if from a group chat",
    "  group_id     — group ID when is_group=true (use this as the reply target in groups)",
    "",
    "Tools available:",
    "  wechat_reply        — send a plain-text reply (always available)",
    "  wechat_send_image   — send an image file from local disk (provide absolute path)",
    "  wechat_send_file    — send a file from local disk (documents, PDFs, etc.)",
    "",
    "Rules:",
    "  - If can_reply=false, do NOT call wechat_reply. Instead output: 'NOTICE: cannot reply, session token missing. User must send one more message.'",
    "  - Otherwise always use wechat_reply or wechat_send_image — never leave a message unanswered.",
    "  - In group chats (is_group=true), pass the group_id as sender_id to reply to the group.",
    "  - Strip all markdown — WeChat renders plain text only.",
    "  - Keep replies concise. WeChat is a chat app.",
    "  - Default language is Chinese unless the user writes in another language.",
    "  - For voice messages the transcript is already in the content — treat it as text.",
    "  - For image/file messages: they are auto-downloaded to local disk. The message text contains the local path — use Read tool to view images or process files.",
    "",
    "## Memory System (Critical)",
    "",
    "You have a persistent memory system. Session may restart at any time — memory is your only continuity.",
    "",
    "### On startup (NOW):",
    `1. Read all files in ${paths.memoryDir} — this is your memory from previous sessions.`,
    "2. Greet the user based on what you remember, not as a stranger.",
    "",
    "### During conversation:",
    "- After each meaningful exchange, write a brief summary to memory.",
    `  File: ${paths.memoryDir}/对话记录.md (append, newest first)`,
    "- If the user mentions past events, check memory files first.",
  );

  const memory = loadAllMemory(paths.memoryDir, loadProfileConfig(paths.profileConfigFile).workdir || process.env.HOME || "/");
  if (memory) parts.push("", memory);

  // Inject previous session context (survives restarts)
  const prevContext = loadSessionContext(paths.sessionSnapshotFile, paths.lastSessionFile, paths.historySnapshotFile);
  if (prevContext) {
    parts.push(
      "",
      "## Previous Session Context (IMPORTANT — read this to continue where you left off)",
      "",
      prevContext,
    );
  }

  return parts.join("\n");
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: CHANNEL_NAME, version: CHANNEL_VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: buildInstructions(),
  },
);

// ── Tool handlers ──────────────────────────────────────────────────────────

let activeAccount: AccountData | null = null;
let pollingActive = false;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_reply",
      description: "Send a plain-text reply to the WeChat user (or group)",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: { type: "string", description: "sender_id from the inbound tag. In group chats use group_id." },
          text: { type: "string", description: "Plain-text message (no markdown)" },
        },
        required: ["sender_id", "text"],
      },
    },
    {
      name: "wechat_send_image",
      description: "Send a local image file to the WeChat user",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: { type: "string", description: "Same as wechat_reply sender_id" },
          file_path: { type: "string", description: "Absolute path to image file (PNG, JPG)" },
        },
        required: ["sender_id", "file_path"],
      },
    },
    {
      name: "wechat_send_file",
      description: "Send a local file to the WeChat user (documents, PDFs, etc.)",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: { type: "string", description: "Same as wechat_reply sender_id" },
          file_path: { type: "string", description: "Absolute path to the file" },
        },
        required: ["sender_id", "file_path"],
      },
    },
    {
      name: "wechat_login",
      description: "Start QR code login flow to connect a WeChat account. Opens a web page with the QR code for scanning.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "wechat_status",
      description: "Check current WeChat connection status — profile name, login state, last activity.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  // Tools that don't require active account
  if (req.params.name === "wechat_login") {
    log("收到登录请求，启动扫码...");
    const account = await doQRLoginWithWebServer(DEFAULT_BASE_URL, PROFILE_NAME, paths.credentialsFile, log);
    if (account) {
      activeAccount = account;

      // Auto-set allow_from from scanned user's ID
      if (account.userId) {
        const config = loadProfileConfig(paths.profileConfigFile);
        const allowList = config.allow_from ?? [];
        if (!allowList.includes(account.userId)) {
          config.allow_from = [account.userId, ...allowList];
          fs.writeFileSync(paths.profileConfigFile, JSON.stringify(config, null, 2), "utf-8");
          log(`白名单已自动添加扫码用户: ${account.userId}`);
        }
      }

      // Start polling in background (don't await — let the tool return immediately)
      if (!pollingActive) {
        pollingActive = true;
        const config = loadProfileConfig(paths.profileConfigFile);
        startMailboxWatcher(() => activeAccount, contextTokens, config.allow_from?.[0] ?? null, log, PROFILE_NAME);
        startPolling(account, {
          mcp, profileName: PROFILE_NAME, paths, contextTokens,
          setActiveAccount: (a) => { activeAccount = a; },
          log, logError,
        }).catch((err) => { logError(`❌ 消息接收异常，程序已退出: ${err}`); process.exit(1); });
      }
      return { content: [{ type: "text" as const, text: `登录成功！账号: ${account.accountId}，Profile: ${PROFILE_NAME}。微信消息监听已启动。扫码用户已自动加入白名单。` }] };
    }
    return { content: [{ type: "text" as const, text: "登录失败或超时。请重试。" }] };
  }

  if (req.params.name === "wechat_status") {
    const lastActivity = (() => {
      try { return fs.readFileSync(paths.lastActivityFile, "utf-8").trim(); } catch { return null; }
    })();
    const status = {
      profile: PROFILE_NAME,
      logged_in: Boolean(activeAccount),
      account_id: activeAccount?.accountId ?? null,
      paused: isPaused(paths.pausedFile),
      last_activity: lastActivity ? new Date(Number(lastActivity)).toISOString() : null,
      profile_dir: paths.credentialsDir,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
  }

  if (!activeAccount) return { content: [{ type: "text" as const, text: "❌ 未登录微信，请先调用 wechat_login 扫码连接" }] };

  const { baseUrl, token } = activeAccount;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const senderId = args.sender_id;
  if (!senderId || typeof senderId !== "string") {
    return { content: [{ type: "text" as const, text: "❌ 缺少 sender_id 参数" }] };
  }
  const ct = contextTokens.get(senderId);

  if (!ct) {
    return { content: [{ type: "text" as const, text: `❌ 无法回复 ${senderId}，请让对方先发一条消息` }] };
  }

  try {
    if (req.params.name === "wechat_reply") {
      const text = args.text;
      if (!text || typeof text !== "string") {
        return { content: [{ type: "text" as const, text: "❌ 缺少 text 参数" }] };
      }
      await sendTextMessage(baseUrl, token, senderId, text, ct);
      onBotReply(senderId);
      recordOutgoing(senderId.split("@")[0] || senderId, text);
      return { content: [{ type: "text" as const, text: "sent" }] };
    }
    if (req.params.name === "wechat_send_image" || req.params.name === "wechat_send_file") {
      const rawPath = args.file_path;
      if (!rawPath || typeof rawPath !== "string") {
        return { content: [{ type: "text" as const, text: "❌ 缺少 file_path 参数" }] };
      }
      // Resolve symlinks to prevent path traversal
      let filePath: string;
      try {
        filePath = fs.realpathSync(path.resolve(rawPath));
      } catch {
        return { content: [{ type: "text" as const, text: `❌ 文件不存在: ${path.basename(rawPath)}` }] };
      }
      const allowedRoots = [process.cwd(), process.env.HOME || "", paths.mediaDir].filter(Boolean).map(p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
      if (!allowedRoots.some(root => filePath.startsWith(root + path.sep) || filePath === root)) {
        return { content: [{ type: "text" as const, text: "❌ 文件路径不在允许范围内" }] };
      }
      const stat = fs.statSync(filePath);
      const maxSize = req.params.name === "wechat_send_image" ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
      if (stat.size > maxSize) return { content: [{ type: "text" as const, text: `❌ 文件太大（最大 ${maxSize / 1024 / 1024}MB）` }] };
      const buf = fs.readFileSync(filePath);
      if (req.params.name === "wechat_send_image") {
        await sendImageMessage(baseUrl, token, senderId, buf, ct);
      } else {
        await sendFileMessage(baseUrl, token, senderId, buf, path.basename(filePath), ct);
      }
      onBotReply(senderId);
      return { content: [{ type: "text" as const, text: `file sent: ${path.basename(rawPath)}` }] };
    }
  } catch (err) {
    return { content: [{ type: "text" as const, text: `❌ 发送失败: ${String(err)}` }] };
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Strip proxy vars for WeChat API (must be direct)
  for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    delete process.env[k];
  }

  // Login-only mode: launcher调用，只做扫码登录然后退出
  if (process.env.WECHAT_LOGIN_ONLY === "1") {
    log("扫码登录模式...");
    const account = await doQRLoginWithWebServer(DEFAULT_BASE_URL, PROFILE_NAME, paths.credentialsFile, log);
    if (!account) {
      log("登录失败或超时。");
      process.exit(1);
    }
    log(`登录成功！账号: ${account.accountId}`);

    // 自动加白名单
    if (account.userId) {
      const config = loadProfileConfig(paths.profileConfigFile);
      const allowList = config.allow_from ?? [];
      if (!allowList.includes(account.userId)) {
        config.allow_from = [account.userId, ...allowList];
        fs.writeFileSync(paths.profileConfigFile, JSON.stringify(config, null, 2), "utf-8");
        log(`白名单已自动添加扫码用户: ${account.userId}`);
      }
    }
    process.exit(0);
  }

  await mcp.connect(new StdioServerTransport());

  // ── Startup summary ──
  if (lockResult.recovered) {
    log(`⚠ 上次未正常退出（进程 ${lockResult.stalePid} 已不存在），已自动恢复`);
  }
  let account = loadCredentials(paths.credentialsFile);
  const lastActivity = (() => {
    try { return fs.readFileSync(paths.lastActivityFile, "utf-8").trim(); } catch { return null; }
  })();
  const profileConfig = loadProfileConfig(paths.profileConfigFile);
  const summaryParts = [
    `v${CHANNEL_VERSION}`,
    `Profile: ${PROFILE_NAME}`,
    account ? `账号: ${account.accountId}` : "未登录",
    lastActivity ? `上次活动: ${new Date(Number(lastActivity)).toLocaleString("zh-CN")}` : null,
    profileConfig.allow_from?.length ? `白名单: ${profileConfig.allow_from.length}人` : null,
  ].filter(Boolean);
  log(summaryParts.join(" | "));

  if (!account) {
    log("未找到凭据。请运行 wechat-channel new <名字> 创建profile并扫码登录。");
    // 通知Claude未登录
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: "微信未连接。请退出后运行 wechat-channel new <名字> 完成扫码登录。",
          meta: { sender: "system", sender_id: "system", msg_type: "setup", can_reply: "false" },
        },
      });
    } catch {}
    // 保持进程活着等待wechat_login工具调用（用户也可以手动/access login）
    await new Promise(() => {});
  }

  log(`使用已保存账号: ${account.accountId}`);
  activeAccount = account;

  // Init session context tracking
  initSessionContext({
    snapshotFile: paths.sessionSnapshotFile,
    lastSessionFile: paths.lastSessionFile,
    profile: PROFILE_NAME,
  });

  // Start mailbox watcher (forwards分身notifications to Jason's WeChat)
  const mailboxRecipient = profileConfig.allow_from?.[0] ?? null;
  startMailboxWatcher(() => activeAccount, contextTokens, mailboxRecipient, log, PROFILE_NAME);

  await startPolling(account, {
    mcp,
    profileName: PROFILE_NAME,
    paths,
    contextTokens,
    setActiveAccount: (a) => { activeAccount = a; },
    log,
    logError,
  });
}

main().catch((err) => { logError(`Fatal: ${String(err)}`); process.exit(1); });
