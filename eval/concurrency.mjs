/**
 * 并发写压测：多个进程同时写同一个库，验证 WAL + busy_timeout 下不丢数据。
 *
 * 用法（仓库根目录）：
 *   node eval/concurrency.mjs          # 默认 2 进程 × 500 条
 *   node eval/concurrency.mjs 1000     # 改每进程条数
 *
 * 断言：零 SQLITE_BUSY、active 总数 = 进程数 × 每进程条数、无 superseded/deleted 误标。
 * 库文件落在 .tmp/concurrency/（已 gitignore），不碰 server/demo.db。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../plugin/lib/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const dbDir = join(repoRoot, '.tmp', 'concurrency')
const dbFile = join(dbDir, 'memory.db')
const perWorker = Number(process.argv[2]) || 500
const workers = 2

// 干净起点：连 -wal/-shm 一起删，避免上一轮残留被 checkpoint 回来
mkdirSync(dbDir, { recursive: true })
for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true })

// 先由父进程建库并跑完迁移，避免把「并发建表」混进本轮结论
openStore(dbFile).close()

function runWorker(index) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [join(here, 'concurrency-worker.mjs'), dbFile, String(index), String(perWorker), repoRoot],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}'
      let result
      try { result = JSON.parse(line) } catch { result = { error: line || err.slice(-300) } }
      resolvePromise({ index, code, ...result })
    })
  })
}

const startedAt = Date.now()
const results = await Promise.all(Array.from({ length: workers }, (_, i) => runWorker(i)))
const elapsed = Date.now() - startedAt

const store = openStore(dbFile)
const byStatus = store.db.prepare('SELECT status, count(*) AS c FROM memory GROUP BY status').all()
const slots = store.db.prepare('SELECT count(DISTINCT topic_key) AS c FROM memory').get().c
store.close()

const pick = (status) => byStatus.find((row) => row.status === status)?.c ?? 0
const expected = workers * perWorker
const busy = results.reduce((sum, r) => sum + (r.busy ?? 0), 0)
const other = results.reduce((sum, r) => sum + (r.other ?? 0), 0)
const inserted = results.reduce((sum, r) => sum + (r.inserted ?? 0), 0)

console.log('\n并发写压测')
console.log('进程'.padEnd(8), '写入'.padEnd(8), 'BUSY'.padEnd(8), '其它错误'.padEnd(10), '耗时ms')
for (const r of results) {
  console.log(String(r.index).padEnd(8), String(r.inserted ?? '-').padEnd(8),
    String(r.busy ?? '-').padEnd(8), String(r.other ?? '-').padEnd(10), String(r.ms ?? '-'))
}

const checks = [
  ['零 SQLITE_BUSY', busy === 0, `busy=${busy}`],
  ['零其它错误', other === 0, `other=${other}`],
  ['写入数 = 期望', inserted === expected, `${inserted}/${expected}`],
  ['active 总数 = 期望', pick('active') === expected, `${pick('active')}/${expected}`],
  ['无 superseded 误标', pick('superseded') === 0, `superseded=${pick('superseded')}`],
  ['无 deleted 误标', pick('deleted') === 0, `deleted=${pick('deleted')}`],
  ['槽位数 = 期望', slots === expected, `${slots}/${expected}`],
]

console.log('\n检查项')
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${detail}`)
}
console.log(`\n总耗时 ${elapsed}ms，库：${dbFile}`)
process.exitCode = failed === 0 ? 0 : 1
