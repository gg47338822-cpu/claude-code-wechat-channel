#!/usr/bin/env npx tsx
/**
 * WeChat Channel Dashboard
 *
 * Local web UI for managing all WeChat bot instances.
 * - View all instances and their real-time status
 * - Create new instances (QR scan -> auto-configure)
 * - Alert via healthy instances when something goes wrong
 *
 * Run: npx tsx dashboard.ts
 * Default: http://localhost:9800
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, execFile, spawn } from "node:child_process";
// QR generation moved to frontend (avoids CommonJS/ESM compat issues with qrcode lib in bundled output)

// Strip proxy env vars — WeChat ilink API must be called directly, not via proxy
for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
  delete process.env[k];
}

// ── Config ──────────────────────────────────────────────────────────────────

// Resolve package root — works whether running from source (.ts) or dist/ (.js)
function findPkgRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  // Walk up until we find package.json
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(new URL(import.meta.url).pathname);
}
const PKG_ROOT = findPkgRoot();

const PORT = 9800;
const PROFILES_DIR = path.join(
  process.env.HOME || "~",
  ".claude",
  "channels",
  "wechat",
  "profiles",
);
const WECHAT_BASE = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const CHANNEL_VERSION = "0.2.0";
const STALE_THRESHOLD_MS = 2 * 60 * 1000;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const MONITOR_INTERVAL_MS = 30_000;

// ── Types ───────────────────────────────────────────────────────────────────

interface InstanceStatus {
  name: string;
  identity: string;
  workdir: string;
  allowFrom: string[];
  hasAccount: boolean;
  accountId: string;
  status: "active" | "online" | "paused" | "stale" | "offline" | "unconfigured";
  paused: boolean;
  syncBufAge: number | null;
  lastActivityAge: number | null;
  pid: number | null;
  lastAlert: number;
}

interface QRSession {
  qrcode: string;
  qrcodeUrl: string;
  profileName: string;
  workdir: string;
  createdAt: number;
}

// ── State ───────────────────────────────────────────────────────────────────

const alertTimestamps = new Map<string, number>();
const activeQRSessions = new Map<string, QRSession>();

// ── Helpers ─────────────────────────────────────────────────────────────────

// Cache pid->cwd mapping, refreshed periodically
let pidCwdCache = new Map<number, string>();
let pidCwdCacheTime = 0;
const PID_CACHE_TTL_MS = 5000;

function refreshPidCache(): void {
  if (Date.now() - pidCwdCacheTime < PID_CACHE_TTL_MS) return;
  const m = new Map<number, string>();
  try {
    const pids = execFileSync("/usr/bin/pgrep", ["-f", "wechat-channel|server:wechat"], {
      encoding: "utf-8", timeout: 3000,
    }).trim().split("\n").map(Number).filter(Boolean);

    for (const pid of pids) {
      try {
        // -a = AND conditions; -d cwd = only cwd fd; -Fn = field output
        const lsof = execFileSync("/usr/sbin/lsof", [
          "-p", String(pid), "-a", "-d", "cwd", "-Fn",
        ], { encoding: "utf-8", timeout: 2000 });
        const lines = lsof.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] === "fcwd" && i + 1 < lines.length && lines[i + 1].startsWith("n")) {
            m.set(pid, lines[i + 1].slice(1));
            break;
          }
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }
  pidCwdCache = m;
  pidCwdCacheTime = Date.now();
}

/** Ensure .mcp.json in workdir points to wechat server */
function ensureMcpConfig(dir: string): void {
  const mcpFile = path.join(dir, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    if (fs.existsSync(mcpFile)) config = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
  } catch {}
  if (!config.mcpServers) config.mcpServers = {};
  const serverJsPath = path.join(PKG_ROOT, "dist", "server.js");
  const wechatConfig = fs.existsSync(serverJsPath)
    ? { command: "node", args: [serverJsPath] }
    : { command: "npx", args: ["-y", "@xiaoyifu_0000/wechat-channel", "start"] };
  const existing = JSON.stringify((config.mcpServers as Record<string, unknown>).wechat ?? null);
  if (existing !== JSON.stringify(wechatConfig)) {
    (config.mcpServers as Record<string, unknown>).wechat = wechatConfig;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2));
    console.log(`[dashboard] .mcp.json updated: ${mcpFile}`);
  }
}

