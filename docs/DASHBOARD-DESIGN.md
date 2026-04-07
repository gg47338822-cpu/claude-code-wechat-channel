# WeChat Channel Dashboard 设计方案

> 用Web面板替代CLI命令，作为用户管理微信实例的主界面。

## 用户旅程

### 首次安装
```
npm install -g @xiaoyifu_0000/wechat-channel
wechat-channel
→ 浏览器自动打开 http://localhost:9800
→ 页面显示"欢迎使用微信-Claude连接器"
→ 引导：创建第一个实例
```

### 创建新实例（在Web面板上）
1. 点击"新建实例"
2. 输入实例名称（如 home、work、legal）
3. 页面显示二维码 + 实例ID
4. 用微信扫码
5. 扫码成功 → 实例卡片出现在面板上，状态"已连接·未启动"
6. 点击"启动" → 后台开终端窗口跑Claude CLI

### 日常使用
```
wechat-channel
→ 浏览器打开面板
→ 看到所有实例状态
→ 点启动/停止/重启
```

### 电脑重启后
```
wechat-channel
→ 面板打开，所有实例显示"已停止"
→ 点"全部启动"或逐个启动
→ 不需要重新扫码（凭据持久化在profile目录）
```

## 架构

```
┌─────────────────────────────────┐
│  Web Dashboard (localhost:9800) │
│  - 实例列表 + 状态              │
│  - 新建/启动/停止/重启/删除     │
│  - QR码显示                     │
│  - 快捷方式入口                 │
└──────────┬──────────────────────┘
           │ HTTP API
┌──────────▼──────────────────────┐
│  Dashboard Server (Node.js)     │
│  - 管理实例生命周期             │
│  - 监控进程状态                 │
│  - 提供REST API                │
│  - 调起终端窗口                 │
└──────────┬──────────────────────┘
           │ spawn / kill
┌──────────▼──────────────────────┐
│  Claude CLI 进程 (每实例一个)    │
│  - 跑在独立终端窗口             │
│  - 加载 wechat channel MCP     │
│  - 实际处理微信消息             │
└─────────────────────────────────┘
```

## Dashboard Server API

```
GET  /api/instances          → 所有实例列表 + 状态
POST /api/instances          → 创建新实例（name）→ 返回实例ID
POST /api/instances/:id/login → 启动QR登录流程
GET  /api/instances/:id/qr   → 获取当前QR码状态
POST /api/instances/:id/start → 启动实例（开终端+Claude）
POST /api/instances/:id/stop  → 停止实例
POST /api/instances/:id/restart → 重启实例
DELETE /api/instances/:id     → 删除实例（含profile目录）
GET  /api/instances/:id/logs  → 实例日志
```

## 实例状态机

```
[不存在] → 创建 → [已创建·未登录]
[已创建·未登录] → 扫码 → [已登录·未启动]
[已登录·未启动] → 启动 → [运行中]
[运行中] → 停止 → [已登录·未启动]
[运行中] → 崩溃 → [已登录·未启动]（自动检测）
[任何状态] → 删除 → [不存在]
```

## 实例数据持久化

每个实例的数据在 `~/.claude/channels/wechat/profiles/<name>/`：
```
account.json    — 微信凭据（扫码后生成，重启不丢）
profile.json    — 配置（identity, rules, workdir, allow_from）
memory/         — 对话记忆
media/          — 媒体文件
```

Dashboard自身状态在 `~/.claude/channels/wechat/dashboard.json`：
```json
{
  "port": 9800,
  "instances": {
    "home": { "pid": 12345, "startedAt": "...", "workdir": "~/" },
    "work": { "pid": null, "startedAt": null, "workdir": "~/Documents/work" }
  }
}
```

## 终端调起方式

Dashboard通过系统命令开终端窗口：

macOS:
```bash
osascript -e 'tell app "Terminal" to do script "cd ~/; claude --dangerously-load-development-channels server:wechat"'
```

或用已有终端（iTerm2、Warp等）的API。

进程管理：
- 启动时记录PID到dashboard.json
- 定时检查PID存活（kill -0）
- 进程退出时更新状态为"已停止"

## 前端页面

单文件HTML（嵌入Dashboard Server中），不需要前端框架：
- 实例卡片列表（名称、状态指示灯、操作按钮）
- QR码弹窗（创建新实例时）
- 简单的使用说明
- 响应式布局（手机也能看）

## 快捷方式

安装后提示用户：
- macOS: `wechat-channel shortcut` → 在桌面/Dock创建快捷方式
- 或直接告诉用户收藏 http://localhost:9800

## 改造范围

1. **新增**: dashboard.ts — Web服务+API+前端页面
2. **改造**: launcher.ts — 简化为"启动dashboard"
3. **改造**: cli.js — `wechat-channel` 直接启动dashboard
4. **保留**: server.ts — MCP server不变
5. **保留**: src/* — 核心逻辑不变

## 实现优先级

P0（必须有）:
- Dashboard Server + REST API
- 实例创建 + QR登录
- 实例启动/停止
- 前端页面基础版

P1（很快要）:
- 进程状态监控
- 实例重启
- 使用说明页

P2（可以后做）:
- 桌面快捷方式
- 日志查看
- 实例删除确认
- 自动启动（launchd/systemd）
