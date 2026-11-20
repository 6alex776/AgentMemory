#!/usr/bin/env node
/**
 * MCP adapter, stdio transport (JSON-RPC 2.0, one message per line).
 *
 * This is the second host next to the DSH plugin: any MCP client — Claude Code,
 * Cursor, Codex, OpenClaw — can use the same engine and the same database file.
 * Nothing in this file knows about DSH.
 */

import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

import { openEngine } from './engine.js'
import { handleMessage } from './tools.js'

const DB_FILE = process.env.AGENTMEMORY_DB ?? join(homedir(), '.agentmemory', 'memory.db')
mkdirSync(dirname(DB_FILE), { recursive: true })
const engine = openEngine({ dbFile: DB_FILE })
const DEFAULT_CWD = process.env.AGENTMEMORY_CWD ?? process.cwd()

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let reply
  try {
    reply = handleMessage(engine, JSON.parse(trimmed), DEFAULT_CWD)
  } catch (error) {
    reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error?.message ?? error) } }
  }
  if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`)
})

lines.on('close', () => {
  engine.close()
  process.exit(0)
})
