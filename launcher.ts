/**
 * Multi-instance launcher for wechat-channel v2.
 * Discovers profiles and spawns one Claude Code process per profile.
 *
 * Usage:
 *   npx tsx launcher.ts              # start all profiles
 *   npx tsx launcher.ts home legal   # start specific profiles
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

// ── Constants ─────────────────────────────────────────────────────────────

import os from "node:os";

const PROFILES_DIR = path.join(
  process.env.HOME || os.homedir(),
  ".claude",
  "channels",
  "wechat",
  "profiles",
);

// dist/launcher.js runs from dist/, so go up one level to find the package root (.claude-plugin/, skills/, etc.)
const PLUGIN_ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), "..");
const SHUTDOWN_TIMEOUT_MS = 10_000;

// ── Profile discovery ─────────────────────────────────────────────────────

interface ProfileConfig {
  workdir?: string;
  identity?: string;
  allow_from?: string[];
}

function discoverProfiles(): string[] {
  try {
    return fs.readdirSync(PROFILES_DIR).filter((name) => {
      const dir = path.join(PROFILES_DIR, name);
      const accountFile = path.join(dir, "account.json");
      return fs.statSync(dir).isDirectory() && fs.existsSync(accountFile);
    });
  } catch {
    return [];
  }
}

function loadProfileConfig(profileName: string): ProfileConfig {
  try {
    const configFile = path.join(PROFILES_DIR, profileName, "profile.json");
    if (!fs.existsSync(configFile)) return {};
    return JSON.parse(fs.readFileSync(configFile, "utf-8"));
  } catch {
    return {};
  }
}

// ── Claude path resolution ────────────────────────────────────────────────

function resolveClaudePath(): string {
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3000 }).trim();
    if (p) return p;
  } catch {}
  logError("未找到 claude 命令。请先安装 Claude Code: https://docs.anthropic.com/claude-code");
  process.exit(1);
}

// ── Process spawning ──────────────────────────────────────────────────────

interface ProfileState {
  proc: ChildProcess;
  name: string;
}

function startProfile(profileName: string, claudePath: string): ChildProcess {
  const config = loadProfileConfig(profileName);
  const workdir = config.workdir || process.cwd();

  const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const shellCmd = [
    `(sleep 3 && echo && sleep 3 && echo)`,
    `| ${esc(claudePath)}`,
    `--permission-mode bypassPermissions`,
    `--plugin-dir ${esc(PLUGIN_ROOT)}`,
  ].join(" ");

  // Strip proxy env vars — WeChat API must go direct
  const cleanEnv = { ...process.env };
  for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    delete cleanEnv[k];
  }

  const proc = spawn("bash", ["-c", shellCmd], {
    cwd: workdir,
    env: {
      ...cleanEnv,
      WECHAT_CHANNEL_PROFILE: profileName,
      CLAUDE_ROLE: profileName,
      ...(profileName !== "home" ? { CLAUDE_SANDBOX: "true" } : {}),
    },
    stdio: "inherit",
  });

  log(`${profileName} 已启动 (pid: ${proc.pid}, cwd: ${workdir})`);
  return proc;
}

// ── Logging ───────────────────────────────────────────────────────────────

function log(msg: string) { process.stderr.write(`[launcher] ${msg}\n`); }
function logError(msg: string) { process.stderr.write(`[launcher] ERROR: ${msg}\n`); }

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const claudePath = resolveClaudePath();
  log(`Claude 路径: ${claudePath}`);

  // Determine which profiles to start
  const allProfiles = discoverProfiles();

  // No profiles yet — launch Claude Code for first-time setup
  if (allProfiles.length === 0) {
    log("首次启动，进入引导模式...");
    const setupPrompt = [
      "你正在帮用户设置微信 Channel 插件。用中文，友好地一步步引导。",
      "",
      "步骤:",
      "1. 欢迎用户，简单介绍：这个插件让微信消息接入 Claude Code，别人在微信里给你发消息，你就能看到并回复。",
      "2. 问：你希望我在微信里扮演什么角色？（例：私人助手、技术顾问、英语老师）以及说话风格。",
      "3. 问：对话记忆存在哪里？全局目录还是某个项目文件夹？需要帮你新建吗？",
      "4. 问：需要限制谁可以发消息吗？（可选，不限制就跳过）",
      `5. 把配置写入 ~/.claude/channels/wechat/profiles/default/profile.json（JSON 格式，含 identity, rules, workdir, allow_from 字段）`,
      `6. 确保目录存在: ~/.claude/channels/wechat/profiles/default/memory/ 和 media/`,
      "7. 告诉用户：配置完成，现在连接微信。请确保微信是最新版。然后调用 wechat_login 工具。",
      "8. 扫码成功后恭喜用户，告诉他微信消息会出现在这个终端里。",
      "",
      "现在开始第 1 步。",
    ].join("\n");
    const proc = spawn(claudePath, [
      "--plugin-dir", PLUGIN_ROOT,
      "--append-system-prompt", setupPrompt,
      "开始设置微信",
    ], {
      stdio: "inherit",
      env: { ...process.env, WECHAT_CHANNEL_PROFILE: "default" },
    });
    proc.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const profilesToStart = args.length > 0
    ? args.filter((name) => {
        if (!allProfiles.includes(name)) {
          logError(`profile "${name}" 不存在，跳过`);
          return false;
        }
        return true;
      })
    : allProfiles;

  if (profilesToStart.length === 0) {
    logError("没有可启动的 profile");
    process.exit(1);
  }

  log(`发现 ${allProfiles.length} 个 profile，启动 ${profilesToStart.length} 个: ${profilesToStart.join(", ")}`);

  // Launch all profiles
  const states = new Map<string, ProfileState>();

  for (const name of profilesToStart) {
    const proc = startProfile(name, claudePath);
    states.set(name, { proc, name });

    proc.on("exit", (code) => {
      log(`${name} 已退出 (code: ${code})`);
      states.delete(name);
      if (states.size === 0 && !shuttingDown) {
        log("所有 profile 已退出");
        process.exit(0);
      }
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
    for (const [name, state] of states) {
      log(`停止 ${name} (pid: ${state.proc.pid})`);
      state.proc.kill("SIGTERM");
      state.proc.on("exit", () => {
        remaining--;
        if (remaining <= 0) process.exit(0);
      });
    }

    setTimeout(() => {
      logError("子进程未在 10 秒内退出，强制退出");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
