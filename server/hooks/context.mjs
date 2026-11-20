/**
 * Trae Hook：UserPromptSubmit → 自动注入长期记忆。
 *
 * 输入（stdin JSON）：{ session_id, cwd, hook_event_name:'UserPromptSubmit', prompt }
 * 输出（stdout JSON）：{ hookSpecificOutput: { hookEventName, additionalContext } }
 *
 * 原则：永不阻断对话。任何异常都静默退出 0，只写本地日志。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
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

if (prompt.trim().length === 0) process.exit(0)

let engine
try {
  engine = openEngine({ dbFile: DB_FILE })
  const text = engine.promptFor({ cwd, question: prompt })
  if (text.trim().length === 0) process.exit(0)
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  })}\n`)
} catch (error) {
  log(`注入失败：${error?.message ?? error}（db=${DB_FILE}）`)
} finally {
  try { engine?.close() } catch { /* ignore */ }
}

process.exit(0)
