# 微信路由系统设计方案（nerve-center）

> 一个微信窗口，跟任何分身对话。@指名、自然语言、或小衣服帮你接。

---

## 一、用户画面

Jason在微信里：

```
Jason:  @造梦师 金字塔进度怎么样了
系统:   [通道已切到造梦师]
造梦师: [造梦师·通道中] 刚补完237条L1.5标签，L2压缩在跑...
Jason:  L2跑完要多久
造梦师: [造梦师·通道中] 大概还要10分钟，有568条topics要处理
系统:   [通知·通信官] v2用户旅程文档写完了，等你确认
Jason:  @通信官 发给我看看
系统:   [通道已切到通信官]
通信官: [通信官·通道中] 文档在docs/USER-JOURNEY.md，覆盖了8种状态...
系统:   [通知·造梦师] L2压缩完成，5个topics生成
Jason:  @小衣服
系统:   [已切回小衣服]
Jason:  今天干了不少活
小衣服: 是的，造梦师补完了标签在跑压缩，通信官v2改进全完了...
```

---

## 二、两层通信

### 对话通道（独占）
- 你@谁就跟谁聊，后续消息持续发给那个分身
- 一次只有一个通道，@新人自动切
- @小衣服 或 "切回来" 回到默认

### 通知通道（广播）
- 任何分身完成任务都可以推通知，不管当前通道指向谁
- 通知格式：[通知·造梦师] 一句话
- 通知不切通道，不打断对话

---

## 三、技术架构

### 核心：localhost HTTP路由服务（Node.js，~200行）

```
微信消息
  → wechat MCP (wechat-home session)
  → 检测@前缀
  → POST localhost:5900/route {target: "造梦师", msg: "金字塔进度"}
  → HTTP服务记录通道状态，tmux send-keys转发给architect-pyramid
  → 造梦师处理、生成回复
  → Stop hook触发，POST localhost:5900/reply {from: "造梦师", content: "..."}
  → HTTP服务调wechat MCP发回微信，前缀加[造梦师·通道中]
```

### 组件清单

| 组件 | 位置 | 职责 |
|------|------|------|
| HTTP路由服务 | ~/memory-pyramid/services/wechat-router.js | 路由状态管理+消息转发+回复收集 |
| Stop hook增强 | ~/memory-pyramid/scripts/hooks/route-reply.sh | 检测通道状态，POST回复到路由服务 |
| wechat MCP改动 | wechat-channel v1 server.ts | 消息到达时检测@前缀，调路由服务 |
| 通道状态文件 | ~/memory-pyramid/saves/route-state.json | 当前通道指向谁，持久化 |
| 身份映射表 | ~/memory-pyramid/saves/persona-map.json | @名字 → tmux session名的映射 |

### 路由服务 API

```
POST /route
  {target: "造梦师", msg: "金字塔进度", sender_id: "xxx@im.wechat"}
  → 切通道状态 + 转发消息到tmux
  → 返回 {ok: true, channel: "造梦师"}

POST /reply
  {from: "architect-pyramid", content: "L1.5标签完成..."}
  → 判断是对话还是通知
  → 调wechat发送

GET /status
  → 返回当前通道状态 {channel: "造梦师", since: "2026-04-04T05:00:00"}
```

---

## 四、三种通道建立方式

### 方式一：@指名（显式触发）
"@造梦师 金字塔进度" → 精确切通道

### 方式二：自然语言（小衣服理解）
"把造梦师叫来" / "让通信官来说说" / "贾维斯在吗" → 小衣服理解意图，建立通道

### 方式三：COO路由（小衣服主动判断）
Jason说"记忆的事怎么样了"，没有@也没有指名。小衣服判断这是金字塔的事，主动说"这个事应该问造梦师，帮你接过去？"。确认后切通道。

三种方式并存。@最精确，自然语言最自然，COO路由最智能。

