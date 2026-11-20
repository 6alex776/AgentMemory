/**
 * SQLite store for AgentMemory.
 *
 * One file, WAL, single writer per process. Every mutation writes a
 * memory_version row in the same transaction, so nothing is ever lost:
 * superseded values stay queryable and a delete is a status change.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { contentNorm, contentTokens, coverage, expandQuery, probeTokens, toMatchQueryOr, toSearchText, tokenHits } from './bigram.js'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE IF NOT EXISTS project (
  id           INTEGER PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  root_path    TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id     INTEGER REFERENCES project(id),
  kind           TEXT NOT NULL CHECK (kind IN ('profile','preference','fact','decision','lesson','episode')),
  topic_key      TEXT,
  content        TEXT NOT NULL,
  content_norm   TEXT NOT NULL,
  search_text    TEXT NOT NULL,
  abstract       TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','superseded','deleted')),
  origin         TEXT NOT NULL CHECK (origin IN ('user','agent','dream','import')),
  importance     INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  pinned         INTEGER NOT NULL DEFAULT 0,
  rev            INTEGER NOT NULL DEFAULT 1,
  use_count      INTEGER NOT NULL DEFAULT 0,
  last_used_at   INTEGER,
  expires_at     INTEGER,
  last_verified_at INTEGER,
  source_session TEXT,
  supersedes_id  TEXT REFERENCES memory(id),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  valid_to       INTEGER,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS memory_slot ON memory(scope, ifnull(project_id,0), topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS memory_dedupe
  ON memory(scope, ifnull(project_id,0), kind, ifnull(topic_key,''), content_norm)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS memory_scan ON memory(scope, project_id, status, kind, importance DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_version (
  id          INTEGER PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memory(id),
  op          TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  actor       TEXT NOT NULL,
  reason      TEXT,
  session_id  TEXT,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS memory_version_by_memory ON memory_version(memory_id, created_at);

CREATE TABLE IF NOT EXISTS dream_proposal (
  id         INTEGER PRIMARY KEY,
  op         TEXT NOT NULL CHECK (op IN ('merge','expire')),
  payload    TEXT NOT NULL,
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS session_flag (
  session_id TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS turn_trace (
  session_id      TEXT NOT NULL,
  turn            INTEGER NOT NULL,
  question        TEXT,
  core_ids        TEXT,
  retrieval_ids   TEXT,
  retrieval_chars INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_summary (
  id           INTEGER PRIMARY KEY,
  content      TEXT NOT NULL,
  source_rev   TEXT NOT NULL,
  model        TEXT,
  generated_at INTEGER NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(search_text, tokenize = 'unicode61');

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  DELETE FROM memory_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF search_text ON memory BEGIN
  DELETE FROM memory_fts WHERE rowid = old.rowid;
  INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

INSERT OR IGNORE INTO meta(key, value) VALUES ('app_id','agentmemory');
`

/**
 * Bump this when a migration step is appended below.
 * v1: memory / memory_version / project / FTS
 * v2: memory_summary (概览缓存)
 * v3: memory.abstract（注入用的短摘要）
 * v4: dream_proposal（后台整理的待确认建议）
 * v5: memory.use_count / last_used_at（注入使用反馈）
 * v6: session_flag（会话级开关）
 * v7: memory.expires_at / last_verified_at（时效与复核）
 * v8: turn_trace（每轮注入了哪些记忆，供对话尾部展示）
 */
const SCHEMA_VERSION = 8

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/**
 * Migrations are additive and idempotent. A database from a newer plugin is
 * refused rather than silently downgraded.
 */
