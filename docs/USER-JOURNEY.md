# WeChat Channel v2 — 用户旅程设计

> 产品视角的完整用户旅程。覆盖8种状态下用户看到什么、系统做什么、怎么引导用户。
> 目标用户：技术小白同事，独立完成安装使用和故障恢复。

---

## 状态总览

```
                    ┌─────────────┐
         ┌─────────│  全新安装(1) │
         │         └──────┬──────┘
         │                │ npm install -g
         │                ▼
         │         ┌─────────────┐
         │         │  扫码登录(2) │◄──────────────┐
         │         └──────┬──────┘               │
         │                │ 扫码成功              │ token过期
         │                ▼                      │
         │         ┌─────────────┐        ┌──────┴──────┐
         │         │  正常运行(3) │───────►│ 登录过期(5) │
         │         └──┬───┬──────┘        └─────────────┘
         │            │   │
         │    关终端/  │   │ crash/kill
         │    重启电脑 │   │
         │            ▼   ▼
         │    ┌────────┐ ┌──────────┐
         │    │重启(4)  │ │异常退出(6)│
         │    └───┬────┘ └────┬─────┘
         │        │           │
         │        └─────┬─────┘
         │              │ 重新运行 wechat-channel
         │              ▼
         │       ┌─────────────┐
         │       │  正常运行(3) │
         │       └─────────────┘
         │
         │  旧版升级   ┌─────────────┐
         └────────────►│ 版本升级(7) │──► 正常运行(3)
                       └─────────────┘

         多实例(8) = 以上所有状态 × N个profile
```

---

## 1. 全新安装

### 用户动作
```bash
npm install -g gg47338822-cpu/claude-code-wechat-channel
wechat-channel
```

### 系统行为

| 步骤 | 系统做什么 | 用户看到什么 |
|------|-----------|------------|
| 1.1 环境预检 | 检查 Node.js >= 18、claude 命令存在 | 缺什么告诉用户装什么（中文+链接） |
| 1.2 旧包迁移 | 扫描所有 .mcp.json 里的旧包名 | 有迁移时打印"已迁移 X 个文件" |
| 1.3 Profile发现 | 无任何 profile → 进入首次设置模式 | "设置新 profile: default" |
| 1.4 启动Claude | spawn claude --dangerously-load-development-channels | Claude CLI 启动 |
| 1.5 MCP加载 | server.ts 启动，buildInstructions 返回 Setup Flow | Claude 收到 onboarding 指令 |
| 1.6 触发登录 | Claude 自动调用 wechat_login | 浏览器弹出二维码页面 |

### 扫码成功后的自动化（当前已实现 + 本次新增）

1. `doQRLoginWithWebServer` 返回 `AccountData`，包含 `userId`（扫码人的微信ID）
2. **[新增]** `wechat_login` handler 自动把 `userId` 写入 `profile.json` 的 `allow_from`
3. Claude 按 instructions 通过微信跟用户对话完成 identity/rules/workdir 设置
4. 写入 `profile.json`（identity、rules、workdir 从对话中获取，allow_from 已自动设好）

### 当前问题和改进方向

| 问题 | 现状 | 改进 |
|------|------|------|
| sender_id 获取 | ~~等用户发消息~~ 已改为扫码自动获取 | 已完成 |
| profile 概念 | 小白不理解 | 单微信号默认 "default"，不问用户 |
| workdir 概念 | 让用户选目录 | 给默认值 ~/Documents/wechat，不强制问 |
| npm权限错误 | 无引导 | README 给出 sudo 方案 |

### 理想体验（目标）

```
$ npm install -g gg47338822-cpu/claude-code-wechat-channel
$ wechat-channel

环境检查通过 ✓
设置新 profile: default
[浏览器弹出二维码]

（用户扫码）

微信连接成功！
白名单已自动添加扫码用户。

（微信上收到消息）
"你好！我是你的微信助手。你希望我扮演什么角色？"
```