/** Resolve workdir: ~/xxx → /Users/mac/xxx, handle cross-machine paths */
function resolveWorkdir(raw: string, instanceName?: string): string {
  const home = process.env.HOME || os.homedir();
  if (!raw || raw === "~" || raw === home) {
    // Bare HOME is not a good workdir — assign ~/Documents/<name>
    if (instanceName) return path.join(home, "Documents", instanceName);
    return home;
  }
  // ~/xxx → current HOME/xxx
  if (raw.startsWith("~/")) return raw.replace(/^~/, home);
  // Absolute path from another machine (e.g. /Users/jasonlee/...) → remap to current HOME
  const foreignHomeMatch = raw.match(/^\/Users\/[^/]+\/(.*)/);
  if (foreignHomeMatch && !fs.existsSync(raw)) {
    const subpath = foreignHomeMatch[1];
    if (!subpath) {
      // Just /Users/xxx with no subdirectory
      if (instanceName) return path.join(home, "Documents", instanceName);
      return home;
    }
    const remapped = path.join(home, subpath);
    console.log(`[dashboard] workdir remapped: ${raw} → ${remapped}`);
    return remapped;
  }
  return raw;
}

function findProcessByWorkdir(workdir: string): number | null {
  refreshPidCache();
  const resolved = path.resolve(workdir);
  // Collect all matching PIDs, return lowest (parent/claude CLI, not child/server.js)
  let best: number | null = null;
  for (const [pid, cwd] of pidCwdCache) {
    if (path.resolve(cwd) === resolved) {
      if (best === null || pid < best) best = pid;
    }
  }
  return best;
}

/** Find claude CLI PID via channel.pid file (most reliable method) */
function findProcessByPidFile(profileName: string): number | null {
  const pidFile = path.join(PROFILES_DIR, profileName, "channel.pid");
  try {
    const serverPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (!serverPid || isNaN(serverPid)) return null;
    // Verify server.js is alive
    try { process.kill(serverPid, 0); } catch { return null; }
    // Get parent PID (claude CLI)
    try {
      const ppid = parseInt(
        execFileSync("ps", ["-p", String(serverPid), "-o", "ppid="], {
          encoding: "utf-8", timeout: 2000,
        }).trim(), 10
      );
      if (ppid > 1) {
        try { process.kill(ppid, 0); return ppid; } catch { return serverPid; }
      }
    } catch {}
    return serverPid; // fallback: return server.js PID itself
  } catch { return null; }
}

function getInstanceStatus(name: string): InstanceStatus {
  const dir = path.join(PROFILES_DIR, name);
  const profileFile = path.join(dir, "profile.json");
  const accountFile = path.join(dir, "account.json");
  const syncBufFile = path.join(dir, "sync_buf.txt");

  const base: InstanceStatus = {
    name, identity: "", workdir: "", allowFrom: [],
    hasAccount: false, accountId: "", paused: false,
    status: "unconfigured", syncBufAge: null, lastActivityAge: null, pid: null,
    lastAlert: alertTimestamps.get(name) ?? 0,
  };

  try {
    const profile = JSON.parse(fs.readFileSync(profileFile, "utf-8"));
    base.identity = profile.identity || "";
    base.workdir = profile.workdir || "";
    base.allowFrom = profile.allow_from || [];
  } catch { return base; }

  try {
    const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
    base.hasAccount = true;
    base.accountId = account.accountId || "";
  } catch { return base; }

  try {
    const stat = fs.statSync(syncBufFile);
    base.syncBufAge = Date.now() - stat.mtimeMs;
  } catch { base.syncBufAge = null; }

  // Read last_activity.txt (written by wechat-channel on each incoming message)
  const activityFile = path.join(dir, "last_activity.txt");
  try {
    const ts = parseInt(fs.readFileSync(activityFile, "utf-8").trim(), 10);
    if (ts > 0) base.lastActivityAge = Date.now() - ts;
  } catch { base.lastActivityAge = null; }

  base.paused = fs.existsSync(path.join(dir, "paused"));
  // 优先用channel.pid找（最可靠），fallback到CWD匹配
  base.pid = findProcessByPidFile(name);
  if (!base.pid) {
    const resolvedWorkdir = base.workdir ? resolveWorkdir(base.workdir, name) : "";
    if (resolvedWorkdir) base.pid = findProcessByWorkdir(resolvedWorkdir);
  }

  const ACTIVE_THRESHOLD_MS = 10 * 60 * 1000;
  if (!base.pid) {
    base.status = "offline";
  } else if (base.paused) {
    base.status = "paused";
  } else if (base.syncBufAge !== null && base.syncBufAge > STALE_THRESHOLD_MS) {
    base.status = "stale";
  } else if (base.lastActivityAge !== null && base.lastActivityAge < ACTIVE_THRESHOLD_MS) {
    base.status = "active";
  } else {
    base.status = "online";
  }

  return base;
}

