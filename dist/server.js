// server.ts
import fs6 from "node:fs";
import path4 from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// src/types.ts
var CHANNEL_NAME = "wechat";
var CHANNEL_VERSION = "1.0.0";
var DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
var BOT_TYPE = "3";
var CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
var MSG_TYPE_USER = 1;
var MSG_TYPE_BOT = 2;
var MSG_STATE_FINISH = 2;
var MSG_ITEM_TEXT = 1;
var MSG_ITEM_IMAGE = 2;
var MSG_ITEM_VOICE = 3;
var MSG_ITEM_FILE = 4;
var MSG_ITEM_VIDEO = 5;
var UPLOAD_MEDIA_IMAGE = 1;
var UPLOAD_MEDIA_FILE = 3;

// src/profile.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var CHANNELS_BASE = path.join(
  process.env.HOME || os.homedir(),
  ".claude",
  "channels",
  "wechat"
);
function resolveProfileName() {
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
      } catch {
        continue;
      }
    }
  } catch {
  }
  if (process.env.WECHAT_CHANNEL_PROFILE) {
    return process.env.WECHAT_CHANNEL_PROFILE;
  }
  return "default";
}
function getProfilePaths(profileName) {
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
    lastActivityFile: path.join(credentialsDir, "last_activity.txt")
  };
}
function ensureDirectories(paths2) {
  fs.mkdirSync(paths2.memoryDir, { recursive: true });
  fs.mkdirSync(paths2.mediaDir, { recursive: true });
}
function loadCredentials(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
function saveCredentials(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 384);
  } catch {
  }
}
function loadProfileConfig(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}
function isPaused(pausedFile) {
  return fs.existsSync(pausedFile);
}
function acquireLock(pidFile) {
  let recovered = false;
  let stalePid;
  try {
    const existing = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(existing, 10);
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        process.stderr.write(
          `\u274C \u5FAE\u4FE1\u63D2\u4EF6\u5DF2\u7ECF\u5728\u8FD0\u884C\u4E2D\uFF08\u8FDB\u7A0B\u53F7: ${pid}\uFF09
   \u{1F449} \u5982\u679C\u8981\u91CD\u65B0\u542F\u52A8\uFF0C\u8BF7\u5148\u8FD0\u884C: kill ${pid}
   \u{1F449} \u5982\u679C\u786E\u8BA4\u6CA1\u6709\u5728\u8FD0\u884C\uFF0C\u8BF7\u5220\u9664\u9501\u6587\u4EF6: rm ${pidFile}
`
        );
        process.exit(1);
      } catch {
        recovered = true;
        stalePid = pid;
      }
    }
  } catch {
  }
  fs.writeFileSync(pidFile, String(process.pid), "utf-8");
  return { recovered, stalePid };
}
function releaseLock(pidFile) {
  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(pidFile);
  } catch {
  }
}
var MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
function cleanOldMedia(mediaDir) {
  try {
    for (const f of fs.readdirSync(mediaDir)) {
      const fp = path.join(mediaDir, f);
      const stat = fs.statSync(fp);
      if (Date.now() - stat.mtimeMs > MEDIA_MAX_AGE_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch {
  }
}
function getNativeMemoryDir(workdir) {
  const encoded = workdir.replace(/\//g, "-");
  return path.join(process.env.HOME || "~", ".claude", "projects", encoded, "memory");
}
function loadMemoryFromDir(dir, label) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".txt")).sort();
    if (files.length === 0) return "";
    const sections = files.map((f) => {
      const content = fs.readFileSync(path.join(dir, f), "utf-8").trim();
      if (!content) return "";
      return `--- ${f} ---
${content}`;
    }).filter(Boolean);
    if (sections.length === 0) return "";
    return `
${label} (from ${dir}):
${sections.join("\n\n")}`;
  } catch {
    return "";
  }
}
function loadAllMemory(memoryDir, workdir) {
  const parts = [];
  const channelMem = loadMemoryFromDir(memoryDir, "Channel memory");
  if (channelMem) parts.push(channelMem);
  const nativeDir = getNativeMemoryDir(workdir);
  if (nativeDir !== memoryDir) {
    const nativeMem = loadMemoryFromDir(nativeDir, "Native CC memory");
    if (nativeMem) parts.push(nativeMem);
  }
  return parts.join("\n");
}

// src/message.ts
import crypto3 from "node:crypto";

// src/api.ts
import crypto from "node:crypto";
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}
function buildHeaders(token, body) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin()
  };
  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}
