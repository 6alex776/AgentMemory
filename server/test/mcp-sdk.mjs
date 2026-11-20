/**
 * 用官方 MCP SDK 当客户端，把两种传输各跑一遍。
 *
 * 这个脚本依赖 @modelcontextprotocol/sdk，故意不做成常驻依赖（其余代码零依赖）：
 *
 *   cd server && npm i -D @modelcontextprotocol/sdk --registry=https://registry.npmmirror.com
 *   node test/mcp-sdk.mjs                          # 先另开一个窗口跑 node http.js
 *
 * stdio 传输会拉起子进程；某些沙箱环境不允许 spawn（报 EPERM），那就跳过它。
 */

let Client, StreamableHTTPClientTransport, StdioClientTransport
try {
  ;({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'))
  ;({ StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'))
  ;({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'))
} catch {
  console.log('缺少 @modelcontextprotocol/sdk，先执行：')
  console.log('  cd server && npm i -D @modelcontextprotocol/sdk --registry=https://registry.npmmirror.com')
  process.exit(0)
}

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', 'mcp.js')
const httpUrl = process.env.MCP_HTTP_URL ?? 'http://127.0.0.1:7788/mcp'

const show = (label, value) => console.log(`\n=== ${label} ===\n${value}`)

// 1) Streamable HTTP
try {
  const client = new Client({ name: 'agentmemory-http-probe', version: '0.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(httpUrl)))
  show('serverInfo (http)', JSON.stringify(client.getServerVersion()))
  const { tools } = await client.listTools()
  show('tools', tools.map((tool) => tool.name).join(','))
  const saved = await client.callTool({
    name: 'memory_save',
    arguments: { content: 'MCP HTTP 实测：插件之外也能写记忆', kind: 'fact', topicKey: 'test.mcp', importance: 3 },
  })
  show('memory_save', saved.content[0].text.replace(/\s+/g, ' '))
  const ctx = await client.callTool({ name: 'memory_context', arguments: { question: 'MCP 测试' } })
  show('memory_context', ctx.content[0].text)
  const bad = await client.callTool({ name: 'memory_save', arguments: { content: 'x' } })
  show('isError 透传', String(bad.isError))
  await client.close()
} catch (error) {
  console.log(`\n=== http FAILED ===\n${error?.message ?? error}`)
  console.log('（先运行 node server/http.js）')
}

// 2) stdio
try {
  const dir = mkdtempSync(join(tmpdir(), 'agentmemory-mcp-'))
  const client = new Client({ name: 'agentmemory-stdio-probe', version: '0.0.0' }, { capabilities: {} })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, AGENTMEMORY_DB: join(dir, 'memory.db') },
  }))
  show('serverInfo (stdio)', JSON.stringify(client.getServerVersion()))
  const { tools } = await client.listTools()
  show('stdio tools', tools.map((tool) => tool.name).join(','))
  await client.close()
} catch (error) {
  console.log(`\n=== stdio FAILED ===\n${error?.message ?? error}`)
}
