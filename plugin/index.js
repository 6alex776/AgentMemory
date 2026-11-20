/**
 * AgentMemory — cross-session long-term memory for DeepSeek Harness.
 *
 * Three surfaces, one store:
 *   1. `ctx.webServer` routes power the sidebar 记忆 panel.
 *   2. `ctx.systemPrompt.context` injects a compact memory block into every session.
 *   3. `ctx.tools.register` gives the model memory_save / memory_search / memory_list /
 *      memory_update / memory_forget / memory_history.
 *
 * The store is SQLite via node:sqlite: no native build, no external service.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore, KIND_LABELS } from './lib/store.js'
import { extractSignals, looksSecret, parseItems, roughlyKnown, shouldFlush } from './lib/capture.js'
import { renderRetrievalBlock } from './lib/retrieval.js'
import { buildMergeProposals, shouldAutoDream } from './lib/dream.js'
import { renderMarkdown } from './lib/export.js'
import { decorate, isExpired } from './lib/lifecycle.js'
import { findAssistantMessage, textOfMessage } from './lib/session-text.js'
import { renderIdentityBlock, renderProjectBlock, selectIdentityRows, selectProjectRows } from './lib/block.js'

export const name = 'agentmemory'

const STATE_PATH = '/api/agentmemory/state'
const MUTATE_PATH = '/api/agentmemory/mutate'
const HISTORY_PATH = '/api/agentmemory/history'
const SUMMARIZE_PATH = '/api/agentmemory/summarize'
const DREAM_PATH = '/api/agentmemory/dream'
const CAPTURE_PATH = '/api/agentmemory/capture'
const RETRIEVE_PATH = '/api/agentmemory/retrieve'
const EXPORT_PATH = '/api/agentmemory/export'
const FLUSH_PATH = '/api/agentmemory/flush'
const MESSAGE_PATH = '/api/agentmemory/message'
const SAVE_PATH = '/api/agentmemory/save'
const TURN_PATH = '/api/agentmemory/turn'

function databaseFile(configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured
  if (typeof process.env.AGENTMEMORY_DB === 'string' && process.env.AGENTMEMORY_DB.length > 0) {
    return process.env.AGENTMEMORY_DB
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'agentmemory', 'memory.db')
}

/** The panel routes are local-only unless the operator opts into remote use. */
function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address.endsWith('127.0.0.1')
}

/** Read one JSON request body with a hard size cap. */
function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('body must be JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * Build the identity block: compact, deterministic, stable order.
 * Each line carries the stored abstract; the full text is one `memory_search`
 * away, which keeps the injection cost roughly constant as memory grows.
 * @returns {{text: string, stats: {chars: number, fullChars: number, entries: number, omitted: number}, ids: string[]}}
 */
function renderCoreBlock(store, cwd, maxChars, includeIds = true) {
  const now = Date.now()
  // Expired memories are not facts anymore; keep them out of the prompt.
  const rows = store.list({ statuses: ['active'], limit: 200 }).filter((row) => !isExpired(row, now))
  return renderIdentityBlock(selectIdentityRows(rows), { maxChars, includeIds })
}

/**
 * Build the project block: what this project already decided.
 *
 * Rendered fresh on every assembly (unlike the identity block, which the
 * session snapshot freezes), because project facts change far more often and
 * a new decision should reach the next turn, not the next session.
 */
function renderProjectRowBlock(store, cwd, maxChars, includeIds = true, minImportance = 3) {
  const project = store.resolveProject(cwd)
  if (project === undefined) {
    return { text: '', ids: [], stats: { chars: 0, fullChars: 0, entries: 0, omitted: 0 } }
  }
  const now = Date.now()
  const rows = store.list({ statuses: ['active'], limit: 200 }).filter((row) => !isExpired(row, now))
  return renderProjectBlock(selectProjectRows(rows, project.id, minImportance), { maxChars, includeIds })
}

/** Resolve the model route: explicit config wins, otherwise the default selection. */
function resolveModel(ctx, options) {
  let provider = options.overviewProvider
  let model = options.overviewModel
  if (provider.length === 0 || model.length === 0) {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    provider = provider || selection?.provider || ''
    model = model || selection?.model || ''
  }
  if (provider.length === 0 || model.length === 0) {
    throw new Error('没有可用的模型；请先在设置里选默认模型，或配置 overviewProvider / overviewModel')
  }
  return { provider, model }
}

/**
 * One streaming completion; throws a readable message on failure.
 *
 * Utility calls (grouping, extraction, overview) can burn the whole output
 * budget on reasoning tokens and finish with `max-tokens` before emitting any
 * text. That is not a failure of the task, so retry once with double budget
 * instead of surfacing an empty result.
 */
async function streamCompletion(ctx, options, system, prompt, maxTokens, temperature = 0.3) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('LLM 服务不可用')
  const { provider, model } = resolveModel(ctx, options)

  const runOnce = async (budget) => {
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: budget,
      temperature,
    })

    let text = ''
    let blockText = ''
    let reasoning = 0
    let finishKind = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'reasoning-delta') {
        reasoning += chunk.text.length
        continue
      }
      if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
        blockText += chunk.block.text
        continue
      }
      if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind ?? ''
        if (finishKind === 'error') throw new Error(chunk.reason?.failure?.message ?? '模型调用失败')
        if (finishKind === 'aborted') throw new Error('模型调用被取消')
      }
    }
    return { text: (text.length > 0 ? text : blockText).trim(), finishKind, reasoning }
  }

  let budget = maxTokens
  let result = await runOnce(budget)
  if (result.text.length === 0 && result.finishKind === 'max-tokens' && budget < 6000) {
    budget = Math.min(6000, budget * 2)
    ctx.logger?.info?.(`agentmemory: retrying with maxTokens=${budget} (reasoning used ${result.reasoning} chars)`)
    result = await runOnce(budget)
  }
  if (result.text.length === 0) {
    throw new Error(
      `模型返回为空（finish=${result.finishKind || 'none'}，推理 ${result.reasoning} 字符，预算 ${budget}）`,
    )
  }
  return { text: result.text, model: `${provider}/${model}` }
}