async function apiFetch(params) {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// src/crypto.ts
import crypto2 from "node:crypto";
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Invalid aes_key: decoded length ${decoded.length}, expected 16 or 32(hex)`);
}
function decryptAesEcb(data, keyBase64) {
  const key = parseAesKey(keyBase64);
  const decipher = crypto2.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
function encryptAesEcb(data, key) {
  const cipher = crypto2.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

// src/cdn.ts
import fs2 from "node:fs";
import path2 from "node:path";
function buildCdnDownloadUrl(encryptQueryParam) {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}
function resolveMediaDownloadInfo(obj) {
  let encryptQueryParam = null;
  let aesKeyBase64 = null;
  function scan(o, depth = 0) {
    if (!o || typeof o !== "object" || depth > 4) return;
    const rec = o;
    if (typeof rec.encrypt_query_param === "string" && rec.encrypt_query_param) {
      encryptQueryParam = rec.encrypt_query_param;
    }
    if (typeof rec.aeskey === "string" && rec.aeskey && !aesKeyBase64) {
      aesKeyBase64 = Buffer.from(rec.aeskey, "hex").toString("base64");
    }
    if (typeof rec.aes_key === "string" && rec.aes_key && !aesKeyBase64) {
      aesKeyBase64 = rec.aes_key;
    }
    for (const v of Object.values(rec)) {
      if (v && typeof v === "object") scan(v, depth + 1);
    }
  }
  scan(obj);
  return { encryptQueryParam, aesKeyBase64 };
}
async function downloadAndDecryptMedia(cdnUrl, aesKeyBase64) {
  const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(3e4) });
  if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());
  return decryptAesEcb(encrypted, aesKeyBase64);
}
async function downloadMediaToFile(cdnUrl, aesKeyBase64, fileName, mediaDir, log3) {
  try {
    const data = await downloadAndDecryptMedia(cdnUrl, aesKeyBase64);
    const safeName = path2.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path2.join(mediaDir, `${Date.now()}_${safeName}`);
    fs2.writeFileSync(filePath, data);
    log3(`\u5A92\u4F53\u5DF2\u4FDD\u5B58: ${filePath} (${(data.length / 1024).toFixed(1)} KB)`);
    return filePath;
  } catch (err) {
    log3(`\u5A92\u4F53\u4E0B\u8F7D\u5931\u8D25: ${String(err)}`);
    return null;
  }
}
async function getUploadUrl(baseUrl, token, params) {
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      ...params,
      base_info: { channel_version: CHANNEL_VERSION }
    }),
    token,
    timeoutMs: 15e3
  });
  return JSON.parse(raw);
}
async function uploadToCdn(uploadParam, filekey, ciphertext) {
  const cdnUploadUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const res = await fetch(cdnUploadUrl, {
    method: "POST",
    body: new Uint8Array(ciphertext),
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(ciphertext.length)
    },
    signal: AbortSignal.timeout(6e4)
  });
  if (!res.ok) throw new Error(`CDN upload failed: ${res.status}`);
  const downloadParam = res.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("CDN upload response missing x-encrypted-param header");
  return downloadParam;
}

// src/message.ts
function extractContent(msg) {
  if (!msg.item_list?.length) return null;
  for (const item of msg.item_list) {
    switch (item.type) {
      case MSG_ITEM_TEXT: {
        if (!item.text_item?.text) continue;
        let text = item.text_item.text;
        if (item.ref_msg?.title) {
          text = `[\u5F15\u7528: ${item.ref_msg.title}]
${text}`;
        }
        return { text, msgType: "text" };
      }
      case MSG_ITEM_VOICE: {
        const transcript = item.voice_item?.text;
        if (transcript) return { text: `[\u8BED\u97F3\u8F6C\u6587\u5B57] ${transcript}`, msgType: "voice" };
        return { text: "[\u8BED\u97F3\u6D88\u606F\uFF08\u65E0\u6587\u5B57\u8F6C\u5F55\uFF09]", msgType: "voice" };
      }
      case MSG_ITEM_IMAGE: {
        const img = item.image_item;
        const dims = img?.width && img?.height ? ` (${img.width}x${img.height})` : "";
        return { text: `[\u56FE\u7247${dims}]`, msgType: "image", mediaItem: img };
      }
      case MSG_ITEM_FILE: {
        const f = item.file_item;
        const name = f?.file_name ? ` "${f.file_name}"` : "";
        const size = f?.file_size ? ` (${(f.file_size / 1024).toFixed(1)} KB)` : "";
        return { text: `[\u6587\u4EF6${name}${size}]`, msgType: "file", mediaItem: f };
      }
      case MSG_ITEM_VIDEO: {
        const v = item.video_item;
        const dur = v?.duration_ms ? ` (${(v.duration_ms / 1e3).toFixed(1)}s)` : "";
        return { text: `[\u89C6\u9891${dur}]`, msgType: "video", mediaItem: v };
      }
      default:
        return { text: `[\u672A\u77E5\u6D88\u606F\u7C7B\u578B ${item.type}]`, msgType: "unknown" };
    }
  }
  return null;
}
function markdownToPlainText(text) {
  return text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, "")).replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/_([^_]+)_/g, "$1").replace(/~~([^~]+)~~/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*+]\s+/gm, "- ").replace(/^\s*\d+\.\s+/gm, (m) => m).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1").replace(/^>\s?/gm, "").replace(/^---+$/gm, "").replace(/\n{3,}/g, "\n\n");
}
var MAX_WECHAT_MSG_LENGTH = 2e3;
function chunkMessage(text) {
  if (text.length <= MAX_WECHAT_MSG_LENGTH) return [text];
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > MAX_WECHAT_MSG_LENGTH) {
      if (current) chunks.push(current.trim());
      if (para.length > MAX_WECHAT_MSG_LENGTH) {
        const lines = para.split("\n");
        current = "";
        for (const line of lines) {
          if (current.length + line.length + 1 > MAX_WECHAT_MSG_LENGTH) {
            if (current) chunks.push(current.trim());
            current = line;
          } else {
            current += (current ? "\n" : "") + line;
          }
        }
      } else {
        current = para;
      }
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  const result = [];
  for (const chunk of chunks) {
    if (chunk.length <= MAX_WECHAT_MSG_LENGTH) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += MAX_WECHAT_MSG_LENGTH) {
        result.push(chunk.slice(i, i + MAX_WECHAT_MSG_LENGTH));
      }
    }
  }
  return result;
}
function generateClientId() {
  return `claude-code-wechat:${Date.now()}-${crypto3.randomBytes(4).toString("hex")}`;
}
async function getUpdates(baseUrl, token, getUpdatesBuf, timeoutMs = 35e3) {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION }
      }),
      token,
      timeoutMs
    });
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}
async function sendTextMessage(baseUrl, token, to, text, contextToken) {
  const plain = markdownToPlainText(text);
  const chunks = chunkMessage(plain);
  for (const chunk of chunks) {
    await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: generateClientId(),
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: chunk } }],
          context_token: contextToken
        },
        base_info: { channel_version: CHANNEL_VERSION }
      }),
      token,
      timeoutMs: 15e3
    });
  }
}
async function sendImageMessage(baseUrl, token, to, imageBuffer, contextToken) {
  const aesKey = crypto3.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const filekey = crypto3.randomBytes(16).toString("hex");
  const rawsize = imageBuffer.length;
  const rawfilemd5 = crypto3.createHash("md5").update(imageBuffer).digest("hex");
  const encrypted = encryptAesEcb(imageBuffer, aesKey);
  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey,
    media_type: UPLOAD_MEDIA_IMAGE,
    to_user_id: to,
    rawsize,
    rawfilemd5,
    filesize: encrypted.length,
    no_need_thumb: true,
    aeskey: aesKeyHex
  });
  if (!uploadResp.upload_param) throw new Error(`getuploadurl failed: ${JSON.stringify(uploadResp)}`);
  const downloadParam = await uploadToCdn(uploadResp.upload_param, filekey, encrypted);
  const aesKeyForMsg = Buffer.from(aesKeyHex).toString("base64");
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{
          type: MSG_ITEM_IMAGE,
          image_item: { media: { encrypt_query_param: downloadParam, aes_key: aesKeyForMsg, encrypt_type: 1 }, mid_size: encrypted.length }
        }],
        context_token: contextToken
      },
      base_info: { channel_version: CHANNEL_VERSION }
    }),
    token,
    timeoutMs: 15e3
  });
}
async function sendFileMessage(baseUrl, token, to, fileBuffer, fileName, contextToken) {
  const aesKey = crypto3.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const filekey = crypto3.randomBytes(16).toString("hex");
  const rawsize = fileBuffer.length;
  const rawfilemd5 = crypto3.createHash("md5").update(fileBuffer).digest("hex");
  const encrypted = encryptAesEcb(fileBuffer, aesKey);
  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey,
    media_type: UPLOAD_MEDIA_FILE,
    to_user_id: to,
    rawsize,
    rawfilemd5,
    filesize: encrypted.length,
    no_need_thumb: true,
    aeskey: aesKeyHex
  });
  if (!uploadResp.upload_param) throw new Error(`getuploadurl failed: ${JSON.stringify(uploadResp)}`);
  const downloadParam = await uploadToCdn(uploadResp.upload_param, filekey, encrypted);
  const aesKeyForMsg = Buffer.from(aesKeyHex).toString("base64");
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{
          type: MSG_ITEM_FILE,
          file_item: { media: { encrypt_query_param: downloadParam, aes_key: aesKeyForMsg, encrypt_type: 1 }, file_name: fileName, len: String(rawsize) }
        }],
        context_token: contextToken
      },
      base_info: { channel_version: CHANNEL_VERSION }
    }),
    token,
    timeoutMs: 15e3
  });
}
async function showTypingIndicator(baseUrl, token, toUserId, contextToken) {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({
        to_user_id: toUserId,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION }
      }),
      token,
      timeoutMs: 5e3
    });
    const resp = JSON.parse(raw);
    if (!resp.typing_ticket) return;
    await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({
        to_user_id: toUserId,
        typing_ticket: resp.typing_ticket,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION }
      }),
      token,
      timeoutMs: 5e3
    });
  } catch {
  }
}

// src/login.ts
import http from "node:http";
import { execFileSync } from "node:child_process";
import QRCode from "qrcode";
var QR_SERVER_BASE_PORT = 9876;
var QR_SERVER_MAX_PORT = 9886;
async function fetchQRCode(baseUrl) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return await res.json();
}
async function pollQRStatus(baseUrl, qrcode) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35e3);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    throw err;
  }
}
async function generateQRSvg(data) {
  return QRCode.toString(data, { type: "svg", width: 280, margin: 1 });
}
async function buildQRPageHtml(qrSvg, qrUrl, profileName) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>\u5FAE\u4FE1\u91CD\u65B0\u767B\u5F55 - ${profileName}</title>
<style>
body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);text-align:center;max-width:400px}
h2{margin:0 0 8px;color:#333}
.hint{color:#999;font-size:14px;margin-bottom:20px}
#status{margin-top:20px;font-size:18px;color:#666}
.success{color:#07c160!important;font-weight:bold}
.expired{color:#e74c3c!important}
#qr-container svg{width:280px;height:280px}
</style></head><body>
<div class="card">
<h2>\u5FAE\u4FE1\u91CD\u65B0\u767B\u5F55</h2>
<p class="hint">Profile: ${profileName} | Token \u5DF2\u8FC7\u671F</p>
<div id="qr-container">${qrSvg}</div>
<p style="font-size:13px;color:#999">\u6216\u6253\u5F00: <a href="${qrUrl}" target="_blank">\u626B\u7801\u94FE\u63A5</a></p>
<div id="status">\u7B49\u5F85\u626B\u7801...</div>
</div>
<script>
async function poll(){
  try{const r=await fetch("/qr-status");const d=await r.json();const el=document.getElementById("status");
  if(d.status==="scaned"){el.textContent="\u5DF2\u626B\u7801\uFF0C\u8BF7\u786E\u8BA4...";}
  else if(d.status==="confirmed"){el.textContent="\u767B\u5F55\u6210\u529F!";el.className="success";return;}
  else if(d.status==="expired"){
    el.textContent="\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u6B63\u5728\u5237\u65B0...";el.className="expired";
    try{const nr=await fetch("/qr-refresh");if(nr.ok){location.reload();}}
    catch{el.textContent="\u5237\u65B0\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u5237\u65B0\u9875\u9762";}
    }}catch{}
  setTimeout(poll,2000);}
poll();
</script></body></html>`;
}
async function doQRLoginWithWebServer(baseUrl, profileName, credentialsFile, log3) {
  log3("Token \u8FC7\u671F\uFF0C\u542F\u52A8 Web \u4E8C\u7EF4\u7801...");
  let qrResp = await fetchQRCode(baseUrl);
  let currentHtml = await buildQRPageHtml(
    await generateQRSvg(qrResp.qrcode_img_content),
    qrResp.qrcode_img_content,
    profileName
  );
  let latestStatus = { status: "wait" };
  let loginResolved = false;
  let currentQrCode = qrResp.qrcode;
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.url === "/qr-status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: latestStatus.status }));
      } else if (req.url === "/qr-refresh") {
        try {
          qrResp = await fetchQRCode(baseUrl);
          currentQrCode = qrResp.qrcode;
          currentHtml = await buildQRPageHtml(
            await generateQRSvg(qrResp.qrcode_img_content),
            qrResp.qrcode_img_content,
            profileName
          );
          latestStatus = { status: "wait" };
          log3("\u4E8C\u7EF4\u7801\u5DF2\u5237\u65B0");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(currentHtml);
      }
    });
    function tryListen(port) {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && port < QR_SERVER_MAX_PORT) tryListen(port + 1);
        else {
          log3(`\u274C \u626B\u7801\u9875\u9762\u542F\u52A8\u5931\u8D25\uFF08\u7AEF\u53E3\u53EF\u80FD\u88AB\u5360\u7528\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5`);
          resolve(null);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        log3(`\u4E8C\u7EF4\u7801\u9875\u9762: http://localhost:${actualPort}`);
        const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        try {
          execFileSync(openCmd, [`http://localhost:${actualPort}`]);
        } catch {
          log3(`\u5982\u679C\u6D4F\u89C8\u5668\u6CA1\u6709\u81EA\u52A8\u6253\u5F00\uFF0C\u8BF7\u624B\u52A8\u8BBF\u95EE: http://localhost:${actualPort}`);
        }
        startQRPolling();
      });
    }
    async function startQRPolling() {
      const deadline = Date.now() + 48e4;
      while (Date.now() < deadline && !loginResolved) {
        try {
          latestStatus = await pollQRStatus(baseUrl, currentQrCode);
          if (latestStatus.status === "confirmed") {
            if (!latestStatus.ilink_bot_id || !latestStatus.bot_token) {
              loginResolved = true;
              server.close();
              resolve(null);
              return;
            }
            const account = {
              token: latestStatus.bot_token,
              baseUrl: latestStatus.baseurl || baseUrl,
              accountId: latestStatus.ilink_bot_id,
              userId: latestStatus.ilink_user_id,
              savedAt: (/* @__PURE__ */ new Date()).toISOString()
            };
            saveCredentials(credentialsFile, account);
            log3("Token \u5237\u65B0\u6210\u529F\uFF01");
            loginResolved = true;
            setTimeout(() => server.close(), 3e3);
            resolve(account);
            return;
          }
        } catch (err) {
          log3(`\u626B\u7801\u72B6\u6001\u67E5\u8BE2\u5F02\u5E38: ${String(err)}`);
        }
        await new Promise((r) => setTimeout(r, 2e3));
      }
      if (!loginResolved) {
        loginResolved = true;
        server.close();
        resolve(null);
      }
    }
    tryListen(QR_SERVER_BASE_PORT);
  });
}

