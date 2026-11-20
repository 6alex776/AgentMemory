/**
 * Trae Hook：UserPromptSubmit → 自动注入长期记忆。
 *
 * 输入（stdin JSON）：{ session_id, cwd, hook_event_name:'UserPromptSubmit', prompt }
 * 输出（stdout JSON）：{ hookSpecificOutput: { hookEventName, additionalContext } }
 *
 * 原则：永不阻断对话。任何异常都静默退出 0，只写本地日志。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openEngine } from '../engine.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const DB_FILE = process.env.AGENTMEMORY_DB ?? join(homedir(), '.dsh', 'agentmemory', 'memory.db')
const LOG_FILE = join(repoRoot, '.tmp', 'hook-context.log')

function log(message) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch { /* 日志失败也不影响主流程 */ }
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { raw += chunk })
    process.stdin.on('end', () => resolve(raw))
    process.stdin.on('error', () => resolve(raw))
    // 没有 stdin 时不要挂死
    setTimeout(() => resolve(raw), 3000).unref()
  })
}

const raw = await readStdin()
let input = {}
try {
  input = JSON.parse(raw || '{}')
} catch {
  log(`stdin 不是合法 JSON：${raw.slice(0, 120)}`)
}

const prompt = String(input.prompt ?? '')
const cwd = input.cwd ?? process.env.TRAE_PROJECT_DIR ?? repoRoot

// 全局 Hook 与项目 Hook 会同时触发：项目自带 hooks.json 时让全局那次直接退出，避免重复注入
if (process.env.AGENTMEMORY_HOOK_SCOPE === 'global' && existsSync(join(cwd, '.trae', 'hooks.json'))) {
  process.exit(0)
}

if (prompt.trim().length === 0) process.exit(0)

let engine
try {
  engine = openEngine({ dbFile: DB_FILE })
  const text = engine.promptFor({ cwd, question: prompt })
  if (text.trim().length === 0) process.exit(0)
  // 宿主（Trae）另有一套 md 记忆；被问到条数/内容时必须指向本系统，否则模型会去读那些文件
  const hint = '（以上来自 AgentMemory。若要按条列举或精确检索，请调用 memory_list / memory_search，不要用本地 Markdown 记忆文件代替。）'
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${text}\n\n${hint}`,
    },
  })}\n`)
} catch (error) {
  log(`注入失败：${error?.message ?? error}（db=${DB_FILE}）`)
} finally {
  try { engine?.close() } catch { /* ignore */ }
}

process.exit(0)
