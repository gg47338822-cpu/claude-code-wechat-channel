# wechat-channel

WeChat messaging bridge for Claude Code. Send and receive WeChat messages directly in your Claude Code session.

## Features

- **Multi-instance** — Run multiple WeChat accounts simultaneously, each with its own profile
- **Memory system** — Persistent memory across sessions, each profile remembers past conversations
- **Media support** — Auto-download images, videos, files; send images and files back
- **Auto re-login** — Token expiry triggers QR code re-authentication automatically
- **Group chat** — Full support for group messages with sender identification
- **Markdown stripping** — Converts markdown to plain text for WeChat display
- **Long message chunking** — Splits long replies into multiple messages

## Quick Start

### 1. Install

```bash
npm install -g claude-code-wechat-channel
```

### 2. Run

```bash
wechat-channel
```

That's it. This launches Claude Code with the plugin loaded. On first run, Claude will guide you through setup in a friendly conversation:

1. Ask what role you want Claude to play on WeChat
2. Ask where to store conversation memory
3. Ask if you want to whitelist specific contacts
4. Save the configuration
5. Open a QR code for you to scan with WeChat
6. Start listening for messages

### Development Setup

If you're working on the plugin itself:

```bash
git clone <repo-url> && cd wechat-channel-v2
npm install && npm run build
claude --plugin-dir .
```

## Multi-Instance Setup

Each WeChat account is a "profile". Profiles are stored in:

```
~/.claude/channels/wechat/profiles/<name>/
```

### Profile structure

```
~/.claude/channels/wechat/profiles/home/
  account.json    — Login credentials (auto-generated after QR scan)
  profile.json    — Configuration (see below)
  memory/         — Conversation memory files
  media/          — Downloaded media (auto-cleaned after 7 days)
```

### profile.json example

```json
{
  "identity": "You are Jason's personal assistant. You speak Chinese. You are warm, helpful, and concise.",
  "rules": "Never share private information. Always respond in Chinese unless the user writes in English.",
  "workdir": "/Users/jason/Documents/my-project",
  "allow_from": ["jason", "friend123"]
}
```

| Field | Description |
|-------|-------------|
| `identity` | Who Claude should be when replying via this profile |
| `rules` | Behavioral rules Claude must follow |
| `workdir` | Working directory for this Claude instance |
| `allow_from` | Whitelist of WeChat IDs that can send messages (empty = allow all) |

### Launch multiple profiles

```bash
# All profiles
npx tsx launcher.ts

# Specific profiles
npx tsx launcher.ts home legal shuji
```

The launcher discovers profiles automatically from the profiles directory.

## Available Tools

When the plugin is loaded, these MCP tools become available:

| Tool | Description |
|------|-------------|
| `wechat_reply` | Send a plain-text reply to a WeChat user or group |
| `wechat_send_image` | Send a local image file (PNG, JPG) |
| `wechat_send_file` | Send a local file (documents, PDFs, etc., max 20MB) |
| `wechat_login` | Start QR code login flow |
| `wechat_status` | Check connection status |

## Skills

| Command | Description |
|---------|-------------|
| `/access` | Connect or reconnect a WeChat account |
| `/access status` | Check current connection status |

## Architecture

```
server.ts          — MCP Server entry point (tools + main)
launcher.ts        — Multi-instance launcher
src/
  polling.ts       — Message polling loop
  message.ts       — Message parsing and sending
  login.ts         — QR code login flows
  profile.ts       — Profile management
  state.ts         — Session state (context tokens, typing)
  cdn.ts           — Media download/upload
  api.ts           — HTTP client
  crypto.ts        — AES decryption
  types.ts         — TypeScript types and constants
```

## Troubleshooting

### "Another channel process is running"
A previous instance didn't shut down cleanly. Delete the PID file:
```bash
rm ~/.claude/channels/wechat/profiles/<name>/channel.pid
```

### Messages not arriving
1. Check `/access status` — is it logged in?
2. Check `allow_from` in profile.json — is the sender whitelisted?
3. Check if paused — delete `~/.claude/channels/wechat/profiles/<name>/paused` if it exists

### Token expired
The system auto-detects token expiry and opens a QR code page. If it doesn't, run `/access` manually.

## License

MIT