function migrate(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  const version = row === undefined ? 0 : (Number(row.value) || 0)
  if (version > SCHEMA_VERSION) {
    throw new Error(`memory database is schema v${version}, this plugin supports up to v${SCHEMA_VERSION}`)
  }
  if (!hasColumn(db, 'memory', 'abstract')) {
    db.exec('ALTER TABLE memory ADD COLUMN abstract TEXT')
  }
  if (!hasColumn(db, 'memory', 'use_count')) {
    db.exec('ALTER TABLE memory ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'memory', 'last_used_at')) {
    db.exec('ALTER TABLE memory ADD COLUMN last_used_at INTEGER')
  }
  if (!hasColumn(db, 'memory', 'expires_at')) {
    db.exec('ALTER TABLE memory ADD COLUMN expires_at INTEGER')
  }
  if (!hasColumn(db, 'memory', 'last_verified_at')) {
    db.exec('ALTER TABLE memory ADD COLUMN last_verified_at INTEGER')
  }
  // Backfill rows written before v3 (and any row whose abstract is empty).
  const missing = db.prepare("SELECT id, content FROM memory WHERE abstract IS NULL OR abstract = ''").all()
  if (missing.length > 0) {
    const update = db.prepare('UPDATE memory SET abstract = ? WHERE id = ?')
    for (const row of missing) update.run(makeAbstract(row.content), row.id)
  }
  if (version < SCHEMA_VERSION) {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
  }
}

const KINDS = ['profile', 'preference', 'fact', 'decision', 'lesson', 'episode']

/**
 * Short form used for injection. Deliberately deterministic: no model call on
 * every write, so saving costs no tokens and the injected block stays stable.
 * @param {string} content
 * @param {number} limit
 */
export function makeAbstract(content, limit = 40) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  const window = text.slice(0, limit)
  const stop = Math.max(window.lastIndexOf('。'), window.lastIndexOf('；'), window.lastIndexOf('，'))
  if (stop >= Math.floor(limit * 0.5)) return window.slice(0, stop + 1)
  return `${window}…`
}

export const KIND_LABELS = {
  profile: '用户背景',
  preference: '偏好',
  fact: '事实',
  decision: '决策',
  lesson: '经验',
  episode: '事件',
}

