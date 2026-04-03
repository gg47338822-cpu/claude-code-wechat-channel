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
 * Ensure .mcp.json in a directory contains the wechat MCP server entry.
 * Merges into existing config — never overwrites other servers.
 * Uses local dist path instead of npx for speed and consistency.
 */
function ensureMcpConfig(dir: string): void {
  const mcpFile = path.join(dir, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    if (fs.existsSync(mcpFile)) {
      config = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
    }
  } catch { /* corrupted file, start fresh */ }

  if (!config.mcpServers) config.mcpServers = {};

  const serverJsPath = path.join(PLUGIN_ROOT, "dist", "server.js");
  const wechatConfig = fs.existsSync(serverJsPath)
    ? { command: "node", args: [serverJsPath] }
    : { command: "npx", args: ["-y", "gg47338822-cpu/claude-code-wechat-channel", "start"] };

  // Only write if wechat entry is missing or different
  const existing = JSON.stringify((config.mcpServers as Record<string, unknown>).wechat ?? null);
  const desired = JSON.stringify(wechatConfig);
  if (existing !== desired) {
    (config.mcpServers as Record<string, unknown>).wechat = wechatConfig;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2));
    log(`.mcp.json 已更新: ${mcpFile}`);
  }
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
  const setupNew = process.env.WECHAT_SETUP_NEW;

  // ── Setup mode: first time or "wechat-channel new [name]" ──
  if (allProfiles.length === 0 || setupNew !== undefined) {
    const profileName = setupNew || "default";
    const autoName = profileName || `wechat-${allProfiles.length + 1}`;
    log(`设置新 profile: ${autoName}`);

    const setupDir = path.join(HOME, ".claude", "channels", "wechat");

    const proc = launchClaude(claudePath, setupDir, {
      WECHAT_CHANNEL_PROFILE: autoName,
    });
    proc.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // ── Run single profile: "wechat-channel run work" ──
  const runProfile = process.env.WECHAT_RUN_PROFILE;
  if (runProfile !== undefined) {
    const name = runProfile;
    if (!name) {
      logError(`用法: wechat-channel run <profile名>\n可用: ${allProfiles.join(", ")}`);
      process.exit(1);
    }
    if (!allProfiles.includes(name)) {
      logError(`profile "${name}" 不存在。可用: ${allProfiles.join(", ")}`);
      process.exit(1);
    }
    log(`启动 profile: ${name}`);
    const config = loadProfileConfig(name);
    const workdir = config.workdir || process.cwd();
    const proc = launchClaude(claudePath, workdir, {
      WECHAT_CHANNEL_PROFILE: name,
      CLAUDE_ROLE: name,
    });
    proc.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // ── Normal mode: launch all profiles ──
  const profilesToStart = allProfiles;

  if (profilesToStart.length === 0) { logError("没有可启动的 profile"); process.exit(1); }

  log(`启动 ${profilesToStart.length} 个 profile: ${profilesToStart.join(", ")}`);

  const states = new Map<string, ChildProcess>();

  for (const name of profilesToStart) {
    const config = loadProfileConfig(name);
    const workdir = config.workdir || process.cwd();

    const proc = launchClaude(claudePath, workdir, {
      WECHAT_CHANNEL_PROFILE: name,
      CLAUDE_ROLE: name,
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
