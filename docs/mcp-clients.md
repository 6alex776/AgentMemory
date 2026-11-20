# 在其他 Agent 工具里用 AgentMemory（MCP）

AgentMemory 有两种接入方式，选一个就行：

| 方式 | 适合 | 特点 |
|---|---|---|
| **stdio**（`server/mcp.js`） | 本地客户端，最通用 | 客户端自己拉起一个 Node 进程，不需要先开服务 |
| **Streamable HTTP**（`POST /mcp`） | 支持 URL 的客户端 | 需要先跑 `node server/http.js`，多个客户端共用一个服务 |

> **本机实测**（2026-11-20）：两种传输都用官方 `@modelcontextprotocol/sdk` 的 `Client` 跑通——`initialize` / `tools/list` / `memory_save` / `memory_context` / `memory_search` / 错误透传（`isError`）。见 [已验证 / 未验证](#已验证--未验证)。

---

## 两个必须注意的点

**1. 用绝对路径指向 Node ≥ 22.5**

引擎用 `node:sqlite`，Node 20 上会直接报 `Cannot find module 'node:sqlite'`。本机有两个 Node，客户端继承的 `PATH` 不一定对：

```
E:\Tool\Node.js\node.exe        ← v22.22.1，用它
E:\Tool\nvm\v20.9.0\node.exe    ← v20.9.0，不行
```

所以下面所有配置都写 `E:\\Tool\\Node.js\\node.exe`，不要写 `node`。

**2. 数据库放在哪**

- 默认：`C:\Users\29390\.agentmemory\memory.db`（MCP 与 DSH 插件各用各的库）
- 覆盖：环境变量 `AGENTMEMORY_DB`
- 项目归属：默认用客户端启动服务时的 `cwd`；要固定就设 `AGENTMEMORY_CWD`

想让「DSH 插件」和「MCP」读同一个库，把 `AGENTMEMORY_DB` 指到 `C:\Users\29390\.dsh\agentmemory\memory.db` 即可。同库双写没做并发验证，演示可以，长期别两个宿主同时高频写。

---

## Claude Code

```bash
# stdio（推荐）
claude mcp add agentmemory -- "E:\Tool\Node.js\node.exe" "C:\Users\29390\OneDrive\Desktop\AgentMemory\server\mcp.js"

# 或者 HTTP
claude mcp add --transport http agentmemory http://127.0.0.1:7788/mcp
```

写进项目根目录的 `.mcp.json`（可提交进仓库）：

```json
{
  "mcpServers": {
    "agentmemory": {
      "type": "stdio",
      "command": "E:\\Tool\\Node.js\\node.exe",
      "args": ["C:\\Users\\29390\\OneDrive\\Desktop\\AgentMemory\\server\\mcp.js"],
      "env": { "AGENTMEMORY_DB": "C:\\Users\\29390\\.agentmemory\\memory.db" }
    }
  }
}
```

进会话后打 `/mcp` 确认 `agentmemory` 是 connected，然后直接说：

> 先调 memory_context 看看你记得我什么，再回答。

---

## Cursor

项目级 `.cursor/mcp.json`（或全局 `~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "E:\\Tool\\Node.js\\node.exe",
      "args": ["C:\\Users\\29390\\OneDrive\\Desktop\\AgentMemory\\server\\mcp.js"],
      "env": { "AGENTMEMORY_DB": "C:\\Users\\29390\\.agentmemory\\memory.db" }
    }
  }
}
```

HTTP 版把上面整块换成：

```json
{ "mcpServers": { "agentmemory": { "url": "http://127.0.0.1:7788/mcp" } } }
```

`Settings → MCP` 里应该出现 6 个工具，绿灯。

---

## Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.agentmemory]
command = "E:\\Tool\\Node.js\\node.exe"
args = ["C:\\Users\\29390\\OneDrive\\Desktop\\AgentMemory\\server\\mcp.js"]
env = { AGENTMEMORY_DB = "C:\\Users\\29390\\.agentmemory\\memory.db" }
```

`codex` 里用 `/mcp` 查看连接状态。

---

## Gemini CLI

`~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "E:\\Tool\\Node.js\\node.exe",
      "args": ["C:\\Users\\29390\\OneDrive\\Desktop\\AgentMemory\\server\\mcp.js"]
    }
  }
}
```

---

## Continue

`~/.continue/config.yaml`（本机已装 `continue` CLI）：

```yaml
mcpServers:
  - name: agentmemory
    command: E:\Tool\Node.js\node.exe
    args:
      - C:\Users\29390\OneDrive\Desktop\AgentMemory\server\mcp.js
    env:
      AGENTMEMORY_DB: C:\Users\29390\.agentmemory\memory.db
