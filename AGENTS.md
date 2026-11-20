# AgentMemory — Agent 协作约定

本文件给接入本仓库的 AI 编码助手读。人类请看 [README.md](./README.md) 与 [HANDOFF.md](./HANDOFF.md)。

## 长期记忆以 AgentMemory 为准

| 场景 | 做法 |
|---|---|
| 需要用户背景、偏好、项目决策 | 调用 AgentMemory 的 `memory_context` / `memory_search` / `memory_list` |
| 判断某条信息值得长期保留 | 调用 `memory_save`；同一 `topicKey` 会替换旧值并保留版本链 |
| 回答"记住了几条 / 有哪些记忆" | 调用 `memory_list`，不要统计本地 md 文件 |
| 宿主自带记忆（Trae 的 `.trae-cn/memory/*.md`、Claude 的 `MEMORY.md`） | 仅作副本参考，不作为事实来源；与 AgentMemory 冲突时以 AgentMemory 为准 |

写入边界：只记用户背景、偏好、决策、项目事实、经验教训、重要事件。**密钥、口令、token 一律不写**（服务端也会拒）。

## 代码结构（改之前先看 HANDOFF.md）

```
server/engine.js   宿主无关引擎：注入 / 检索 / 保存 / 版本
server/mcp.js      MCP stdio 适配（8 个工具）
server/http.js     记忆面板 API + 静态页（7788）
plugin/index.js    DSH 插件适配层（注入注册、工具、事件）
plugin/lib/        store / block / capture / dream / retrieval 等纯逻辑
demo/index.html    只读优先的记忆面板
```

约束：

- `plugin/lib/*` 对 DSH API 的引用数必须为 0（引擎可移植性）。
- 不要在 `server/` 与 `plugin/lib` 之间复制代码，只允许 import。
- 记忆删除只用 `forget`（软删）+ `restore`，不做物理删除。

## 环境

- Node 必须 ≥ 22.19（`node:sqlite`）。本机用 `E:\Tool\Node.js\node.exe`；PATH 里的 v20 会报 `Cannot find module 'node:sqlite'`。
- 测试：`plugin/test/*.test.js`（89 例）、`server/test/engine.test.js`（6 例）、`server/test/tools.test.js`（4 例）、`eval/run.js`（40 用例）、`eval/concurrency.mjs`（并发压测）。
- 改 `plugin/index.js` 需重载插件；只改 `client.js` 刷新页面即可。
