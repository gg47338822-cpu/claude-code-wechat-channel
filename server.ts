/**
 * WeChat Channel MCP Server — entry point.
 * Bridges WeChat messages into Claude Code via the Channels MCP protocol.
 */

import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { CHANNEL_NAME, CHANNEL_VERSION, DEFAULT_BASE_URL, type AccountData } from "./src/types.js";
import { resolveProfileName, getProfilePaths, ensureDirectories, loadCredentials, loadProfileConfig, isPaused, acquireLock, releaseLock, cleanOldMedia, loadAllMemory } from "./src/profile.js";
import { sendTextMessage, sendImageMessage, sendFileMessage } from "./src/message.js";
import { doQRLogin, doQRLoginWithWebServer } from "./src/login.js";
import { ContextTokenCache, onBotReply } from "./src/state.js";
import { startPolling } from "./src/polling.js";

// ── Profile resolution ─────────────────────────────────────────────────────

const PROFILE_NAME = resolveProfileName();
const paths = getProfilePaths(PROFILE_NAME);
ensureDirectories(paths);
acquireLock(paths.pidFile);
process.on("exit", () => releaseLock(paths.pidFile));
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
      "## Step 2: Get user's WeChat ID (in terminal)",
      "After login succeeds, tell user in terminal:",
      "  WeChat connected! Now send me a message on WeChat so I can identify you.",
      "Wait for a <channel> notification. The sender_id is the user's WeChat ID. Remember it.",
      "",
      "## Step 3: Onboarding ON WECHAT (use wechat_reply tool for ALL replies)",
      "From here, talk to user ONLY through WeChat using `wechat_reply` tool.",
      "Do NOT type responses in terminal. Use wechat_reply for every message.",
      "",
      "3a. wechat_reply: Hi! I'm your WeChat assistant. What role should I play? (e.g. personal assistant, tutor, friend) And what language/style do you prefer?",
      "3b. After user answers, wechat_reply: Where should I store our conversation memory? Your home folder, or a specific project folder?",
      "3c. After user answers, wechat_reply: Got it. I'll only respond to messages from you. Want to add anyone else?",
      "",
      "## Step 4: Save config (silently)",
      `Write to: ${paths.profileConfigFile}`,
      '{"identity":"<from 3a>","rules":"<from 3a>","workdir":"<from 3b>","allow_from":["<sender_id from step 2>"]}',
      `Ensure dirs: ${paths.memoryDir}, ${paths.mediaDir}`,
      "",
      "## Step 5: Confirm on WeChat",
      "wechat_reply: All set! Just chat with me here from now on.",
      "In terminal: show config summary.",
      "",
      "## Rules",
      "- Steps 1-2: terminal. Steps 3-5: WeChat via wechat_reply.",
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
      // Start polling in background (don't await — let the tool return immediately)
      if (!pollingActive) {
        pollingActive = true;
        startPolling(account, {
          mcp, profileName: PROFILE_NAME, paths, contextTokens,
          setActiveAccount: (a) => { activeAccount = a; },
          log, logError,
        }).catch((err) => { logError(`❌ 消息接收异常，程序已退出: ${err}`); process.exit(1); });
      }
      return { content: [{ type: "text" as const, text: `登录成功！账号: ${account.accountId}，Profile: ${PROFILE_NAME}。微信消息监听已启动。` }] };
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
    return { content: [{ type: "text" as const, text: "error: sender_id is required" }] };
  }
  const ct = contextTokens.get(senderId);

  if (!ct) {
    return { content: [{ type: "text" as const, text: `❌ 无法回复 ${senderId}，请让对方先发一条消息` }] };
  }

  try {
    if (req.params.name === "wechat_reply") {
      const text = args.text;
      if (!text || typeof text !== "string") {
        return { content: [{ type: "text" as const, text: "error: text is required and must be a string" }] };
      }
      await sendTextMessage(baseUrl, token, senderId, text, ct);
      onBotReply(senderId);
      return { content: [{ type: "text" as const, text: "sent" }] };
    }
    if (req.params.name === "wechat_send_image" || req.params.name === "wechat_send_file") {
      const rawPath = args.file_path;
      if (!rawPath || typeof rawPath !== "string") {
        return { content: [{ type: "text" as const, text: "error: file_path is required" }] };
      }
      // Resolve symlinks to prevent path traversal
      let filePath: string;
      try {
        filePath = fs.realpathSync(path.resolve(rawPath));
      } catch {
        return { content: [{ type: "text" as const, text: `error: file not found: ${path.basename(rawPath)}` }] };
      }
      const allowedRoots = [process.cwd(), process.env.HOME || "", paths.mediaDir].filter(Boolean).map(p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
      if (!allowedRoots.some(root => filePath.startsWith(root + path.sep) || filePath === root)) {
        return { content: [{ type: "text" as const, text: "error: file path not allowed" }] };
      }
      const stat = fs.statSync(filePath);
      const maxSize = req.params.name === "wechat_send_image" ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
      if (stat.size > maxSize) return { content: [{ type: "text" as const, text: `error: file too large (max ${maxSize / 1024 / 1024}MB)` }] };
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
    return { content: [{ type: "text" as const, text: `failed: ${String(err)}` }] };
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Strip proxy vars for WeChat API (must be direct)
  for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    delete process.env[k];
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP 连接就绪");
  log(`Profile: ${PROFILE_NAME}`);
  log(`目录: ${paths.credentialsDir}`);

  const account = loadCredentials(paths.credentialsFile);
  if (!account) {
    log("未找到凭据，发送引导通知...");
    // Send a channel notification to trigger Claude's onboarding flow
    // (instructions alone are passive — Claude won't act until it sees a message)
    setTimeout(async () => {
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: "WeChat Channel 插件已加载，请开始引导用户完成首次设置。按 instructions 中的 Setup Flow 步骤进行。",
            meta: { sender: "system", sender_id: "system", msg_type: "setup", can_reply: "false" },
          },
        });
      } catch (err) {
        logError(`引导通知失败: ${err}`);
      }
    }, 1000);
    // Keep the process alive waiting for tool calls
    await new Promise(() => {});
  }

  log(`使用已保存账号: ${account.accountId}`);
  activeAccount = account;
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
