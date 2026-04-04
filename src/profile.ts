/**
 * Multi-instance Profile management.
 * Resolves profile by cwd or env var, loads/saves credentials and config.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountData, ProfileConfig } from "./types.js";

const CHANNELS_BASE = path.join(
  process.env.HOME || os.homedir(),
  ".claude",
  "channels",
  "wechat",
);

export function resolveProfileName(): string {
  const cwd = process.cwd();
  const profilesDir = path.join(CHANNELS_BASE, "profiles");
  try {
    for (const name of fs.readdirSync(profilesDir)) {
      const configFile = path.join(profilesDir, name, "profile.json");
      if (!fs.existsSync(configFile)) continue;
      try {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
        if (config.workdir && path.resolve(config.workdir) === path.resolve(cwd)) {
          return name;
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }

  if (process.env.WECHAT_CHANNEL_PROFILE) {
    return process.env.WECHAT_CHANNEL_PROFILE;
  }
  return "default";
}

export function getProfilePaths(profileName: string) {
  const credentialsDir = path.join(CHANNELS_BASE, "profiles", profileName);
  return {
    credentialsDir,
    credentialsFile: path.join(credentialsDir, "account.json"),
    profileConfigFile: path.join(credentialsDir, "profile.json"),
    memoryDir: path.join(credentialsDir, "memory"),
    mediaDir: path.join(credentialsDir, "media"),
    pidFile: path.join(credentialsDir, "channel.pid"),
    syncBufFile: path.join(credentialsDir, "sync_buf.txt"),
    contextTokenFile: path.join(credentialsDir, "context_tokens.json"),
    pausedFile: path.join(credentialsDir, "paused"),
    lastActivityFile: path.join(credentialsDir, "last_activity.txt"),
  };
}

export function ensureDirectories(paths: ReturnType<typeof getProfilePaths>): void {
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  fs.mkdirSync(paths.mediaDir, { recursive: true });
}

export function loadCredentials(filePath: string): AccountData | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function saveCredentials(filePath: string, data: AccountData): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

export function loadProfileConfig(filePath: string): ProfileConfig {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

export function isPaused(pausedFile: string): boolean {
  return fs.existsSync(pausedFile);
}

// ── Process lock ───────────────────────────────────────────────────────────

export function acquireLock(pidFile: string): void {
  try {
    const existing = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(existing, 10);
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        process.stderr.write(
          `❌ 微信插件已经在运行中（进程号: ${pid}）\n` +
          `   👉 如果要重新启动，请先运行: kill ${pid}\n` +
          `   👉 如果确认没有在运行，请删除锁文件: rm ${pidFile}\n`
        );
        process.exit(1);
      } catch {
        // Process not running — stale lock, clean it up
        process.stderr.write(`[wechat] 发现残留锁文件（进程 ${pid} 已不存在），已自动清理\n`);
      }
    }
  } catch { /* no lock file */ }
  fs.writeFileSync(pidFile, String(process.pid), "utf-8");
}

export function releaseLock(pidFile: string): void {
  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(pidFile);
  } catch { /* best-effort */ }
}

// ── Media cleanup ──────────────────────────────────────────────────────────

const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cleanOldMedia(mediaDir: string): void {
  try {
    for (const f of fs.readdirSync(mediaDir)) {
      const fp = path.join(mediaDir, f);
      const stat = fs.statSync(fp);
      if (Date.now() - stat.mtimeMs > MEDIA_MAX_AGE_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch { /* best-effort */ }
}

// ── Memory loading ─────────────────────────────────────────────────────────

function getNativeMemoryDir(workdir: string): string {
  const encoded = workdir.replace(/\//g, "-");
  return path.join(process.env.HOME || "~", ".claude", "projects", encoded, "memory");
}

function loadMemoryFromDir(dir: string, label: string): string {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".md") || f.endsWith(".txt"))
      .sort();
    if (files.length === 0) return "";
    const sections = files.map(f => {
      const content = fs.readFileSync(path.join(dir, f), "utf-8").trim();
      if (!content) return "";
      return `--- ${f} ---\n${content}`;
    }).filter(Boolean);
    if (sections.length === 0) return "";
    return `\n${label} (from ${dir}):\n${sections.join("\n\n")}`;
  } catch {
    return "";
  }
}

export function loadAllMemory(memoryDir: string, workdir: string): string {
  const parts: string[] = [];
  const channelMem = loadMemoryFromDir(memoryDir, "Channel memory");
  if (channelMem) parts.push(channelMem);

  const nativeDir = getNativeMemoryDir(workdir);
  if (nativeDir !== memoryDir) {
    const nativeMem = loadMemoryFromDir(nativeDir, "Native CC memory");
    if (nativeMem) parts.push(nativeMem);
  }
  return parts.join("\n");
}