用户全程只需要：装包 → 运行 → 扫码 → 在微信上回答2-3个问题。

---

## 2. 扫码登录

### 两种触发场景

| 场景 | 触发方式 | 入口 |
|------|---------|------|
| 首次设置 | Claude 自动调 wechat_login | server.ts wechat_login handler |
| Token过期 | polling 检测到认证失败 | polling.ts → doQRLoginWithWebServer |

### 当前流程

```
获取二维码 (fetchQRCode)
  ↓
终端显示 QR (qrcode-terminal)  +  启动本地 Web Server (端口9876-9886)
  ↓
打开浏览器 → 二维码页面
  ↓
轮询扫码状态 (pollQRStatus)
  ├── wait → 继续轮询
  ├── scaned → 显示"已扫码，请确认"
  ├── expired → 页面自动刷新二维码（/qr-refresh 端点）
  └── confirmed → 保存凭据，返回 AccountData
```

### 当前问题和改进方向

| 问题 | 现状 | 改进 |
|------|------|------|
| 二维码依赖外部API | ~~api.qrserver.com~~ 已改为本地 QRCode 库 | 已完成 |
| 二维码过期 | 已支持自动刷新（页面端轮询 /qr-refresh） | 已完成 |
| 浏览器打不开 | 已加提示"手动访问 http://localhost:XXX" | 已完成 |
| 超时时间 | 480秒（8分钟） | 足够，保持不变 |

### 需要新增

| 改进 | 说明 | 优先级 |
|------|------|--------|
| 终端也显示扫码状态 | 除了Web页面，终端也打印"已扫码""请确认"等状态 | P2 |
| 登录成功后终端打印摘要 | "微信已连接，用户: XXX，消息监听已启动" | P1 |

---

## 3. 正常运行

### 系统架构

```
用户微信 ──► iLink API ──► polling.ts (长轮询)
                                │
                                ▼
                          消息分发到 Claude (MCP notification)
                                │
                                ▼
                          Claude 处理 → 调用 wechat_reply
                                │
                                ▼
                          message.ts → iLink API ──► 用户微信
```

### 运行时行为

| 行为 | 实现 | 说明 |
|------|------|------|
| 消息监听 | 长轮询 getUpdates | 35秒超时自动重连 |
| 白名单过滤 | allow_from 检查 | 支持完整ID和裸ID匹配 |
| context_token 缓存 | 持久化到 context_tokens.json | 支持断线恢复 |
| typing 指示器 | 5秒间隔发送 | 用户等待时看到"对方正在输入" |
| 媒体下载 | CDN下载+AES解密 | 图片/文件/视频自动保存到 media/ |
| 媒体清理 | 7天自动清理 | 每次启动时执行 |
| 长消息分片 | 2000字符自动分段 | 按段落边界切分 |
| markdown转纯文本 | 自动去除格式标记 | 微信只支持纯文本 |
| 暂停/恢复 | paused 文件控制 | /access pause/resume |
| 记忆加载 | channel记忆 + CC原生记忆 | 启动时全部注入 instructions |

### 用户可感知的行为

| 用户动作 | 系统响应 |
|---------|---------|
| 发文本消息 | Claude 处理后通过微信回复 |
| 发图片 | 自动下载到本地，Claude 可用 Read 查看 |
| 发文件 | 自动下载，Claude 可处理 |
| 发语音 | iLink 自动转文字，Claude 处理文字 |
| 发视频 | 自动下载到本地 |
| 在群里@机器人 | 群消息走 group_id 回复 |
| 不在白名单的人发消息 | 静默忽略 |

---

## 4. 重启 Session（关终端再开 / 重启电脑）

### 用户动作
```bash
# 关闭终端窗口（或重启电脑），然后：
wechat-channel
```

### 系统行为

