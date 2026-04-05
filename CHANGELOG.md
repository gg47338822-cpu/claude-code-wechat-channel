# Changelog

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
