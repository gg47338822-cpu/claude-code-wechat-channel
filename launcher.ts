/**
 * Multi-instance launcher for wechat-channel v2.
 * Discovers profiles and spawns one Claude Code process per profile.
 *
 * Usage:
 *   wechat-channel              # start all profiles (or first-time setup)
 *   wechat-channel home legal   # start specific profiles
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

// ── Constants ─────────────────────────────────────────────────────────────

const HOME = process.env.HOME || os.homedir();
const PROFILES_DIR = path.join(HOME, ".claude", "channels", "wechat", "profiles");
const PLUGIN_ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), "..");
const SHUTDOWN_TIMEOUT_MS = 10_000;

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg: string) { process.stderr.write(`[launcher] ${msg}\n`); }
function logError(msg: string) { process.stderr.write(`[launcher] ERROR: ${msg}\n`); }

function resolveClaudePath(): string {
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3000 }).trim();
    if (p) return p;
  } catch {}
  logError("未找到 claude 命令。请先安装 Claude Code: https://docs.anthropic.com/claude-code");
  process.exit(1);
}

function discoverProfiles(): string[] {
  try {
    return fs.readdirSync(PROFILES_DIR).filter((name) => {
      const dir = path.join(PROFILES_DIR, name);
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "account.json"));
    });
  } catch {
    return [];
  }
}

function loadProfileConfig(profileName: string): { workdir?: string } {
  try {
    const f = path.join(PROFILES_DIR, profileName, "profile.json");
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Write .mcp.json into a directory so Claude Code auto-discovers the wechat MCP server.
 * Uses npx to resolve the package — works after npm install -g.
 */
function ensureMcpConfig(dir: string): void {
  const mcpFile = path.join(dir, ".mcp.json");
  const config = {
    mcpServers: {
      wechat: { command: "npx", args: ["-y", "@xiaoyifu_0000/wechat-channel", "start"] },
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2));
}

// ── Launch a single profile ───────────────────────────────────────────────

function launchClaude(claudePath: string, cwd: string, env: Record<string, string>, extraArgs: string[] = []): ChildProcess {
  // Write .mcp.json into cwd so Claude Code finds the wechat server
  ensureMcpConfig(cwd);

  // Don't strip proxy vars here — Claude Code needs them for Anthropic API.
  // server.ts strips proxy vars in its own main() for WeChat API calls.

  return spawn(claudePath, [
    "--dangerously-load-development-channels", "server:wechat",
    ...extraArgs,
  ], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const claudePath = resolveClaudePath();
  log(`Claude: ${claudePath}`);
  log(`Plugin: ${PLUGIN_ROOT}`);

  const allProfiles = discoverProfiles();

  // ── First-time setup ──
  if (allProfiles.length === 0) {
    log("首次启动，进入引导模式...");

    const setupDir = path.join(HOME, ".claude", "channels", "wechat");
    const setupPrompt = [
      "你正在帮用户设置微信 Channel 插件。用中文，友好地一步步引导。",
      "",
      "步骤:",
      "1. 欢迎用户，简单介绍：这个插件让微信消息接入 Claude Code，别人在微信里给你发消息，你就能看到并回复。",
      "2. 问：你希望我在微信里扮演什么角色？（例：私人助手、技术顾问、英语老师）以及说话风格。",
      "3. 问：对话记忆存在哪里？全局目录还是某个项目文件夹？需要帮你新建吗？",
      "4. 问：需要限制谁可以发消息吗？（可选，不限制就跳过）",
      "5. 把配置写入 ~/.claude/channels/wechat/profiles/default/profile.json",
      "6. 确保目录存在: ~/.claude/channels/wechat/profiles/default/memory/ 和 media/",
      "7. 告诉用户：配置完成，现在连接微信。请确保微信是最新版。然后调用 wechat_login 工具。",
      "8. 扫码成功后恭喜用户，告诉他微信消息会出现在这个终端里。",
      "",
      "现在开始第 1 步。",
    ].join("\n");

    const proc = launchClaude(claudePath, setupDir, {
      WECHAT_CHANNEL_PROFILE: "default",
    });
    proc.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // ── Normal mode: launch profiles ──
  const profilesToStart = args.length > 0
    ? args.filter((name) => {
        if (!allProfiles.includes(name)) { logError(`profile "${name}" 不存在，跳过`); return false; }
        return true;
      })
    : allProfiles;

  if (profilesToStart.length === 0) { logError("没有可启动的 profile"); process.exit(1); }

  log(`启动 ${profilesToStart.length} 个 profile: ${profilesToStart.join(", ")}`);

  const states = new Map<string, ChildProcess>();

  for (const name of profilesToStart) {
    const config = loadProfileConfig(name);
    const workdir = config.workdir || process.cwd();

    const proc = launchClaude(claudePath, workdir, {
      WECHAT_CHANNEL_PROFILE: name,
      CLAUDE_ROLE: name,
      ...(name !== "home" ? { CLAUDE_SANDBOX: "true" } : {}),
    });

    log(`${name} 已启动 (pid: ${proc.pid}, cwd: ${workdir})`);
    states.set(name, proc);

    proc.on("exit", (code) => {
      log(`${name} 已退出 (code: ${code})`);
      states.delete(name);
      if (states.size === 0 && !shuttingDown) { log("所有 profile 已退出"); process.exit(0); }
    });
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`正在停止 ${states.size} 个 profile...`);
    if (states.size === 0) process.exit(0);
    let remaining = states.size;
    for (const [name, proc] of states) {
      proc.kill("SIGTERM");
      proc.on("exit", () => { if (--remaining <= 0) process.exit(0); });
    }
    setTimeout(() => { logError("强制退出"); process.exit(1); }, SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
