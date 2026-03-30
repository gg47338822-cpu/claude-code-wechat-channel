/**
 * Unit tests for wechat-channel-v2 core business logic.
 * Uses Node.js built-in test runner (node --test).
 *
 * Run: npx tsx --test test/unit.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── extractContent ────────────────────────────────────────────────────────

import { extractContent, markdownToPlainText, chunkMessage } from "../src/message.js";
import { MSG_ITEM_TEXT, MSG_ITEM_VOICE, MSG_ITEM_IMAGE, MSG_ITEM_FILE, MSG_ITEM_VIDEO } from "../src/types.js";

describe("extractContent", () => {
  it("extracts text message", () => {
    const msg = {
      item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: "hello" } }],
    };
    const result = extractContent(msg as any);
    assert.equal(result?.text, "hello");
    assert.equal(result?.msgType, "text");
  });

  it("extracts text with quoted reply", () => {
    const msg = {
      item_list: [{
        type: MSG_ITEM_TEXT,
        text_item: { text: "my reply" },
        ref_msg: { title: "original msg" },
      }],
    };
    const result = extractContent(msg as any);
    assert.equal(result?.text, "[引用: original msg]\nmy reply");
  });

  it("extracts voice message with transcript", () => {
    const msg = {
      item_list: [{ type: MSG_ITEM_VOICE, voice_item: { text: "hello world" } }],
    };
    const result = extractContent(msg as any);
    assert.equal(result?.text, "[语音转文字] hello world");
    assert.equal(result?.msgType, "voice");
  });

  it("extracts voice message without transcript", () => {
    const msg = {
      item_list: [{ type: MSG_ITEM_VOICE, voice_item: {} }],
    };
    const result = extractContent(msg as any);
    assert.equal(result?.text, "[语音消息（无文字转录）]");
  });

  it("extracts image message with dimensions", () => {
    const msg = {
      item_list: [{ type: MSG_ITEM_IMAGE, image_item: { width: 800, height: 600 } }],
    };
    const result = extractContent(msg as any);
    assert.equal(result?.text, "[图片 (800x600)]");
    assert.equal(result?.msgType, "image");
    assert.ok(result?.mediaItem);
  });

  it("extracts file message with name and size", () => {
    const msg = {
      item_list: [{ type: MSG_ITEM_FILE, file_item: { file_name: "doc.pdf", file_size: 102400 } }],
    };
    const result = extractContent(msg as any);
    assert.equal(result?.text, '[文件 "doc.pdf" (100.0 KB)]');
    assert.equal(result?.msgType, "file");
  });

  it("extracts video message with duration", () => {
    const msg = {
      item_list: [{ type: MSG_ITEM_VIDEO, video_item: { duration_ms: 15000 } }],
    };
    const result = extractContent(msg as any);
    assert.equal(result?.text, "[视频 (15.0s)]");
    assert.equal(result?.msgType, "video");
  });

  it("returns unknown for unrecognized type", () => {
    const msg = {
      item_list: [{ type: 999 }],
    };
    const result = extractContent(msg as any);
    assert.equal(result?.msgType, "unknown");
  });

  // ── Negative cases ──

  it("returns null for empty item_list", () => {
    assert.equal(extractContent({ item_list: [] } as any), null);
  });

  it("returns null for missing item_list", () => {
    assert.equal(extractContent({} as any), null);
  });

  it("skips text item with no text", () => {
    const msg = {
      item_list: [{ type: MSG_ITEM_TEXT, text_item: {} }],
    };
    assert.equal(extractContent(msg as any), null);
  });
});

// ── markdownToPlainText ───────────────────────────────────────────────────

describe("markdownToPlainText", () => {
  it("strips bold", () => {
    assert.equal(markdownToPlainText("**bold**"), "bold");
  });

  it("strips italic", () => {
    assert.equal(markdownToPlainText("*italic*"), "italic");
  });

  it("strips inline code", () => {
    assert.equal(markdownToPlainText("`code`"), "code");
  });

  it("strips code blocks", () => {
    const input = "before\n```js\nconst x = 1;\n```\nafter";
    const result = markdownToPlainText(input);
    assert.ok(!result.includes("```"));
    assert.ok(result.includes("const x = 1;"));
  });

  it("strips headings", () => {
    assert.equal(markdownToPlainText("## Title"), "Title");
  });

  it("strips links, keeps text", () => {
    assert.equal(markdownToPlainText("[click](http://example.com)"), "click");
  });

  it("strips blockquotes", () => {
    assert.equal(markdownToPlainText("> quoted"), "quoted");
  });

  it("strips horizontal rules", () => {
    assert.equal(markdownToPlainText("---").trim(), "");
  });

  it("collapses multiple newlines", () => {
    const result = markdownToPlainText("a\n\n\n\nb");
    assert.ok(!result.includes("\n\n\n"));
  });
});

// ── chunkMessage ──────────────────────────────────────────────────────────

describe("chunkMessage", () => {
  it("returns single chunk for short message", () => {
    const result = chunkMessage("short message");
    assert.equal(result.length, 1);
    assert.equal(result[0], "short message");
  });

  it("splits long message into chunks", () => {
    const longText = Array(50).fill("This is a paragraph of text that is reasonably long.").join("\n\n");
    const result = chunkMessage(longText);
    assert.ok(result.length > 1);
    for (const chunk of result) {
      assert.ok(chunk.length <= 2000, `Chunk too long: ${chunk.length}`);
    }
  });

  it("preserves all content across chunks", () => {
    const paragraphs = Array(30).fill(0).map((_, i) => `Paragraph ${i}`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkMessage(text);
    const rejoined = chunks.join("\n\n");
    for (const p of paragraphs) {
      assert.ok(rejoined.includes(p), `Missing: ${p}`);
    }
  });

  it("splits single very long line into valid chunks", () => {
    const longLine = "x".repeat(5000);
    const result = chunkMessage(longLine);
    assert.ok(result.length > 1, `Should split into multiple chunks, got ${result.length}`);
    for (const chunk of result) {
      assert.ok(chunk.length <= 2000, `Chunk too long: ${chunk.length}`);
    }
    assert.equal(result.join("").length, 5000, "Total content preserved");
  });
});

// ── parseAesKey ───────────────────────────────────────────────────────────

import { parseAesKey } from "../src/crypto.js";

describe("parseAesKey", () => {
  it("parses raw 16-byte key (Format A)", () => {
    const raw = Buffer.alloc(16, 0xab);
    const b64 = raw.toString("base64");
    const key = parseAesKey(b64);
    assert.equal(key.length, 16);
    assert.deepEqual(key, raw);
  });

  it("parses hex-encoded 32-char key (Format B)", () => {
    const hexStr = "0123456789abcdef0123456789abcdef";
    const b64 = Buffer.from(hexStr, "ascii").toString("base64");
    const key = parseAesKey(b64);
    assert.equal(key.length, 16);
    assert.deepEqual(key, Buffer.from(hexStr, "hex"));
  });

  // ── Negative cases ──

  it("throws on invalid key length", () => {
    const bad = Buffer.alloc(8, 0xff).toString("base64");
    assert.throws(() => parseAesKey(bad), /Invalid aes_key/);
  });

  it("throws on 32-byte non-hex content", () => {
    const nonHex = Buffer.from("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "ascii").toString("base64");
    assert.throws(() => parseAesKey(nonHex), /Invalid aes_key/);
  });
});

// ── encrypt/decrypt roundtrip ─────────────────────────────────────────────

import { encryptAesEcb, decryptAesEcb } from "../src/crypto.js";

describe("AES-ECB roundtrip", () => {
  it("encrypts and decrypts back to original", () => {
    const key = Buffer.alloc(16, 0x42);
    const keyB64 = key.toString("base64");
    const plaintext = Buffer.from("Hello WeChat media encryption!");
    const encrypted = encryptAesEcb(plaintext, key);
    const decrypted = decryptAesEcb(encrypted, keyB64);
    assert.deepEqual(decrypted, plaintext);
  });
});