| 步骤 | 系统做什么 | 用户看到什么 |
|------|-----------|------------|
| 4.1 预检 | 同1.1 | 通过 |
| 4.2 Profile发现 | 找到已有profile(s) | "启动 N 个 profile: home, legal, ..." |
| 4.3 PID锁检查 | 检测到旧PID文件 | — |
| 4.4 Stale检测 | process.kill(pid, 0) 抛异常 = 进程已死 | "上次未正常退出，已自动恢复" |
| 4.5 清理锁 | 删除旧 PID 文件，写入新 PID | — |
| 4.6 凭据加载 | 读 account.json | "使用已保存账号: XXX" |
| 4.7 同步状态恢复 | 读 sync_buf.txt | "恢复同步状态 (N bytes)" |
| 4.8 context_token恢复 | 读 context_tokens.json | — |
| 4.9 开始轮询 | startPolling | "开始监听微信消息..." |

### 关键点

- **不需要重新扫码**：account.json 里的 token 通常在24小时内有效
- **消息不丢失**：sync_buf 记录了上次轮询位置，从断点继续
- **context_token 恢复**：持久化到磁盘，重启后仍能回复

### 当前问题和改进方向

| 问题 | 现状 | 改进 |
|------|------|------|
| 恢复摘要不够清晰 | 分散在多行日志里 | 启动时统一打印一段恢复摘要 |
| 用户不知道数据有没有丢 | 无明确提示 | 告诉用户"消息从断点继续" |
| 记忆连续性 | 依赖 Claude instructions 里的记忆加载 | 当前已实现 |

### 理想体验

```
$ wechat-channel

上次未正常退出（进程 12345 已不存在），已自动恢复。
消息从断点继续，无需重新扫码。

启动 2 个 profile: home, legal
  home  已启动 (pid: 67890, cwd: ~/)
  legal 已启动 (pid: 67891, cwd: ~/Documents/legal)
```

---

## 5. 登录过期（Token 失效）

### 触发条件

polling.ts 连续 3 次收到认证错误（errcode 401/403/-14 或 ret=-1 或 errmsg 含 "token"/"session"）。

### 系统行为

| 步骤 | 系统做什么 | 用户看到什么 |
|------|-----------|------------|
| 5.1 检测 | 连续3次认证失败 | 终端日志："登录已过期，正在重新连接..." |
| 5.2 通知用户 | 尝试用旧token发微信通知 | 微信收到："Token过期，需要重新扫码" |
| 5.3 启动Web QR | doQRLoginWithWebServer | 浏览器弹出二维码页面 |
| 5.4 用户扫码 | 轮询扫码状态 | 页面显示"已扫码""登录成功" |
| 5.5 刷新凭据 | 保存新token，重置同步状态 | 终端日志："Token刷新完成" |
| 5.6 恢复轮询 | 继续 polling 循环 | 消息恢复正常 |

### 关键点

- **微信通知是 best-effort**：旧 token 可能已经完全失效，通知可能发不出去
- **二维码在页面上自动刷新**：过期后不需要用户手动刷新
- **context_token 被清空**：刷新后用户需要发一条消息才能收到回复

### 当前问题和改进方向

| 问题 | 现状 | 改进 |
|------|------|------|
| 用户可能看不到通知 | 微信通知可能发不出去 | 加系统级通知（macOS notification） |
| context_token清空 | 刷新后第一条消息无法回复 | 保留旧的context_token作为fallback |
| 刷新后无确认 | 只有终端日志 | 刷新成功后通过微信通知用户"已恢复" |

### 理想体验

```
[终端]
登录已过期，正在重新连接...
二维码页面: http://localhost:9876
[浏览器自动弹出]

（用户扫码）

Token 刷新成功！消息监听已恢复。

[微信]
"连接已恢复，可以继续聊天了。"
```

---

## 6. 异常退出（进程被杀 / Crash）

### 触发场景
- `kill <pid>` 或 `kill -9 <pid>`
- 系统 OOM killer
- 未捕获异常导致 crash
- Claude CLI stdin 关闭（父进程退出）

### 系统行为

