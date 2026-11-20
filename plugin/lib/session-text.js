/**
 * Pulling text out of a stored session message.
 *
 * The chat action row hands the browser only ids, so the manual-save entry
 * point reads the durable transcript on the Host and hands the text back.
 * Kept here (not in index.js) so the shape assumptions are covered by tests:
 * a session message carries `content` as an array of blocks, and only `text`
 * blocks are the assistant's own words.
 */

/** Blocks of a message, whichever field the caller's snapshot uses. */
function blocksOf(message) {
  if (message === null || typeof message !== 'object') return []
  if (Array.isArray(message.content)) return message.content
  if (Array.isArray(message.blocks)) return message.blocks
  return []
}

/** The assistant's own words: text blocks only, reasoning stays private. */
export function textOfMessage(message) {
  if (message === null || typeof message !== 'object') return ''
  if (typeof message.content === 'string') return message.content.trim()
  return blocksOf(message)
    .filter((block) => block !== null
      && typeof block === 'object'
      && block.type === 'text'
      && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/** Find one assistant message by id; a later one wins if the id repeats. */
export function findAssistantMessage(events, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  let hit
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    const message = event.data === undefined || event.data === null ? undefined : event.data.message
    if (message === undefined || message === null) continue
    if (String(message.id ?? '') !== messageId) continue
    hit = message
  }
  return hit
}