/** @param {string} file absolute db path */
export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(SCHEMA)
    migrate(db)
  } catch (error) {
    // A refused or malformed database must not leak the handle: on Windows the
    // file stays locked and the caller can neither retry nor move it aside.
    try { db.close() } catch { /* already closed */ }
    throw error
  }

  const now = () => Date.now()
  const newId = () => `m_${randomBytes(6).toString('hex')}`

  const q = {
    byId: db.prepare('SELECT * FROM memory WHERE id = ?'),
    activeInSlot: db.prepare(
      `SELECT * FROM memory WHERE status = 'active' AND scope = ? AND ifnull(project_id,0) = ifnull(?,0)
       AND ifnull(topic_key,'') = ifnull(?,'') LIMIT 1`,
    ),
    sameContent: db.prepare(
      `SELECT * FROM memory WHERE status = 'active' AND scope = ? AND ifnull(project_id,0) = ifnull(?,0)
       AND kind = ? AND content_norm = ? LIMIT 1`,
    ),
    tombstone: db.prepare(
      `SELECT * FROM memory WHERE status = 'deleted' AND scope = ? AND ifnull(project_id,0) = ifnull(?,0)
       AND ifnull(topic_key,'') = ifnull(?,'') AND content_norm = ? ORDER BY updated_at DESC LIMIT 1`,
    ),
    insert: db.prepare(
      `INSERT INTO memory (id, scope, project_id, kind, topic_key, content, content_norm, search_text,
        abstract, status, origin, importance, pinned, rev, source_session, supersedes_id, created_at, updated_at,
        expires_at, last_verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?)`,
    ),
    version: db.prepare(
      `INSERT INTO memory_version (memory_id, op, before_json, after_json, actor, reason, session_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ),
    projectByKey: db.prepare('SELECT * FROM project WHERE key = ?'),
    projectInsert: db.prepare(
      'INSERT INTO project (key, root_path, name, created_at, last_seen_at) VALUES (?,?,?,?,?)',
    ),
    projectTouch: db.prepare('UPDATE project SET last_seen_at = ? WHERE id = ?'),
    projectById: db.prepare('SELECT * FROM project WHERE id = ?'),
    projectList: db.prepare('SELECT * FROM project ORDER BY last_seen_at DESC'),
  }

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  function snapshot(row) {
    if (row === undefined) return 'null'
    const { search_text: _ignored, content_norm: _ignored2, ...rest } = row
    return JSON.stringify(rest)
  }

  function logVersion(memoryId, op, before, after, actor, reason, sessionId) {
    q.version.run(
      memoryId,
      op,
      before === undefined ? null : snapshot(before),
      after === undefined ? null : snapshot(after),
      actor,
      reason ?? null,
      sessionId ?? null,
      now(),
    )
  }

  /**
   * Project identity: a Git checkout wins over the raw cwd so that sub
   * directories and linked worktrees share one project instead of fragmenting.
   * Falls back to the directory itself outside Git.
   * @param {string} cwd
   * @returns {string | undefined} normalized root
   */
  function projectRoot(cwd) {
    if (typeof cwd !== 'string' || cwd.trim().length === 0) return undefined
    const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    let current = normalized
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        if (existsSync(`${current}/.git`)) return current
      } catch { /* unreadable: keep walking */ }
      const parent = dirname(current).replace(/\\/g, '/').replace(/\/+$/, '')
      if (parent === current || parent.length === 0) break
      current = parent
    }
    return normalized
  }

  function projectKeyOf(root) {
    return createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12)
  }

  function ensureProject(cwd) {
    const root = projectRoot(cwd)
    if (root === undefined) return undefined
    const key = projectKeyOf(root)
    const found = q.projectByKey.get(key)
    if (found !== undefined) {
      q.projectTouch.run(now(), found.id)
      return found
    }
    const ts = now()
    const name = basename(root) || root
    try {
      q.projectInsert.run(key, root, name, ts, ts)
    } catch {
      const raced = q.projectByKey.get(key)
      if (raced !== undefined) return raced
      throw new Error('project insert failed')
    }
    return q.projectByKey.get(key)
  }

  /** Read-only project lookup for prompt building (never creates a row). */
  function resolveProject(cwd) {
    const root = projectRoot(cwd)
    if (root === undefined) return undefined
    return q.projectByKey.get(projectKeyOf(root))
  }

  /** Record that these memories were injected and presumably used. */
  function markUsed(ids) {
    const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
    if (list.length === 0) return 0
    const at = now()
    const update = db.prepare('UPDATE memory SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    let touched = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of list) {
        const info = update.run(at, id)
        if (Number(info.changes) > 0) touched += 1
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
    return touched
  }

  /**
   * Add or supersede a memory.
   * @returns {{status:'added'|'duplicate'|'tombstoned'|'superseded', id:string}}
   */
  function add(input) {
    const scope = input.scope === 'project' ? 'project' : 'global'
    const projectId = scope === 'project' ? Number(input.projectId) : null
    if (scope === 'project' && !Number.isFinite(projectId)) throw new Error('project scope needs a project')
    const kind = KINDS.includes(input.kind) ? input.kind : 'fact'
    const content = String(input.content ?? '').trim()
    if (content.length === 0) throw new Error('empty content')
    const topicKey = typeof input.topicKey === 'string' && input.topicKey.trim().length > 0
      ? input.topicKey.trim()
      : null
    const norm = contentNorm(content)
    const importance = Math.min(5, Math.max(1, Number(input.importance) || 3))
    const actor = ['user', 'agent', 'dream', 'import'].includes(input.origin) ? input.origin : 'user'
    const expiresAt = Number(input.expiresAt) > 0 ? Number(input.expiresAt) : null

    return tx(() => {
      if (topicKey === null) {
        const same = q.sameContent.get(scope, projectId, kind, norm)
        if (same !== undefined) return { status: 'duplicate', id: same.id }
      } else {
        const current = q.activeInSlot.get(scope, projectId, topicKey)
        if (current !== undefined) {
          if (current.content_norm === norm) return { status: 'duplicate', id: current.id }
          const previous = { ...current, status: 'superseded', valid_to: now(), rev: current.rev + 1, updated_at: now() }
          db.prepare("UPDATE memory SET status='superseded', valid_to=?, rev=rev+1, updated_at=? WHERE id=?")
            .run(previous.valid_to, previous.updated_at, current.id)
          const id = newId()
          q.insert.run(id, scope, projectId, kind, topicKey, content, norm, toSearchText(content),
            makeAbstract(content), actor, importance, 0, 1, input.sessionId ?? null, current.id, now(), now(),
            expiresAt, now())
          logVersion(current.id, 'supersede', current, previous, actor, input.reason, input.sessionId)
          logVersion(id, 'create', undefined, q.byId.get(id), actor, input.reason, input.sessionId)
          return { status: 'superseded', id, replaced: current.id }
        }
        const tomb = q.tombstone.get(scope, projectId, topicKey, norm)
        if (tomb !== undefined && input.force !== true) return { status: 'tombstoned', id: tomb.id }
      }

      const id = newId()
      q.insert.run(id, scope, projectId, kind, topicKey, content, norm, toSearchText(content),
        makeAbstract(content), actor, importance, input.pinned === true ? 1 : 0, 1,
        input.sessionId ?? null, null, now(), now(), expiresAt, now())
      logVersion(id, 'create', undefined, q.byId.get(id), actor, input.reason, input.sessionId)
      return { status: 'added', id }
    })
  }

  function update(id, patch) {
    return tx(() => {
      const before = q.byId.get(id)
      if (before === undefined || before.status !== 'active') return false
      const content = patch.content === undefined ? before.content : String(patch.content).trim()
      if (content.length === 0) throw new Error('empty content')
      const importance = patch.importance === undefined
        ? before.importance
        : Math.min(5, Math.max(1, Number(patch.importance) || before.importance))
      const pinned = patch.pinned === undefined ? before.pinned : (patch.pinned ? 1 : 0)
      const kind = KINDS.includes(patch.kind) ? patch.kind : before.kind
      const contentChanged = content !== before.content
      const expiresAt = patch.expiresAt === undefined
        ? before.expires_at
        : (Number(patch.expiresAt) > 0 ? Number(patch.expiresAt) : null)
      const verifiedAt = contentChanged ? now() : before.last_verified_at
      db.prepare(
        `UPDATE memory SET content=?, content_norm=?, search_text=?, abstract=?, importance=?, pinned=?, kind=?,
          expires_at=?, last_verified_at=?, rev=rev+1, updated_at=? WHERE id=?`,
      ).run(
        content,
        contentNorm(content),
        toSearchText(content),
        makeAbstract(content),
        importance,
        pinned,
        kind,
        expiresAt,
        verifiedAt,
        now(),
        id,
      )
      const after = q.byId.get(id)
      logVersion(id, pinned !== before.pinned && content === before.content ? 'pin' : 'update', before, after, 'user', patch.reason)
      return true
    })
  }

  /** Mark a memory as re-confirmed by the user. */
  function verify(id) {
    return tx(() => {
      const before = q.byId.get(id)
      if (before === undefined || before.status !== 'active') return false
      db.prepare('UPDATE memory SET last_verified_at = ?, expires_at = NULL, updated_at = ? WHERE id = ?')
        .run(now(), now(), id)
      logVersion(id, 'verify', before, q.byId.get(id), 'user', 'confirmed in panel')
      return true
    })
  }

  /** Full row for one id, any status. */
  function get(id) {
    return q.byId.get(id)
  }

  function forget(id) {
    return tx(() => {
      const before = q.byId.get(id)
      if (before === undefined || before.status !== 'active') return false
      db.prepare("UPDATE memory SET status='deleted', valid_to=?, rev=rev+1, updated_at=? WHERE id=?")
        .run(now(), now(), id)
      logVersion(id, 'delete', before, q.byId.get(id), 'user', 'deleted from panel')
      return true
    })
  }

  function restore(id) {
    return tx(() => {
      const before = q.byId.get(id)
      if (before === undefined || before.status !== 'deleted') return false
      const clash = before.topic_key === null
        ? undefined
        : q.activeInSlot.get(before.scope, before.project_id, before.topic_key)
      if (clash !== undefined && clash.id !== id) {
        db.prepare("UPDATE memory SET status='superseded', valid_to=?, rev=rev+1, updated_at=? WHERE id=?")
          .run(now(), now(), clash.id)
        logVersion(clash.id, 'supersede', clash, q.byId.get(clash.id), 'user', 'restore replaced it')
      }
      db.prepare("UPDATE memory SET status='active', valid_to=NULL, rev=rev+1, updated_at=? WHERE id=?")
        .run(now(), id)
      logVersion(id, 'restore', before, q.byId.get(id), 'user', 'restored from panel')
      return true
    })
  }

  /** Hard delete: removes the row and its version history. Irreversible. */
  function purge(id) {
    return tx(() => {
      const before = q.byId.get(id)
      if (before === undefined) return false
      db.prepare('DELETE FROM memory_version WHERE memory_id = ?').run(id)
      db.prepare('DELETE FROM memory WHERE id = ?').run(id)
      return true
    })
  }

  /**
   * Restore one history version as the current value.
   * The rollback itself is recorded, so it is undoable too.
   * @param {string} id memory id
   * @param {number} versionId memory_version.id
   */
  function rollback(id, versionId) {
    return tx(() => {
      const row = q.byId.get(id)
      if (row === undefined || row.status !== 'active') return false
      const version = db.prepare(
        'SELECT * FROM memory_version WHERE id = ? AND memory_id = ?',
      ).get(versionId, id)
      if (version === undefined || version.after_json === null) return false
      let target
      try {
        target = JSON.parse(version.after_json)
      } catch {
        return false
      }
      if (target === null || typeof target.content !== 'string') return false
      const content = target.content
      db.prepare(
        `UPDATE memory SET content=?, content_norm=?, search_text=?, abstract=?, kind=?, importance=?, rev=rev+1, updated_at=? WHERE id=?`,
      ).run(
        content,
        contentNorm(content),
        toSearchText(content),
        makeAbstract(content),
        KINDS.includes(target.kind) ? target.kind : row.kind,
        Number(target.importance) || row.importance,
        now(),
        id,
      )
      logVersion(id, 'rollback', row, q.byId.get(id), 'user', `回到版本 #${versionId}`)
      return true
    })
  }

  function history(id) {    return db.prepare('SELECT * FROM memory_version WHERE memory_id = ? ORDER BY created_at DESC, id DESC').all(id)
  }

  function list(options = {}) {
    const clauses = []
    const params = []
    if (options.status === 'all') {
      // every status
    } else if (Array.isArray(options.statuses) && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => '?').join(',')})`)
      params.push(...options.statuses)
    } else {
      clauses.push("status = 'active'")
    }
    if (options.scope === 'global' || options.scope === 'project') {
      clauses.push('scope = ?')
      params.push(options.scope)
    }
    if (Number.isFinite(options.projectId)) {
      clauses.push('project_id = ?')
      params.push(options.projectId)
    }
    if (options.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(options.kind)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return db.prepare(
      `SELECT * FROM memory ${where} ORDER BY importance DESC, updated_at DESC LIMIT ?`,
    ).all(...params, options.limit ?? 200)
  }

  function search(query, options = {}) {
    const expanded = expandQuery(query)
    const match = toMatchQueryOr(expanded)
    const tokens = contentTokens(toSearchText(expanded).split(' ').filter(Boolean))
    const scopeClause = options.allScopes === true
      ? '1 = 1'
      : (Number.isFinite(options.projectId)
        ? "(m.scope = 'global' OR m.project_id = ?)"
        : "m.scope = 'global'")
    const scopeParams = options.allScopes === true
      ? []
      : (Number.isFinite(options.projectId) ? [options.projectId] : [])
    const limit = options.limit ?? 20
    let rows = []
    if (match.length > 0) {
      try {
        rows = db.prepare(
          `SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts
           JOIN memory m ON m.rowid = memory_fts.rowid
           WHERE memory_fts MATCH ? AND m.status = 'active' AND ${scopeClause}
           ORDER BY rank LIMIT ?`,
        ).all(match, ...scopeParams, limit * 4)
      } catch {
        rows = []
      }
      // OR matching finds candidates; keep the ones that share enough of the
      // question. A long question can only ever overlap a memory by a couple of
      // bigrams, so the floor is proportional and never above one hit.
      const minHits = Math.max(1, Math.floor(tokens.length * 0.15))
      rows = rows
        .map((row) => ({ row, hits: tokenHits(tokens, row.content) }))
        .filter(({ hits }) => hits >= minHits)
        .sort((a, b) => b.hits - a.hits || a.row.rank - b.row.rank)
        .slice(0, limit)
        .map(({ row }) => row)
    }
    if (rows.length === 0) {
      // Last resort: probe with the longest content bigrams of the question,
      // not with the whole sentence (which no memory would ever contain).
      const probes = probeTokens(tokens.length > 0 ? tokens : contentTokens(toSearchText(String(expanded ?? '')).split(' ').filter(Boolean)))
      if (probes.length > 0) {
        const likeClause = probes.map(() => 'm.content LIKE ?').join(' OR ')
        rows = db.prepare(
          `SELECT m.*, 0 AS rank FROM memory m
           WHERE m.status = 'active' AND (${likeClause}) AND ${scopeClause}
           ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`,
        ).all(...probes.map((probe) => `%${probe}%`), ...scopeParams, limit)
      }
    }
    return rows
  }

  /** Hash of the current active set: the invalidation key for the overview. */
  function summarySourceRev() {
    const rows = db.prepare("SELECT id, updated_at FROM memory WHERE status = 'active' ORDER BY id").all()
    const digest = rows.map((row) => `${row.id}:${row.updated_at}`).join('|')
    return createHash('sha1').update(digest).digest('hex').slice(0, 16)
  }

  /** Cached overview plus whether it still matches the current memory set. */
  function summaryGet() {
    const row = db.prepare('SELECT * FROM memory_summary WHERE id = 1').get()
    const currentRev = summarySourceRev()
    return {
      content: row === undefined ? '' : row.content,
      generatedAt: row === undefined ? 0 : row.generated_at,
      model: row === undefined ? '' : (row.model ?? ''),
      sourceRev: row === undefined ? '' : row.source_rev,
      currentRev,
      stale: row !== undefined && row.source_rev !== currentRev,
    }
  }

  function summarySave(content, model) {
    const rev = summarySourceRev()
    db.prepare(
      'INSERT OR REPLACE INTO memory_summary(id, content, source_rev, model, generated_at) VALUES (1,?,?,?,?)',
    ).run(content, rev, model ?? null, now())
    return summaryGet()
  }

  /** Flattened, ordered input for the overview and the consolidation prompt. */
  function summaryInput() {
    const projects = new Map(q.projectList.all().map((row) => [row.id, row.name]))
    return db.prepare(
      `SELECT id, scope, project_id, kind, content, importance, pinned, updated_at
       FROM memory WHERE status = 'active'
       ORDER BY scope, kind, importance DESC, updated_at DESC LIMIT 300`,
    ).all().map((row) => ({
      ...row,
      projectName: row.project_id === null ? '' : (projects.get(row.project_id) ?? ''),
    }))
  }

  // ------------------------------------------------------ dream proposals
  /** Pending consolidation suggestions, newest first. */
  function proposalsPending() {
    return db.prepare(
      "SELECT * FROM dream_proposal WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50",
    ).all().map((row) => {
      let payload = {}
      try { payload = JSON.parse(row.payload) } catch { /* keep empty */ }
      return { id: row.id, op: row.op, payload, reason: row.reason, createdAt: row.created_at }
    })
  }

  function proposalInsert(op, payload, reason) {
    if (op !== 'merge' && op !== 'expire') throw new Error(`unknown proposal op ${JSON.stringify(op)}`)
    const info = db.prepare(
      'INSERT INTO dream_proposal(op, payload, reason, created_at) VALUES (?,?,?,?)',
    ).run(op, JSON.stringify(payload), reason ?? null, now())
    return Number(info.lastInsertRowid)
  }

  function applyMerge(payload) {
    const ids = Array.isArray(payload.ids)
      ? payload.ids.filter((id) => typeof id === 'string').slice(0, 8)
      : []
    const rows = ids
      .map((id) => q.byId.get(id))
      .filter((row) => row !== undefined && row.status === 'active')
    if (rows.length < 2) return { ok: false, error: '合并需要至少两条仍然生效的记忆' }
    const content = String(payload.content ?? '').trim()
    if (content.length === 0) return { ok: false, error: '合并结果为空' }

    const first = rows[0]
    const created = add({
      scope: first.scope,
      projectId: first.project_id,
      kind: payload.kind ?? first.kind,
      topicKey: payload.topicKey ?? null,
      content,
      importance: Math.max(...rows.map((row) => row.importance)),
      origin: 'dream',
      reason: `合并 ${rows.map((row) => row.id).join(', ')}`,
    })
    let merged = 0
    for (const row of rows) {
      // The merged text is often one member verbatim; that member IS the result,
      // so retiring it would delete the only copy.
      if (row.id === created.id) continue
      if (forget(row.id)) merged += 1
    }
    return { ok: true, id: created.id, merged }
  }

  /**
   * Accept or reject one suggestion. Accepting applies it through the same
   * store operations a manual edit uses, so versions are recorded identically.
   */
  function decideProposal(id, accept) {
    const row = db.prepare('SELECT * FROM dream_proposal WHERE id = ? AND status = ?').get(id, 'pending')
    if (row === undefined) return { ok: false, error: '建议不存在或已处理' }
    let applied
    if (accept !== true) {
      applied = { ok: true }
    } else {
      let payload = {}
      try { payload = JSON.parse(row.payload) } catch { payload = {} }
      if (row.op === 'merge') applied = applyMerge(payload)
      else if (row.op === 'expire') applied = { ok: forget(String(payload.id ?? '')) }
      else applied = { ok: false, error: '未知操作' }
    }
    db.prepare('UPDATE dream_proposal SET status = ?, decided_at = ? WHERE id = ?')
      .run(accept === true ? 'accepted' : 'rejected', now(), id)
    return { ok: true, applied }
  }

  /** Session-level switch: absent means enabled. */
  function sessionAllowed(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return true
    const row = db.prepare('SELECT enabled FROM session_flag WHERE session_id = ?').get(sessionId)
    return row === undefined ? true : Number(row.enabled) !== 0
  }

  function setSessionAllowed(sessionId, enabled) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    db.prepare('INSERT OR REPLACE INTO session_flag(session_id, enabled, updated_at) VALUES (?,?,?)')
      .run(sessionId, enabled ? 1 : 0, now())
    return true
  }

  // --------------------------------------------------------- turn traces
  /**
   * One row per (session, turn): which memories that turn actually carried.
   * Recorded when the turn closes, read by the chat tail.
   * @param {string} sessionId
   * @param {number} turn
   * @param {{question?: string, coreIds?: string[], retrievalIds?: string[], retrievalChars?: number, startedAt?: number}} patch
   */
  function recordTurn(sessionId, turn, patch) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    const index = Number(turn)
    if (!Number.isFinite(index) || index < 0) return false
    const ts = now()
    const encode = (value) => (Array.isArray(value) ? JSON.stringify(value.slice(0, 40)) : null)
    db.prepare(
      `INSERT INTO turn_trace(session_id, turn, question, core_ids, retrieval_ids, retrieval_chars, started_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id, turn) DO UPDATE SET
         question = COALESCE(excluded.question, turn_trace.question),
         core_ids = COALESCE(excluded.core_ids, turn_trace.core_ids),
         retrieval_ids = COALESCE(excluded.retrieval_ids, turn_trace.retrieval_ids),
         retrieval_chars = excluded.retrieval_chars,
         started_at = MIN(COALESCE(turn_trace.started_at, excluded.started_at), excluded.started_at),
         updated_at = excluded.updated_at`,
    ).run(
      sessionId,
      index,
      patch?.question ?? null,
      encode(patch?.coreIds),
      encode(patch?.retrievalIds),
      Number(patch?.retrievalChars ?? 0) || 0,
      Number(patch?.startedAt ?? ts) || ts,
      ts,
    )
    return true
  }

  /**
   * What one turn carried, with the ids expanded and a live count of memories
   * the session added between this turn and the next one.
   * @param {string} sessionId
   * @param {number} turn
   */
  function readTurn(sessionId, turn) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const index = Number(turn)
    if (!Number.isFinite(index) || index < 0) return undefined
    const row = db.prepare('SELECT * FROM turn_trace WHERE session_id = ? AND turn = ?').get(sessionId, index)
    if (row === undefined) return undefined
    const decode = (text) => {
      try {
        const value = JSON.parse(text ?? '[]')
        return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []
      } catch {
        return []
      }
    }
    const expand = (ids) => ids.map((id) => {
      const memory = q.byId.get(id)
      if (memory === undefined) return { id, missing: true, kind: '', abstract: '' }
      return {
        id,
        kind: memory.kind,
        scope: memory.scope,
        status: memory.status,
        abstract: memory.abstract ?? makeAbstract(memory.content),
      }
    })
    const boundary = db.prepare(
      'SELECT MIN(started_at) AS at FROM turn_trace WHERE session_id = ? AND turn > ?',
    ).get(sessionId, index)?.at ?? null
    const from = Number(row.started_at ?? 0)
    const added = boundary === null
      ? db.prepare(
        'SELECT COUNT(*) AS n FROM memory WHERE source_session = ? AND created_at >= ?',
      ).get(sessionId, from)
      : db.prepare(
        'SELECT COUNT(*) AS n FROM memory WHERE source_session = ? AND created_at >= ? AND created_at < ?',
      ).get(sessionId, from, Number(boundary))
    return {
      turn: index,
      question: row.question ?? '',
      startedAt: from,
      updatedAt: row.updated_at,
      core: expand(decode(row.core_ids)),
      retrieval: expand(decode(row.retrieval_ids)),
      retrievalChars: row.retrieval_chars ?? 0,
      added: Number(added?.n ?? 0),
    }
  }

  // ------------------------------------------------------------ dream clock
  // The last consolidation pass is persisted, not kept in memory: a plugin
  // restart must not make the gate think a week has passed.
  function metaNumber(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    const value = Number(row?.value ?? 0)
    return Number.isFinite(value) ? value : 0
  }

  function dreamLastAt() {
    return metaNumber('dream_last_at')
  }

  function noteDream(at, created) {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('dream_last_at', ?)").run(String(at))
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('dream_last_created', ?)").run(String(created))
    return true
  }

  function state() {
    const active = db.prepare(
      `SELECT * FROM memory WHERE status = 'active'
       ORDER BY scope, kind, importance DESC, updated_at DESC`,
    ).all()
    const projects = q.projectList.all()
    const projectName = new Map(projects.map((row) => [row.id, row.name]))
    const superseded = db.prepare(
      `SELECT * FROM memory WHERE status IN ('superseded','deleted')
       ORDER BY updated_at DESC LIMIT 20`,
    ).all()

    const groups = []
    const globalByKind = new Map()
    const projectGroups = new Map()
    for (const row of active) {
      if (row.scope === 'global') {
        if (!globalByKind.has(row.kind)) globalByKind.set(row.kind, [])
        globalByKind.get(row.kind).push(row)
      } else {
        if (!projectGroups.has(row.project_id)) projectGroups.set(row.project_id, [])
        projectGroups.get(row.project_id).push(row)
      }
    }
    for (const kind of KINDS) {
      const items = globalByKind.get(kind)
      if (items === undefined || items.length === 0) continue
      groups.push({ key: `global:${kind}`, title: KIND_LABELS[kind], subtitle: '全局', items })
    }
    for (const [pid, items] of projectGroups) {
      groups.push({
        key: `project:${pid}`,
        title: `项目：${projectName.get(pid) ?? `#${pid}`}`,
        subtitle: '项目',
        projectId: pid,
        items,
      })
    }

    const lastUpdated = active.reduce((max, row) => Math.max(max, row.updated_at), 0)
    // Content changes and usage are different clocks: retrieval bumps use_count
    // every turn while the text itself may stay untouched for weeks.
    const lastUsed = active.reduce((max, row) => Math.max(max, row.last_used_at ?? 0), 0)
    const uses = active.reduce((sum, row) => sum + (row.use_count ?? 0), 0)
    return {
      updatedAt: lastUpdated,
      usedAt: lastUsed,
      uses,
      now: now(),
      projects: projects.map((row) => ({ id: row.id, name: row.name, rootPath: row.root_path })),
      counts: {
        total: active.length,
        global: active.filter((row) => row.scope === 'global').length,
        project: active.filter((row) => row.scope === 'project').length,
        superseded: superseded.length,
      },
      groups,
      superseded,
      summary: summaryGet(),
      proposals: proposalsPending(),
      dream: { at: metaNumber('dream_last_at'), created: metaNumber('dream_last_created') },
    }
  }

  return {
    db,
    add,
    update,
    forget,
    restore,
    purge,
    verify,
    get,
    list,
    search,
    history,
    rollback,
    state,
    summaryGet,
    summarySave,
    summaryInput,
    summarySourceRev,
    proposalsPending,
    proposalInsert,
    decideProposal,
    dreamLastAt,
    noteDream,
    ensureProject,
    resolveProject,
    projectRoot,
    markUsed,
    recordTurn,
    readTurn,
    sessionAllowed,
    setSessionAllowed,
    close: () => db.close(),
    file,
  }
}
