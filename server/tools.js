/**
 * The tool surface, shared by both transports.
 *
 * `mcp.js` (stdio) and `http.js` (Streamable HTTP at POST /mcp) must expose the
 * same thing, otherwise the two clients drift apart and only one of them is
 * really tested. So the definitions and the dispatch live here.
 */

export const TOOLS = [
  {
    name: 'memory_context',
    description: '取回本轮该注入的长期记忆：身份块、项目块、以及针对这个问题的检索块。开始回答前调用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用户当前的问题或任务，用于检索补充' },
        cwd: { type: 'string', description: '当前项目目录，用于挑选项目记忆' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save',
    description: '把一条值得长期记住的信息写进记忆。同一个 topicKey 的旧值会被新值替换，并保留版本链。',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string', description: '一句自包含的话' },
        kind: { type: 'string', enum: ['profile', 'preference', 'fact', 'decision', 'lesson', 'episode'] },
        scope: { type: 'string', enum: ['global', 'project'] },
        topicKey: { type: 'string', description: '槽位名，例如 tech.datastore；同槽位会替换旧值' },
        importance: { type: 'number', minimum: 1, maximum: 5 },
        cwd: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description: '按中文关键词检索记忆（FTS5 + 二元组影子列），返回摘要而不是全文。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 20 },
        allScopes: { type: 'boolean' },
        cwd: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_list',
    description: '列出生效的记忆条目。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'memory_history',
    description: '看一条记忆的变更历史。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_forget',
    description: '删除一条记忆（保留墓碑，同槽位不会被自动复活）。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    },
  },
]

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

/**
 * @param {ReturnType<typeof import('./engine.js').openEngine>} engine
 * @param {string} name
 * @param {object} args
 * @param {string} defaultCwd
 */
export function callTool(engine, name, args = {}, defaultCwd = process.cwd()) {
  const cwd = args.cwd ?? defaultCwd
  switch (name) {
    case 'memory_context': {
      const parts = engine.inject({ cwd, question: args.question })
      const body = [parts.identity.text, parts.project.text, parts.retrieval.text]
        .filter((part) => part && part.trim().length > 0)
        .join('\n\n')
      return text(body.length > 0 ? body : '（记忆里还没有相关内容）')
    }
    case 'memory_save': {
      if (typeof args.content !== 'string' || args.content.trim().length < 4) {
        return { isError: true, ...text('内容太短，至少 4 个字') }
      }
      const { result } = engine.save({
        content: args.content.trim(),
        kind: args.kind ?? 'fact',
        scope: args.scope ?? 'project',
        topicKey: args.topicKey,
        importance: args.importance ?? 3,
        cwd,
        origin: 'agent',
        reason: 'mcp',
      })
      return text(result)
    }
    case 'memory_search': {
      const rows = engine.search(args.query, {
        allScopes: args.allScopes === true,
        limit: args.limit ?? 8,
        projectId: engine.store.resolveProject(cwd)?.id,
      })
      return text(rows.map((row) => `${row.id} [${row.kind}] ${row.abstract ?? row.content}`))
    }
    case 'memory_list':
      return text(engine.list().map((row) => `${row.id} [${row.scope}/${row.kind}] ${row.content}`))
    case 'memory_history':
      return text(engine.history(args.id).map((row) => `${row.op} @ ${row.created_at}`))
    case 'memory_forget':
      return text({ forgotten: engine.forget(args.id) })
    default:
      return { isError: true, ...text(`unknown tool: ${name}`) }
  }
}

export const SERVER_INFO = { name: 'agentmemory', version: '0.1.0' }
export const PROTOCOL_VERSION = '2025-06-18'

/**
 * One JSON-RPC message in, one JSON-RPC message out (or null for notifications).
 * Both transports share this so a client sees identical behaviour.
 */
export function handleMessage(engine, message, defaultCwd) {
  const { id, method, params } = message ?? {}
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      },
    }
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {}
    return { jsonrpc: '2.0', id, result: callTool(engine, name, args, defaultCwd) }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (id === undefined) return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
}