function getAllInstances(): InstanceStatus[] {
  try {
    return fs.readdirSync(PROFILES_DIR)
      .filter((n) => fs.statSync(path.join(PROFILES_DIR, n)).isDirectory())
      .map(getInstanceStatus);
  } catch { return []; }
}

// ── Alert via healthy instance ──────────────────────────────────────────────

async function sendAlert(unhealthyName: string, message: string): Promise<void> {
  const now = Date.now();
  const last = alertTimestamps.get(unhealthyName) ?? 0;
  if (now - last < ALERT_COOLDOWN_MS) return;

  const healthy = getAllInstances().find((i) => (i.status === "online" || i.status === "active") && i.name !== unhealthyName);
  if (!healthy) return;

  try {
    const account = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, healthy.name, "account.json"), "utf-8"));
    const ctMap = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, healthy.name, "context_tokens.json"), "utf-8"));
    const recipient = healthy.allowFrom[0];
    if (!recipient) return;
    const ct = ctMap[recipient] || Object.values(ctMap)[0];
    if (!ct) return;

    await fetch(`${WECHAT_BASE}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${account.token}`,
      },
      body: JSON.stringify({
        msg: {
          from_user_id: "", to_user_id: recipient,
          client_id: `dashboard-${Date.now()}`,
          message_type: 2, message_state: 2,
          item_list: [{ type: 1, text_item: { text: message } }],
          context_token: ct,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
    });
    alertTimestamps.set(unhealthyName, now);
    console.log(`[dashboard] alert sent via ${healthy.name}: ${message}`);
  } catch (err) {
    console.error(`[dashboard] alert failed: ${err}`);
  }
}

// ── Monitor ─────────────────────────────────────────────────────────────────

const prevStatus = new Map<string, string>();

function monitor(): void {
  for (const inst of getAllInstances()) {
    if (!inst.hasAccount) continue;
    const prev = prevStatus.get(inst.name);
    prevStatus.set(inst.name, inst.status);
    const wasHealthy = prev === "online" || prev === "active";
    const isHealthy = inst.status === "online" || inst.status === "active";
    if (wasHealthy && !isHealthy) {
      const msg = inst.status === "stale"
        ? `[告警] ${inst.name} 异常: sync_buf ${Math.round((inst.syncBufAge ?? 0) / 60000)}分钟未更新`
        : `[告警] ${inst.name} 已离线`;
      sendAlert(inst.name, msg);
    }
  }
}

setInterval(monitor, MONITOR_INTERVAL_MS);

// ── QR API ──────────────────────────────────────────────────────────────────

async function startQRSession(profileName: string, workdir: string): Promise<QRSession> {
  const res = await fetch(`${WECHAT_BASE}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`);
  const data = (await res.json()) as { qrcode: string; qrcode_img_content: string };
  const session: QRSession = {
    qrcode: data.qrcode, qrcodeUrl: data.qrcode_img_content,
    profileName, workdir, createdAt: Date.now(),
  };
  activeQRSessions.set(profileName, session);
  return session;
}

