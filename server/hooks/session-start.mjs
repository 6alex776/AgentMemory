/**
 * Trae Hook：SessionStart → 会话一建立就把「记忆归属规则」放进上下文。
 *
 * 规则靠人记或在 UI 里填，经常在新会话里失效；这里在会话创建时注入一次，
 * 与 UserPromptSubmit 的注入块互补：前者管规则，后者管内容。
 *
 * 永不阻断会话：任何异常静默退出 0。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const LOG_FILE = join(repoRoot, '.tmp', 'hook-session.log')

function log(message) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch { /* ignore */ }
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { raw += chunk })
    process.stdin.on('end', () => resolve(raw))
    process.stdin.on('error', () => resolve(raw))
    setTimeout(() => resolve(raw), 3000).unref()
  })
}

const RULES = [
  '【本项目记忆约定】',
  '1. 长期记忆以 AgentMemory 为准：需要用户背景、偏好、项目决策时调用 memory_context / memory_search。',
  '2. 被问「记住了几条 / 有哪些记忆」时调用 memory_list，不要统计 .trae-cn/memory 下的 Markdown 文件。',
  '3. 宿主内置 md 记忆只作副本，不作为事实来源；冲突时以 AgentMemory 为准。',
  '4. Hindsight 与 research-dream skill 本项目未启用，不要当作记忆来源。',
  '5. 写入只在信息值得长期保留时调用 memory_save；同一 topicKey 会替换旧值；密钥、口令、token 一律不写。',
].join('\n')

const raw = await readStdin()
let input = {}
try {
  input = JSON.parse(raw || '{}')
} catch { /* 非 JSON 时按空对象处理 */ }

const cwd = input.cwd ?? process.env.TRAE_PROJECT_DIR ?? repoRoot
// 全局 Hook 与项目 Hook 同时存在时，项目那份负责注入，全局这份退出
if (process.env.AGENTMEMORY_HOOK_SCOPE === 'global' && existsSync(join(cwd, '.trae', 'hooks.json'))) {
  process.exit(0)
}

try {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: RULES,
    },
  })}\n`)
} catch (error) {
  log(`会话规则注入失败：${error?.message ?? error}`)
}

process.exit(0)
