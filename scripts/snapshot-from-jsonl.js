#!/usr/bin/env node
/**
 * Stop hook: 从当前session的jsonl提取最近30次对谈，写到wechat profile的小本本。
 *
 * 触发时机：每次Claude回复后（Stop hook）
 * 输入：stdin JSON with { session_id, transcript_path, cwd }
 * 输出：~/.claude/channels/wechat/profiles/{profile}/session-snapshot.md
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const MAX_CONVERSATIONS = 30
const MAX_TEXT_LEN = 800 // 每条消息最大字符数

// ── Read hook input ──────────────────────────────────────────────────────

let hookData = {}
try {
  const stdin = readFileSync(0, 'utf-8')
  hookData = JSON.parse(stdin)
} catch { process.exit(0) }

const transcriptPath = hookData.transcript_path

if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0)

// ── Resolve wechat profile ───────────────────────────────────────────────
// 只用环境变量判断归属，不猜测CWD。
// WECHAT_CHANNEL_PROFILE 由 dashboard 启动时设置，最可靠。
// 没有环境变量 → 不是微信窗口 → 直接退出。

const profilesDir = join(homedir(), '.claude/channels/wechat/profiles')

function resolveProfile() {
  const envProfile = process.env.WECHAT_CHANNEL_PROFILE
  if (!envProfile) return null
  const profileDir = join(profilesDir, envProfile)
  if (!existsSync(profileDir)) return null
  return envProfile
}

const profile = resolveProfile()
if (!profile) process.exit(0)

const snapshotFile = join(profilesDir, profile, 'history-snapshot.md')
const registryFile = join(profilesDir, profile, 'session-registry.json')

// ── Parse jsonl ──────────────────────────────────────────────────────────

function extractUserText(msg) {
  // user消息的content可能是string或array
  let content = msg.message?.content || msg.content || ''
  // 数组格式：[{type: "text", text: "..."}]
  if (Array.isArray(content)) {
    content = content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n')
  }
  if (typeof content !== 'string' || !content.trim()) return ''
  // 提取channel标签内的文本
  const channelMatch = content.match(/<channel[^>]*>([\s\S]*?)<\/channel>/)
  if (channelMatch) return channelMatch[1].trim()
  return content.trim()
}

function extractAssistantText(msg) {
  // assistant消息的content是数组，找text类型的块
  const content = msg.message?.content || msg.content || []
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text)
    }
  }
  return texts.join('\n').trim()
}

// ── 从单个jsonl提取对谈 ──────────────────────────────────────────────────

function extractConversations(jsonlPath) {
  const convs = []
  try {
    const raw = readFileSync(jsonlPath, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim())
    let lastUser = null

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'user') {
          const text = extractUserText(entry)
          if (text) lastUser = { time: entry.timestamp || new Date().toISOString(), text }
        } else if (entry.type === 'assistant' && lastUser) {
          const text = extractAssistantText(entry)
          if (text) {
            convs.push({
              userTime: lastUser.time,
              userText: lastUser.text.slice(0, MAX_TEXT_LEN),
              botText: text.slice(0, MAX_TEXT_LEN),
            })
            lastUser = null
          }
        }
      } catch { continue }
    }
  } catch {}
  return convs
}

// ── Session 注册表：每个 profile 只读自己的 jsonl ────────────────────────

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(registryFile, 'utf-8'))
  } catch { return { jsonls: [] } }
}

function saveRegistry(registry) {
  writeFileSync(registryFile, JSON.stringify(registry, null, 2), 'utf-8')
}

// 把当前 transcriptPath 注册到 profile 的注册表
function registerCurrentJsonl(currentJsonl) {
  const registry = loadRegistry()
  const absPath = resolve(currentJsonl)
  if (!registry.jsonls.includes(absPath)) {
    registry.jsonls.push(absPath)
  }
  // 清理已不存在的文件
  registry.jsonls = registry.jsonls.filter(f => existsSync(f))
  registry.updated = new Date().toISOString()
  saveRegistry(registry)
  return registry
}

// 只从注册表中的 jsonl 取，按修改时间倒序
function findProfileJsonls(currentJsonl) {
  const registry = registerCurrentJsonl(currentJsonl)
  const files = registry.jsonls
    .filter(f => existsSync(f))
    .map(f => {
      try {
        const stat = statSync(f)
        return { path: f, mtime: stat.mtimeMs }
      } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
  return files.map(f => f.path)
}

// ── 跨jsonl收集对谈直到凑满30次 ────────────────────────────────────────────

try {
  const jsonlFiles = findProfileJsonls(transcriptPath)
  const allConversations = []

  for (const jsonlFile of jsonlFiles) {
    const convs = extractConversations(jsonlFile)
    // 每个文件的对谈按时间正序，从后往前取还没凑满的部分
    allConversations.unshift(...convs)
    if (allConversations.length >= MAX_CONVERSATIONS) break
  }

  // 取最后30次
  const recent = allConversations.slice(-MAX_CONVERSATIONS)
  if (recent.length === 0) process.exit(0)

  // ── 格式化小本本 ────────────────────────────────────────────────────────

  const sources = jsonlFiles.slice(0, 5).map(f => f.split('/').pop()).join(', ')
  const parts = [
    `# 对话记录 (${profile})`,
    `更新: ${new Date().toISOString()}`,
    `对谈数: ${recent.length}`,
    `来源: ${sources}`,
    '',
  ]

  for (const conv of recent) {
    parts.push(`>> 用户: ${conv.userText}`)
    parts.push(`<< 回复: ${conv.botText}`)
    parts.push('')
  }

  writeFileSync(snapshotFile, parts.join('\n'), 'utf-8')
} catch (err) {
  process.exit(0)
}
