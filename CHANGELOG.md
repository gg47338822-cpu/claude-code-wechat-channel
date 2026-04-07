# Changelog

## 1.0.32 (2026-04-07)

### Bug Fixes

- **前端启动profile串台**: 启动命令改用`export WECHAT_CHANNEL_PROFILE=name`确保不被shell环境覆盖
- **小本本读取补全**: loadSessionContext支持history-snapshot.md（jsonl提取版）作为第三备选
- **Profile路径**: 加historySnapshotFile路径定义

## 1.0.31 (2026-04-07)

### New Features

- **Session Context 模块**: 新增 `session-context.ts`，实时记录对话到小本本（环形缓冲60条消息）
- **小本本 jsonl 提取**: 新增 `scripts/snapshot-from-jsonl.js` Stop hook，从 jsonl 跨文件提取最近30次对谈写 history-snapshot.md
- **Session 注册表**: 每个 profile 维护 session-registry.json，精确追踪属于该 profile 的 jsonl 文件

### Bug Fixes

- **通知前缀中文化**: 所有面向用户的通知前缀从 `[profileName]` 改为 `【profileName】`
- **Mailbox 格式**: `[紧急] [分身名]` 改为 `【紧急】【分身名】`
- **Dashboard 停止后自动刷新**: closeRestart 和 Step2 切换前都加了 load()
- **媒体 debug 日志**: extractContent 入口 dump 非文本消息到 /tmp（临时，排查视频问题用）
- **媒体失败日志增强**: 输出 mediaItem 的 keys 列表辅助排查
- **Profile 匹配优化**: 精确匹配优先于子目录，避免 home 目录兜底导致串 profile
- **ESM 兼容**: statSync 改用顶部 import

### Changes

- **退出通知改为静默**: CLI 断开/服务停止不再发微信，只记日志（避免技术消息困扰用户）
- **Mailbox watcher 仅 jason profile**: 非 jason profile 跳过，避免多实例重复推送

## 1.0.30 (2026-04-05)

### New Features

- **Dashboard 重启服务**: 新增重启按钮，完整流程——停止所有实例→逐个启动→Terminal.app弹出独立tab
- **Dashboard 在线检测修复**: resolveWorkdir 在状态检测时也正确应用，实例在线状态判断更准确
- **Mailbox 推送记录**: 推送成功后记录到 `~/.claude/mailbox-pushed.jsonl`，方便追溯

### Changes

- **移除 Dashboard 中的 Mailbox/分身状态**: mailbox面板和分身状态相关代码已移除，这些功能将迁移到 nerve-center 统一管理
- **Mailbox Watcher 仅限 jason profile**: 非 jason profile 不启动 watcher，避免多实例重复推送

## 1.0.29 (2026-04-05)

### New Features

- **Mailbox Watcher**: 自动监听 `~/.claude/mailbox.jsonl`，分身干完活写的通知直接推送到Jason微信。不依赖任何CLI在线，不经过小衣服中转。

### Details

- 新增 `src/mailbox.ts` 模块，3秒轮询 mailbox.jsonl 新增行
- 只推送 `cc` 包含"小衣服"的条目
- 按 level 格式化：error 加"[紧急]"前缀，其他为"[分身名] 消息内容"
- 通过当前 profile 的 iLink account 直接发送，发送目标为 allow_from 第一个用户
- offset追踪避免重复发送，文件截断时自动重置
- 启动时跳到文件末尾，只推新通知（不推历史）
- timer.unref() 不阻止进程退出

## 1.0.28 (2026-04-05)

### Bug Fixes

- **媒体token降级自动恢复**: 检测到连续3次媒体消息缺少下载信息时（旧token权限降级），自动触发重新扫码登录流程。重登成功后通知用户重发最后的媒体消息。解决了用户只看到"[图片]"但无法下载文件的问题。

### Details

- 新增 `consecutiveMediaFailures` 计数器，独立于API级别的错误检测
- 媒体下载失败时主动通知用户当前状态（"媒体权限过期，正在自动重新登录"）
- 重登成功后通知用户后续消息已恢复正常
- 降级期间媒体消息仍以文本形式（如"[图片]"）传递给Claude，不丢消息

## 1.0.27 and earlier

Initial release and iterative improvements. No changelog maintained for earlier versions.
