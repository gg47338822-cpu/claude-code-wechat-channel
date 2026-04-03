# wechat-channel

把微信接入 Claude Code。朋友在微信里给你发消息，Claude 帮你回复。

## 安装

```bash
npm install -g gg47338822-cpu/claude-code-wechat-channel
```

## 首次设置

```bash
wechat-channel
```

1. 浏览器弹出二维码，用微信扫码
2. 扫完后用微信给 bot 发一条消息
3. Claude 在微信里跟你聊几句，完成身份和规则配置
4. 搞定

### 添加更多微信号

```bash
wechat-channel new work     # 给新号起个名字
wechat-channel new 妈妈     # 中文也行
```

每个微信号独立配置身份、规则、白名单。

## 日常启动

```bash
wechat-channel              # 自动启动所有微信号
wechat-channel run home     # 只启动指定的号
```

就这一个命令。它会自动发现所有已配置的微信号并启动对应的 Claude 进程。

## 前提条件

- [Claude Code](https://docs.anthropic.com/claude-code) 已安装并登录
- Node.js >= 18
- 微信 iOS 最新版（需支持 iLink Bot）

## 功能

- **多实例** — 同时运行多个微信号，各有各的身份和规则
- **记忆系统** — 每个微信号有独立的对话记忆，重启不丢
- **媒体支持** — 自动下载图片/视频/文件，也能发图发文件
- **自动重登** — Token 过期会通知你并弹二维码重新扫
- **断连通知** — 连接异常时通过微信主动告知
- **群聊** — 支持群消息，能识别发送者
- **长消息分块** — 超长回复自动分成多条

## 常用命令

在 Claude Code 会话里可以用：

| 命令 | 说明 |
|------|------|
| `/access` | 重新扫码登录 |
| `/access status` | 查看连接状态 |
| `/access setup` | 创建新 profile |
| `/access config` | 修改当前 profile 配置 |

## 常见问题

### 消息收不到
- 检查微信是否是最新版
- 检查 Claude Code 终端是否还在运行
- 重新扫码：在 Claude Code 里输入 `/access`

### Token 过期
系统会自动检测并通过微信通知你。然后在终端弹出二维码页面，重新扫码即可。
如果没有自动弹，手动运行 `/access`。

### 删除某个微信号
```bash
rm -rf ~/.claude/channels/wechat/profiles/<名字>
```

## 数据存储

所有数据在本地：
```
~/.claude/channels/wechat/profiles/<名字>/
  account.json   — 登录凭据
  profile.json   — 身份、规则、白名单
  memory/        — 对话记忆
  media/         — 下载的图片/文件（7天自动清理）
```

## License

MIT
