/**
 * AgentMemory engine — the host-independent half of the system.
 *
 * Everything here is plain Node + SQLite: no DSH API, no Cordis, no HTTP. The
 * DSH plugin and the MCP server are both thin adapters over this object, which
 * is what makes the memory model portable and testable on its own.
 */

import { openStore } from '../plugin/lib/store.js'
import {
  renderIdentityBlock,
  renderProjectBlock,
  selectIdentityRows,
  selectProjectRows,
} from '../plugin/lib/block.js'
import { renderRetrievalBlock } from '../plugin/lib/retrieval.js'
import { renderMarkdown } from '../plugin/lib/export.js'

const EMPTY_BLOCK = { text: '', ids: [], stats: { chars: 0, fullChars: 0, entries: 0, omitted: 0 } }

/**
 * @param {{dbFile: string, includeIds?: boolean, identityMaxChars?: number,
 *          projectMaxChars?: number, retrievalMaxChars?: number,
 *          projectMinImportance?: number}} options
 */
export function openEngine(options) {
  if (typeof options?.dbFile !== 'string' || options.dbFile.length === 0) {
    throw new Error('openEngine needs a dbFile')
  }
  const includeIds = options.includeIds !== false
  const identityMaxChars = Number(options.identityMaxChars) > 0 ? Number(options.identityMaxChars) : 400
  const projectMaxChars = Number(options.projectMaxChars) > 0 ? Number(options.projectMaxChars) : 800
  const retrievalMaxChars = Number(options.retrievalMaxChars) > 0 ? Number(options.retrievalMaxChars) : 600
  const projectMinImportance = Number(options.projectMinImportance) >= 1
    ? Math.min(5, Number(options.projectMinImportance))
    : 3

  const store = openStore(options.dbFile)

  /** The two persistent blocks: identity (global) and the current project. */
  function blocks(cwd) {
    const rows = store.list({ statuses: ['active'], limit: 200 })
    const identity = renderIdentityBlock(selectIdentityRows(rows), {
      maxChars: identityMaxChars,
      includeIds,
    })
    const project = store.resolveProject(cwd)
    const projectBlock = project === undefined
      ? EMPTY_BLOCK
      : renderProjectBlock(selectProjectRows(rows, project.id, projectMinImportance), {
        maxChars: projectMaxChars,
        includeIds,
      })
    return { identity, project: projectBlock, projectId: project?.id }
  }

  return {
    store,
    file: store.file,

    /** Save one memory through the same slot/version rules the plugin uses. */
    save(input = {}) {
      const project = input.scope === 'project'
        ? store.ensureProject(input.cwd)
        : undefined
      if (input.scope === 'project' && project === undefined) {
        throw new Error('project scope needs a cwd')
      }
      const result = store.add({
        scope: project === undefined ? 'global' : 'project',
        projectId: project?.id,
        kind: input.kind,
        topicKey: input.topicKey,
        content: input.content,
        importance: input.importance,
        expiresAt: input.expiresAt,
        origin: input.origin ?? 'user',
        reason: input.reason ?? 'engine',
      })
      return { result, state: store.state() }
    },

    search(query, options = {}) {
      return store.search(query, {
        projectId: options.projectId,
        allScopes: options.allScopes === true,
        limit: options.limit ?? 8,
      })
    },

    get: (id) => store.get(id),
    history: (id) => store.history(id),

    /** Every row that ever occupied one slot, oldest first. */
    chain(topicKey, scope) {
      if (typeof topicKey !== 'string' || topicKey.length === 0) return []
      return store.list({ statuses: ['active', 'superseded', 'deleted'], limit: 200 })
        .filter((row) => row.topic_key === topicKey && (scope === undefined || row.scope === scope))
        .sort((a, b) => a.created_at - b.created_at)
        .map((row) => ({
          id: row.id,
          content: row.content,
          status: row.status,
          kind: row.kind,
          scope: row.scope,
          created_at: row.created_at,
          supersedes_id: row.supersedes_id,
        }))
    },

    list: () => store.list({ statuses: ['active'], limit: 200 }),
    update: (id, patch) => store.update(id, patch),
    forget: (id) => store.forget(id),
    restore: (id) => store.restore(id),

    state() {
      const state = store.state()
      // Ids are stable across calls; the panel only needs the two blocks' sizes.
      return state
    },

    /**
     * What a host would inject for one turn: two stable blocks plus the
     * question-specific retrieval. Returns the text and the character cost of
     * each part so a caller can show the budget instead of guessing it.
     */
    inject(input = {}) {
      const { identity, project, projectId } = blocks(input.cwd)
      const coreIds = [...new Set([...identity.ids, ...project.ids])]
      let retrieval = { text: '', ids: [], chars: 0 }
      if (typeof input.question === 'string' && input.question.trim().length > 0) {
        const rows = store.search(input.question, {
          projectId,
          allScopes: projectId === undefined,
          limit: 6,
        })
        retrieval = renderRetrievalBlock(rows, {
          coreIds,
          coreText: identity.text,
          maxChars: retrievalMaxChars,
          includeIds,
        })
      }
      return {
        identity: identity.text ? { ...identity, ...identity.stats } : { text: '', ids: [], chars: 0, entries: 0 },
        project: project.text ? { ...project, ...project.stats } : { text: '', ids: [], chars: 0, entries: 0 },
        retrieval,
        chars: identity.stats.chars + project.stats.chars + retrieval.chars,
      }
    },

    /** The same injected text a host would see, in one string. */
    promptFor(input = {}) {
      const parts = this.inject(input)
      return [parts.identity.text, parts.project.text, parts.retrieval.text]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join('\n\n')
    },

    markdown: () => renderMarkdown(store.state()),
    close: () => store.close(),
  }
}
