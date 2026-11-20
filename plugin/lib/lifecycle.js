/**
 * Memory lifecycle: what counts as expired, and what counts as "needs a
 * second look". Pure functions so the boundaries can be tested.
 */

/** A memory whose explicit expiry has passed. */
export function isExpired(row, now = Date.now()) {
  const at = Number(row?.expires_at)
  return Number.isFinite(at) && at > 0 && at <= now
}

/**
 * A memory nobody has confirmed or used for `days`: not wrong, but worth
 * re-checking. Pinned memories are exempt by definition.
 */
export function isStale(row, now = Date.now(), days = 90) {
  const window = Number(days)
  if (!(window > 0)) return false
  if (Number(row?.pinned) === 1) return false
  const last = Math.max(
    Number(row?.last_verified_at) || 0,
    Number(row?.last_used_at) || 0,
    Number(row?.created_at) || 0,
  )
  if (last === 0) return false
  return now - last > window * 86_400_000
}

/**
 * @param {object[]} rows
 * @param {number} now
 * @param {number} days
 */
export function decorate(rows, now = Date.now(), days = 90) {
  return rows.map((row) => ({
    ...row,
    expired: isExpired(row, now),
    stale: isStale(row, now, days),
  }))
}
