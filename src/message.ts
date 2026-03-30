/**
 * Message parsing, sending, and text utilities.
 */

import crypto from "node:crypto";
import { apiFetch } from "./api.js";
import { encryptAesEcb } from "./crypto.js";
import { getUploadUrl, uploadToCdn } from "./cdn.js";
import {
  CHANNEL_VERSION, MSG_TYPE_BOT, MSG_STATE_FINISH,
  MSG_ITEM_TEXT, MSG_ITEM_IMAGE, MSG_ITEM_VOICE, MSG_ITEM_FILE, MSG_ITEM_VIDEO,
  UPLOAD_MEDIA_IMAGE, UPLOAD_MEDIA_FILE,
  type WeixinMessage, type ExtractedContent, type GetUpdatesResp,
} from "./types.js";

// ── Parsing ────────────────────────────────────────────────────────────────

export function extractContent(msg: WeixinMessage): ExtractedContent | null {
  if (!msg.item_list?.length) return null;

  for (const item of msg.item_list) {
    switch (item.type) {
      case MSG_ITEM_TEXT: {
        if (!item.text_item?.text) continue;
        let text = item.text_item.text;
        if (item.ref_msg?.title) {
          text = `[引用: ${item.ref_msg.title}]\n${text}`;
        }
        return { text, msgType: "text" };
      }
      case MSG_ITEM_VOICE: {
        const transcript = item.voice_item?.text;
        if (transcript) return { text: `[语音转文字] ${transcript}`, msgType: "voice" };
        return { text: "[语音消息（无文字转录）]", msgType: "voice" };
      }
      case MSG_ITEM_IMAGE: {
        const img = item.image_item;
        const dims = img?.width && img?.height ? ` (${img.width}x${img.height})` : "";
        return { text: `[图片${dims}]`, msgType: "image", mediaItem: img };
      }
      case MSG_ITEM_FILE: {
        const f = item.file_item;
        const name = f?.file_name ? ` "${f.file_name}"` : "";
        const size = f?.file_size ? ` (${(f.file_size / 1024).toFixed(1)} KB)` : "";
        return { text: `[文件${name}${size}]`, msgType: "file", mediaItem: f };
      }
      case MSG_ITEM_VIDEO: {
        const v = item.video_item;
        const dur = v?.duration_ms ? ` (${(v.duration_ms / 1000).toFixed(1)}s)` : "";
        return { text: `[视频${dur}]`, msgType: "video", mediaItem: v };
      }
      default:
        return { text: `[未知消息类型 ${item.type}]`, msgType: "unknown" };
    }
  }
  return null;
}

// ── Markdown to plain text ─────────────────────────────────────────────────

export function markdownToPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, "").replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\s*\d+\.\s+/gm, m => m)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

// ── Long message chunking ──────────────────────────────────────────────────

const MAX_WECHAT_MSG_LENGTH = 2000;

export function chunkMessage(text: string): string[] {
  if (text.length <= MAX_WECHAT_MSG_LENGTH) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > MAX_WECHAT_MSG_LENGTH) {
      if (current) chunks.push(current.trim());
      if (para.length > MAX_WECHAT_MSG_LENGTH) {
        // Split long paragraph by lines
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

  // Hard-split any chunk that still exceeds the limit (e.g. single long line without breaks)
  const result: string[] = [];
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

// ── Sending ────────────────────────────────────────────────────────────────

function generateClientId(): string {
  return `claude-code-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
  timeoutMs = 35_000,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

export async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  // Auto-convert markdown and chunk
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
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 15_000,
    });
  }
}

export async function sendImageMessage(
  baseUrl: string,
  token: string,
  to: string,
  imageBuffer: Buffer,
  contextToken: string,
): Promise<void> {
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const filekey = crypto.randomBytes(16).toString("hex");
  const rawsize = imageBuffer.length;
  const rawfilemd5 = crypto.createHash("md5").update(imageBuffer).digest("hex");
  const encrypted = encryptAesEcb(imageBuffer, aesKey);

  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey, media_type: UPLOAD_MEDIA_IMAGE, to_user_id: to,
    rawsize, rawfilemd5, filesize: encrypted.length,
    no_need_thumb: true, aeskey: aesKeyHex,
  });
  if (!uploadResp.upload_param) throw new Error(`getuploadurl failed: ${JSON.stringify(uploadResp)}`);

  const downloadParam = await uploadToCdn(uploadResp.upload_param, filekey, encrypted);
  const aesKeyForMsg = Buffer.from(aesKeyHex).toString("base64");

  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "", to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [{
          type: MSG_ITEM_IMAGE,
          image_item: { media: { encrypt_query_param: downloadParam, aes_key: aesKeyForMsg, encrypt_type: 1 }, mid_size: encrypted.length },
        }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
}

export async function sendFileMessage(
  baseUrl: string,
  token: string,
  to: string,
  fileBuffer: Buffer,
  fileName: string,
  contextToken: string,
): Promise<void> {
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const filekey = crypto.randomBytes(16).toString("hex");
  const rawsize = fileBuffer.length;
  const rawfilemd5 = crypto.createHash("md5").update(fileBuffer).digest("hex");
  const encrypted = encryptAesEcb(fileBuffer, aesKey);

  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey, media_type: UPLOAD_MEDIA_FILE, to_user_id: to,
    rawsize, rawfilemd5, filesize: encrypted.length,
    no_need_thumb: true, aeskey: aesKeyHex,
  });
  if (!uploadResp.upload_param) throw new Error(`getuploadurl failed: ${JSON.stringify(uploadResp)}`);

  const downloadParam = await uploadToCdn(uploadResp.upload_param, filekey, encrypted);
  const aesKeyForMsg = Buffer.from(aesKeyHex).toString("base64");

  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "", to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [{
          type: MSG_ITEM_FILE,
          file_item: { media: { encrypt_query_param: downloadParam, aes_key: aesKeyForMsg, encrypt_type: 1 }, file_name: fileName, len: String(rawsize) },
        }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
}

// ── Typing indicator ───────────────────────────────────────────────────────

export async function showTypingIndicator(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
): Promise<void> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({
        to_user_id: toUserId, context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 5_000,
    });
    const resp = JSON.parse(raw) as { typing_ticket?: string };
    if (!resp.typing_ticket) return;

    await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({
        to_user_id: toUserId, typing_ticket: resp.typing_ticket,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 5_000,
    });
  } catch { /* typing is best-effort */ }
}