// src/state.ts
import fs3 from "node:fs";
var MAX_CACHE_ENTRIES = 500;
function log(msg) {
  process.stderr.write(`[state] ${msg}
`);
}
var ContextTokenCache = class {
  cache;
  filePath;
  writeTimer = null;
  constructor(filePath) {
    this.filePath = filePath;
    this.cache = /* @__PURE__ */ new Map();
    try {
      const raw = fs3.readFileSync(filePath, "utf-8");
      for (const [k, v] of Object.entries(JSON.parse(raw))) {
        if (typeof v === "string") this.cache.set(k, v);
      }
    } catch {
    }
  }
  set(key, token) {
    this.cache.set(key, token);
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const entries = [...this.cache.entries()];
      this.cache = new Map(entries.slice(-Math.floor(MAX_CACHE_ENTRIES / 2)));
    }
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        this.flush();
      }, 100);
    }
  }
  get(key) {
    const exact = this.cache.get(key);
    if (exact) return exact;
    const bareKey = key.split("@")[0];
    for (const [k, v] of this.cache) {
      if (k.split("@")[0] === bareKey) return v;
    }
    if (this.cache.size === 1) {
      const [, token] = [...this.cache.entries()][0];
      log(`context_token: \u5355\u7528\u6237 fallback (key=${key}, cache\u6709 ${[...this.cache.keys()][0]})`);
      return token;
    }
    return void 0;
  }
  clear() {
    this.cache.clear();
    try {
      fs3.writeFileSync(this.filePath, "{}", "utf-8");
    } catch {
    }
  }
  flush() {
    try {
      fs3.writeFileSync(
        this.filePath,
        JSON.stringify(Object.fromEntries(this.cache), null, 2),
        "utf-8"
      );
      try {
        fs3.chmodSync(this.filePath, 384);
      } catch {
      }
    } catch {
    }
  }
};
var conversations = /* @__PURE__ */ new Map();
var TYPING_INTERVAL_MS = 5e3;
var PROGRESS_MAX_MS = 5 * 60 * 1e3;
var CONV_EXPIRE_MS = 30 * 60 * 1e3;
var typingTicker = setInterval(() => {
  const now = Date.now();
  for (const [key, conv] of conversations) {
    const lastActive = Math.max(conv.lastUserMsgAt, conv.lastBotReplyAt);
    if (now - lastActive > CONV_EXPIRE_MS) {
      conversations.delete(key);
      continue;
    }
    const userWaiting = conv.lastUserMsgAt > conv.lastBotReplyAt;
    const elapsed = now - conv.lastUserMsgAt;
    if (!userWaiting || elapsed > PROGRESS_MAX_MS) continue;
    showTypingIndicator(conv.baseUrl, conv.token, conv.toUserId, conv.contextToken).catch(() => {
    });
  }
}, TYPING_INTERVAL_MS);
typingTicker.unref();
function onUserMessage(baseUrl, token, toUserId, contextToken, contextKey) {
  let conv = conversations.get(contextKey);
  if (!conv) {
    conv = { lastUserMsgAt: 0, lastBotReplyAt: 0, baseUrl, token, toUserId, contextToken };
    conversations.set(contextKey, conv);
  }
  conv.lastUserMsgAt = Date.now();
  conv.baseUrl = baseUrl;
  conv.token = token;
  conv.toUserId = toUserId;
  conv.contextToken = contextToken;
  showTypingIndicator(baseUrl, token, toUserId, contextToken).catch(() => {
  });
}
function onBotReply(contextKey) {
  const conv = conversations.get(contextKey);
  if (conv) conv.lastBotReplyAt = Date.now();
}