/** Prompt for the overview: only the given memories, no invention. */
function buildOverviewPrompt(rows) {
  const lines = []
  let used = 0
  for (const row of rows) {
    const where = row.scope === 'global' ? '全局' : `项目 ${row.projectName || ''}`.trim()
    const line = `- [${where}/${KIND_LABELS[row.kind] ?? row.kind}] ${row.content}`
    if (used + line.length > 6000) break
    lines.push(line)
    used += line.length + 1
  }
  return [
    '请用中文写一段 120–200 字的「记忆概览」，用第二人称「你」，覆盖：身份与学业背景、技术栈与兴趣、当前项目与进展、长期偏好与目标。',
    '要求：只使用下面给出的记忆，不要编造；不要逐条罗列；不要加标题、不要用 Markdown；时间尽量用「目前」「最近」这类相对说法。',
    '',
    '记忆：',
    ...lines,
  ].join('\n')
}

/**
 * Step 1 of consolidation: ask only for topic groups. Merging is decided by
 * code (see lib/dream.js), because a small model either refuses or invents.
 */
function buildGroupPrompt(rows) {
  const lines = []
  let used = 0
  let index = 0
  for (const row of rows) {
    index += 1
    const where = row.scope === 'global' ? '全局' : `项目 ${row.projectName || ''}`.trim()
    const line = `${index}) [${where}/${KIND_LABELS[row.kind] ?? row.kind}] ${row.content.slice(0, 160)}`
    if (used + line.length > 6000) break
    lines.push(line)
    used += line.length + 1
  }
  return [
    '把下面这些长期记忆按主题分组：讲同一件事、同一个人、同一个项目的放一组。',
    '只输出 JSON，不要解释、不要 Markdown 代码块：',
    '{"groups":[{"topic":"职业规划","ids":[1,3]}]}',
    '规则：',
    '1. ids 填上面列表的序号（整数），例如 [1,3]；不要写 id 字符串、不要写 undefined。',
    '2. 每条记忆至少出现在一个组里；宁可单独成组，也不要硬凑。',
    '3. 不要编造新内容，只做归类。',
    '',
    '记忆列表（序号) [范围/类型] 内容）：',
    ...lines,
  ].join('\n')
}

/** Pull `groups` out of a model reply that may add prose or fences. */
function parseGroups(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed?.groups) ? parsed.groups : []
  } catch {
    return []
  }
}

/** One overview generation; returns the saved summary. */
async function generateOverview(ctx, store, options) {
  const rows = store.summaryInput()
  if (rows.length === 0) return store.summarySave('', null)
  const { text, model } = await streamCompletion(
    ctx,
    options,
    '你在为一位用户维护长期记忆摘要。只使用给定内容，不编造，不输出标题。',
    buildOverviewPrompt(rows),
    800,
  )
  return store.summarySave(text, model)
}

/**
 * Two-step consolidation: the model groups by topic (cheap, reliable), then
 * code decides which members are similar enough to merge and what the merged
 * text is. Nothing is applied until the user accepts.
 */
async function runDream(ctx, store, options) {
  const rows = store.summaryInput()
  if (rows.length < 2) return { created: [], skipped: 0, empty: true }

  const { text } = await streamCompletion(
    ctx,
    options,
    '你在整理长期记忆库。只输出 JSON，不要解释。',
    buildGroupPrompt(rows),
    1200,
    0,
  )

  const groups = parseGroups(text)
  const byId = new Map(rows.map((row) => [row.id, row]))

  // The model is asked for 1-based indices because small integers copy far more
  // reliably than hex ids. Real ids are still accepted if it volunteers them.
  const resolveRef = (value) => {
    if (typeof value === 'number' && Number.isInteger(value)) return rows[value - 1]?.id
    const raw = String(value ?? '').trim()
    if (/^\d+$/.test(raw)) return rows[Number(raw) - 1]?.id
    if (byId.has(raw)) return raw
    return undefined
  }
  const resolvedGroups = groups.map((group) => ({
    topic: group?.topic,
    ids: [...new Set((Array.isArray(group?.ids) ? group.ids : [])
      .map(resolveRef)
      .filter((id) => typeof id === 'string'))],
  }))

  const proposals = buildMergeProposals(resolvedGroups, byId, {
    threshold: options.mergeSimilarity,
    maxProposals: 8,
  })

  const pending = new Set(
    store.proposalsPending().map((proposal) => [...(proposal.payload?.ids ?? [])].sort().join(',')),
  )
  const created = []
  for (const proposal of proposals) {
    const key = [...proposal.ids].sort().join(',')
    if (pending.has(key)) continue
    try {
      const id = store.proposalInsert(
        'merge',
        { ids: proposal.ids, content: proposal.content, kind: proposal.kind },
        proposal.reason,
      )
      created.push({ id, op: 'merge', ids: proposal.ids, content: proposal.content })
    } catch { /* a single bad proposal must not abort the run */ }
  }

  if (created.length === 0) {
    ctx.logger?.info?.(`agentmemory: dream found nothing; groups=${groups.length}, candidates=${proposals.length}`)
  }
  return {
    created,
    skipped: proposals.length - created.length,
    groups: resolvedGroups.length,
    resolved: resolvedGroups,
    raw: created.length === 0 ? text.slice(0, 400) : undefined,
  }
}

/** Prompt for conversational extraction: user statements only, strict JSON out. */
function buildExtractPrompt(text) {
  return [
    '下面是一段用户发言。请提取其中值得长期记住的、关于用户本人的稳定信息：身份与背景、技能、偏好、长期目标、项目背景、明确做出的技术决策。',
    '要求：',
    '1. 只提取用户明确陈述的内容；不要推断，不要从提问里猜，不要把助手的回答当作用户事实。',
    '2. 每条一句话、自包含、不超过 80 字；不要写「用户说」「我」这类指代。',
    '3. kind 只能是 profile / preference / fact / decision / lesson。',
    '4. 没有值得记住的就输出 {"items":[]}。',
    '只输出 JSON，不要解释、不要 Markdown：',
    '{"items":[{"content":"用户……","kind":"fact","importance":3,"confidence":0.8,"topic_key":""}]}',
    '',
    '用户发言：',
    text.slice(0, 4000),
  ].join('\n')
}


/** One extraction pass: model proposes, store dedupes and slots the result. */
async function extractFacts(ctx, store, options, text, sessionId) {
  const { text: reply } = await streamCompletion(
    ctx,
    options,
    '你是记忆抽取器。只输出 JSON，不要解释。',
    buildExtractPrompt(text),
    800,
    0,
  )
  const items = parseItems(reply).slice(0, 6)
  let added = 0
  for (const item of items) {
    const content = String(item?.content ?? '').trim()
    const confidence = Number(item?.confidence ?? 0)
    const kind = ['profile', 'preference', 'fact', 'decision', 'lesson'].includes(item?.kind)
      ? item.kind
      : 'fact'
    if (content.length < 4 || content.length > 200) continue
    if (confidence < 0.55) continue
    if (/[?？]$/.test(content)) continue
    if (looksSecret(content)) continue
    try {
      const result = store.add({
        scope: 'global',
        kind,
        topicKey: typeof item?.topic_key === 'string' ? item.topic_key : undefined,
        content,
        importance: Math.min(5, Math.max(1, Number(item?.importance) || 3)),
        origin: 'agent',
        sessionId,
        reason: 'auto-capture',
      })
      if (result.status === 'added' || result.status === 'superseded') added += 1
    } catch {
      // one bad item must not abort the rest
    }
  }
  return added
}