| 场景 | 系统做什么 | 遗留状态 |
|------|-----------|---------|
| SIGTERM | sendExitNotification → 微信通知"服务已停止" → 优雅退出 | PID文件残留 |
| stdin关闭 | sendExitNotification → 微信通知"CLI已断开" → 退出 | PID文件残留 |
| SIGKILL/crash | 无清理机会 | PID文件残留、sync_buf可能不完整 |

### 恢复（同状态4）

```bash
wechat-channel  # 直接重新运行
```

系统自动检测 stale PID → 清理 → 恢复。

### 当前问题和改进方向

| 问题 | 现状 | 改进 |
|------|------|------|
| crash原因不明 | 只有 Fatal: ${err} | 写 crash 日志到文件 |
| 用户不知道挂了 | 除非看终端 | LaunchAgent 自动重启（/service） |
| MCP连接断开 | 3次失败后退出 | 退出前通知用户 |

### 理想体验

```
$ wechat-channel

上次未正常退出（进程 12345 已不存在），已自动恢复。
消息从断点继续，无需重新扫码。

提示: 运行 'wechat-channel service install' 可设置开机自启动，
      断线时自动恢复，无需手动重启。
```

---

## 7. 版本升级

### 用户动作
```bash
npm install -g gg47338822-cpu/claude-code-wechat-channel@latest
wechat-channel
```

### 系统行为

| 步骤 | 系统做什么 | 用户看到什么 |
|------|-----------|------------|
| 7.1 预检 | 同1.1 | 通过 |
| 7.2 旧包迁移 | migrateAllMcpConfigs 扫描所有 .mcp.json | "已迁移 N 个文件中的旧包名"（如有） |
| 7.3 .mcp.json更新 | ensureMcpConfig 更新命令路径 | ".mcp.json 已更新" |
| 7.4 正常启动 | 同状态3或4 | 正常运行 |

### 升级路径

```
旧包名 (@xiaoyifu_0000/wechat-channel)
  │
  │ npm install -g 新包
  ▼
新包名 (gg47338822-cpu/claude-code-wechat-channel)
  │
  │ wechat-channel（自动迁移.mcp.json）
  ▼
正常运行（profile数据完全兼容）
```

### 当前问题和改进方向

| 问题 | 现状 | 改进 |
|------|------|------|
| 旧包残留 | 新旧包共存 | 迁移后提示用户卸载旧包 |
| 版本显示 | 无明确版本信息 | 启动时打印版本号 |
| 升级命令 | `wechat-channel upgrade` 只做迁移检查 | 扩展为完整升级流程 |

### 理想体验

```
$ npm install -g gg47338822-cpu/claude-code-wechat-channel@latest
$ wechat-channel

wechat-channel v1.1.0（升级自 v1.0.9）
已迁移 2 个 .mcp.json 文件中的旧包名。

提示: 旧版 @xiaoyifu_0000/wechat-channel 可以卸载了：
  npm uninstall -g @xiaoyifu_0000/wechat-channel

启动 2 个 profile: home, legal
```

---

## 8. 多实例

### 概念

一台电脑运行多个微信账号，每个账号是一个 "profile"。每个 profile 有独立的：
- account.json（登录凭据）
- profile.json（配置：身份、规则、白名单）
- memory/（对话记忆）
- media/（媒体文件）

### 用户操作

```bash
# 创建新实例
wechat-channel new work     # 创建 "work" profile 并进入设置

# 查看所有实例
ls ~/.claude/channels/wechat/profiles/

# 启动所有实例
wechat-channel

# 只启动指定实例
wechat-channel run home
wechat-channel run work
```

### Launcher 行为

```
wechat-channel
  │
  ├── 发现 profiles: home, legal, shuji
  │
  ├── 为每个 profile:
  │     1. 读 profile.json → 获取 workdir
  │     2. ensureMcpConfig(workdir) → 确保 .mcp.json
  │     3. spawn claude --dangerously-load-development-channels
  │        (env: WECHAT_CHANNEL_PROFILE=<name>)
  │
  └── 所有进程共享终端输出，前缀区分：
        [wechat:home] 开始监听微信消息...
        [wechat:legal] 开始监听微信消息...
```

