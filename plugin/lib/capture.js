/**
 * Pure helpers for conversational memory capture.
 *
 * Kept free of Cordis and SQLite so the gating rules can be unit-tested: the
 * whole point of these functions is to avoid a model call, so their behaviour
 * is worth pinning down.
 */

import { toSearchText } from './bigram.js'

/**
 * Cheap local gate: does this sentence even look like a durable fact about the
 * user? Runs before any model call, so an ordinary exchange costs zero tokens.
 */
export const SIGNAL_PATTERN = /(记住|记一下|帮我记|请记|以后都|以后不|每次都|一律|总是|从不|我喜欢|我不喜欢|我讨厌|我习惯|我是|我在做|我负责|我决定|我们决定|计划|打算|目标|改成|改用|选用|换成|我一般|我的[^，。]{0,8}是)/

/**
 * Keep only the sentences that carry a memory signal. Questions are dropped:
 * asking about Python does not mean you use Python.
 * @param {string} text
 * @returns {string} joined signal sentences, or ''
 */
export function extractSignals(text) {
  const sentences = String(text ?? '')
    .split(/[。！？!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 6)
  const picked = []
  for (const sentence of sentences) {
    if (/(吗|呢|么|嘛)$/.test(sentence)) continue
    if (sentence.includes('？') || sentence.includes('?')) continue
    if (!SIGNAL_PATTERN.test(sentence)) continue
    picked.push(sentence)
  }
  return picked.join('。')
}

/**
 * Pull `items` from a model reply that may wrap it in prose or fences.
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseItems(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed?.items) ? parsed.items : []
  } catch {
    return []
  }
}

/**
 * True when the turn is over and the buffer has enough signal text to be worth
 * one extraction call.
 *
 * This is the trigger that actually fires in practice: waiting for an 8-minute
 * idle gap almost never happens in a working session, so the buffer would pile
 * up until the session closed. Flushing at turn boundaries keeps the cost to
 * roughly one model call every few turns instead of one per turn.
 *
 * @param {string} text buffered signal sentences
 * @param {number} minChars threshold, e.g. 300
 */
export function shouldFlush(text, minChars) {
  const size = String(text ?? '').trim().length
  const floor = Number(minChars) > 0 ? Number(minChars) : 300
  return size >= floor
}

/**
 * Jaccard similarity over bigram tokens; 0 when either side is empty. */
export function similarity(a, b) {
  const left = new Set(toSearchText(a).split(' ').filter(Boolean))
  const right = new Set(toSearchText(b).split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * Share of the smaller text's tokens that also appear in the larger one.
 * A short sentence that is almost entirely contained in a longer one is the
 * same fact being restated with more detail, which Jaccard alone punishes.
 * @param {string} a
 * @param {string} b
 */
export function containment(a, b) {
  const left = new Set(toSearchText(a).split(' ').filter(Boolean))
  const right = new Set(toSearchText(b).split(' ').filter(Boolean))
  const smaller = left.size <= right.size ? left : right
  const larger = smaller === left ? right : left
  if (smaller.size < 4) return 0
  let shared = 0
  for (const token of smaller) if (larger.has(token)) shared += 1
  return shared / smaller.size
}

/**
 * True when the text is near-verbatim to something already stored, so a second
 * extraction would only produce a duplicate. Another zero-token gate.
 * @param {{content: string}[]} rows active memories
 * @param {string} text candidate signal text
 * @param {number} threshold
 */
export function roughlyKnown(rows, text, threshold = 0.72) {
  for (const row of rows) {
    if (similarity(row.content, text) >= threshold) return true
  }
  return false
}