export function apply(ctx, config = {}) {
  const options = {
    dbPath: typeof config.dbPath === 'string' && config.dbPath.trim().length > 0 ? config.dbPath.trim() : undefined,
    maxInjectChars: Number(config.maxInjectChars) >= 200 ? Number(config.maxInjectChars) : 1200,
    // Identity block budget. Separate from maxInjectChars (the legacy single-block
    // ceiling) so the two blocks can be tuned independently.
    identityMaxChars: Number(config.identityMaxChars) >= 100
      ? Number(config.identityMaxChars)
      : (config.maxInjectChars !== undefined ? Math.min(1200, Number(config.maxInjectChars) || 400) : 400),
    projectBlock: config.projectBlock !== false,
    projectMaxChars: Number(config.projectMaxChars) >= 200 ? Number(config.projectMaxChars) : 800,
    projectMinImportance: Number(config.projectMinImportance) >= 1
      ? Math.min(5, Number(config.projectMinImportance))
      : 3,
    allowRemote: config.allowRemote === true,
    overviewProvider: typeof config.overviewProvider === 'string' ? config.overviewProvider : '',
    overviewModel: typeof config.overviewModel === 'string' ? config.overviewModel : '',
    autoCapture: config.autoCapture !== false,
    captureMinChars: Number(config.captureMinChars) > 20 ? Number(config.captureMinChars) : 60,
    // A turn boundary is the reliable flush point; the idle timer below is only
    // a fallback for sessions that stop without a closing event.
    captureTurnChars: Number(config.captureTurnChars) > 20 ? Number(config.captureTurnChars) : 300,
    captureIdleMinutes: Number(process.env.AGENTMEMORY_CAPTURE_IDLE_MINUTES) >= 1
      ? Number(process.env.AGENTMEMORY_CAPTURE_IDLE_MINUTES)
      : (Number(config.captureIdleMinutes) >= 1 ? Number(config.captureIdleMinutes) : 8),
    coreSnapshot: config.coreSnapshot === 'live' ? 'live' : 'session',
    retrieval: config.retrieval !== false,
    retrievalMaxChars: Number(config.retrievalMaxChars) > 100 ? Number(config.retrievalMaxChars) : 600,
    retrievalLimit: Number(config.retrievalLimit) > 0 ? Math.min(8, Number(config.retrievalLimit)) : 4,
    mergeSimilarity: Number(config.mergeSimilarity) >= 0.3 && Number(config.mergeSimilarity) <= 0.95
      ? Number(config.mergeSimilarity)
      : 0.55,
    includeIds: config.includeIds !== false,
    staleDays: Number(config.staleDays) > 0 ? Number(config.staleDays) : 90,
    // Background consolidation: on by default, but gated by volume and clock so
    // it never fires on a nearly empty library or on top of an unreviewed card.
    autoDream: config.autoDream !== false,
    dreamIntervalDays: Number(config.dreamIntervalDays) > 0 ? Number(config.dreamIntervalDays) : 7,
    dreamMinMemories: Number(config.dreamMinMemories) > 1 ? Number(config.dreamMinMemories) : 8,
  }

  let store
  let openError
  /** Last injection measurement, surfaced to the panel as a cost readout. */
  const injectionStats = {
    chars: 0,
    fullChars: 0,
    entries: 0,
    omitted: 0,
    projectChars: 0,
    projectEntries: 0,
    at: 0,
  }
  /** Last conversational capture, surfaced so the panel can explain itself. */
  const captureStats = { at: 0, added: 0, chars: 0, skipped: 0, pending: 0, reason: '' }
  /** Last consolidation attempt, including the reason the gate stayed shut. */
  const dreamStats = { at: 0, created: 0, reason: '', running: false }

  const getStore = () => {
    if (store !== undefined) return store
    if (openError !== undefined) throw openError
    try {
      store = openStore(databaseFile(options.dbPath))
      ctx.logger?.info?.(`agentmemory: store at ${store.file}`)
      return store
    } catch (error) {
      openError = error
      ctx.logger?.warn?.(`agentmemory: cannot open store: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  // Safe wrapper for surfaces that must never throw into the host.
  const withStore = (fn, fallback) => {
    try {
      return fn(getStore())
    } catch (error) {
      ctx.logger?.warn?.(`agentmemory: ${error instanceof Error ? error.message : String(error)}`)
      return fallback
    }
  }

  /**
   * Read one assistant message out of the durable session log.
   * The chat action row only knows ids, so the text has to come from here.
   */
  const readAssistantMessage = async (sessionId, messageId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { error: 'sessionId required' }
    if (typeof messageId !== 'string' || messageId.length === 0) return { error: 'messageId required' }
    let persistence
    try {
      persistence = ctx.get('sessionPersistence')
    } catch {
      persistence = undefined
    }
    if (persistence === undefined || persistence === null) return { error: 'session store unavailable' }
    const handle = await persistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read()
      const message = findAssistantMessage(events, messageId)
      if (message === undefined) return { error: 'message not found' }
      return { text: textOfMessage(message), cwd: handle.header?.cwd }
    } finally {
      try {
        await handle.close()
      } catch { /* already closed */ }
    }
  }

  ctx.effect(() => () => {
    try {
      store?.close()
    } catch { /* already closed */ }
    store = undefined
    openError = undefined
  }, 'agentmemory.store()')

  /**
   * Background consolidation, fired from a finished turn and never awaited.
   *
   * Three things keep it quiet: a volume floor, a persisted interval, and the
   * presence of an unreviewed suggestion. When the gate stays shut the reason
   * is kept so the panel can say why nothing happened yet.
   */
  const autoDream = async () => {
    if (!options.autoDream || dreamStats.running) return
    let live
    try {
      live = getStore()
    } catch {
      return
    }
    const decision = shouldAutoDream({
      now: Date.now(),
      lastAt: live.dreamLastAt(),
      activeCount: live.list({ statuses: ['active'], limit: 1000 }).length,
      pending: live.proposalsPending().length,
      minMemories: options.dreamMinMemories,
      intervalDays: options.dreamIntervalDays,
    })
    if (!decision.ok) {
      dreamStats.reason = decision.reason
      return
    }
    dreamStats.running = true
    dreamStats.reason = '整理中…'
    try {
      const result = await runDream(ctx, live, options)
      const at = Date.now()
      live.noteDream(at, result.created.length)
      dreamStats.at = at
      dreamStats.created = result.created.length
      dreamStats.reason = result.created.length > 0
        ? `自动整理新增 ${result.created.length} 条建议`
        : '没有可合并的条目'
      if (result.created.length > 0) {
        ctx.logger?.info?.(`agentmemory: auto dream proposed ${result.created.length}`)
      }
    } catch (error) {
      dreamStats.reason = `整理失败：${error instanceof Error ? error.message : String(error)}`
      ctx.logger?.warn?.(`agentmemory: auto dream failed: ${dreamStats.reason}`)
    } finally {
      dreamStats.running = false
    }
  }

  // ---------------------------------------------------------------- HTTP panel
  ctx.inject(['webServer'], (webCtx) => {
    const allow = (req, res) => {
      if (options.allowRemote || isLocalRequest(req)) return true
      sendJson(res, 403, { error: 'agentmemory routes are local-only; set config.allowRemote to expose them' })
      return false
    }

    const disposeState = webCtx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const payload = withStore((s) => s.state(), { error: 'store unavailable' })
        if (payload.error === undefined) {
          const now = Date.now()
          payload.groups = payload.groups.map((group) => ({
            ...group,
            items: decorate(group.items, now, options.staleDays),
          }))
          payload.superseded = decorate(payload.superseded, now, options.staleDays)
          payload.injection = { ...injectionStats }
          payload.capture = { ...captureStats }
          payload.dream = { ...dreamStats }
          payload.retrieval = { ...retrievalStats }
        }
        sendJson(res, payload.error === undefined ? 200 : 500, payload)
      },
    })

    const disposeMutate = webCtx.webServer.register({
      kind: 'exact',
      path: MUTATE_PATH,
      handler: async (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad body' })
          return
        }
        try {
          const result = withStore((s) => {
            const op = String(body.op ?? '')
            if (op === 'add') {
              return s.add({
                scope: body.scope === 'project' ? 'project' : 'global',
                projectId: body.projectId,
                kind: body.kind,
                topicKey: body.topicKey,
                content: body.content,
                importance: body.importance,
                origin: 'user',
              })
            }
            if (op === 'update') return { ok: s.update(String(body.id), { content: body.content, importance: body.importance, pinned: body.pinned, kind: body.kind }) }
            if (op === 'delete') return { ok: s.forget(String(body.id)) }
            if (op === 'restore') return { ok: s.restore(String(body.id)) }
            if (op === 'purge') return { ok: s.purge(String(body.id)) }
            if (op === 'rollback') return { ok: s.rollback(String(body.id), Number(body.versionId)) }
            if (op === 'pin') return { ok: s.update(String(body.id), { pinned: body.pinned === true }) }
            if (op === 'verify') return { ok: s.verify(String(body.id)) }
            if (op === 'expiry') return { ok: s.update(String(body.id), { expiresAt: body.expiresAt }) }
            if (op === 'decide') return s.decideProposal(Number(body.id), body.accept === true)
            throw new Error(`unknown op ${JSON.stringify(op)}`)
          }, { error: 'store unavailable' })
          if (result?.error !== undefined) {
            sendJson(res, 500, result)
            return
          }
          const state = withStore((s) => s.state(), { error: 'store unavailable' })
          if (state.error === undefined) state.injection = { ...injectionStats }
          sendJson(res, 200, { ok: true, result, state })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    const disposeHistory = webCtx.webServer.register({
      kind: 'exact',
      path: HISTORY_PATH,
      handler: (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? HISTORY_PATH, 'http://localhost')
        const id = url.searchParams.get('id')
        if (typeof id !== 'string' || !id.startsWith('m_')) {
          sendJson(res, 400, { error: 'id required' })
          return
        }
        const rows = withStore((s) => s.history(id), [])
        sendJson(res, 200, {
          versions: rows.map((row) => {
            let content = ''
            try {
              const parsed = row.after_json === null ? null : JSON.parse(row.after_json)
              content = parsed !== null && typeof parsed.content === 'string' ? parsed.content : ''
            } catch { /* keep empty */ }
            return {
              id: row.id,
              op: row.op,
              actor: row.actor,
              at: row.created_at,
              reason: row.reason,
              content,
            }
          }),
        })
      },
    })

    const disposeSummarize = webCtx.webServer.register({
      kind: 'exact',
      path: SUMMARIZE_PATH,
      handler: async (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const summary = await generateOverview(ctx, getStore(), options)
          const state = withStore((s) => s.state(), undefined)
          if (state !== undefined) state.injection = { ...injectionStats }
          sendJson(res, 200, { ok: true, summary, state })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`agentmemory: overview failed: ${message}`)
          sendJson(res, 200, { ok: false, error: message, summary: withStore((s) => s.summaryGet(), null) })
        }
      },
    })

    const disposeDream = webCtx.webServer.register({
      kind: 'exact',
      path: DREAM_PATH,
      handler: async (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const result = await runDream(ctx, getStore(), options)
          const state = withStore((s) => s.state(), undefined)
          if (state !== undefined) state.injection = { ...injectionStats }
          sendJson(res, 200, { ok: true, ...result, state })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`agentmemory: dream failed: ${message}`)
          sendJson(res, 200, { ok: false, error: message })
        }
      },
    })

    // Manual capture: the same extraction the turn hook runs, exposed so a
    // conversation can be backfilled or a snippet tested by hand.
    const disposeCapture = webCtx.webServer.register({
      kind: 'exact',
      path: CAPTURE_PATH,
      handler: async (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad body' })
          return
        }
        const text = String(body.text ?? '').trim()
        if (text.length === 0) {
          sendJson(res, 400, { error: 'text required' })
          return
        }
        try {
          const added = await extractFacts(ctx, getStore(), options, text, String(body.sessionId ?? 'manual'))
          captureStats.added = added
          captureStats.chars = text.length
          captureStats.at = Date.now()
          sendJson(res, 200, { ok: true, added, state: withStore((s) => s.state(), undefined) })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // Debug/preview hook: render exactly what retrieval would inject for a query.
    const disposeRetrieve = webCtx.webServer.register({
      kind: 'exact',
      path: RETRIEVE_PATH,
      handler: (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? RETRIEVE_PATH, 'http://localhost')
        const query = (url.searchParams.get('q') ?? '').trim()
        if (query.length === 0) {
          sendJson(res, 400, { error: 'q required' })
          return
        }
        const rows = withStore((s) => s.search(query, { limit: 8, allScopes: true }), [])
        const block = renderRetrievalBlock(rows, { maxChars: options.retrievalMaxChars })
        sendJson(res, 200, { ok: true, query, hits: block.ids.length, chars: block.chars, text: block.text })
      },
    })

    // Portable Markdown copy of the whole store.
    const disposeExport = webCtx.webServer.register({
      kind: 'exact',
      path: EXPORT_PATH,
      handler: (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const state = withStore((s) => s.state(), undefined)
        if (state === undefined) {
          sendJson(res, 500, { error: 'store unavailable' })
          return
        }
        const markdown = renderMarkdown(state, new Date())
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="agentmemory-${Date.now()}.md"`,
          'cache-control': 'no-store',
        })
        res.end(markdown)
      },
    })

    // Flush buffered signals now instead of waiting for idle.
    const disposeFlush = webCtx.webServer.register({
      kind: 'exact',
      path: FLUSH_PATH,
      handler: async (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (typeof flushAll.fn !== 'function') {
          sendJson(res, 200, { ok: false, error: 'capture 未就绪' })
          return
        }
        try {
          await flushAll.fn()
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        const state = withStore((s) => s.state(), undefined)
        if (state !== undefined) {
          state.injection = { ...injectionStats }
          state.capture = { ...captureStats }
          state.retrieval = { ...retrievalStats }
        }
        sendJson(res, 200, { ok: true, added: captureStats.added, state })
      },
    })

    // Manual save entry point for the chat action row: the client only holds
    // ids, so the text is resolved here from the session log.
    const disposeMessage = webCtx.webServer.register({
      kind: 'exact',
      path: MESSAGE_PATH,
      handler: async (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? MESSAGE_PATH, 'http://localhost')
        const sessionId = (url.searchParams.get('session') ?? '').trim()
        const messageId = (url.searchParams.get('message') ?? '').trim()
        try {
          const found = await readAssistantMessage(sessionId, messageId)
          if (found.error !== undefined) {
            sendJson(res, 200, { ok: false, error: found.error })
            return
          }
          sendJson(res, 200, { ok: true, text: found.text.slice(0, 4000), cwd: found.cwd })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // Store exactly what the user approved — no extraction, no model call.
    const disposeSave = webCtx.webServer.register({
      kind: 'exact',
      path: SAVE_PATH,
      handler: async (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad body' })
          return
        }
        try {
          let content = typeof body.content === 'string' ? body.content.trim() : ''
          let cwd = typeof body.cwd === 'string' ? body.cwd : undefined
          if (content.length === 0) {
            const found = await readAssistantMessage(
              typeof body.sessionId === 'string' ? body.sessionId : '',
              typeof body.messageId === 'string' ? body.messageId : '',
            )
            if (found.error !== undefined) {
              sendJson(res, 200, { ok: false, error: found.error })
              return
            }
            content = found.text.trim()
            cwd = cwd ?? found.cwd
          }
          if (content.length < 4) {
            sendJson(res, 200, { ok: false, error: '内容太短，至少 4 个字' })
            return
          }
          if (content.length > 1000) content = `${content.slice(0, 1000)}…`
          // Nothing reaches the store if it looks like a credential, no matter
          // whether the model proposed it or the user clicked 存入记忆.
          if (looksSecret(content)) {
            sendJson(res, 200, { ok: false, error: '内容里像是密钥或密码，已拒绝保存' })
            return
          }
          const project = body.scope === 'project'
            ? withStore((s) => s.ensureProject(cwd), undefined)
            : undefined
          if (body.scope === 'project' && project === undefined) {
            sendJson(res, 200, { ok: false, error: '当前会话没有可归属的项目目录' })
            return
          }
          const result = withStore((s) => s.add({
            scope: project === undefined ? 'global' : 'project',
            projectId: project?.id,
            kind: body.kind,
            topicKey: typeof body.topicKey === 'string' && body.topicKey.trim().length > 0 ? body.topicKey.trim() : undefined,
            content,
            importance: Number(body.importance),
            origin: 'user',
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            reason: 'chat-action',
          }), { status: 'error', id: '' })
          const state = withStore((s) => s.state(), undefined)
          if (state !== undefined) state.injection = { ...injectionStats }
          sendJson(res, 200, { ok: true, result, state })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // What one finished turn actually carried, for the chat footer.
    const disposeTurn = webCtx.webServer.register({
      kind: 'exact',
      path: TURN_PATH,
      handler: (req, res) => {
        if (!allow(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? TURN_PATH, 'http://localhost')
        const sessionId = (url.searchParams.get('session') ?? '').trim()
        const turn = Number(url.searchParams.get('turn') ?? '')
        if (sessionId.length === 0 || !Number.isFinite(turn)) {
          sendJson(res, 400, { ok: false, error: 'session and turn required' })
          return
        }
        const trace = withStore((s) => s.readTurn(sessionId, turn), undefined)
        if (trace === undefined) {
          sendJson(res, 200, { ok: false, error: 'no trace' })
          return
        }
        sendJson(res, 200, { ok: true, trace })
      },
    })

    webCtx.effect(() => disposeState, 'agentmemory.state-route()')
    webCtx.effect(() => disposeMutate, 'agentmemory.mutate-route()')
    webCtx.effect(() => disposeHistory, 'agentmemory.history-route()')
    webCtx.effect(() => disposeSummarize, 'agentmemory.summarize-route()')
    webCtx.effect(() => disposeDream, 'agentmemory.dream-route()')
    webCtx.effect(() => disposeCapture, 'agentmemory.capture-route()')
    webCtx.effect(() => disposeRetrieve, 'agentmemory.retrieve-route()')
    webCtx.effect(() => disposeExport, 'agentmemory.export-route()')
    webCtx.effect(() => disposeFlush, 'agentmemory.flush-route()')
    webCtx.effect(() => disposeMessage, 'agentmemory.message-route()')
    webCtx.effect(() => disposeSave, 'agentmemory.save-route()')
    webCtx.effect(() => disposeTurn, 'agentmemory.turn-route()')
    ctx.logger?.info?.(`agentmemory: routes at ${STATE_PATH}`)
  })

  // ---------------------------------------------------------------- injection
  // The rendered block is frozen per session by default: a mid-session write
  // would otherwise supersede the runtime-context snapshot and cost a fresh
  // prefix on the next request. Live mode re-renders on every assembly.
  const coreCache = new Map()
  /** agentId -> ids the injected block actually contained. */
  const lastInjected = new Map()
  /** agentId -> the user's current question, used for per-turn retrieval. */
  const lastQuestion = new Map()
  /** sessionId -> what the in-flight turn is carrying, flushed at turn end. */
  const turnTrace = new Map()
  const patchTurn = (sessionId, patch) => {
    if (sessionId.length === 0) return
    const current = turnTrace.get(sessionId) ?? {}
    // The first render of a turn fixes the window; later steps must not move it.
    const startedAt = current.startedAt ?? patch.startedAt
    turnTrace.set(sessionId, { ...current, ...patch, startedAt })
    if (turnTrace.size > 64) turnTrace.delete(turnTrace.keys().next().value)
  }
  const retrievalStats = { chars: 0, hits: 0, at: 0, query: '' }
  /** Set by the capture effect so the panel can flush on demand. */
  const flushAll = { fn: null }
  /** `${agentId}:${memoryId}` already counted as used in this session. */
  const markedIds = new Set()
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.context({
      name: 'agentmemory:core',
      order: -150,
      text: (context) => {
        try {
          const agent = context?.agent
          if (agent === undefined || agent === null) return ''
          const header = agent.session?.header
          if (header?.origin === 'subagent') return ''
          const agentId = String(agent.id ?? '')
          if (!withStore((s) => s.sessionAllowed(agentId), true)) return ''
          if (options.coreSnapshot === 'session' && agentId.length > 0) {
            const hit = coreCache.get(agentId)
            if (hit !== undefined) {
              Object.assign(injectionStats, hit.stats)
              return hit.text
            }
          }
          const cwd = header?.cwd
          const current = getStore()
          const block = renderCoreBlock(current, cwd, options.identityMaxChars, options.includeIds)
          if (options.coreSnapshot === 'session' && agentId.length > 0) {
            if (coreCache.size > 64) coreCache.delete(coreCache.keys().next().value)
            coreCache.set(agentId, block)
          }
          injectionStats.chars = block.stats.chars
          injectionStats.fullChars = block.stats.fullChars
          injectionStats.entries = block.stats.entries
          injectionStats.omitted = block.stats.omitted
          injectionStats.at = Date.now()
          if (agentId.length > 0) {
            lastInjected.set(agentId, block.ids)
            if (lastInjected.size > 128) lastInjected.delete(lastInjected.keys().next().value)
          }
          return block.text
        } catch (error) {
          ctx.logger?.warn?.(`agentmemory: injection failed: ${error instanceof Error ? error.message : String(error)}`)
          return ''
        }
      },
    }), 'agentmemory.context()')

    // The project half: a second block, rebuilt on every assembly.
    //
    // It sits right after the identity block so the stable prefix stays intact
    // and only its own lines change when a new project decision is written —
    // that decision reaches the next turn instead of the next session, which is
    // the whole reason it is not frozen with the identity half.
    promptCtx.effect(() => promptCtx.systemPrompt.context({
      name: 'agentmemory:project',
      order: -140,
      text: (context) => {
        try {
          if (!options.projectBlock) return ''
          const agent = context?.agent
          if (agent === undefined || agent === null) return ''
          const header = agent.session?.header
          if (header?.origin === 'subagent') return ''
          const agentId = String(agent.id ?? '')
          if (!withStore((s) => s.sessionAllowed(agentId), true)) return ''
          const current = getStore()
          const block = renderProjectRowBlock(
            current,
            header?.cwd,
            options.projectMaxChars,
            options.includeIds,
            options.projectMinImportance,
          )
          injectionStats.projectChars = block.stats.chars
          injectionStats.projectEntries = block.stats.entries
          if (agentId.length > 0) {
            const coreIds = coreCache.get(agentId)?.ids ?? lastInjected.get(agentId) ?? []
            // Both blocks are injected: everything in them counts as used.
            lastInjected.set(agentId, [...new Set([...coreIds, ...block.ids])])
            if (lastInjected.size > 128) lastInjected.delete(lastInjected.keys().next().value)
          }
          return block.text
        } catch (error) {
          ctx.logger?.warn?.(`agentmemory: project injection failed: ${error instanceof Error ? error.message : String(error)}`)
          return ''
        }
      },
    }), 'agentmemory.project-context()')

    // Per-turn retrieval: the current question selects a few related memories
    // that the core block does not already carry. Late order keeps the stable
    // prefix intact and only the tail changes between turns.
    promptCtx.effect(() => promptCtx.systemPrompt.context({
      name: 'agentmemory:retrieval',
      order: 900,
      text: (context) => {
        try {
          if (!options.retrieval) return ''
          const agent = context?.agent
          if (agent === undefined || agent === null) return ''
          const header = agent.session?.header
          if (header?.origin === 'subagent') return ''
          const agentId = String(agent.id ?? '')
          if (!withStore((s) => s.sessionAllowed(agentId), true)) return ''
          const question = lastQuestion.get(agentId)
          if (question === undefined || question.trim().length < 4) return ''

          const current = getStore()
          const project = current.resolveProject(header?.cwd)
          const rows = current.search(question, {
            projectId: project?.id,
            limit: options.retrievalLimit + 2,
          })
          retrievalStats.query = question.slice(0, 60)
          retrievalStats.at = Date.now()
          if (rows.length === 0) {
            retrievalStats.chars = 0
            retrievalStats.hits = 0
            patchTurn(agentId, { retrievalIds: [], retrievalChars: 0 })
            return ''
          }

          const core = coreCache.get(agentId)
          const block = renderRetrievalBlock(rows, {
            coreIds: core?.ids ?? lastInjected.get(agentId),
            coreText: core?.text ?? '',
            maxChars: options.retrievalMaxChars,
            includeIds: options.includeIds,
          })
          retrievalStats.chars = block.chars
          retrievalStats.hits = block.ids.length
          patchTurn(agentId, {
            question: question.slice(0, 200),
            retrievalIds: block.ids,
            retrievalChars: block.chars,
            startedAt: Date.now(),
          })
          return block.text
        } catch (error) {
          ctx.logger?.warn?.(`agentmemory: retrieval failed: ${error instanceof Error ? error.message : String(error)}`)
          return ''
        }
      },
    }), 'agentmemory.retrieval-context()')
  })

  // ---------------------------------------------------------------- tools
  ctx.inject(['tools'], (toolCtx) => {
    const cwdOf = (exec) => {
      try {
        return exec?.agent?.session?.header?.cwd
      } catch {
        return undefined
      }
    }

    const resolveScope = (exec, requested) => {
      if (requested !== 'project') return { scope: 'global', projectId: null }
      const project = withStore((s) => s.ensureProject(cwdOf(exec)), undefined)
      if (project === undefined) return { scope: 'global', projectId: null }
      return { scope: 'project', projectId: project.id }
    }

    const text = (value) => [{ type: 'text', text: value }]

    const save = {
      name: 'memory_save',
      description: '把一条值得长期保留的用户信息写入长期记忆（跨会话生效）。只存稳定事实、偏好、决策与项目背景；不要存临时任务细节、密钥或一次性上下文。',
      parameters: {
        content: { type: 'string', required: true, description: '一句话事实，尽量自包含（不要用“他/这个项目”之类指代）' },
        kind: { type: 'string', description: 'profile | preference | fact | decision | lesson | episode，默认 fact' },
        topic_key: { type: 'string', description: '可选槽位键，如 career.direction；同键写入会替换旧值并保留历史' },
        scope: { type: 'string', description: 'global（默认，跨项目）或 project（仅当前项目）' },
        importance: { type: 'number', description: '1-5，默认 3' },
        expires_in_days: { type: 'number', description: '可选：多少天后自动失效（如答辩日期）' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value)) },
      execute: async (args, exec) => {
        const { scope, projectId } = resolveScope(exec, args.scope)
        const result = withStore((s) => s.add({
          scope,
          projectId,
          kind: args.kind,
          topicKey: args.topic_key,
          content: args.content,
          importance: args.importance,
          expiresAt: Number(args.expires_in_days) > 0
            ? Date.now() + Number(args.expires_in_days) * 86_400_000
            : undefined,
          origin: 'agent',
          sessionId: exec?.agent?.id,
        }), { status: 'error', id: '' })
        return { ...result, scope }
      },
    }

    const search = {
      name: 'memory_search',
      description: '按关键词检索长期记忆（中文按二元组匹配，支持两字词）。返回最相关的若干条。',
      parameters: {
        query: { type: 'string', required: true, description: '检索词，可为中文或英文' },
        limit: { type: 'number', description: '返回条数，默认 8' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value)) },
      execute: async (args, exec) => {
        const project = withStore((s) => s.resolveProject(cwdOf(exec)), undefined)
        const rows = withStore((s) => s.search(args.query, {
          projectId: project?.id,
          limit: Math.min(30, Math.max(1, Number(args.limit) || 8)),
        }), [])
        return {
          items: rows.map((row) => ({
            id: row.id,
            scope: row.scope,
            kind: row.kind,
            content: row.content,
            updatedAt: row.updated_at,
          })),
        }
      },
    }

    const list = {
      name: 'memory_list',
      description: '列出当前生效的长期记忆。可用 scope 过滤全部范围。',
      parameters: {
        scope: { type: 'string', description: '可选：global | project' },
        kind: { type: 'string', description: '可选：profile | preference | fact | decision | lesson | episode' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value)) },
      execute: async (args) => {
        const rows = withStore((s) => s.list({ scope: args.scope, kind: args.kind, limit: 100 }), [])
        return {
          items: rows.map((row) => ({ id: row.id, scope: row.scope, kind: row.kind, content: row.content })),
        }
      },
    }

    const update = {
      name: 'memory_update',
      description: '修改一条已有记忆的内容（保留版本历史）。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id（m_ 开头）' },
        content: { type: 'string', required: true, description: '新的内容' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value)) },
      execute: async (args) => ({ ok: withStore((s) => s.update(args.id, { content: args.content }), false) }),
    }

    const forget = {
      name: 'memory_forget',
      description: '删除一条记忆（软删除，可在记忆面板恢复）。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id（m_ 开头）' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value)) },
      execute: async (args) => ({ ok: withStore((s) => s.forget(args.id), false) }),
    }

    const history = {
      name: 'memory_history',
      description: '查看一条记忆的版本历史（谁、什么时候、改了什么）。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value)) },
      execute: async (args) => ({
        versions: withStore((s) => s.history(args.id), []).map((row) => ({
          op: row.op,
          actor: row.actor,
          at: row.created_at,
          after: row.after_json,
        })),
      }),
    }

    const get = {
      name: 'memory_get',
      description: '按 id 读取一条记忆的完整内容。注入块里只有摘要时，用它取全文。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id（m_ 开头，注入块里方括号内即是）' },
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value)) },
      execute: async (args) => {
        const row = withStore((s) => s.get(String(args.id)), undefined)
        if (row === undefined) return { ok: false, error: 'not found' }
        return {
          ok: true,
          id: row.id,
          content: row.content,
          kind: row.kind,
          scope: row.scope,
          importance: row.importance,
          pinned: row.pinned === 1,
          status: row.status,
          updatedAt: row.updated_at,
          expiresAt: row.expires_at ?? null,
        }
      },
    }

    for (const definition of [save, search, list, get, update, forget, history]) {
      try {
        toolCtx.effect(() => toolCtx.tools.register(definition), `agentmemory.tool(${definition.name})`)
      } catch (error) {
        ctx.logger?.warn?.(`agentmemory: cannot register ${definition.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  // ---------------------------------------------------------------- commands
  // Human plane: never enters the model context.
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'memory',
      description: '为本会话开关长期记忆（/memory on|off|status）',
      handler: ({ agent, rawInput }) => {
        const id = String(agent?.id ?? '')
        if (id.length === 0) return { kind: 'error', text: '拿不到当前会话' }
        const arg = String(rawInput ?? '').trim().toLowerCase()
        if (arg === 'on' || arg === 'off') {
          withStore((s) => s.setSessionAllowed(id, arg === 'on'), false)
          return { kind: 'success', text: arg === 'on' ? '本会话已开启记忆。' : '本会话已关闭记忆。' }
        }
        if (arg !== '' && arg !== 'status') {
          return { kind: 'error', text: '用法：/memory on|off|status' }
        }
        const on = withStore((s) => s.sessionAllowed(id), true)
        return { kind: 'success', text: `本会话记忆：${on ? '开启' : '关闭'}` }
      },
    }), 'agentmemory.command()')
  })

  // ---------------------------------------------------- conversational capture
  // Memories are produced when a conversation goes quiet or ends, not on every
  // turn: the user's signal sentences are buffered locally (zero tokens), then
  // exactly one extraction call runs per session flush.
  ctx.effect(() => {
    const sessions = new Map() // id -> { text, timer, flushing, lastAt }
    const idleMs = Math.max(60_000, options.captureIdleMinutes * 60_000)

    const syncPending = () => {
      let total = 0
      for (const state of sessions.values()) total += state.text.length
      captureStats.pending = total
    }

    /** @returns {Promise<void>} resolves when this flush's extraction settled */
    const flush = (id, reason) => {
      const state = sessions.get(id)
      if (state === undefined) return Promise.resolve()
      if (state.timer !== null) {
        clearTimeout(state.timer)
        state.timer = null
      }
      const text = state.text.trim()
      state.text = ''
      syncPending()
      if (text.length === 0) {
        captureStats.reason = '没有待抽取内容'
        return Promise.resolve()
      }
      if (text.length < options.captureMinChars) {
        captureStats.reason = '信号文本太短'
        return Promise.resolve()
      }
      if (state.flushing) {
        state.text = text
        syncPending()
        return Promise.resolve()
      }
      const current = getStore()
      if (roughlyKnown(current.list({ statuses: ['active'], limit: 200 }), text)) {
        captureStats.skipped += 1
        captureStats.reason = '与已有记忆重复'
        return Promise.resolve()
      }
      state.flushing = true
      captureStats.chars = text.length
      captureStats.at = Date.now()
      captureStats.reason = reason
      return extractFacts(ctx, current, options, text, id)
        .then((added) => {
          captureStats.added = added
          if (added > 0) ctx.logger?.info?.(`agentmemory: captured ${added} memory item(s), ${reason}`)
        })
        .catch((error) => {
          // Put the text back: a failed extraction (model error, timeout) must
          // not silently swallow what the user said. The next turn retries.
          state.text = state.text.length > 0 ? `${text}\n${state.text}` : text
          syncPending()
          captureStats.reason = '抽取失败，内容已放回缓冲'
          ctx.logger?.warn?.(`agentmemory: capture failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          state.flushing = false
        })
    }

    const arm = (id) => {
      const state = sessions.get(id)
      if (state === undefined) return
      if (state.timer !== null) clearTimeout(state.timer)
      state.timer = setTimeout(() => flush(id, '会话空闲'), idleMs)
      state.timer.unref?.()
    }

    const stop = ctx.on('session/event', (session, event) => {
      try {
        if (session?.header?.origin === 'subagent') return
        const id = String(session?.id ?? '')
        if (id.length === 0) return
        if (!withStore((s) => s.sessionAllowed(id), true)) return

        if (event.type === 'user/message') {
          const message = event.data
          if (message?.source?.kind !== 'user') return
          const text = (Array.isArray(message.content) ? message.content : [])
            .filter((block) => block?.type === 'text')
            .map((block) => block.text)
            .join('\n')
            .trim()
          if (text.length === 0) return
          // The current question drives per-turn retrieval, whether or not
          // automatic capture is enabled.
          lastQuestion.set(id, text.slice(0, 500))
          if (lastQuestion.size > 128) lastQuestion.delete(lastQuestion.keys().next().value)
          patchTurn(id, { question: text.slice(0, 200), startedAt: Date.now() })

          if (!options.autoCapture) return
          const signals = extractSignals(text)
          if (signals.length === 0) {
            captureStats.skipped += 1
            captureStats.reason = '没有记忆信号'
            return
          }
          const state = sessions.get(id) ?? { text: '', timer: null, flushing: false, lastAt: 0 }
          state.text = state.text.length > 0 ? `${state.text}。${signals}` : signals
          state.lastAt = Date.now()
          sessions.set(id, state)
          syncPending()
          arm(id)
          return
        }

        if (event.type === 'turn/end') {
          // One row per finished turn so the chat footer can say what this turn
          // actually carried. Written even when capture or retrieval is off.
          const turn = Number(event?.data?.turn)
          const pending = turnTrace.get(id) ?? {}
          if (Number.isFinite(turn)) {
            withStore((s) => s.recordTurn(id, turn, {
              question: pending.question,
              coreIds: lastInjected.get(id),
              retrievalIds: pending.retrievalIds,
              retrievalChars: pending.retrievalChars,
              startedAt: pending.startedAt,
            }), false)
            turnTrace.delete(id)
          }
          // Turn boundary: the one point that reliably happens. If the buffer
          // already holds enough signal text, extract now instead of waiting
          // for an idle gap that a working session never has.
          if (options.autoCapture) {
            const buffered = sessions.get(id)?.text ?? ''
            if (shouldFlush(buffered, options.captureTurnChars)) {
              flush(id, '回合结束')
            } else {
              // Silence is a legitimate result: record why the hook looked at
              // the buffer and left it alone, so the panel can say so.
              captureStats.at = Date.now()
              captureStats.chars = buffered.length
              captureStats.reason = buffered.length === 0
                ? '没有记忆信号'
                : `信号文本不足（${buffered.length}/${options.captureTurnChars} 字符）`
            }
          }
        }

        if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') {
          // Count one exposure per memory per session, so the usage signal
          // stays meaningful instead of growing with every turn.
          try {
            const injected = lastInjected.get(id)
            if (Array.isArray(injected) && injected.length > 0) {
              const fresh = injected.filter((memoryId) => !markedIds.has(`${id}:${memoryId}`))
              if (fresh.length > 0) {
                withStore((s) => s.markUsed(fresh), 0)
                for (const memoryId of fresh) markedIds.add(`${id}:${memoryId}`)
                if (markedIds.size > 5000) markedIds.clear()
              }
            }
          } catch { /* usage bookkeeping must never affect the turn */ }
          arm(id)
          // Background consolidation after a clean turn; it decides for itself
          // whether the volume and the clock allow a run.
          void autoDream()
        }
      } catch (error) {
        ctx.logger?.warn?.(`agentmemory: capture listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // A closing session is the other natural flush point.
    const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
      try {
        const id = String(agent?.id ?? '')
        if (id.length > 0) flush(id, '会话结束')
      } catch (error) {
        ctx.logger?.warn?.(`agentmemory: capture flush failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    flushAll.fn = () => Promise.all([...sessions.keys()].map((id) => flush(id, '手动提取')))

    return () => {
      flushAll.fn = null
      stop?.()
      stopDisposed?.()
      for (const state of sessions.values()) {
        if (state.timer !== null) clearTimeout(state.timer)
      }
      sessions.clear()
    }
  }, 'agentmemory.capture()')
}
