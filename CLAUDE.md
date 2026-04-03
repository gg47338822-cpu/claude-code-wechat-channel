# wechat-channel v2

微信消息接入 Claude Code 的官方 Plugin。通过 iLink API 桥接微信消息到 Claude Code Channel 协议。

## 项目结构

```
server.ts          — MCP Server 入口（tool handlers + main）
launcher.ts        — 多实例启动器（发现 profiles, spawn claude 进程）
src/
  polling.ts       �� 消息轮询主循环（长轮询 + 错误恢复 + 自动重登）
  types.ts         — 类型定义和常量
  api.ts           — HTTP 请求封装
  crypto.ts        — AES 解密（媒体文件）
  cdn.ts           — CDN 媒体下载
  profile.ts       — 多实例 Profile 管理（路径、凭据、��、记忆加载）
  login.ts         — 扫码登录（终端 QR + Web 页面）
  message.ts       — 消��收发（文本、图片、文件、typing）
  state.ts         — 会话状态管理（context token 缓存、typing 指示器）
skills/access/     — /access 配对命令（login/status/setup/config）
skills/service/    — /service LaunchDaemon 管理（install/uninstall）
.claude-plugin/    — Claude Plugin 配置
```

## 构建和运行

```bash
npm run build          # esbuild -> dist/

# === 日常启动（推荐） ===
# 单个 profile: 在对应 workdir 下启动 Claude CLI，加载 wechat channel
cd ~/                  # home profile 的 workdir
claude --dangerously-load-development-channels server:wechat

# 多实例: launcher 自动发现所有 profiles 并启动
npm run launch         # 或 npx tsx launcher.ts
npx tsx launcher.ts home legal  # 只启动指定 profiles

# === 开发/调试 ===
npm run dev            # tsx 直接跑 server.ts（MCP server，需要 Claude CLI 的 stdio）
npm start              # node dist/server.js（同上，编译后版本）
```

**注意**：
- `npm start` / `npm run dev` 只启动 MCP server 进程，不启动 Claude CLI。
  它们需要配合 Claude CLI 的 `--dangerously-load-development-channels` 使用。
- 使用 v2 前必须先停止 v1（共享 profile 目录，PID 锁互斥）。
- launcher 会合并 `.mcp.json`（不覆盖已有 MCP 配置），优先用本地 dist/server.js。

## Profile 数据

存储在 `~/.claude/channels/wechat/profiles/<name>/`：
- `account.json` — 登录凭据（token, baseUrl, accountId）
- `profile.json` — 配置（identity, workdir, allow_from, rules）
- `memory/` — Channel 记忆文件
- `media/` — 下载的媒体（7天自动清理）

## 关键约定

- 构建系统: esbuild（不用 bun）
- Profile 解析优先级: cwd 匹配 > 环境变量 > 默认 "default"
- 代理环境变量在启动时清除（微信 API 必须直连）
- Profile 数据格式与 v1 兼容
