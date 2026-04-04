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

// ── Old package names (for migration) ────────────────────────────────────

const OLD_PACKAGE_NAMES = [
  "@xiaoyifu_0000/wechat-channel",
];

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg: string) { process.stderr.write(`[launcher] ${msg}\n`); }
function logError(msg: string) { process.stderr.write(`[launcher] ERROR: ${msg}\n`); }

/**
 * Pre-flight environment checks. Prints human-readable errors and exits
 * if critical dependencies are missing.
 */
function preflight(): void {
  const errors: string[] = [];

  // Node.js version check
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    errors.push(
      `❌ Node.js 版本太低（当前 v${process.versions.node}，需要 v18 以上）`,
      `   👉 去 https://nodejs.org 下载最新版`,
    );
  }

  // Claude Code existence check
  let claudeFound = false;
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3000 }).trim();
    if (p) claudeFound = true;
  } catch {}
  if (!claudeFound) {
    errors.push(
      `❌ 未检测到 Claude Code`,
      `   👉 安装: npm install -g @anthropic-ai/claude-code`,
    );
  }

  if (errors.length > 0) {
    process.stderr.write("\n环境检查未通过:\n\n");
    for (const line of errors) process.stderr.write(`${line}\n`);
    process.stderr.write("\n");
    process.exit(1);
  }
}

function resolveClaudePath(): string {
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3000 }).trim();
    if (p) return p;
  } catch {}
  // Should not reach here after preflight, but keep as safeguard
  logError("未找到 claude 命令");
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
 * Migrate old package names in a .mcp.json file.
 * Returns true if any migration was performed.
 */
function migrateOldPackageNames(mcpFile: string): boolean {
  try {
    if (!fs.existsSync(mcpFile)) return false;
    const raw = fs.readFileSync(mcpFile, "utf-8");
    const config = JSON.parse(raw);
    if (!config.mcpServers) return false;

    let migrated = false;
    const servers = config.mcpServers as Record<string, { command?: string; args?: string[] }>;

    for (const [key, value] of Object.entries(servers)) {
      if (!value?.args) continue;
      const argsStr = value.args.join(" ");
      for (const oldName of OLD_PACKAGE_NAMES) {
        if (argsStr.includes(oldName)) {
          // Remove the old entry; ensureMcpConfig will add the correct one
          delete servers[key];
          log(`迁移: ${mcpFile} 中移除旧包名 "${oldName}" (key: ${key})`);
          migrated = true;
          break;
        }
      }
    }

    if (migrated) {
      fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2));
    }
    return migrated;
  } catch {
    return false;
  }
}

/**
 * Scan common .mcp.json locations for old package names and migrate them.
 */
function migrateAllMcpConfigs(): void {
  const locations = new Set<string>();

  // Home directory
  locations.add(path.join(HOME, ".mcp.json"));

  // All profile workdirs
  for (const name of discoverProfiles()) {
    const config = loadProfileConfig(name);
    if (config.workdir) {
      locations.add(path.join(config.workdir, ".mcp.json"));
    }
  }

  // Wechat channel directory
  locations.add(path.join(HOME, ".claude", "channels", "wechat", ".mcp.json"));

  let total = 0;
  for (const loc of locations) {
    if (migrateOldPackageNames(loc)) total++;
  }
  if (total > 0) {
    log(`已迁移 ${total} 个 .mcp.json 文件中的旧包名`);
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
  } catch {
    // Corrupted file — backup before overwriting
    try {
      fs.copyFileSync(mcpFile, `${mcpFile}.bak`);
      log(`⚠️ ${mcpFile} 格式损坏，已备份为 .mcp.json.bak`);
    } catch {}
  }

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
  preflight();

  const args = process.argv.slice(2);
  const claudePath = resolveClaudePath();
  log(`Claude: ${claudePath}`);
  log(`Plugin: ${PLUGIN_ROOT}`);

  // Migrate old package names before anything else
  migrateAllMcpConfigs();

  // Upgrade-only mode: just run migration and exit
  if (process.env.WECHAT_UPGRADE_ONLY === "1") {
    log("升级检查完成");
    process.exit(0);
  }

  const allProfiles = discoverProfiles();
  const setupNew = process.env.WECHAT_SETUP_NEW;

  // ── Setup mode: first time or "wechat-channel new [name]" ──
  if (allProfiles.length === 0 || setupNew !== undefined) {
    const profileName = setupNew || "default";
    const autoName = profileName || `wechat-${allProfiles.length + 1}`;

    // Prevent silent overwrite of existing profile
    if (allProfiles.includes(autoName)) {
      logError(
        `profile "${autoName}" 已存在，不能覆盖。\n` +
        `   👉 用新名字: wechat-channel new <其他名字>\n` +
        `   👉 如要删除旧的: rm -rf ${path.join(PROFILES_DIR, autoName)}`
      );
      process.exit(1);
    }

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