```

---

## Windsurf

`~/.codeium/windsurf/mcp_config.json`，结构与 Cursor 相同（`mcpServers` + `command`/`args`），面板里点 Refresh。

## Zed

`settings.json`：

```json
{
  "context_servers": {
    "agentmemory": {
      "command": {
        "path": "E:\\Tool\\Node.js\\node.exe",
        "args": ["C:\\Users\\29390\\OneDrive\\Desktop\\AgentMemory\\server\\mcp.js"]
      }
    }
  }
}
```

## 不认识但支持 JSON 导入的客户端

（Cherry Studio、ChatWise、5ire、Witsy…）一律用这个通用块：

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "E:\\Tool\\Node.js\\node.exe",
      "args": ["C:\\Users\\29390\\OneDrive\\Desktop\\AgentMemory\\server\\mcp.js"],
      "env": { "AGENTMEMORY_DB": "C:\\Users\\29390\\.agentmemory\\memory.db" }
    }
  }
}
```

---

## 接入后的用法

6 个工具，模型自己会挑；你只需要在提示里点名：

| 你说的话 | 应当触发的工具 |
|---|---|
| 「先看看你记得我什么」 | `memory_context` |
| 「记住：这个项目的数据存储用 ClickHouse」 | `memory_save`（`topicKey: tech.datastore`） |
| 「我之前说数据存储用什么来着？」 | `memory_search` 或 `memory_context` |
| 「把那条过时的删了」 | `memory_list` → `memory_forget` |
| 「这条改过几次？」 | `memory_history` |

**槽位是关键**：`memory_save` 时给同一个 `topicKey`，旧值才会被替换（状态 `superseded`），不给就是一条并列的新记忆。演示「记忆会更新」，靠的就是这个参数。

---

## 已验证 / 未验证

| 项 | 状态 |
|---|---|
| HTTP `POST /mcp`：`initialize` / `tools/list` / 4 个工具调用 / `isError` 透传 | ✅ 官方 SDK `Client` + `StreamableHTTPClientTransport` 实测 |
| stdio：`initialize` / `tools/list` / `memory_save` / `memory_context` | ✅ 官方 SDK `Client` + `StdioClientTransport` 实测（子进程由 SDK 拉起，DB 用临时文件） |
| 手工管道（`node server/mcp.js < in.jsonl`） | ✅ 6 个工具全过，见提交历史里的探针 |
| Claude Code / Cursor / Codex 真机连接 | ⬜ 本机没装这些客户端，配置按官方文档格式写好，未实跑 |
| 老的 SSE 传输（`GET /sse`） | ⬜ 未实现，只支持 Streamable HTTP；SSE-only 的客户端请改用 stdio |

## 自己验一遍（不装客户端）

```powershell
cd C:\Users\29390\OneDrive\Desktop\AgentMemory

# 1) 手打一个 JSON-RPC，回车，看返回
'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | & "E:\Tool\Node.js\node.exe" server\mcp.js
```

返回里有 6 个工具名就是通的。它会把库建在 `~/.agentmemory/memory.db`，想换位置就先 `$env:AGENTMEMORY_DB = "..."`。

官方 Inspector（可选，需要网络）：

```powershell
npx -y @modelcontextprotocol/inspector "E:\Tool\Node.js\node.exe" "C:\Users\29390\OneDrive\Desktop\AgentMemory\server\mcp.js"
```