// src/polling.ts
import fs4 from "node:fs";
var MAX_CONSECUTIVE_FAILURES = 3;
var MAX_MEDIA_FAILURES = 3;
var BACKOFF_DELAY_MS = 3e4;
var RETRY_DELAY_MS = 2e3;
async function startPolling(account, deps) {
  const { mcp: mcp2, profileName, paths: paths2, contextTokens: contextTokens2, setActiveAccount, log: log3, logError: logError2 } = deps;
  let { baseUrl, token } = account;
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;
  let consecutiveMediaFailures = 0;
  let mcpFailures = 0;
  try {
    if (fs4.existsSync(paths2.syncBufFile)) {
      getUpdatesBuf = fs4.readFileSync(paths2.syncBufFile, "utf-8");
      log3(`\u6062\u590D\u540C\u6B65\u72B6\u6001 (${getUpdatesBuf.length} bytes)`);
    }
  } catch {
  }
  function reloadAccountIfChanged() {
    try {
      const raw = JSON.parse(fs4.readFileSync(paths2.credentialsFile, "utf-8"));
      if (raw.token && raw.token !== token) {
        log3("\u68C0\u6D4B\u5230 token \u66F4\u65B0");
        token = raw.token;
        baseUrl = raw.baseUrl || baseUrl;
        setActiveAccount(raw);
      }
    } catch {
    }
  }
  async function sendExitNotification(reason) {
    try {
      const profileConfig = loadProfileConfig(paths2.profileConfigFile);
      const recipient = profileConfig.allow_from?.[0];
      const ct = contextTokens2.get(recipient || "");
      if (!recipient || !ct) return;
      await sendTextMessage(baseUrl, token, recipient, reason, ct);
    } catch {
    }
  }
  process.stdin.on("end", () => {
    sendExitNotification(`[${profileName}] Claude CLI \u5DF2\u65AD\u5F00`).finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    sendExitNotification(`[${profileName}] \u670D\u52A1\u5DF2\u505C\u6B62`).finally(() => process.exit(0));
  });
  log3("\u5F00\u59CB\u76D1\u542C\u5FAE\u4FE1\u6D88\u606F...");
  while (true) {
    try {
      reloadAccountIfChanged();
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);
      const isError = resp.ret !== void 0 && resp.ret !== 0 || resp.errcode !== void 0 && resp.errcode !== 0;
      if (isError) {
        consecutiveFailures++;
        logError2(`\u6D88\u606F\u62C9\u53D6\u5931\u8D25: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);
        const isAuthError = resp.errcode === 401 || resp.errcode === 403 || resp.errcode === -14 || resp.ret === -1 || (resp.errmsg ?? "").toLowerCase().includes("token") || (resp.errmsg ?? "").toLowerCase().includes("session");
        if (isAuthError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logError2("\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u6B63\u5728\u91CD\u65B0\u8FDE\u63A5...");
          try {
            const profileConfig = loadProfileConfig(paths2.profileConfigFile);
            const recipient = profileConfig.allow_from?.[0];
            const ct = contextTokens2.get(recipient || "");
            if (recipient && ct) {
              await sendTextMessage(
                baseUrl,
                token,
                recipient,
                `[${profileName}] Token \u8FC7\u671F\uFF0C\u9700\u8981\u91CD\u65B0\u626B\u7801\u767B\u5F55\u3002\u8BF7\u5728\u7EC8\u7AEF\u67E5\u770B\u4E8C\u7EF4\u7801\u3002`,
                ct
              );
            }
          } catch {
          }
          const newAccount = await doQRLoginWithWebServer(baseUrl, profileName, paths2.credentialsFile, log3);
          if (newAccount) {
            token = newAccount.token;
            baseUrl = newAccount.baseUrl;
            setActiveAccount(newAccount);
            getUpdatesBuf = "";
            contextTokens2.clear();
            try {
              fs4.writeFileSync(paths2.syncBufFile, "", "utf-8");
            } catch {
            }
            consecutiveFailures = 0;
            log3("Token \u5237\u65B0\u5B8C\u6210");
            continue;
          }
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          try {
            const profileConfig = loadProfileConfig(paths2.profileConfigFile);
            const recipient = profileConfig.allow_from?.[0];
            const ct = contextTokens2.get(recipient || "");
            if (recipient && ct) {
              await sendTextMessage(
                baseUrl,
                token,
                recipient,
                `[${profileName}] \u8FDE\u63A5\u5F02\u5E38\uFF0C${BACKOFF_DELAY_MS / 1e3}\u79D2\u540E\u91CD\u8BD5\u3002errmsg: ${resp.errmsg ?? "unknown"}`,
                ct
              );
            }
          } catch {
          }
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
        try {
          fs4.writeFileSync(paths2.syncBufFile, getUpdatesBuf, "utf-8");
        } catch {
        }
      }
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;
        if (!msg.from_user_id) continue;
        const extracted = extractContent(msg);
        if (!extracted) continue;
        if (extracted.mediaItem) {
          const mi = extracted.mediaItem;
          let { encryptQueryParam, aesKeyBase64 } = resolveMediaDownloadInfo(mi);
          if (encryptQueryParam && aesKeyBase64) {
            consecutiveMediaFailures = 0;
            const cdnUrl = buildCdnDownloadUrl(encryptQueryParam);
            let fileName = extracted.msgType === "file" && typeof mi.file_name === "string" ? mi.file_name : extracted.msgType === "image" ? "image.jpg" : extracted.msgType === "video" ? "video.mp4" : `media_${extracted.msgType}`;
            const localPath = await downloadMediaToFile(cdnUrl, aesKeyBase64, fileName, paths2.mediaDir, log3);
            if (localPath) {
              extracted.localPath = localPath;
              extracted.text = `[${extracted.msgType} \u5DF2\u4FDD\u5B58\u5230 ${localPath}]`;
            }
          } else {
            consecutiveMediaFailures++;
            logError2(`\u5A92\u4F53\u6570\u636E\u7F3A\u5931 (${consecutiveMediaFailures}/${MAX_MEDIA_FAILURES}): ${extracted.msgType} \u65E0 encrypt_query_param/aes_key`);
            if (consecutiveMediaFailures >= MAX_MEDIA_FAILURES) {
              log3("\u5A92\u4F53 token \u53EF\u80FD\u5DF2\u964D\u7EA7\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u65B0\u767B\u5F55...");
              try {
                const ct = contextTokens2.get(msg.from_user_id) || contextTokens2.get(msg.group_id || "");
                if (ct) {
                  await sendTextMessage(
                    baseUrl,
                    token,
                    msg.from_user_id,
                    `[${profileName}] \u5A92\u4F53\u6743\u9650\u8FC7\u671F\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u65B0\u767B\u5F55\uFF0C\u8BF7\u7A0D\u5019...`,
                    ct
                  );
                }
              } catch {
              }
              const newAccount = await doQRLoginWithWebServer(baseUrl, profileName, paths2.credentialsFile, log3);
              if (newAccount) {
                token = newAccount.token;
                baseUrl = newAccount.baseUrl;
                setActiveAccount(newAccount);
                consecutiveMediaFailures = 0;
                log3("\u5A92\u4F53 token \u5237\u65B0\u5B8C\u6210\uFF0C\u91CD\u8BD5\u4E0B\u8F7D...");
                try {
                  const ct = contextTokens2.get(msg.from_user_id) || contextTokens2.get(msg.group_id || "");
                  if (ct) {
                    await sendTextMessage(
                      baseUrl,
                      token,
                      msg.from_user_id,
                      `[${profileName}] \u91CD\u65B0\u767B\u5F55\u6210\u529F\uFF0C\u540E\u7EED\u5A92\u4F53\u6D88\u606F\u6062\u590D\u6B63\u5E38\u3002\u521A\u624D\u7684${extracted.msgType}\u8BF7\u91CD\u65B0\u53D1\u9001\u3002`,
                      ct
                    );
                  }
                } catch {
                }
              }
            }
          }
        }
        const profileConfig = loadProfileConfig(paths2.profileConfigFile);
        if (isPaused(paths2.pausedFile)) continue;
        const senderId = msg.from_user_id;
        const groupId = msg.group_id;
        const isGroup = Boolean(groupId);
        const allowList = Array.isArray(profileConfig.allow_from) ? profileConfig.allow_from : [];
        if (allowList.length > 0) {
          const senderBare = senderId.split("@")[0] || senderId;
          const allowed = allowList.some((id) => id === senderId || id === senderBare);
          if (!allowed) {
            log3(`\u62D2\u7EDD: ${senderId}`);
            continue;
          }
        }
        const contextKey = groupId || senderId;
        if (!contextKey) {
          log3(`\u8DF3\u8FC7: \u6D88\u606F\u65E0\u6709\u6548 contextKey (senderId=${senderId})`);
          continue;
        }
        log3(`context_token: ${msg.context_token ? "\u6709(" + msg.context_token.slice(0, 20) + "...)" : "\u65E0"} key=${contextKey}`);
        if (msg.context_token) {
          contextTokens2.set(contextKey, msg.context_token);
          if (isGroup) contextTokens2.set(senderId, msg.context_token);
        } else {
          log3(`\u6D88\u606F\u7F3A\u5C11 context_token: from=${senderId}`);
        }
        const canReply = Boolean(contextTokens2.get(contextKey));
        const senderShort = senderId.split("@")[0] || senderId;
        log3(`\u6536\u5230${isGroup ? "\u7FA4" : "\u79C1"}\u6D88\u606F [${extracted.msgType}]: from=${senderShort} can_reply=${canReply}`);
        try {
          fs4.writeFileSync(paths2.lastActivityFile, String(Date.now()));
        } catch {
        }
        if (canReply && msg.context_token) {
          onUserMessage(baseUrl, token, senderId, msg.context_token, contextKey);
        }
        const meta = {
          sender: senderShort,
          sender_id: isGroup ? groupId : senderId,
          msg_type: extracted.msgType,
          can_reply: String(canReply)
        };
        if (isGroup) {
          meta.is_group = "true";
          meta.group_id = groupId;
          meta.from_sender_id = senderId;
        }
        try {
          await mcp2.notification({
            method: "notifications/claude/channel",
            params: { content: extracted.text, meta }
          });
          mcpFailures = 0;
        } catch (mcpErr) {
          mcpFailures++;
          logError2(`\u6D88\u606F\u8F6C\u53D1\u5931\u8D25 (${mcpFailures}/3): ${mcpErr}`);
          if (mcpFailures >= 3) {
            logError2("\u4E0E Claude \u7684\u8FDE\u63A5\u65AD\u5F00\uFF0C\u7A0B\u5E8F\u9000\u51FA\u3002\u8BF7\u91CD\u65B0\u8FD0\u884C wechat-channel");
            process.exit(1);
          }
        }
      }
    } catch (err) {
      consecutiveFailures++;
      logError2(`\u6D88\u606F\u63A5\u6536\u5F02\u5E38: ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        try {
          const profileConfig = loadProfileConfig(paths2.profileConfigFile);
          const recipient = profileConfig.allow_from?.[0];
          const ct = contextTokens2.get(recipient || "");
          if (recipient && ct) {
            await sendTextMessage(
              baseUrl,
              token,
              recipient,
              `[${profileName}] \u8F6E\u8BE2\u5F02\u5E38\uFF0C${BACKOFF_DELAY_MS / 1e3}\u79D2\u540E\u91CD\u8BD5: ${String(err).slice(0, 100)}`,
              ct
            );
          }
        } catch {
        }
        consecutiveFailures = 0;
        await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
      } else {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
}

// src/mailbox.ts
import fs5 from "node:fs";
import path3 from "node:path";
var MAILBOX_PATH = path3.join(process.env.HOME || "", ".claude", "mailbox.jsonl");
var POLL_INTERVAL_MS = 3e3;
function formatMailboxMsg(entry) {
  const prefix = entry.level === "error" ? "[\u7D27\u6025] " : "";
  return `${prefix}[${entry.from}] ${entry.msg}`;
}
function startMailboxWatcher(getAccount, contextTokens2, recipientId, log3) {
  if (!recipientId) {
    log3("mailbox-watcher: \u65E0\u53D1\u9001\u76EE\u6807\uFF08allow_from\u4E3A\u7A7A\uFF09\uFF0C\u8DF3\u8FC7");
    return;
  }
  let offset = 0;
  try {
    if (fs5.existsSync(MAILBOX_PATH)) {
      const stat = fs5.statSync(MAILBOX_PATH);
      offset = stat.size;
    }
  } catch {
  }
  log3(`mailbox-watcher: \u542F\u52A8\u76D1\u542C (offset=${offset})`);
  const timer = setInterval(() => {
    try {
      if (!fs5.existsSync(MAILBOX_PATH)) return;
      const stat = fs5.statSync(MAILBOX_PATH);
      if (stat.size < offset) {
        offset = 0;
      }
      if (stat.size <= offset) return;
      const fd = fs5.openSync(MAILBOX_PATH, "r");
      const buf = Buffer.alloc(stat.size - offset);
      fs5.readSync(fd, buf, 0, buf.length, offset);
      fs5.closeSync(fd);
      offset = stat.size;
      const newContent = buf.toString("utf-8");
      const lines = newContent.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (!entry.cc?.includes("\u5C0F\u8863\u670D")) continue;
          const account = getAccount();
          if (!account) {
            log3("mailbox-watcher: \u672A\u767B\u5F55\uFF0C\u8DF3\u8FC7\u901A\u77E5");
            continue;
          }
          const ct = contextTokens2.get(recipientId);
          if (!ct) {
            log3("mailbox-watcher: \u65E0 context_token\uFF0C\u8DF3\u8FC7\u901A\u77E5");
            continue;
          }
          const text = formatMailboxMsg(entry);
          sendTextMessage(account.baseUrl, account.token, recipientId, text, ct).then(() => log3(`mailbox-watcher: \u5DF2\u63A8\u9001 [${entry.from}] ${entry.task_id || ""}`)).catch((err) => log3(`mailbox-watcher: \u63A8\u9001\u5931\u8D25: ${String(err)}`));
        } catch {
        }
      }
    } catch (err) {
      log3(`mailbox-watcher: \u8BFB\u53D6\u5F02\u5E38: ${String(err)}`);
    }
  }, POLL_INTERVAL_MS);
  timer.unref();
}

// server.ts
var PROFILE_NAME = resolveProfileName();
var paths = getProfilePaths(PROFILE_NAME);
ensureDirectories(paths);
var lockResult = acquireLock(paths.pidFile);
process.on("exit", () => releaseLock(paths.pidFile));
cleanOldMedia(paths.mediaDir);
var contextTokens = new ContextTokenCache(paths.contextTokenFile);
function log2(msg) {
  process.stderr.write(`[wechat:${PROFILE_NAME}] ${msg}
`);
}
function logError(msg) {
  process.stderr.write(`[wechat:${PROFILE_NAME}] ERROR: ${msg}
`);
}
function buildInstructions() {
  const profileConfig = loadProfileConfig(paths.profileConfigFile);
  const hasCredentials = fs6.existsSync(paths.credentialsFile);
  const parts = [];
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
      "- Speak Chinese. Be warm and concise."
    );
    return parts.join("\n");
  }
  if (profileConfig.identity) {
    parts.push(`## Your Identity
${profileConfig.identity}
`);
  }
  if (profileConfig.rules) {
    parts.push(`## Behavior Rules (MUST follow)
${profileConfig.rules}
`);
  }
  parts.push(
    'Messages from WeChat users arrive as <channel source="wechat" ...> tags.',
    "",
    `Active profile: "${PROFILE_NAME}"`,
    `Profile directory: ${paths.credentialsDir}`,
    `Memory directory: ${paths.memoryDir}`,
    "",
    "## WeChat Protocol",
    "",
    "Tag attributes:",
    "  sender       \u2014 display name (xxx part of xxx@im.wechat)",
    "  sender_id    \u2014 full user ID (xxx@im.wechat) \u2014 REQUIRED for all reply tools",
    "  msg_type     \u2014 text | voice | image | file | video | unknown",
    "  can_reply    \u2014 'true': reply normally; 'false': no session token, tell the user to send another message",
    "  is_group     \u2014 'true' if from a group chat",
    "  group_id     \u2014 group ID when is_group=true (use this as the reply target in groups)",
    "",
    "Tools available:",
    "  wechat_reply        \u2014 send a plain-text reply (always available)",
    "  wechat_send_image   \u2014 send an image file from local disk (provide absolute path)",
    "  wechat_send_file    \u2014 send a file from local disk (documents, PDFs, etc.)",
    "",
    "Rules:",
    "  - If can_reply=false, do NOT call wechat_reply. Instead output: 'NOTICE: cannot reply, session token missing. User must send one more message.'",
    "  - Otherwise always use wechat_reply or wechat_send_image \u2014 never leave a message unanswered.",
    "  - In group chats (is_group=true), pass the group_id as sender_id to reply to the group.",
    "  - Strip all markdown \u2014 WeChat renders plain text only.",
    "  - Keep replies concise. WeChat is a chat app.",
    "  - Default language is Chinese unless the user writes in another language.",
    "  - For voice messages the transcript is already in the content \u2014 treat it as text.",
    "  - For image/file messages: they are auto-downloaded to local disk. The message text contains the local path \u2014 use Read tool to view images or process files.",
    "",
    "## Memory System (Critical)",
    "",
    "You have a persistent memory system. Session may restart at any time \u2014 memory is your only continuity.",
    "",
    "### On startup (NOW):",
    `1. Read all files in ${paths.memoryDir} \u2014 this is your memory from previous sessions.`,
    "2. Greet the user based on what you remember, not as a stranger.",
    "",
    "### During conversation:",
    "- After each meaningful exchange, write a brief summary to memory.",
    `  File: ${paths.memoryDir}/\u5BF9\u8BDD\u8BB0\u5F55.md (append, newest first)`,
    "- If the user mentions past events, check memory files first."
  );
  const memory = loadAllMemory(paths.memoryDir, loadProfileConfig(paths.profileConfigFile).workdir || process.env.HOME || "/");
  if (memory) parts.push("", memory);
  return parts.join("\n");
}
var mcp = new Server(
  { name: CHANNEL_NAME, version: CHANNEL_VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {}
    },
    instructions: buildInstructions()
  }
);
var activeAccount = null;
var pollingActive = false;
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_reply",
      description: "Send a plain-text reply to the WeChat user (or group)",
      inputSchema: {
        type: "object",
        properties: {
          sender_id: { type: "string", description: "sender_id from the inbound tag. In group chats use group_id." },
          text: { type: "string", description: "Plain-text message (no markdown)" }
        },
        required: ["sender_id", "text"]
      }
    },
    {
      name: "wechat_send_image",
      description: "Send a local image file to the WeChat user",
      inputSchema: {
        type: "object",
        properties: {
          sender_id: { type: "string", description: "Same as wechat_reply sender_id" },
          file_path: { type: "string", description: "Absolute path to image file (PNG, JPG)" }
        },
        required: ["sender_id", "file_path"]
      }
    },
    {
      name: "wechat_send_file",
      description: "Send a local file to the WeChat user (documents, PDFs, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          sender_id: { type: "string", description: "Same as wechat_reply sender_id" },
          file_path: { type: "string", description: "Absolute path to the file" }
        },
        required: ["sender_id", "file_path"]
      }
    },
    {
      name: "wechat_login",
      description: "Start QR code login flow to connect a WeChat account. Opens a web page with the QR code for scanning.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "wechat_status",
      description: "Check current WeChat connection status \u2014 profile name, login state, last activity.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ]
}));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "wechat_login") {
    log2("\u6536\u5230\u767B\u5F55\u8BF7\u6C42\uFF0C\u542F\u52A8\u626B\u7801...");
    const account = await doQRLoginWithWebServer(DEFAULT_BASE_URL, PROFILE_NAME, paths.credentialsFile, log2);
    if (account) {
      activeAccount = account;
      if (account.userId) {
        const config = loadProfileConfig(paths.profileConfigFile);
        const allowList = config.allow_from ?? [];
        if (!allowList.includes(account.userId)) {
          config.allow_from = [account.userId, ...allowList];
          fs6.writeFileSync(paths.profileConfigFile, JSON.stringify(config, null, 2), "utf-8");
          log2(`\u767D\u540D\u5355\u5DF2\u81EA\u52A8\u6DFB\u52A0\u626B\u7801\u7528\u6237: ${account.userId}`);
        }
      }
      if (!pollingActive) {
        pollingActive = true;
        const config = loadProfileConfig(paths.profileConfigFile);
        startMailboxWatcher(() => activeAccount, contextTokens, config.allow_from?.[0] ?? null, log2);
        startPolling(account, {
          mcp,
          profileName: PROFILE_NAME,
          paths,
          contextTokens,
          setActiveAccount: (a) => {
            activeAccount = a;
          },
          log: log2,
          logError
        }).catch((err) => {
          logError(`\u274C \u6D88\u606F\u63A5\u6536\u5F02\u5E38\uFF0C\u7A0B\u5E8F\u5DF2\u9000\u51FA: ${err}`);
          process.exit(1);
        });
      }
      return { content: [{ type: "text", text: `\u767B\u5F55\u6210\u529F\uFF01\u8D26\u53F7: ${account.accountId}\uFF0CProfile: ${PROFILE_NAME}\u3002\u5FAE\u4FE1\u6D88\u606F\u76D1\u542C\u5DF2\u542F\u52A8\u3002\u626B\u7801\u7528\u6237\u5DF2\u81EA\u52A8\u52A0\u5165\u767D\u540D\u5355\u3002` }] };
    }
    return { content: [{ type: "text", text: "\u767B\u5F55\u5931\u8D25\u6216\u8D85\u65F6\u3002\u8BF7\u91CD\u8BD5\u3002" }] };
  }
  if (req.params.name === "wechat_status") {
    const lastActivity = (() => {
      try {
        return fs6.readFileSync(paths.lastActivityFile, "utf-8").trim();
      } catch {
        return null;
      }
    })();
    const status = {
      profile: PROFILE_NAME,
      logged_in: Boolean(activeAccount),
      account_id: activeAccount?.accountId ?? null,
      paused: isPaused(paths.pausedFile),
      last_activity: lastActivity ? new Date(Number(lastActivity)).toISOString() : null,
      profile_dir: paths.credentialsDir
    };
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
  if (!activeAccount) return { content: [{ type: "text", text: "\u274C \u672A\u767B\u5F55\u5FAE\u4FE1\uFF0C\u8BF7\u5148\u8C03\u7528 wechat_login \u626B\u7801\u8FDE\u63A5" }] };
  const { baseUrl, token } = activeAccount;
  const args = req.params.arguments ?? {};
  const senderId = args.sender_id;
  if (!senderId || typeof senderId !== "string") {
    return { content: [{ type: "text", text: "\u274C \u7F3A\u5C11 sender_id \u53C2\u6570" }] };
  }
  const ct = contextTokens.get(senderId);
  if (!ct) {
    return { content: [{ type: "text", text: `\u274C \u65E0\u6CD5\u56DE\u590D ${senderId}\uFF0C\u8BF7\u8BA9\u5BF9\u65B9\u5148\u53D1\u4E00\u6761\u6D88\u606F` }] };
  }
  try {
    if (req.params.name === "wechat_reply") {
      const text = args.text;
      if (!text || typeof text !== "string") {
        return { content: [{ type: "text", text: "\u274C \u7F3A\u5C11 text \u53C2\u6570" }] };
      }
      await sendTextMessage(baseUrl, token, senderId, text, ct);
      onBotReply(senderId);
      return { content: [{ type: "text", text: "sent" }] };
    }
    if (req.params.name === "wechat_send_image" || req.params.name === "wechat_send_file") {
      const rawPath = args.file_path;
      if (!rawPath || typeof rawPath !== "string") {
        return { content: [{ type: "text", text: "\u274C \u7F3A\u5C11 file_path \u53C2\u6570" }] };
      }
      let filePath;
      try {
        filePath = fs6.realpathSync(path4.resolve(rawPath));
      } catch {
        return { content: [{ type: "text", text: `\u274C \u6587\u4EF6\u4E0D\u5B58\u5728: ${path4.basename(rawPath)}` }] };
      }
      const allowedRoots = [process.cwd(), process.env.HOME || "", paths.mediaDir].filter(Boolean).map((p) => {
        try {
          return fs6.realpathSync(p);
        } catch {
          return path4.resolve(p);
        }
      });
      if (!allowedRoots.some((root) => filePath.startsWith(root + path4.sep) || filePath === root)) {
        return { content: [{ type: "text", text: "\u274C \u6587\u4EF6\u8DEF\u5F84\u4E0D\u5728\u5141\u8BB8\u8303\u56F4\u5185" }] };
      }
      const stat = fs6.statSync(filePath);
      const maxSize = req.params.name === "wechat_send_image" ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
      if (stat.size > maxSize) return { content: [{ type: "text", text: `\u274C \u6587\u4EF6\u592A\u5927\uFF08\u6700\u5927 ${maxSize / 1024 / 1024}MB\uFF09` }] };
      const buf = fs6.readFileSync(filePath);
      if (req.params.name === "wechat_send_image") {
        await sendImageMessage(baseUrl, token, senderId, buf, ct);
      } else {
        await sendFileMessage(baseUrl, token, senderId, buf, path4.basename(filePath), ct);
      }
      onBotReply(senderId);
      return { content: [{ type: "text", text: `file sent: ${path4.basename(rawPath)}` }] };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `\u274C \u53D1\u9001\u5931\u8D25: ${String(err)}` }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});
