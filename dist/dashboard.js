#!/usr/bin/env npx tsx

// dashboard.ts
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
  delete process.env[k];
}
function findPkgRoot() {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(new URL(import.meta.url).pathname);
}
var PKG_ROOT = findPkgRoot();
var PORT = 9800;
var PROFILES_DIR = path.join(
  process.env.HOME || "~",
  ".claude",
  "channels",
  "wechat",
  "profiles"
);
var WECHAT_BASE = "https://ilinkai.weixin.qq.com";
var BOT_TYPE = "3";
var CHANNEL_VERSION = "0.2.0";
var STALE_THRESHOLD_MS = 2 * 60 * 1e3;
var ALERT_COOLDOWN_MS = 5 * 60 * 1e3;
var MONITOR_INTERVAL_MS = 3e4;
var alertTimestamps = /* @__PURE__ */ new Map();
var activeQRSessions = /* @__PURE__ */ new Map();
var pidCwdCache = /* @__PURE__ */ new Map();
var pidCwdCacheTime = 0;
var PID_CACHE_TTL_MS = 5e3;
function refreshPidCache() {
  if (Date.now() - pidCwdCacheTime < PID_CACHE_TTL_MS) return;
  const m = /* @__PURE__ */ new Map();
  try {
    const pids = execFileSync("/usr/bin/pgrep", ["-f", "WECHAT_CHANNEL_PROFILE|wechat-channel"], {
      encoding: "utf-8",
      timeout: 3e3
    }).trim().split("\n").map(Number).filter(Boolean);
    for (const pid of pids) {
      try {
        const lsof = execFileSync("/usr/sbin/lsof", [
          "-p",
          String(pid),
          "-a",
          "-d",
          "cwd",
          "-Fn"
        ], { encoding: "utf-8", timeout: 2e3 });
        const lines = lsof.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] === "fcwd" && i + 1 < lines.length && lines[i + 1].startsWith("n")) {
            m.set(pid, lines[i + 1].slice(1));
            break;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
  }
  pidCwdCache = m;
  pidCwdCacheTime = Date.now();
}
function ensureMcpConfig(dir) {
  const mcpFile = path.join(dir, ".mcp.json");
  let config = {};
  try {
    if (fs.existsSync(mcpFile)) config = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
  } catch {
  }
  if (!config.mcpServers) config.mcpServers = {};
  const serverJsPath = path.join(PKG_ROOT, "dist", "server.js");
  const wechatConfig = fs.existsSync(serverJsPath) ? { command: "node", args: [serverJsPath] } : { command: "npx", args: ["-y", "@xiaoyifu_0000/wechat-channel", "start"] };
  const existing = JSON.stringify(config.mcpServers.wechat ?? null);
  if (existing !== JSON.stringify(wechatConfig)) {
    config.mcpServers.wechat = wechatConfig;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2));
    console.log(`[dashboard] .mcp.json updated: ${mcpFile}`);
  }
}
function resolveWorkdir(raw, instanceName) {
  const home = process.env.HOME || os.homedir();
  if (!raw || raw === "~" || raw === home) {
    if (instanceName) return path.join(home, "Documents", instanceName);
    return home;
  }
  if (raw.startsWith("~/")) return raw.replace(/^~/, home);
  const foreignHomeMatch = raw.match(/^\/Users\/[^/]+\/(.*)/);
  if (foreignHomeMatch && !fs.existsSync(raw)) {
    const subpath = foreignHomeMatch[1];
    if (!subpath) {
      if (instanceName) return path.join(home, "Documents", instanceName);
      return home;
    }
    const remapped = path.join(home, subpath);
    console.log(`[dashboard] workdir remapped: ${raw} \u2192 ${remapped}`);
    return remapped;
  }
  return raw;
}
function findProcessByWorkdir(workdir) {
  refreshPidCache();
  const resolved = path.resolve(workdir);
  for (const [pid, cwd] of pidCwdCache) {
    if (path.resolve(cwd) === resolved) return pid;
  }
  return null;
}
function getInstanceStatus(name) {
  const dir = path.join(PROFILES_DIR, name);
  const profileFile = path.join(dir, "profile.json");
  const accountFile = path.join(dir, "account.json");
  const syncBufFile = path.join(dir, "sync_buf.txt");
  const base = {
    name,
    identity: "",
    workdir: "",
    allowFrom: [],
    hasAccount: false,
    accountId: "",
    paused: false,
    status: "unconfigured",
    syncBufAge: null,
    lastActivityAge: null,
    pid: null,
    lastAlert: alertTimestamps.get(name) ?? 0
  };
  try {
    const profile = JSON.parse(fs.readFileSync(profileFile, "utf-8"));
    base.identity = profile.identity || "";
    base.workdir = profile.workdir || "";
    base.allowFrom = profile.allow_from || [];
  } catch {
    return base;
  }
  try {
    const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
    base.hasAccount = true;
    base.accountId = account.accountId || "";
  } catch {
    return base;
  }
  try {
    const stat = fs.statSync(syncBufFile);
    base.syncBufAge = Date.now() - stat.mtimeMs;
  } catch {
    base.syncBufAge = null;
  }
  const activityFile = path.join(dir, "last_activity.txt");
  try {
    const ts = parseInt(fs.readFileSync(activityFile, "utf-8").trim(), 10);
    if (ts > 0) base.lastActivityAge = Date.now() - ts;
  } catch {
    base.lastActivityAge = null;
  }
  base.paused = fs.existsSync(path.join(dir, "paused"));
  const resolvedWorkdir = base.workdir ? resolveWorkdir(base.workdir, name) : "";
  if (resolvedWorkdir) base.pid = findProcessByWorkdir(resolvedWorkdir);
  const ACTIVE_THRESHOLD_MS = 10 * 60 * 1e3;
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
function getAllInstances() {
  try {
    return fs.readdirSync(PROFILES_DIR).filter((n) => fs.statSync(path.join(PROFILES_DIR, n)).isDirectory()).map(getInstanceStatus);
  } catch {
    return [];
  }
}
async function sendAlert(unhealthyName, message) {
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
        Authorization: `Bearer ${account.token}`
      },
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: recipient,
          client_id: `dashboard-${Date.now()}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: message } }],
          context_token: ct
        },
        base_info: { channel_version: CHANNEL_VERSION }
      })
    });
    alertTimestamps.set(unhealthyName, now);
    console.log(`[dashboard] alert sent via ${healthy.name}: ${message}`);
  } catch (err) {
    console.error(`[dashboard] alert failed: ${err}`);
  }
}
var prevStatus = /* @__PURE__ */ new Map();
function monitor() {
  for (const inst of getAllInstances()) {
    if (!inst.hasAccount) continue;
    const prev = prevStatus.get(inst.name);
    prevStatus.set(inst.name, inst.status);
    const wasHealthy = prev === "online" || prev === "active";
    const isHealthy = inst.status === "online" || inst.status === "active";
    if (wasHealthy && !isHealthy) {
      const msg = inst.status === "stale" ? `[\u544A\u8B66] ${inst.name} \u5F02\u5E38: sync_buf ${Math.round((inst.syncBufAge ?? 0) / 6e4)}\u5206\u949F\u672A\u66F4\u65B0` : `[\u544A\u8B66] ${inst.name} \u5DF2\u79BB\u7EBF`;
      sendAlert(inst.name, msg);
    }
  }
}
setInterval(monitor, MONITOR_INTERVAL_MS);
async function startQRSession(profileName, workdir) {
  const res = await fetch(`${WECHAT_BASE}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`);
  const data = await res.json();
  const session = {
    qrcode: data.qrcode,
    qrcodeUrl: data.qrcode_img_content,
    profileName,
    workdir,
    createdAt: Date.now()
  };
  activeQRSessions.set(profileName, session);
  return session;
}
async function pollQRStatus(qrcode) {
  try {
    const res = await fetch(
      `${WECHAT_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { headers: { "iLink-App-ClientVersion": "1" }, signal: AbortSignal.timeout(1e4) }
    );
    if (!res.ok) return { status: "wait" };
    return await res.json();
  } catch {
    return { status: "wait" };
  }
}
function createProfile(name, workdir, account) {
  const profileDir = path.join(PROFILES_DIR, name);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(path.join(profileDir, "memory"), { recursive: true });
  const resolvedWorkdir = resolveWorkdir(workdir);
  fs.mkdirSync(resolvedWorkdir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "account.json"), JSON.stringify(account, null, 2));
  try {
    fs.chmodSync(path.join(profileDir, "account.json"), 384);
  } catch {
  }
  fs.writeFileSync(path.join(profileDir, "profile.json"), JSON.stringify({
    identity: "\u4F60\u662F\u4E00\u4E2A\u5168\u80FD\u63A2\u7D22\u578B\u52A9\u624B\uFF0C\u6CA1\u6709\u56FA\u5B9A\u89D2\u8272\u9650\u5236\u3002\u7528\u6237\u8BA9\u4F60\u505A\u4EC0\u4E48\u4F60\u5C31\u505A\u4EC0\u4E48\u3002\u98CE\u683C\u8F7B\u677E\u76F4\u63A5\uFF0C\u50CF\u4E00\u4E2A\u4EC0\u4E48\u90FD\u4F1A\u7684\u670B\u53CB\u3002",
    workdir,
    allow_from: account.userId ? [account.userId] : []
  }, null, 2));
  fs.writeFileSync(path.join(profileDir, "sync_buf.txt"), "");
  fs.writeFileSync(path.join(profileDir, "context_tokens.json"), "{}");
  fs.mkdirSync(path.join(profileDir, "media"), { recursive: true });
}
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function body(req) {
  const MAX_BODY = 1e6;
  return new Promise((resolve, reject) => {
    let b = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      b += c;
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}
var server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const m = req.method || "GET";
  try {
    if (url.pathname === "/api/instances" && m === "GET") {
      json(res, getAllInstances());
      return;
    }
    if (url.pathname === "/api/instances/create" && m === "POST") {
      const b = JSON.parse(await body(req));
      const name = (b.name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (!name) {
        json(res, { error: "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
        return;
      }
      if (fs.existsSync(path.join(PROFILES_DIR, name))) {
        json(res, { error: "\u8BE5\u540D\u79F0\u5DF2\u5B58\u5728" }, 400);
        return;
      }
      const workdir = path.join("~", "Documents", b.folderName || name);
      const session = await startQRSession(name, workdir);
      json(res, { qrcode: session.qrcode, qrcodeUrl: session.qrcodeUrl, name, workdir });
      return;
    }
    if (url.pathname.startsWith("/api/qr-status/") && m === "GET") {
      const name = url.pathname.split("/").pop() || "";
      const session = activeQRSessions.get(name);
      if (!session) {
        json(res, { error: "no session" }, 404);
        return;
      }
      const st = await pollQRStatus(session.qrcode);
      if (st.status === "confirmed" && st.bot_token && st.ilink_bot_id) {
        createProfile(name, session.workdir, {
          token: st.bot_token,
          baseUrl: st.baseurl || WECHAT_BASE,
          accountId: st.ilink_bot_id,
          userId: st.ilink_user_id,
          savedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        activeQRSessions.delete(name);
        json(res, {
          status: "confirmed",
          name,
          workdir: session.workdir,
          launchCmd: `claude-code-wechat-channel dashboard`
        });
        return;
      }
      json(res, { status: st.status });
      return;
    }
    if (url.pathname.startsWith("/api/rescan/") && m === "POST") {
      const name = url.pathname.split("/").pop() || "";
      const pDir = path.join(PROFILES_DIR, name);
      if (!fs.existsSync(pDir)) {
        json(res, { error: "\u4E0D\u5B58\u5728" }, 404);
        return;
      }
      let workdir = "";
      try {
        workdir = JSON.parse(fs.readFileSync(path.join(pDir, "profile.json"), "utf-8")).workdir || "";
      } catch {
      }
      const session = await startQRSession(name, workdir);
      json(res, { qrcode: session.qrcode, qrcodeUrl: session.qrcodeUrl, name });
      return;
    }
    if (url.pathname.startsWith("/api/qr-image/") && m === "GET") {
      const name = url.pathname.split("/").pop() || "";
      const session = activeQRSessions.get(name);
      if (!session) {
        res.writeHead(404);
        res.end("no session");
        return;
      }
      try {
        const QR = await import("qrcode");
        const svg = await QR.default.toString(session.qrcodeUrl, { type: "svg", width: 200, margin: 1 });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
        res.end(svg);
        return;
      } catch (err) {
        res.writeHead(302, { Location: session.qrcodeUrl });
        res.end();
        return;
      }
    }
    if (url.pathname.startsWith("/api/rescan-status/") && m === "GET") {
      const name = url.pathname.split("/").pop() || "";
      const session = activeQRSessions.get(name);
      if (!session) {
        json(res, { error: "no session" }, 404);
        return;
      }
      const st = await pollQRStatus(session.qrcode);
      if (st.status === "confirmed" && st.bot_token && st.ilink_bot_id) {
        const profileDir = path.join(PROFILES_DIR, name);
        fs.mkdirSync(profileDir, { recursive: true });
        const accountFile = path.join(profileDir, "account.json");
        fs.writeFileSync(accountFile, JSON.stringify({
          token: st.bot_token,
          baseUrl: st.baseurl || WECHAT_BASE,
          accountId: st.ilink_bot_id,
          userId: st.ilink_user_id,
          savedAt: (/* @__PURE__ */ new Date()).toISOString()
        }, null, 2));
        try {
          fs.chmodSync(accountFile, 384);
        } catch {
        }
        fs.writeFileSync(path.join(PROFILES_DIR, name, "sync_buf.txt"), "");
        activeQRSessions.delete(name);
        json(res, { status: "confirmed" });
        return;
      }
      json(res, { status: st.status });
      return;
    }
    if (url.pathname.startsWith("/api/detail/") && m === "GET") {
      const name = url.pathname.split("/").pop() || "";
      const dir = path.join(PROFILES_DIR, name);
      if (!fs.existsSync(dir)) {
        json(res, { error: "\u4E0D\u5B58\u5728" }, 404);
        return;
      }
      const status = getInstanceStatus(name);
      const detail = { ...status };
      detail.paused = fs.existsSync(path.join(dir, "paused"));
      try {
        const pf = JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf-8"));
        detail.rules = pf.rules || "";
      } catch {
        detail.rules = "";
      }
      try {
        const acc = JSON.parse(fs.readFileSync(path.join(dir, "account.json"), "utf-8"));
        detail.tokenSavedAt = acc.savedAt || "";
        detail.userId = acc.userId || "";
      } catch {
        detail.tokenSavedAt = "";
        detail.userId = "";
      }
      try {
        const ct = JSON.parse(fs.readFileSync(path.join(dir, "context_tokens.json"), "utf-8"));
        detail.contextTokenCount = Object.keys(ct).length;
      } catch {
        detail.contextTokenCount = 0;
      }
      const memDir = path.join(dir, "memory");
      try {
        detail.memoryFiles = fs.readdirSync(memDir).filter((f) => f.endsWith(".md") || f.endsWith(".txt")).map((f) => {
          try {
            const content = fs.readFileSync(path.join(memDir, f), "utf-8");
            return { name: f, size: content.length, preview: content.slice(0, 200) };
          } catch {
            return { name: f, size: 0, preview: "" };
          }
        });
      } catch {
        detail.memoryFiles = [];
      }
      try {
        detail.claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
      } catch {
        detail.claudeMd = "";
      }
      detail.launchCmd = `WECHAT_CHANNEL_PROFILE=${name} wechat-channel run ${name}`;
      json(res, detail);
      return;
    }
    if (url.pathname.startsWith("/api/update/") && m === "POST") {
      const name = url.pathname.split("/").pop() || "";
      const dir = path.join(PROFILES_DIR, name);
      const pFile = path.join(dir, "profile.json");
      if (!fs.existsSync(pFile)) {
        json(res, { error: "\u4E0D\u5B58\u5728" }, 404);
        return;
      }
      const current = JSON.parse(fs.readFileSync(pFile, "utf-8"));
      const updates = JSON.parse(await body(req));
      if (updates.identity !== void 0) current.identity = updates.identity;
      if (updates.rules !== void 0) current.rules = updates.rules;
      if (updates.allow_from !== void 0) current.allow_from = updates.allow_from;
      fs.writeFileSync(pFile, JSON.stringify(current, null, 2));
      console.log(`[dashboard] \u914D\u7F6E\u5DF2\u66F4\u65B0: ${name}`);
      json(res, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/api/pause/") && m === "POST") {
      const name = url.pathname.split("/").pop() || "";
      const dir = path.join(PROFILES_DIR, name);
      if (!fs.existsSync(dir)) {
        json(res, { error: "\u4E0D\u5B58\u5728" }, 404);
        return;
      }
      fs.writeFileSync(path.join(dir, "paused"), (/* @__PURE__ */ new Date()).toISOString());
      console.log(`[dashboard] \u5DF2\u6682\u505C: ${name}`);
      json(res, { ok: true, paused: true });
      return;
    }
    if (url.pathname.startsWith("/api/resume/") && m === "POST") {
      const name = url.pathname.split("/").pop() || "";
      const pausedFile = path.join(PROFILES_DIR, name, "paused");
      try {
        fs.unlinkSync(pausedFile);
      } catch {
      }
      console.log(`[dashboard] \u5DF2\u6062\u590D: ${name}`);
      json(res, { ok: true, paused: false });
      return;
    }
    if (url.pathname.startsWith("/api/delete/") && m === "DELETE") {
      const name = url.pathname.split("/").pop() || "";
      const dir = path.join(PROFILES_DIR, name);
      if (!fs.existsSync(dir)) {
        json(res, { error: "\u4E0D\u5B58\u5728" }, 404);
        return;
      }
      const status = getInstanceStatus(name);
      if (status.pid) {
        json(res, { error: `\u5B9E\u4F8B\u6B63\u5728\u8FD0\u884C (PID ${status.pid})\uFF0C\u8BF7\u5148\u505C\u6B62\u8FDB\u7A0B` }, 400);
        return;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[dashboard] \u5DF2\u5220\u9664: ${name}`);
      json(res, { ok: true });
      return;
    }
    if (url.pathname === "/api/info" && m === "GET") {
      json(res, { home: process.env.HOME || "", platform: process.platform });
      return;
    }
    if (url.pathname === "/api/check-env" && m === "GET") {
      const checks = [];
      const nodeVer = process.versions.node;
      const major = parseInt(nodeVer.split(".")[0], 10);
      checks.push({ name: "Node.js", ok: major >= 18, detail: major >= 18 ? `v${nodeVer}` : `v${nodeVer} (\u9700\u8981 >= 18)` });
      let claudeOk = false;
      let claudeDetail = "\u672A\u5B89\u88C5";
      try {
        const ver = execFileSync("claude", ["--version"], { encoding: "utf-8", timeout: 5e3 }).trim();
        claudeOk = true;
        claudeDetail = ver.split("\n")[0];
      } catch {
        claudeDetail = "\u672A\u5B89\u88C5 \u2014 npm install -g @anthropic-ai/claude-code";
      }
      checks.push({ name: "Claude Code", ok: claudeOk, detail: claudeDetail });
      let wechatOk = false;
      let wechatDetail = "\u4E0D\u53EF\u8FBE";
      try {
        const r = await fetch(`${WECHAT_BASE}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
          signal: AbortSignal.timeout(8e3)
        });
        wechatOk = r.ok;
        wechatDetail = r.ok ? "\u53EF\u8FBE" : `HTTP ${r.status}`;
      } catch (err) {
        wechatDetail = `\u7F51\u7EDC\u9519\u8BEF: ${err instanceof Error ? err.message : String(err)}`;
      }
      checks.push({ name: "\u5FAE\u4FE1 API", ok: wechatOk, detail: wechatDetail });
      let dirOk = false;
      try {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
        fs.accessSync(PROFILES_DIR, fs.constants.W_OK);
        dirOk = true;
      } catch {
      }
      checks.push({ name: "\u76EE\u5F55\u6743\u9650", ok: dirOk, detail: dirOk ? PROFILES_DIR : "\u65E0\u5199\u5165\u6743\u9650" });
      const allOk = checks.every((c) => c.ok);
      json(res, { checks, allOk });
      return;
    }
    if (url.pathname === "/api/register-mcp" && m === "POST") {
      const mcpFile = path.join(process.env.HOME || "~", ".claude", ".mcp.json");
      let mcpConfig = {};
      try {
        mcpConfig = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
      } catch {
      }
      const servers = mcpConfig.mcpServers || {};
      if (!servers.wechat) {
        const cliPath = path.resolve(PKG_ROOT, "cli.mjs");
        servers.wechat = {
          command: process.execPath,
          args: [cliPath, "start"]
        };
        mcpConfig.mcpServers = servers;
        fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
        fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2));
        console.log("[dashboard] MCP channel registered in ~/.claude/.mcp.json");
        json(res, { ok: true, registered: true });
        return;
      }
      json(res, { ok: true, registered: false, message: "already registered" });
      return;
    }
    if (url.pathname === "/api/rename-profile" && m === "POST") {
      const b = JSON.parse(await body(req));
      const from = (b.from || "").trim();
      const to = (b.to || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const workdir = (b.workdir || "").trim();
      if (!from || !to) {
        json(res, { error: "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
        return;
      }
      const srcDir = path.join(PROFILES_DIR, from);
      const dstDir = path.join(PROFILES_DIR, to);
      if (!fs.existsSync(srcDir)) {
        json(res, { error: `\u6E90 profile "${from}" \u4E0D\u5B58\u5728` }, 404);
        return;
      }
      if (from !== to) {
        if (fs.existsSync(dstDir)) {
          json(res, { error: `\u76EE\u6807\u540D\u79F0 "${to}" \u5DF2\u5B58\u5728` }, 400);
          return;
        }
        fs.renameSync(srcDir, dstDir);
      }
      if (workdir) {
        const profileFile = path.join(dstDir, "profile.json");
        try {
          const pf = JSON.parse(fs.readFileSync(profileFile, "utf-8"));
          const resolvedWorkdir = workdir.replace(/^~/, process.env.HOME || "~");
          pf.workdir = resolvedWorkdir;
          fs.writeFileSync(profileFile, JSON.stringify(pf, null, 2));
          fs.mkdirSync(resolvedWorkdir, { recursive: true });
        } catch {
        }
      }
      console.log(`[dashboard] profile renamed: ${from} -> ${to}`);
      json(res, { ok: true, name: to });
      return;
    }
    if (url.pathname === "/api/install-autostart" && m === "POST") {
      if (process.platform !== "darwin") {
        json(res, { ok: false, error: "\u4EC5\u652F\u6301 macOS" });
        return;
      }
      const plistName = "com.wechat-channel.launcher.plist";
      const launchAgentsDir = path.join(process.env.HOME || "~", "Library", "LaunchAgents");
      const plistDst = path.join(launchAgentsDir, plistName);
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
        execFileSync("launchctl", ["unload", plistDst], { timeout: 5e3 });
      } catch {
      }
      try {
        execFileSync("launchctl", ["load", plistDst], { timeout: 5e3 });
        console.log("[dashboard] LaunchAgent installed and loaded");
        json(res, { ok: true });
        return;
      } catch (err) {
        json(res, { ok: false, error: String(err) });
        return;
      }
    }
    if (url.pathname === "/api/restart-service" && m === "POST") {
      try {
        const pids = execFileSync("/usr/bin/pgrep", ["-f", "claude.*wechat"], {
          encoding: "utf-8",
          timeout: 3e3
        }).trim().split("\n").map(Number).filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
          }
        }
        console.log(`[dashboard] killed ${pids.length} wechat Claude processes`);
      } catch {
      }
      try {
        const serverPids = execFileSync("/usr/bin/pgrep", ["-f", "wechat-channel.*server\\.js"], {
          encoding: "utf-8",
          timeout: 3e3
        }).trim().split("\n").map(Number).filter(Boolean);
        for (const pid of serverPids) {
          if (pid === process.pid) continue;
          try {
            process.kill(pid, "SIGTERM");
          } catch {
          }
        }
      } catch {
      }
      try {
        execFileSync("tmux", ["kill-session", "-t", "wechat-v2"], { timeout: 3e3 });
      } catch {
      }
      if (process.platform === "darwin") {
        const script = `tell application "Terminal"
activate
do script "echo 'WeChat Channel - \u7B49\u5F85\u542F\u52A8\u5B9E\u4F8B\u2026'"
end tell`;
        execFile("osascript", ["-e", script], () => {
        });
      }
      json(res, { ok: true, message: "\u6240\u6709\u5B9E\u4F8B\u5DF2\u505C\u6B62\uFF0C\u53EF\u4EE5\u9010\u4E2A\u542F\u52A8" });
      return;
    }
    if (url.pathname === "/api/launch" && m === "POST") {
      const b = JSON.parse(await body(req));
      const profileName = (b.name || "").trim();
      const action = (b.action || "").trim();
      console.log(`[dashboard] /api/launch called: name=${profileName} action=${action}`);
      if (action === "stop" && profileName) {
        try {
          const inst = getInstanceStatus(profileName);
          if (inst.pid) {
            process.kill(inst.pid, "SIGTERM");
          }
          try {
            execFileSync("tmux", ["kill-window", "-t", `wechat-v2:${profileName}`], { timeout: 3e3 });
          } catch {
          }
        } catch {
        }
        json(res, { ok: true });
        return;
      }
      const profiles = profileName ? [profileName] : getAllInstances().filter((i) => i.hasAccount && !i.paused && i.status !== "unconfigured").map((i) => i.name);
      if (profiles.length === 0) {
        json(res, { ok: false, error: "\u6CA1\u6709\u53EF\u542F\u52A8\u7684\u5B9E\u4F8B" });
        return;
      }
      let claudePath = "claude";
      try {
        claudePath = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3e3 }).trim();
      } catch {
      }
      for (const name of profiles) {
        const inst = getInstanceStatus(name);
        if (inst.pid) {
          console.log(`[dashboard] ${name} already running (pid=${inst.pid}), skipping`);
          continue;
        }
        const workdir = resolveWorkdir(inst.workdir || "~", name);
        try {
          fs.mkdirSync(workdir, { recursive: true });
        } catch {
        }
        ensureMcpConfig(workdir);
        const cmd = `cd '${workdir}' && WECHAT_CHANNEL_PROFILE=${name} CLAUDE_ROLE=${name} ${claudePath} --dangerously-load-development-channels server:wechat`;
        console.log(`[dashboard] launching ${name}: ${cmd.slice(0, 80)}...`);
        if (process.platform === "darwin") {
          const script = `tell application "Terminal"
activate
tell application "System Events" to keystroke "t" using command down
delay 0.5
do script "${cmd.replace(/"/g, '\\"')}" in front window
end tell`;
          execFileSync("osascript", ["-e", script], { timeout: 5e3 });
        }
        console.log(`[dashboard] launched ${name} in Terminal tab`);
      }
      json(res, { ok: true, profiles });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const selfDir = path.dirname(new URL(import.meta.url).pathname);
      let htmlPath = path.join(selfDir, "dashboard.html");
      if (!fs.existsSync(htmlPath)) htmlPath = path.join(PKG_ROOT, "dashboard.html");
      res.end(fs.readFileSync(htmlPath, "utf-8"));
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  } catch (err) {
    console.error(`[dashboard] ${err}`);
    json(res, { error: String(err) }, 500);
  }
});
server.listen(PORT, () => {
  console.log(`[dashboard] http://localhost:${PORT}`);
  if (process.platform === "darwin") {
    execFile("open", [`http://localhost:${PORT}`], () => {
    });
  }
});
