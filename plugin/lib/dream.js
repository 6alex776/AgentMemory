/**
 * Two-step consolidation: the model only groups memories by topic, the code
 * decides what to merge. Keeping the decision deterministic makes it testable
 * and stops a weak model from inventing merges (or refusing them all).
 */

import { containment, similarity } from './capture.js'

/**
 * Two memories describe the same fact when their token sets substantially
 * overlap: either similar overall (Jaccard) or one almost contained in the
 * other (a restatement that adds detail).
 */
export function sameFact(left, right, threshold = 0.55) {
  if (similarity(left, right) >= threshold) return true
  return containment(left, right) >= 0.85
}

/**
 * Cluster ids whose text is at least `threshold` similar (union-find).
 * @param {string[]} ids
 * @param {Map<string, {content: string}>} byId
 * @param {number} threshold
 * @returns {string[][]}
 */
export function clusterIds(ids, byId, threshold = 0.6) {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (id) => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    return root
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = byId.get(ids[i])
      const right = byId.get(ids[j])
      if (left === undefined || right === undefined) continue
      if (sameFact(left.content, right.content, threshold)) union(ids[i], ids[j])
    }
  }

  const buckets = new Map()
  for (const id of ids) {
    const root = find(id)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(id)
  }
  return [...buckets.values()]
}

/**
 * Turn model-produced topic groups into merge proposals.
 * The merged text is the longest member: for near-duplicates it is the most
 * complete one, and inventing a synthesis would need another model call.
 *
 * @param {{topic?: string, ids?: string[]}[]} groups
 * @param {Map<string, {id: string, content: string, kind: string, importance: number}>} byId
 * @param {{threshold?: number, maxProposals?: number}} options
 */
export function buildMergeProposals(groups, byId, options = {}) {
  const threshold = Number(options.threshold) > 0 ? Number(options.threshold) : 0.6
  const maxProposals = Number(options.maxProposals) > 0 ? Number(options.maxProposals) : 8
  const proposals = []
  const seen = new Set()

  for (const group of Array.isArray(groups) ? groups : []) {
    const ids = (Array.isArray(group?.ids) ? group.ids : []).filter((id) => byId.has(id))
    if (ids.length < 2) continue
    const clusters = clusterIds(ids, byId, threshold)
    for (const cluster of clusters) {
      if (cluster.length < 2) continue
      const key = [...cluster].sort().join(',')
      if (seen.has(key)) continue
      seen.add(key)
      const rows = cluster.map((id) => byId.get(id))
      const longest = rows.reduce((a, b) => (b.content.length > a.content.length ? b : a))
      proposals.push({
        ids: cluster,
        content: longest.content,
        kind: longest.kind,
        importance: Math.max(...rows.map((row) => row.importance ?? 3)),
        reason: `同主题「${group.topic ?? '未命名'}」且内容重合度 ≥ ${threshold}`,
      })
      if (proposals.length >= maxProposals) return proposals
    }
  }
  return proposals
}

/**
 * Decide whether a background consolidation pass is due.
 *
 * Two gates keep this from becoming noise: the library must hold enough
 * memories to be worth merging, and an unreviewed suggestion blocks a new run
 * (otherwise every session adds another duplicate card nobody asked for).
 * Everything else is the clock, which is persisted by the caller.
 *
 * @param {{now?: number, lastAt?: number, activeCount?: number, pending?: number,
 *          minMemories?: number, intervalDays?: number}} input
 * @returns {{ok: boolean, reason: string}}
 */
export function shouldAutoDream(input = {}) {
  const now = Number(input.now) || Date.now()
  const lastAt = Number(input.lastAt) || 0
  const activeCount = Math.max(0, Number(input.activeCount) || 0)
  const pending = Math.max(0, Number(input.pending) || 0)
  const minMemories = Number(input.minMemories) > 1 ? Number(input.minMemories) : 8
  const intervalDays = Number(input.intervalDays) > 0 ? Number(input.intervalDays) : 7

  if (activeCount < minMemories) {
    return { ok: false, reason: `记忆还不够 ${minMemories} 条，现在 ${activeCount} 条` }
  }
  if (pending > 0) {
    return { ok: false, reason: `还有 ${pending} 条整理建议没处理` }
  }
  const due = lastAt + intervalDays * 86_400_000
  if (now < due) {
    const days = Math.max(1, Math.ceil((due - now) / 86_400_000))
    return { ok: false, reason: `距上次整理不满 ${intervalDays} 天，还有 ${days} 天` }
  }
  return { ok: true, reason: '' }
}