async function main() {
  for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    delete process.env[k];
  }
  if (process.env.WECHAT_LOGIN_ONLY === "1") {
    log2("\u626B\u7801\u767B\u5F55\u6A21\u5F0F...");
    const account2 = await doQRLoginWithWebServer(DEFAULT_BASE_URL, PROFILE_NAME, paths.credentialsFile, log2);
    if (!account2) {
      log2("\u767B\u5F55\u5931\u8D25\u6216\u8D85\u65F6\u3002");
      process.exit(1);
    }
    log2(`\u767B\u5F55\u6210\u529F\uFF01\u8D26\u53F7: ${account2.accountId}`);
    if (account2.userId) {
      const config = loadProfileConfig(paths.profileConfigFile);
      const allowList = config.allow_from ?? [];
      if (!allowList.includes(account2.userId)) {
        config.allow_from = [account2.userId, ...allowList];
        fs6.writeFileSync(paths.profileConfigFile, JSON.stringify(config, null, 2), "utf-8");
        log2(`\u767D\u540D\u5355\u5DF2\u81EA\u52A8\u6DFB\u52A0\u626B\u7801\u7528\u6237: ${account2.userId}`);
      }
    }
    process.exit(0);
  }
  await mcp.connect(new StdioServerTransport());
  if (lockResult.recovered) {
    log2(`\u26A0 \u4E0A\u6B21\u672A\u6B63\u5E38\u9000\u51FA\uFF08\u8FDB\u7A0B ${lockResult.stalePid} \u5DF2\u4E0D\u5B58\u5728\uFF09\uFF0C\u5DF2\u81EA\u52A8\u6062\u590D`);
  }
  let account = loadCredentials(paths.credentialsFile);
  const lastActivity = (() => {
    try {
      return fs6.readFileSync(paths.lastActivityFile, "utf-8").trim();
    } catch {
      return null;
    }
  })();
  const profileConfig = loadProfileConfig(paths.profileConfigFile);
  const summaryParts = [
    `v${CHANNEL_VERSION}`,
    `Profile: ${PROFILE_NAME}`,
    account ? `\u8D26\u53F7: ${account.accountId}` : "\u672A\u767B\u5F55",
    lastActivity ? `\u4E0A\u6B21\u6D3B\u52A8: ${new Date(Number(lastActivity)).toLocaleString("zh-CN")}` : null,
    profileConfig.allow_from?.length ? `\u767D\u540D\u5355: ${profileConfig.allow_from.length}\u4EBA` : null
  ].filter(Boolean);
  log2(summaryParts.join(" | "));
  if (!account) {
    log2("\u672A\u627E\u5230\u51ED\u636E\u3002\u8BF7\u8FD0\u884C wechat-channel new <\u540D\u5B57> \u521B\u5EFAprofile\u5E76\u626B\u7801\u767B\u5F55\u3002");
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: "\u5FAE\u4FE1\u672A\u8FDE\u63A5\u3002\u8BF7\u9000\u51FA\u540E\u8FD0\u884C wechat-channel new <\u540D\u5B57> \u5B8C\u6210\u626B\u7801\u767B\u5F55\u3002",
          meta: { sender: "system", sender_id: "system", msg_type: "setup", can_reply: "false" }
        }
      });
    } catch {
    }
    await new Promise(() => {
    });
  }
  log2(`\u4F7F\u7528\u5DF2\u4FDD\u5B58\u8D26\u53F7: ${account.accountId}`);
  activeAccount = account;
  const mailboxRecipient = profileConfig.allow_from?.[0] ?? null;
  startMailboxWatcher(() => activeAccount, contextTokens, mailboxRecipient, log2);
  await startPolling(account, {
    mcp,
    profileName: PROFILE_NAME,
    paths,
    contextTokens,
    setActiveAccount: (a) => {
      activeAccount = a;
    },
    log: log2,
    logError
  });
}
main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
