/**
 * CDN media download/upload with AES encryption.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { apiFetch } from "./api.js";
import { decryptAesEcb, encryptAesEcb } from "./crypto.js";
import { CDN_BASE_URL, CHANNEL_VERSION, type UploadUrlResp } from "./types.js";

// ── Download ───────────────────────────────────────────────────────────────

export function buildCdnDownloadUrl(encryptQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

/**
 * Deep-search a media item for encrypt_query_param and aes_key.
 * The iLink API nests these fields inconsistently across message types.
 */
export function resolveMediaDownloadInfo(obj: Record<string, unknown>): {
  encryptQueryParam: string | null;
  aesKeyBase64: string | null;
} {
  let encryptQueryParam: string | null = null;
  let aesKeyBase64: string | null = null;

  function scan(o: unknown, depth = 0): void {
    if (!o || typeof o !== "object" || depth > 4) return;
    const rec = o as Record<string, unknown>;

    if (typeof rec.encrypt_query_param === "string" && rec.encrypt_query_param && !encryptQueryParam) {
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

export async function downloadAndDecryptMedia(
  cdnUrl: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());
  return decryptAesEcb(encrypted, aesKeyBase64);
}

export async function downloadMediaToFile(
  cdnUrl: string,
  aesKeyBase64: string,
  fileName: string,
  mediaDir: string,
  log: (msg: string) => void,
): Promise<string | null> {
  try {
    const data = await downloadAndDecryptMedia(cdnUrl, aesKeyBase64);
    const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path.join(mediaDir, `${Date.now()}_${safeName}`);
    fs.writeFileSync(filePath, data);
    log(`媒体已保存: ${filePath} (${(data.length / 1024).toFixed(1)} KB)`);
    return filePath;
  } catch (err) {
    log(`媒体下载失败: ${String(err)}`);
    return null;
  }
}

// ── Upload ─────────────────────────────────────────────────────────────────

export async function getUploadUrl(
  baseUrl: string,
  token: string,
  params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    no_need_thumb: boolean;
    aeskey: string;
  },
): Promise<UploadUrlResp> {
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      ...params,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
  return JSON.parse(raw) as UploadUrlResp;
}

export async function uploadToCdn(
  uploadParam: string,
  filekey: string,
  ciphertext: Buffer,
): Promise<string> {
  const cdnUploadUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const res = await fetch(cdnUploadUrl, {
    method: "POST",
    body: new Uint8Array(ciphertext),
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(ciphertext.length),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`CDN upload failed: ${res.status}`);
  const downloadParam = res.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("CDN upload response missing x-encrypted-param header");
  return downloadParam;
}
