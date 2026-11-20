/**
 * Standalone demo host.
 *
 * Runs the engine behind plain HTTP so the memory model can be shown in a
 * browser without the DSH plugin, an MCP client, or a model in the loop. The
 * extractor below is a scripted stand-in for the model step: it exists so the
 * demo is deterministic, and the page says so out loud.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openEngine } from './engine.js'
import { handleMessage } from './tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 7788)
const DB_FILE = process.env.AGENTMEMORY_DB ?? join(here, 'demo.db')
const CWD = process.env.AGENTMEMORY_CWD ?? process.cwd()

let engine = openEngine({ dbFile: DB_FILE })

function seed() {
  if (engine.state().counts.total > 0) return
  const rows = [
    { scope: 'global', kind: 'profile', topicKey: 'profile.education', importance: 5,
      content: '用户是计算机专业本科生，毕业设计做「基于湖仓一体的金融实时与离线分析看板」' },
    { scope: 'global', kind: 'preference', topicKey: 'preference.style', importance: 4,
      content: '用户偏好先给结论再给理由，不要冗长铺垫' },
    { scope: 'project', kind: 'decision', topicKey: 'tech.datastore', importance: 4,
      content: '毕业设计的数据存储用 PostgreSQL' },
    { scope: 'project', kind: 'fact', topicKey: 'project.pipeline', importance: 3,
      content: '实时链路是 Kafka 行情事件 → Flink 计算 → Iceberg 落湖' },
    { scope: 'project', kind: 'lesson', topicKey: 'project.search', importance: 3,
      content: '中文检索用 FTS5 影子列就够了，不引入外部检索引擎' },
    // Below the project block's importance gate on purpose: these only surface
    // through the retrieval block, which is what makes the third block visible.
    { scope: 'project', kind: 'fact', topicKey: 'project.market-data', importance: 2,
      content: '行情数据用 FAKEPACA 脚本生成模拟盘口，不依赖真实行情源' },
    { scope: 'project', kind: 'fact', topicKey: 'project.dashboard', importance: 2,
      content: '看板前端用 Grafana，告警先接邮件' },
    { scope: 'project', kind: 'lesson', topicKey: 'project.flink', importance: 2,
      content: 'Flink checkpoint 落在 MinIO，作业重启从最近一次 checkpoint 恢复' },
  ]
  for (const row of rows) {
    engine.save({ ...row, cwd: CWD, origin: 'seed', reason: 'demo-seed' })
  }
}

seed()

const SLOTS = {
  数据存储: 'tech.datastore',
  存储: 'tech.datastore',
  数据库: 'tech.datastore',
  消息队列: 'tech.queue',
  检索引擎: 'tech.search',
  部署方式: 'ops.deploy',
}

function slotFor(noun) {
  return SLOTS[noun] ?? `slot.${noun}`
}

/** Scripted extraction: one slot rule plus a plain-fact fallback. */
function extract(text) {
  const clean = text.trim()
  const swap = /把\s*([^，。,\s]{1,12}?)\s*从\s*([^，。,\s]{1,20}?)\s*(?:换成|改成|改为|换为|更新为)了?\s*([^，。,\s]{1,20})/.exec(clean)
  if (swap !== null) {
    const [, noun, from, to] = swap
    return { kind: 'decision', topicKey: slotFor(noun), content: `${noun}从 ${from} 换成 ${to}`, basis: '命中槽位' }
  }
  return { kind: 'fact', topicKey: undefined, content: clean.slice(0, 300), basis: '普通事实' }
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname

    if (req.method === 'GET' && (path === '/' || path === '/demo' || path === '/demo/')) {
      const html = await readFile(join(here, '..', 'demo', 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    // MCP over Streamable HTTP: same tools as the stdio server, but a client
    // that speaks HTTP — Cursor, Claude Code `--transport http` — can point at
    // http://127.0.0.1:7788/mcp without spawning a child process.
    if (path === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
        res.end('POST JSON-RPC here')
        return
      }
      const body = await readBody(req)
      const batch = Array.isArray(body)
      const replies = (batch ? body : [body])
        .map((message) => handleMessage(engine, message, CWD))
        .filter((reply) => reply !== null)
      if (replies.length === 0) {
        res.writeHead(202)
        res.end()
        return
      }
      return sendJson(res, batch ? replies : replies[0])
    }

    if (req.method === 'GET' && path === '/api/health') {
      return sendJson(res, { ok: true, file: DB_FILE, cwd: CWD })
    }

    if (req.method === 'GET' && path === '/api/state') {
      return sendJson(res, { ok: true, state: engine.state() })
    }

    if (req.method === 'GET' && path === '/api/inject') {
      const question = url.searchParams.get('q') ?? ''
      return sendJson(res, { ok: true, inject: engine.inject({ cwd: CWD, question }) })
    }

    if (req.method === 'GET' && path === '/api/history') {
      const id = url.searchParams.get('id') ?? ''
      const versions = engine.history(id)
      return sendJson(res, { ok: true, versions })
    }

    if (req.method === 'GET' && path === '/api/chain') {
      const topic = url.searchParams.get('topic') ?? ''
      const scope = url.searchParams.get('scope') ?? undefined
      return sendJson(res, { ok: true, chain: engine.chain(topic, scope) })
    }

    if (req.method === 'GET' && path === '/api/export') {
      const markdown = engine.markdown()
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
      res.end(markdown)
      return
    }

    // ---------------------------------------------------------------- 管理面板
    if (req.method === 'GET' && path === '/api/list') {
      const status = url.searchParams.get('status') ?? 'active'
      const scope = url.searchParams.get('scope') ?? undefined
      const rows = engine.store.list({
        status: status === 'all' ? 'all' : undefined,
        statuses: status === 'all' ? undefined : [status],
        scope: scope === 'global' || scope === 'project' ? scope : undefined,
        limit: 500,
      })
      return sendJson(res, { ok: true, rows })
    }

    if (req.method === 'GET' && path === '/api/get') {
      const row = engine.get(url.searchParams.get('id') ?? '')
      return row === undefined
        ? sendJson(res, { ok: false, error: '没有这条记忆' }, 404)
        : sendJson(res, { ok: true, row })
    }

    if (req.method === 'POST' && path === '/api/update') {
      const body = await readBody(req)
      const patch = {}
      if (typeof body.content === 'string') patch.content = body.content
      if (typeof body.kind === 'string') patch.kind = body.kind
      if (Number.isFinite(Number(body.importance))) patch.importance = Number(body.importance)
      if (body.pinned !== undefined) patch.pinned = body.pinned === true
      const updated = engine.update(String(body.id ?? ''), patch)
      return updated
        ? sendJson(res, { ok: true })
        : sendJson(res, { ok: false, error: '更新失败：条目不存在或已失效' }, 400)
    }

    if (req.method === 'POST' && path === '/api/forget') {
      const body = await readBody(req)
      const forgotten = engine.forget(String(body.id ?? ''))
      return forgotten
        ? sendJson(res, { ok: true })
        : sendJson(res, { ok: false, error: '删除失败：条目不存在或已失效' }, 400)
    }

    if (req.method === 'POST' && path === '/api/restore') {
      const body = await readBody(req)
      const restored = engine.restore(String(body.id ?? ''))
      return restored
        ? sendJson(res, { ok: true })
        : sendJson(res, { ok: false, error: '恢复失败：只有已删除的条目可以恢复' }, 400)
    }

    if (req.method === 'POST' && path === '/api/say') {
      const body = await readBody(req)
      const text = String(body.text ?? '').trim()
      if (text.length === 0) return sendJson(res, { ok: false, error: '说点什么' }, 400)

      const fact = extract(text)
      const scope = body.scope === 'global' ? 'global' : 'project'
      const { result } = engine.save({
        scope,
        cwd: CWD,
        kind: fact.kind,
        topicKey: fact.topicKey,
        content: fact.content,
        importance: 4,
        origin: 'agent',
        reason: 'demo-extract',
      })
      const replaced = result.status === 'superseded' ? engine.get(result.replaced) : undefined
      return sendJson(res, {
        ok: true,
        said: text,
        extracted: fact,
        result,
        replaced: replaced === undefined ? null : { id: replaced.id, content: replaced.content },
        state: engine.state(),
        inject: engine.inject({ cwd: CWD, question: text }),
      })
    }

    if (req.method === 'POST' && path === '/api/save') {
      const body = await readBody(req)
      const content = String(body.content ?? '').trim()
      if (content.length < 4) return sendJson(res, { ok: false, error: '内容太短' }, 400)
      const { result } = engine.save({
        scope: body.scope === 'project' ? 'project' : 'global',
        cwd: CWD,
        kind: body.kind ?? 'fact',
        topicKey: body.topicKey,
        content,
        importance: Number(body.importance) || 3,
        origin: 'user',
        reason: 'demo-manual',
      })
      return sendJson(res, { ok: true, result, state: engine.state() })
    }

    if (req.method === 'POST' && path === '/api/reset') {
      // 真实库不允许重置：这个接口是演示用的，误点一次就会清空用户记忆
      if (!/demo\.db$/i.test(DB_FILE)) {
        return sendJson(res, { ok: false, error: '真实记忆库禁止重置（只允许 server/demo.db）' }, 403)
      }
      engine.close()
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${DB_FILE}${suffix}`, { force: true })
      }
      engine = openEngine({ dbFile: DB_FILE })
      seed()
      return sendJson(res, { ok: true, state: engine.state() })
    }

    sendJson(res, { ok: false, error: 'not found' }, 404)
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AgentMemory demo → http://127.0.0.1:${PORT}/`)
  console.log(`engine db  → ${DB_FILE}`)
  console.log(`project cwd → ${CWD}`)
})
