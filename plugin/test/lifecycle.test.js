import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decorate, isExpired, isStale } from '../lib/lifecycle.js'

const DAY = 86_400_000
const now = Date.parse('2026-11-19T12:00:00Z')

test('expiry is inclusive of the exact timestamp', () => {
  assert.equal(isExpired({ expires_at: now - 1 }, now), true)
  assert.equal(isExpired({ expires_at: now }, now), true)
  assert.equal(isExpired({ expires_at: now + 1 }, now), false)
  assert.equal(isExpired({}, now), false)
  assert.equal(isExpired({ expires_at: null }, now), false)
})

test('staleness starts after the window', () => {
  const created = now - 100 * DAY
  assert.equal(isStale({ created_at: created }, now, 90), true)
  assert.equal(isStale({ created_at: now - 10 * DAY }, now, 90), false)
})

test('a recent confirmation wins over an old creation date', () => {
  const row = { created_at: now - 200 * DAY, last_verified_at: now - 1 * DAY }
  assert.equal(isStale(row, now, 90), false)
})

test('a recent use also counts as confirmation', () => {
  const row = { created_at: now - 200 * DAY, last_used_at: now - 2 * DAY }
  assert.equal(isStale(row, now, 90), false)
})

test('pinned memories never go stale, and days<=0 disables the check', () => {
  assert.equal(isStale({ created_at: now - 999 * DAY, pinned: 1 }, now, 90), false)
  assert.equal(isStale({ created_at: now - 999 * DAY }, now, 0), false)
})

test('decorate marks both flags without mutating the source', () => {
  const rows = [
    { id: 'a', created_at: now - 200 * DAY, expires_at: now - 1 },
    { id: 'b', created_at: now - 1 * DAY },
  ]
  const out = decorate(rows, now, 90)
  assert.equal(out[0].expired, true)
  assert.equal(out[1].expired, false)
  assert.equal(out[0].stale, true)
  assert.equal(out[1].stale, false)
  assert.equal(rows[0].expired, undefined)
})

test('an expired row can also be stale, and both are reported', () => {
  const out = decorate([{ created_at: now - 200 * DAY, expires_at: now - 1 }], now, 90)
  assert.deepEqual([out[0].expired, out[0].stale], [true, true])
})
