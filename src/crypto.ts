/**
 * AES-128-ECB encryption/decryption for WeChat CDN media.
 */

import crypto from "node:crypto";

/**
 * Parse AES key from base64.
 * Format A: base64(raw 16 bytes) — images typically use this
 * Format B: base64(hex string of 32 chars) — files/voice/video use this
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Invalid aes_key: decoded length ${decoded.length}, expected 16 or 32(hex)`);
}

export function decryptAesEcb(data: Buffer, keyBase64: string): Buffer {
  const key = parseAesKey(keyBase64);
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