async function pollQRStatus(qrcode: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(
      `${WECHAT_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { headers: { "iLink-App-ClientVersion": "1" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return { status: "wait" };
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { status: "wait" };
  }
}

function createProfile(
  name: string, workdir: string,
  account: { token: string; baseUrl: string; accountId: string; userId?: string; savedAt: string },
): void {
  const profileDir = path.join(PROFILES_DIR, name);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(path.join(profileDir, "memory"), { recursive: true });
  const resolvedWorkdir = resolveWorkdir(workdir);
  fs.mkdirSync(resolvedWorkdir, { recursive: true });

  fs.writeFileSync(path.join(profileDir, "account.json"), JSON.stringify(account, null, 2));
  try { fs.chmodSync(path.join(profileDir, "account.json"), 0o600); } catch {}

  fs.writeFileSync(path.join(profileDir, "profile.json"), JSON.stringify({
    identity: "你是一个全能探索型助手，没有固定角色限制。用户让你做什么你就做什么。风格轻松直接，像一个什么都会的朋友。",
    workdir,
    allow_from: account.userId ? [account.userId] : [],
  }, null, 2));

  fs.writeFileSync(path.join(profileDir, "sync_buf.txt"), "");
  fs.writeFileSync(path.join(profileDir, "context_tokens.json"), "{}");
  fs.mkdirSync(path.join(profileDir, "media"), { recursive: true });
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function body(req: http.IncomingMessage): Promise<string> {
  const MAX_BODY = 1_000_000; // 1MB
  return new Promise((resolve, reject) => {
    let b = ""; let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error("Body too large")); return; }
      b += c;
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const m = req.method || "GET";

  try {
    if (url.pathname === "/api/instances" && m === "GET") {
      json(res, getAllInstances()); return;
    }

    if (url.pathname === "/api/instances/create" && m === "POST") {
      const b = JSON.parse(await body(req));
      const name = (b.name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (!name) { json(res, { error: "名称不能为空" }, 400); return; }
      if (fs.existsSync(path.join(PROFILES_DIR, name))) { json(res, { error: "该名称已存在" }, 400); return; }
      const workdir = path.join("~", "Documents", b.folderName || name);
      const session = await startQRSession(name, workdir);
      json(res, { qrcode: session.qrcode, qrcodeUrl: session.qrcodeUrl, name, workdir }); return;
    }

    if (url.pathname.startsWith("/api/qr-status/") && m === "GET") {
      const name = url.pathname.split("/").pop() || "";
      const session = activeQRSessions.get(name);
      if (!session) { json(res, { error: "no session" }, 404); return; }
      const st = await pollQRStatus(session.qrcode) as any;
      if (st.status === "confirmed" && st.bot_token && st.ilink_bot_id) {
        createProfile(name, session.workdir, {
          token: st.bot_token, baseUrl: st.baseurl || WECHAT_BASE,
          accountId: st.ilink_bot_id, userId: st.ilink_user_id,
          savedAt: new Date().toISOString(),
        });
        activeQRSessions.delete(name);
        json(res, {
          status: "confirmed", name, workdir: session.workdir,
          launchCmd: `claude-code-wechat-channel dashboard`,
        }); return;
      }
      json(res, { status: st.status }); return;
    }

    if (url.pathname.startsWith("/api/rescan/") && m === "POST") {
      const name = url.pathname.split("/").pop() || "";
      const pDir = path.join(PROFILES_DIR, name);
      if (!fs.existsSync(pDir)) { json(res, { error: "不存在" }, 404); return; }
      let workdir = "";
      try { workdir = JSON.parse(fs.readFileSync(path.join(pDir, "profile.json"), "utf-8")).workdir || ""; } catch {}
      const session = await startQRSession(name, workdir);
      json(res, { qrcode: session.qrcode, qrcodeUrl: session.qrcodeUrl, name }); return;
    }

    // QR image endpoint — generates SVG inline (no external deps at runtime)
    if (url.pathname.startsWith("/api/qr-image/") && m === "GET") {
      const name = url.pathname.split("/").pop() || "";
      const session = activeQRSessions.get(name);
      if (!session) { res.writeHead(404); res.end("no session"); return; }
      try {
        const QR = await import("qrcode");
        const svg = await QR.default.toString(session.qrcodeUrl, { type: "svg", width: 200, margin: 1 });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
        res.end(svg); return;
      } catch (err) {
        // Fallback: redirect to the WeChat QR page itself
        res.writeHead(302, { Location: session.qrcodeUrl });
        res.end(); return;
      }
    }

    if (url.pathname.startsWith("/api/rescan-status/") && m === "GET") {
      const name = url.pathname.split("/").pop() || "";
      const session = activeQRSessions.get(name);
      if (!session) { json(res, { error: "no session" }, 404); return; }
      const st = await pollQRStatus(session.qrcode) as any;
      if (st.status === "confirmed" && st.bot_token && st.ilink_bot_id) {
        const profileDir = path.join(PROFILES_DIR, name);
        fs.mkdirSync(profileDir, { recursive: true });
        const accountFile = path.join(profileDir, "account.json");
        fs.writeFileSync(accountFile, JSON.stringify({
          token: st.bot_token, baseUrl: st.baseurl || WECHAT_BASE,
          accountId: st.ilink_bot_id, userId: st.ilink_user_id,
          savedAt: new Date().toISOString(),
        }, null, 2));
        try { fs.chmodSync(accountFile, 0o600); } catch {}
        fs.writeFileSync(path.join(PROFILES_DIR, name, "sync_buf.txt"), "");
        activeQRSessions.delete(name);
        json(res, { status: "confirmed" }); return;
      }
      json(res, { status: st.status }); return;
    }

    // ── Detail API ───────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/detail/") && m === "GET") {
      const name = url.pathname.split("/").pop() || "";
      const dir = path.join(PROFILES_DIR, name);
      if (!fs.existsSync(dir)) { json(res, { error: "不存在" }, 404); return; }

      const status = getInstanceStatus(name);
      const detail: Record<string, unknown> = { ...status };

      detail.paused = fs.existsSync(path.join(dir, "paused"));

      // Rules from profile.json
      try {
        const pf = JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf-8"));
        detail.rules = pf.rules || "";
      } catch { detail.rules = ""; }

      // Account info
      try {
        const acc = JSON.parse(fs.readFileSync(path.join(dir, "account.json"), "utf-8"));
        detail.tokenSavedAt = acc.savedAt || "";
        detail.userId = acc.userId || "";
      } catch { detail.tokenSavedAt = ""; detail.userId = ""; }

      // Context tokens count
      try {
        const ct = JSON.parse(fs.readFileSync(path.join(dir, "context_tokens.json"), "utf-8"));
        detail.contextTokenCount = Object.keys(ct).length;
      } catch { detail.contextTokenCount = 0; }

      // Memory files with content preview
      const memDir = path.join(dir, "memory");
      try {
        detail.memoryFiles = fs.readdirSync(memDir)
          .filter(f => f.endsWith(".md") || f.endsWith(".txt"))
          .map(f => {
            try {
              const content = fs.readFileSync(path.join(memDir, f), "utf-8");
              return { name: f, size: content.length, preview: content.slice(0, 200) };
            } catch { return { name: f, size: 0, preview: "" }; }
          });
      } catch { detail.memoryFiles = []; }

      // CLAUDE.md
      try {
        detail.claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
      } catch { detail.claudeMd = ""; }

      // Launch command
      detail.launchCmd = `WECHAT_CHANNEL_PROFILE=${name} wechat-channel run ${name}`;

      json(res, detail); return;
    }

    // ── Update API ─────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/update/") && m === "POST") {
      const name = url.pathname.split("/").pop() || "";
      const dir = path.join(PROFILES_DIR, name);
      const pFile = path.join(dir, "profile.json");
      if (!fs.existsSync(pFile)) { json(res, { error: "不存在" }, 404); return; }
      const current = JSON.parse(fs.readFileSync(pFile, "utf-8"));
      const updates = JSON.parse(await body(req));
      if (updates.identity !== undefined) current.identity = updates.identity;
      if (updates.rules !== undefined) current.rules = updates.rules;
      if (updates.allow_from !== undefined) current.allow_from = updates.allow_from;
      fs.writeFileSync(pFile, JSON.stringify(current, null, 2));
      console.log(`[dashboard] 配置已更新: ${name}`);
      json(res, { ok: true }); return;
    }

    // ── Pause/Resume API ────────────────────────────────────────────
    if (url.pathname.startsWith("/api/pause/") && m === "POST") {
      const name = url.pathname.split("/").pop() || "";
      const dir = path.join(PROFILES_DIR, name);
      if (!fs.existsSync(dir)) { json(res, { error: "不存在" }, 404); return; }
      fs.writeFileSync(path.join(dir, "paused"), new Date().toISOString());
      console.log(`[dashboard] 已暂停: ${name}`);
      json(res, { ok: true, paused: true }); return;
    }

    if (url.pathname.startsWith("/api/resume/") && m === "POST") {
      const name = url.pathname.split("/").pop() || "";
      const pausedFile = path.join(PROFILES_DIR, name, "paused");
      try { fs.unlinkSync(pausedFile); } catch {}
      console.log(`[dashboard] 已恢复: ${name}`);
      json(res, { ok: true, paused: false }); return;
    }

    // ── Delete API ──────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/delete/") && m === "DELETE") {
      const name = url.pathname.split("/").pop() || "";
      const dir = path.join(PROFILES_DIR, name);
      if (!fs.existsSync(dir)) { json(res, { error: "不存在" }, 404); return; }
      const status = getInstanceStatus(name);
      if (status.pid) {
        json(res, { error: `实例正在运行 (PID ${status.pid})，请先停止进程` }, 400); return;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[dashboard] 已删除: ${name}`);
      json(res, { ok: true }); return;
    }

    // ── Server Info API ───────────────────────────────────────────
    if (url.pathname === "/api/info" && m === "GET") {
      json(res, { home: process.env.HOME || "", platform: process.platform }); return;
    }

    // ── Environment Check API (for setup wizard) ─────────────────
    if (url.pathname === "/api/check-env" && m === "GET") {
      const checks: { name: string; ok: boolean; detail: string }[] = [];

      // Node.js version
      const nodeVer = process.versions.node;
      const major = parseInt(nodeVer.split(".")[0], 10);
      checks.push({ name: "Node.js", ok: major >= 18, detail: major >= 18 ? `v${nodeVer}` : `v${nodeVer} (需要 >= 18)` });

      // Claude Code installed
      let claudeOk = false;
      let claudeDetail = "未安装";
      try {
        const ver = execFileSync("claude", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
        claudeOk = true;
        claudeDetail = ver.split("\n")[0];
      } catch {
        claudeDetail = "未安装 — npm install -g @anthropic-ai/claude-code";
      }
      checks.push({ name: "Claude Code", ok: claudeOk, detail: claudeDetail });

      // WeChat API reachable
      let wechatOk = false;
      let wechatDetail = "不可达";
      try {
        const r = await fetch(`${WECHAT_BASE}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
          signal: AbortSignal.timeout(8000),
        });
        wechatOk = r.ok;
        wechatDetail = r.ok ? "可达" : `HTTP ${r.status}`;
      } catch (err) {
        wechatDetail = `网络错误: ${err instanceof Error ? err.message : String(err)}`;
      }
      checks.push({ name: "微信 API", ok: wechatOk, detail: wechatDetail });

      // Profiles dir writable
      let dirOk = false;
      try {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
        fs.accessSync(PROFILES_DIR, fs.constants.W_OK);
        dirOk = true;
      } catch {}
      checks.push({ name: "目录权限", ok: dirOk, detail: dirOk ? PROFILES_DIR : "无写入权限" });

      const allOk = checks.every((c) => c.ok);
      json(res, { checks, allOk }); return;
    }

    // ── Register MCP (auto-register channel in Claude Code) ─────
    if (url.pathname === "/api/register-mcp" && m === "POST") {
      const mcpFile = path.join(process.env.HOME || "~", ".claude", ".mcp.json");
      let mcpConfig: Record<string, unknown> = {};
      try {
        mcpConfig = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
      } catch {}

      const servers = (mcpConfig.mcpServers || {}) as Record<string, unknown>;
      if (!servers.wechat) {
        // Use absolute path so it works regardless of npm link / npx resolution
        const cliPath = path.resolve(PKG_ROOT, "cli.mjs");
        servers.wechat = {
          command: process.execPath,
          args: [cliPath, "start"],
        };
        mcpConfig.mcpServers = servers;
        fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
        fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2));
        console.log("[dashboard] MCP channel registered in ~/.claude/.mcp.json");
        json(res, { ok: true, registered: true }); return;
      }

      json(res, { ok: true, registered: false, message: "already registered" }); return;
    }

    // ── Rename Profile (wizard: rename _wizard_tmp to real name) ─
    if (url.pathname === "/api/rename-profile" && m === "POST") {
      const b = JSON.parse(await body(req));
      const from = (b.from || "").trim();
      const to = (b.to || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const workdir = (b.workdir || "").trim();
      if (!from || !to) { json(res, { error: "名称不能为空" }, 400); return; }
      const srcDir = path.join(PROFILES_DIR, from);
      const dstDir = path.join(PROFILES_DIR, to);
      if (!fs.existsSync(srcDir)) { json(res, { error: `源 profile "${from}" 不存在` }, 404); return; }
      if (from !== to) {
        if (fs.existsSync(dstDir)) { json(res, { error: `目标名称 "${to}" 已存在` }, 400); return; }
        fs.renameSync(srcDir, dstDir);
      }

      // Update workdir in profile.json
      if (workdir) {
        const profileFile = path.join(dstDir, "profile.json");
        try {
          const pf = JSON.parse(fs.readFileSync(profileFile, "utf-8"));
          const resolvedWorkdir = workdir.replace(/^~/, process.env.HOME || "~");
          pf.workdir = resolvedWorkdir;
          fs.writeFileSync(profileFile, JSON.stringify(pf, null, 2));
          fs.mkdirSync(resolvedWorkdir, { recursive: true });
        } catch {}
      }

      console.log(`[dashboard] profile renamed: ${from} -> ${to}`);
      json(res, { ok: true, name: to }); return;
    }

    // ── Install LaunchAgent (macOS auto-start) ──────────────────
    if (url.pathname === "/api/install-autostart" && m === "POST") {
      if (process.platform !== "darwin") {
        json(res, { ok: false, error: "仅支持 macOS" }); return;
      }

      const plistName = "com.wechat-channel.launcher.plist";
      const launchAgentsDir = path.join(process.env.HOME || "~", "Library", "LaunchAgents");
      const plistDst = path.join(launchAgentsDir, plistName);

      // Find launcher script
      let launcherPath = path.join(PKG_ROOT, "dist", "launcher.js");
      if (!fs.existsSync(launcherPath)) launcherPath = path.join(PKG_ROOT, "launcher.ts");

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wechat-channel.launcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.resolve(launcherPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${path.resolve(PKG_ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${path.join(process.env.HOME || "~", ".claude", "channels", "wechat", "launcher.stdout.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(process.env.HOME || "~", ".claude", "channels", "wechat", "launcher.stderr.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key><string>${process.env.HOME || ""}</string>
  </dict>
</dict>
</plist>`;

      fs.mkdirSync(launchAgentsDir, { recursive: true });
      fs.writeFileSync(plistDst, plistContent);

      try {
        execFileSync("launchctl", ["unload", plistDst], { timeout: 5000 });
      } catch {}
      try {
        execFileSync("launchctl", ["load", plistDst], { timeout: 5000 });
        console.log("[dashboard] LaunchAgent installed and loaded");
        json(res, { ok: true }); return;
      } catch (err) {
        json(res, { ok: false, error: String(err) }); return;
      }
    }

    // ── Restart service (kill all wechat-channel Claude processes, restart dashboard) ──
    if (url.pathname === "/api/restart-service" && m === "POST") {
      // 1. Kill all Claude CLI processes that load wechat channel
      try {
        const pids = execFileSync("/usr/bin/pgrep", ["-f", "claude.*wechat"], {
          encoding: "utf-8", timeout: 3000,
        }).trim().split("\n").map(Number).filter(Boolean);
        for (const pid of pids) {
          try { process.kill(pid, "SIGTERM"); } catch {}
        }
        console.log(`[dashboard] killed ${pids.length} wechat Claude processes`);
      } catch { /* no matching processes */ }

      // 2. Kill orphan server.js processes
      try {
        const serverPids = execFileSync("/usr/bin/pgrep", ["-f", "wechat-channel.*server\\.js"], {
          encoding: "utf-8", timeout: 3000,
        }).trim().split("\n").map(Number).filter(Boolean);
        for (const pid of serverPids) {
          if (pid === process.pid) continue; // don't kill ourselves
          try { process.kill(pid, "SIGTERM"); } catch {}
        }
      } catch {}

      // 3. Clean up old tmux session
      try { execFileSync("tmux", ["kill-session", "-t", "wechat-v2"], { timeout: 3000 }); } catch {}

      // 4. Open a NEW Terminal.app window (empty, ready for instance tabs)
      if (process.platform === "darwin") {
        const script = `tell application "Terminal"
activate
do script "echo 'WeChat Channel - 等待启动实例…'"
end tell`;
        execFile("osascript", ["-e", script], () => {});
      }

      json(res, { ok: true, message: "所有实例已停止，可以逐个启动" }); return;
    }

    // ── Launch profile (start channel process in tmux window) ──
    if (url.pathname === "/api/launch" && m === "POST") {
      const b = JSON.parse(await body(req));
      const profileName = (b.name || "").trim();
      const action = (b.action || "").trim();
      console.log(`[dashboard] /api/launch called: name=${profileName} action=${action}`);

      // Stop action: kill Claude CLI + all children + cleanup
      if (action === "stop" && profileName) {
        try {
          const inst = getInstanceStatus(profileName);
          if (inst.pid) {
            // Find all child processes first
            const children: number[] = [];
            try {
              const childPids = execFileSync("/usr/bin/pgrep", ["-P", String(inst.pid)], {
                encoding: "utf-8", timeout: 3000,
              }).trim().split("\n").map(Number).filter(Boolean);
              children.push(...childPids);
            } catch { /* no children */ }

            // Kill parent (claude CLI) first
            process.kill(inst.pid, "SIGTERM");
            // Kill children explicitly (server.js, MCP servers)
            for (const cpid of children) {
              try { process.kill(cpid, "SIGTERM"); } catch {}
            }
            // Wait up to 5s for parent to exit
            for (let i = 0; i < 10; i++) {
              try { process.kill(inst.pid, 0); } catch { break; }
              execFileSync("sleep", ["0.5"], { timeout: 2000 });
            }
            // Force kill parent + remaining children
            try { process.kill(inst.pid, 0); process.kill(inst.pid, "SIGKILL"); } catch {}
            for (const cpid of children) {
              try { process.kill(cpid, 0); process.kill(cpid, "SIGKILL"); } catch {}
            }
          }
          // Also kill the tmux window
          try { execFileSync("tmux", ["kill-window", "-t", `wechat-v2:${profileName}`], { timeout: 3000 }); } catch {}
        } catch {}
        // Invalidate PID cache so next status check is fresh
        pidCwdCacheTime = 0;
        json(res, { ok: true }); return;
      }

      const profiles = profileName ? [profileName] : getAllInstances()
        .filter((i) => i.hasAccount && !i.paused && i.status !== "unconfigured")
        .map((i) => i.name);

      if (profiles.length === 0) {
        json(res, { ok: false, error: "没有可启动的实例" }); return;
      }

      // Find claude binary
      let claudePath = "claude";
      try { claudePath = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3000 }).trim(); } catch {}

      for (const name of profiles) {
        const inst = getInstanceStatus(name);
        if (inst.pid) {
          // Kill old process before launching new one
          console.log(`[dashboard] ${name} has old process (pid=${inst.pid}), killing before relaunch`);
          try {
            process.kill(inst.pid, "SIGTERM");
            for (let i = 0; i < 6; i++) {
              try { process.kill(inst.pid, 0); } catch { break; }
              execFileSync("sleep", ["0.5"], { timeout: 2000 });
            }
            try { process.kill(inst.pid, 0); process.kill(inst.pid, "SIGKILL"); } catch {}
          } catch {}
          // Short delay to let port/resources release
          execFileSync("sleep", ["1"], { timeout: 3000 });
        }

        const workdir = resolveWorkdir(inst.workdir || "~", name);
        try { fs.mkdirSync(workdir, { recursive: true }); } catch {}
        ensureMcpConfig(workdir);

        const cmd = `cd '${workdir}' && WECHAT_CHANNEL_PROFILE=${name} CLAUDE_ROLE=${name} ${claudePath} --dangerously-load-development-channels server:wechat`;
        console.log(`[dashboard] launching ${name}: ${cmd.slice(0, 80)}...`);

        if (process.platform === "darwin") {
          // Open a new tab in the frontmost Terminal window, run the command
          const script = `tell application "Terminal"
activate
tell application "System Events" to keystroke "t" using command down
delay 0.5
do script "${cmd.replace(/"/g, '\\"')}" in front window
end tell`;
          execFileSync("osascript", ["-e", script], { timeout: 5000 });
        }

        console.log(`[dashboard] launched ${name} in Terminal tab`);
      }

      json(res, { ok: true, profiles }); return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // dashboard.html is in both root and dist/ — check current dir first, then root
      const selfDir = path.dirname(new URL(import.meta.url).pathname);
      let htmlPath = path.join(selfDir, "dashboard.html");
      if (!fs.existsSync(htmlPath)) htmlPath = path.join(PKG_ROOT, "dashboard.html");
      res.end(fs.readFileSync(htmlPath, "utf-8")); return;
    }

    res.writeHead(404); res.end("Not Found");
  } catch (err) {
    console.error(`[dashboard] ${err}`);
    json(res, { error: String(err) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`[dashboard] http://localhost:${PORT}`);
  if (process.platform === "darwin") {
    execFile("open", [`http://localhost:${PORT}`], () => {});
  }
});


