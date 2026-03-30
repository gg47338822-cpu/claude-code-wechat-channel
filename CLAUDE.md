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
npm start              # 单实例启动
npm run launch         # 多实例启动（所有 profiles）
npx tsx launcher.ts home legal  # 启动指定 profiles
```

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
