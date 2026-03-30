/**
 * WeChat iLink API types and message constants.
 */

// ── Message type constants ─────────────────────────────────────────────────

export const CHANNEL_NAME = "wechat";
export const CHANNEL_VERSION = "1.0.0";
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export const MSG_TYPE_USER = 1;
export const MSG_TYPE_BOT = 2;
export const MSG_STATE_FINISH = 2;

export const MSG_ITEM_TEXT = 1;
export const MSG_ITEM_IMAGE = 2;
export const MSG_ITEM_VOICE = 3;
export const MSG_ITEM_FILE = 4;
export const MSG_ITEM_VIDEO = 5;

export const UPLOAD_MEDIA_IMAGE = 1;
export const UPLOAD_MEDIA_VIDEO = 2;
export const UPLOAD_MEDIA_FILE = 3;
export const UPLOAD_MEDIA_VOICE = 4;

// ── Account & Profile ──────────────────────────────────────────────────────

export interface AccountData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
}

export interface ProfileConfig {
  identity?: string;
  rules?: string;
  workdir?: string;
  allow_from?: string[];
}

// ── Message structures (iLink API) ─────────────────────────────────────────

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface TextItem {
  text?: string;
}

export interface ImageItem {
  aeskey?: string;
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  width?: number;
  height?: number;
  media_id?: string;
}

export interface VoiceItem {
  text?: string;
  media?: CDNMedia;
  aeskey?: string;
  duration_ms?: number;
}

export interface FileItem {
  file_name?: string;
  file_size?: number;
  media?: CDNMedia;
  aeskey?: string;
  media_id?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  duration_ms?: number;
  media_id?: string;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: RefMessage;
}

export interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface UploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  ret?: number;
}

export type ExtractedContent = {
  text: string;
  msgType: "text" | "voice" | "image" | "file" | "video" | "unknown";
  mediaItem?: ImageItem | FileItem | VideoItem;
  localPath?: string;
};