### 当前问题和改进方向

| 问题 | 现状 | 改进 |
|------|------|------|
| 多实例输出混杂 | 所有 profile 共享 stderr | 加颜色/前缀区分 |
| PID锁跨实例 | 每个 profile 独立锁文件 | 当前已正确实现 |
| 单实例启动 | `wechat-channel run <name>` | 已实现 |
| 实例列表 | 无命令查看 | 加 `wechat-channel list` |
| 删除实例 | 手动 rm -rf | 加 `wechat-channel remove <name>` |

### 理想体验

```
$ wechat-channel list
  home   ● 运行中  workdir: ~/         最近活动: 2分钟前
  legal  ● 运行中  workdir: ~/legal    最近活动: 5分钟前
  shuji  ○ 未启动  workdir: ~/shuji

$ wechat-channel new work
设置新 profile: work
[浏览器弹出二维码]
（扫码 + 在微信上回答问题 → 设置完成）

$ wechat-channel
启动 3 个 profile: home, legal, work
```

---

## 跨状态问题汇总

以下是贯穿多个状态的系统性问题：

### 1. 启动摘要

**现状**：各种日志分散，没有统一的"启动完成"时刻。

**改进**：启动完成后统一打印一段摘要：
```
wechat-channel v1.1.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Profile: home
  状态:   已连接（上次活动: 3分钟前）
  账号:   5cae93962649@im.bot
  目录:   ~/
  .mcp:   ~/.mcp.json
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
开始监听微信消息...
```

### 2. 错误消息标准

所有用户可见的消息统一格式：
- 错误：`❌ 问题描述`
- 操作：`   👉 具体操作步骤`
- 警告：`⚠️  警告信息`
- 成功：`✓ 操作成功`
- 信息：`[wechat:profile] 日志内容`

### 3. 通知机制

| 层级 | 方式 | 场景 |
|------|------|------|
| 终端日志 | stderr 前缀输出 | 所有状态变化 |
| 微信通知 | wechat_reply（best-effort） | 异常退出、token过期、恢复 |
| 系统通知 | macOS Notification Center | 需要用户操作时（扫码） |

### 4. 数据持久化

| 数据 | 文件 | 存活范围 |
|------|------|---------|
| 登录凭据 | account.json | 跨重启，直到token过期 |
| Profile配置 | profile.json | 永久 |
| 同步位置 | sync_buf.txt | 跨重启，token刷新时清空 |
| 会话令牌 | context_tokens.json | 跨重启，token刷新时清空 |
| 对话记忆 | memory/*.md | 永久 |
| 媒体文件 | media/* | 7天自动清理 |
| 进程锁 | channel.pid | 进程退出时清理 |
| 暂停状态 | paused | 手动控制 |
| 最近活动 | last_activity.txt | 每条消息更新 |

---

## 实施优先级

### P0 — 已完成
- [x] 环境预检（Node版本、Claude CLI）
- [x] 旧包名自动迁移
- [x] 扫码自动获取用户ID设白名单
- [x] 错误消息中文化
- [x] 二维码本地生成
- [x] 二维码过期自动刷新

### P1 — 下一步
- [ ] 启动摘要（统一打印版本、profile状态、连接信息）
- [ ] 登录成功后微信通知"已恢复"
- [ ] `wechat-channel list` 查看所有实例状态
- [ ] workdir 给默认值，首次设置不强制问

### P2 — 近期
- [ ] 多实例输出加颜色区分
- [ ] 版本号显示
- [ ] 升级后提示卸载旧包
- [ ] `wechat-channel remove <name>` 删除实例
- [ ] crash 日志写入文件

### P3 — 后续
- [ ] macOS 系统通知（需要扫码时）
- [ ] `wechat-channel upgrade` 完整升级流程
- [ ] `wechat-channel doctor` 环境诊断
- [ ] README 故障排查章节扩展
