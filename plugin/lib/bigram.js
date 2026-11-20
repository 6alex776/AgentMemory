/**
 * CJK-aware search text expansion.
 *
 * SQLite's `trigram` tokenizer only matches queries of 3+ characters, so a
 * two-character Chinese word such as 湖仓 finds nothing. `unicode61` on the raw
 * text treats a whole Chinese run as one token, so it finds nothing either.
 *
 * The workable middle ground: expand every CJK run into overlapping bigrams and
 * index that shadow text with `unicode61`. ASCII runs stay whole words. The same
 * function runs on the query side, so both sides agree.
 *
 *   湖仓一体  ->  湖仓 仓一 一体
 *   SQLite 存储  ->  sqlite 存储
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
const ASCII = /[A-Za-z0-9]/

/**
 * @param {string} text
 * @returns {string} space-separated tokens for FTS5
 */
export function toSearchText(text) {
  const pieces = []
  let run = ''
  let mode = null
  const flush = () => {
    if (run.length === 0) return
    if (mode === 'cjk') {
      const chars = [...run]
      if (chars.length === 1) pieces.push(chars[0])
      for (let i = 0; i + 1 < chars.length; i += 1) pieces.push(chars[i] + chars[i + 1])
    } else {
      pieces.push(run.toLowerCase())
    }
    run = ''
  }
  for (const ch of text) {
    const next = CJK.test(ch) ? 'cjk' : (ASCII.test(ch) ? 'ascii' : null)
    if (next !== mode) {
      flush()
      mode = next
    }
    if (next === null) continue
    run += ch
  }
  flush()
  return pieces.join(' ')
}

/**
 * Build an FTS5 MATCH expression from user input. Never interpolate raw input:
 * every token is quoted, then joined with AND.
 *
 * @param {string} text
 * @returns {string} MATCH expression, or '' when nothing is searchable
 */
export function toMatchQuery(text) {
  const tokens = toSearchText(String(text ?? ''))
    .split(' ')
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
}

/**
 * OR'd variant for natural-language questions: a long sentence rarely contains
 * every bigram, so requiring all of them finds nothing. Ranking still separates
 * the good hits, and `coverage()` filters the tail.
 * @param {string} text
 * @returns {string} MATCH expression, or '' when nothing is searchable
 */
export function toMatchQueryOr(text) {
  const tokens = toSearchText(String(text ?? ''))
    .split(' ')
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * Share of the query's tokens that appear in the candidate text.
 * @param {string[]} tokens
 * @param {string} text
 */
export function coverage(tokens, text) {
  if (tokens.length === 0) return 0
  return tokenHits(tokens, text) / tokens.length
}

/**
 * How many of the query's tokens actually appear in the candidate text.
 * Used instead of pure coverage once the question gets long: a 15-bigram
 * question only ever overlaps a memory by a few bigrams, so a fixed
 * percentage threshold silently drops every honest hit.
 * @param {string[]} tokens
 * @param {string} text
 */
export function tokenHits(tokens, text) {
  if (tokens.length === 0) return 0
  const present = new Set(toSearchText(text).split(' ').filter(Boolean))
  let hit = 0
  for (const token of tokens) if (present.has(token)) hit += 1
  return hit
}

/** Longest tokens first — used as LIKE probes when full-text matching finds nothing. */
export function probeTokens(tokens, limit = 3) {
  return [...new Set(tokens)].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, limit)
}

/** Common Chinese abbreviations, expanded before matching. */
const ABBREVIATIONS = [
  [/毕设/g, '毕业设计'],
  [/大模型/g, '大语言模型'],
  [/向量库/g, '向量数据库'],
  [/数仓/g, '数据仓库'],
]

/** Bigrams that carry no retrieval signal in a natural-language question. */
export const STOP_TOKENS = new Set([
  '什么', '是什', '么是', '用什', '怎么', '么办', '如何', '可以', '一下', '帮我',
  '我的', '我毕', '请问', '有哪', '哪些', '是不', '不是', '为什', '么要', '到哪',
  '哪一', '一步', '做了', '了吗', '多少', '怎样', '现在',
])

/**
 * Expand abbreviations in a question before tokenizing.
 * @param {string} text
 */
export function expandQuery(text) {
  let expanded = String(text ?? '')
  for (const [pattern, replacement] of ABBREVIATIONS) expanded = expanded.replace(pattern, replacement)
  return expanded
}

/** Tokens worth scoring, i.e. the query minus stop bigrams. */
export function contentTokens(tokens) {
  const kept = tokens.filter((token) => !STOP_TOKENS.has(token))
  return kept.length > 0 ? kept : tokens
}

/**
 * Normalized form used only for duplicate detection.
 * @param {string} text
 */
export function contentNorm(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