### 模糊匹配
每个场景配多个别名，支持错别字容错：
- @金字塔 / @pyramid / @做梦 / @梦 → architect-pyramid
- @微信 / @wechat / @通信 → comms-officer
- @家 / @home / @贾维斯 / @管家 → jarvis
- @cosmo / @SP / @总工 → cosmo-chief
- @中枢 / @路由 / @nerve → nerve-center

匹配失败不报错，问"你想跟谁聊？"列出可选项。

---

## 五、身份映射

| @名字 | tmux session | 项目目录 |
|--------|-------------|---------|
| @小衣服 | wechat-home | ~ |
| @造梦师 | architect-pyramid | ~/memory-pyramid |
| @通信官 | comms-officer | ~/Documents/wechat-channel-v2 |
| @贾维斯 | jarvis | ~/Code/home-automation |
| @总工 | cosmo-chief | ~/Documents/SP-clone |
| @极客 | explorer | （按需开） |
| @守护者 | guardian | （按需开） |
| @讲师 | lecturer | （按需开） |
| @鉴赏家 | connoisseur | （按需开） |

不在线的分身@时提示"造梦师没在运行，要开一个吗？"

---

## 五、边界处理

### 体验类
| 场景 | 处理方式 |
|------|---------|
| 切入通道 | 推一条 [通道已切到造梦师] |
| 切出通道 | 推一条 [已切回小衣服] |
| 每条分身回复 | 前缀 [造梦师·通道中] |
| 目标不在线 | "造梦师没在运行，要开一个吗？" → 用户确认后自动tmux开CLI |
| 目标在忙 | "造梦师正在处理任务，消息已送达，空了会回复" |
| 响应超时(120s) | [通知] 造梦师似乎卡住了，要切回小衣服吗？ |
| 收到非当前通道的通知 | [通知·造梦师] 一句话摘要，不切通道 |

### 逻辑类
| 场景 | 处理方式 |
|------|---------|
| 切通道时旧分身还在处理 | 旧分身完成后走通知通道，不丢弃 |
| Stop hook只发最终回复 | Stop hook天然是最终回复时触发，不需要额外过滤 |
| Stream存档 | HTTP服务转发消息时同时追加到当天stream文件 |
| 小衣服OB视角 | 所有路由消息都进stream，日记可见 |
| CLI重启 | 通道状态在文件里，不丢失 |

### 架构类
| 场景 | 处理方式 |
|------|---------|
| HTTP服务挂了 | launchd守护自动重启 |
| 多个Stop hook共存 | route-reply是第四个Stop hook，5秒超时，互不阻塞 |
| Mac mini重启 | launchd拉HTTP服务 + tmux session脚本重建 |
| 微信token过期 | 路由服务发现发送失败时推通知到终端 |

---

## 六、替代mailbox

这个路由服务成熟后，mailbox.jsonl可以退役：
- 分身通知 → 走HTTP POST /reply，直接推到微信
- 小衣服感知 → stream文件有完整记录
- 跨分身通信 → POST /route 互相转发

mailbox的三个功能（通知、记录、跨分身通信）全部被HTTP服务+stream文件覆盖。

---

## 七、实现优先级

| 步骤 | 内容 | 预计工作量 |
|------|------|----------|
| 1 | HTTP路由服务基础版（路由+转发+状态文件） | 2小时 |
| 2 | Stop hook增强（检测通道状态POST回复） | 30分钟 |
| 3 | wechat MCP加@检测逻辑 | 1小时 |
| 4 | 身份映射表+不在线处理 | 30分钟 |
| 5 | 通知通道 | 1小时 |
| 6 | launchd守护+自愈 | 30分钟 |
| 7 | 替代mailbox迁移 | 1小时 |

总计约7小时开发。可以分两天做。

---

*这个路由服务本质上是小衣服的神经系统——所有感知和输出都经过它。不是一个工具，是基础设施。*
