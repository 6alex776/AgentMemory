# AgentMemory 项目交接

写给接手的 agent（或人）。目标：你读完这份文档，能在 30 分钟内把项目跑起来，知道每个文件干什么、哪些已验证、哪些还欠着、哪些坑别再踩一遍。

最后更新：2026-11-20（Windows / Node v22.22.1 / DSH 0.2.x）

---

## 1. 这个项目是什么

一个**跨会话长期记忆系统**，毕设形态是「引擎 + 两个宿主适配器 + 一个可演示的界面」：

```
浏览器记忆面板 / DSH 插件面板 / 任意 MCP 客户端
                 │
        engine.js（零宿主依赖）
                 │
        store.js（SQLite + FTS5）
```

答辩要讲的差异化不是「我也做了个记忆插件」，而是**同一条用户事实的旧值怎么被新值替换**：

- 记忆带 `topic_key`（槽位），同一槽位写第二次 → 旧值变 `superseded`，新值 `active`，两者都在 `memory_version` 里，可回滚；
- 注入按三段预算切：**身份块 400 字符（会话内冻结）/ 项目块 800 字符（每轮重建）/ 检索块 600 字符**；
- 中文检索不靠分词器：CJK 二元组影子列 + FTS5 `unicode61` + `bm25`。

已实测：插件侧 89 个单测、引擎侧 6 个、评测 40 条用例（替换正确率 100%，跨会话检索命中 85%）。

---

## 2. 文件位置与结构

仓库根：`C:\Users\29390\OneDrive\Desktop\AgentMemory`（**未初始化 git**，要版本管理先 `git init`）

```
AgentMemory/
├── README.md                 面向使用者的总文档（安装、三种形态、演示脚本、配置、限制）
├── DESIGN.md                 设计文档：为什么这么设计、预算调度、版本链语义（写论文时主要素材）
├── PROPOSAL.md               开题材料
├── RESEARCH.md               调研证据链（DSH 契约实测、SQLite/FTS5 中文实测、竞品对比）
├── HANDOFF.md                本文件
│
├── plugin/                   ← DSH 插件（宿主适配器之一）
│   ├── index.js      1531 行 宿主适配层：路由、注入、工具、命令、capture/turn/dream 监听
│   ├── client.js     1416 行 浏览器侧：侧栏面板 + 4 个 slot（书签按钮/回合栏/…）
│   ├── lib/
│   │   ├── store.js   978 行 全部 SQLite 读写、schema v8、迁移、槽位/版本/生命周期
│   │   ├── block.js   100 行 两段常驻块的取材、排序、预算截断（纯函数）
│   │   ├── capture.js 114 行 抽取提示词构造、shouldFlush 闸门（纯函数）
│   │   ├── dream.js   128 行 整合两步法：模型分组 → 代码判合并/过期 + 三道自动闸门
│   │   ├── retrieval.js 52 行 检索块渲染与去重（纯函数）
│   │   ├── lifecycle.js 40 行 过期/陈旧判定
│   │   ├── export.js   59 行 Markdown 导出
│   │   ├── bigram.js  153 行 中文二元组、缩写展开、覆盖率/hits、停用词
│   │   └── session-text.js 45 行 从 session 事件里取 assistant 消息正文
│   ├── test/*.test.js  89 个用例（store 34 / capture 14 / dream 13 / export 3 / lifecycle 7 / retrieval 6 / session-text 5 / block 7）
│   ├── locale/{zh,en}.json、icon.svg、cordis.patch.yml、package.json
│   └── README.md             插件自身文档（面板、配置项、已知限制）
│
├── server/                   ← 独立进程（演示服务 + MCP，宿主适配器之二/之三）
│   ├── engine.js     163 行 宿主无关 API（下面第 5 节有签名）
│   ├── http.js       229 行 演示服务：静态页 + JSON API + POST /mcp
│   ├── tools.js      164 行 MCP 工具定义与 JSON-RPC 分发（stdio 与 HTTP 共用）
│   ├── mcp.js         39 行 stdio 入口
│   ├── hooks/                Trae Hook：context.mjs（每轮注入）、session-start.mjs（会话规则）
│   ├── package.json           零依赖；scripts: start / mcp
│   ├── demo.db               演示库（首次启动自动 seed 8 条）
│   └── test/                  engine.test.js（6）+ tools.test.js（4，密钥拦截）
│
├── demo/index.html   ~500 行 单文件记忆面板（只读优先，零外部依赖、零构建）
│
├── eval/                     ← 评测（论文实验章）
│   ├── cases.js       66 行 40 条中文用例（A 组更新 20 / B 组跨会话 20）
│   ├── run.js        154 行 跑指标、打印、写 eval/report.md
│   └── report.md              最近一次运行的报告（含逐条结果表）
│
└── docs/
    ├── mcp-clients.md         在 Claude Code / Cursor / Codex / Gemini CLI / Continue / Windsurf / Zed 的配置
    ├── schema-v1.sql          建表 SQL（历史参考，实际以 store.js 内 v8 为准）
    ├── plugin-ui-analysis.md  对第三方插件 dsh-plugin-memory@0.20.0 解包产物的只读审阅笔记（面板 UX 参考）
    └── plugin-module-map.md   同上，模块地图（行号口径为 0.20.0 的 lib/client.js 与 lib/host/*）
```

> `docs/plugin-ui-analysis.md`、`docs/plugin-module-map.md` 的分析对象是 npm 包 `dsh-plugin-memory@0.20.0`（第三方实现，非本仓库代码）；两篇开头都写了审阅对象与方法。**它们不含该包的源代码，只含结论与引用行号**，因此没有复制许可证义务；但论文/答辩引用时应说明出处（"参考实现：dsh-plugin-memory 0.20.0"）。

`plugin/lib/*.js` 对 DSH API 的引用数为 **0**，这是「引擎可移植」的证据（`grep -rn "ctx\.\|cordis" plugin/lib/` 应为空）。

---

## 3. 三种运行形态

| 形态 | 启动 | 存储 | 用途 |
|---|---|---|---|
| DSH 插件 | 已装在 `~/.dsh/profiles/desktop/node_modules/dsh-agentmemory`（Junction 指向 `plugin/`，改文件即生效） | `$DSH_HOME/agentmemory/memory.db` | 日常使用、答辩演示「真实宿主里能用」 |
| 独立演示服务 | `node server/http.js` → http://127.0.0.1:7788 | `server/demo.db` | **答辩演示主力**，不需要 DSH |
| MCP | `node server/mcp.js`（stdio）或 `POST http://127.0.0.1:7788/mcp`（Streamable HTTP） | 默认 `~/.agentmemory/memory.db`，`AGENTMEMORY_DB` 覆盖 | 证明「不是只能跑在 DSH 里」 |

注意：演示服务与插件**共用同一套 `plugin/lib/*`**（engine 只 import，不复制），所以修一处两边都变。这是刻意设计，别把 engine 的代码复制进 `server/`。

---

## 4. 数据模型（读代码前先看这段）

一条记忆（`memory` 表，schema v8）：

| 字段 | 含义 |
|---|---|
| `scope` | `global`（跨项目，关于用户本人）或 `project`（绑定 `project_id`） |
| `kind` | `profile` / `preference` / `fact` / `decision` / `lesson` / `episode` |
| `topic_key` | 槽位。同一个 `(scope, project_id, topic_key)` 只能有一条 `active`（**部分唯一索引**） |
| `content` / `abstract` | 全文与摘要（注入用 abstract，检索用全文） |
| `importance` | 1–5。项目块只收 ≥3；<3 的只能靠检索块进入上下文 |
| `status` | `active` / `superseded` / `deleted` |
| `supersedes_id` | 版本链指针（新值 → 旧值） |
| `pin` / `expires_at` / `last_used_at` / `use_count` | 生命周期字段 |

八张表：`meta`（schema_version 等）、`project`、`memory`、`memory_version`（每次写的 before/after 快照）、`dream_proposal`（整合建议）、`session_flag`（`/memory off`）、`turn_trace`（每轮注入了哪些 id，供回合栏展示）、`memory_summary`（概览缓存 + `source_rev` 失效键）。

迁移机制：`store.js` 内 `SCHEMA_VERSION` 常量 + 顺序迁移，启动时比对 `meta.schema_version` 并逐版升级。

逐版变更（`plugin/lib/store.js:137-146` 的注释即权威）：

| 版本 | 加了什么 |
|---|---|
| v1 | `memory` / `memory_version` / `project` / `memory_fts`（含中文二元组影子列） |
| v2 | `memory_summary`（概览缓存 + `source_rev` 失效键） |
| v3 | `memory.abstract`（≤40 字短摘要，注入用；已有行会回填） |
| v4 | `dream_proposal`（整理建议卡） |
| v5 | `memory.use_count` / `memory.last_used_at` |
| v6 | `session_flag`（`/memory off`） |
| v7 | `memory.expires_at` / `memory.last_verified_at`（时效） |
| v8 | `turn_trace`（每轮注入了哪些 id、检索字符数、新增条数） |

`migrate()` 是**幂等增量**：只用 `hasColumn()` + `ALTER TABLE` 补列、必要时 `UPDATE` 回填，不重建表；若库里版本高于代码里的 `SCHEMA_VERSION`，直接抛错拒绝降级（不会静默丢数据）。`docs/schema-v1.sql` 仅是 v1 的历史快照，不要拿它当现状。

---

## 5. 接口契约

### 5.1 引擎 `server/engine.js`

```js
const engine = openEngine({ dbFile, includeIds?, identityMaxChars=400, projectMaxChars=800,
                            retrievalMaxChars=600, projectMinImportance=3 })

engine.save({ scope, cwd?, kind, topicKey?, content, importance?, expiresAt? })
      → { result: { status: 'added'|'duplicate'|'superseded'|'tombstoned', id, replaced? }, state }
engine.search(query, { projectId?, allScopes?, limit? }) → rows[]
engine.inject({ cwd?, question? })
      → { identity:{text,ids,chars,entries}, project:{...}, retrieval:{text,ids,chars}, chars }
engine.promptFor(input)                 // 三段拼成宿主真正看到的一段
engine.chain(topicKey, scope?)          // 一个槽位的全部历史，旧→新
engine.get/history/list/update/forget/restore/state/markdown/close
engine.store                            // 逃生口：需要 store 细节时直接用
```

### 5.2 演示服务 HTTP（`server/http.js`，只绑 127.0.0.1:7788）

`GET /`（记忆面板）、`/api/health`、`/api/state`、`/api/list?status=&scope=`、`/api/get?id=`、`/api/inject?q=`、`/api/chain?topic=&scope=`、`/api/history?id=`、`/api/export`；`POST /api/save`、`/api/update`、`/api/forget`、`/api/restore`、`/api/say`（规则抽取，演示用）、`/api/reset`（仅 `demo.db`，真实库返回 403）、`/mcp`。

### 5.3 插件 HTTP（`plugin/index.js`，全部以 `/api/agentmemory/` 开头）

`state`、`mutate`、`history`、`summarize`、`dream`、`capture`、`retrieve`、`export`、`flush`、`message`、`save`、`turn`。

### 5.4 MCP（`server/tools.js`，stdio 与 HTTP 共用）

8 个工具：`memory_context`、`memory_save`、`memory_search`、`memory_list`、`memory_get`、`memory_update`、`memory_history`、`memory_forget`。协议版本 `2025-06-18`。逐客户端配置见 `docs/mcp-clients.md`。

插件侧是 7 个（没有 `memory_context`——DSH 自己会注入；MCP 客户端不会，所以多这一个入口）。两边实现各走各的：插件直连 `lib/store.js`，MCP 走 `server/engine.js`，同名工具语义一致（同一套 `topicKey` 槽位规则）。

### 5.5 DSH 宿主接入面（已实测，别凭记忆改）

- **注入**：`ctx.systemPrompt.context({ name, order, text })`，三个块：`agentmemory:core`（-150）、`agentmemory:project`（-140）、检索块走 `agent/pre-step` 尾部。`context` 是 durable user-role 快照，宿主每轮整块重发。
- **面板**：`ctx.slots.register` 到侧栏；四个 slot：`conversation.chat.assistant-actions`（书签「存入记忆」，order 30）、`conversation.chat.turnTail`（回合记忆栏，order 30）、侧栏面板、设置项。
- **工具**：`memory_*` 七个（save / search / list / get / update / forget / history），与 MCP 工具同名；插件直连 store，MCP 走 engine。插件没有 `memory_context`（宿主自己注入）。
- **命令**：`/memory`（面板、`on|off`、`export` 等子命令）。
- **事件**：`turn/end`（写 `turn_trace` + 触发抽取 + 触发自动整理）、`user/message`（补回合问题）、`agent/disposed`（兜底落盘）。
- **`Agent.id` 的类型就是 `SessionId`**，所以 `agentId`、`session.id`、客户端 `sessionId` 是同一个值（这一点曾改错一版）。

### 5.6 门控常量一览（改阈值前先看这里，别散落着改）

插件侧集中在 `plugin/index.js:413-450` 的 `options`，全部可被 profile 的 `config` 覆盖：

| 键 | 默认 | 作用 |
|---|---|---|
| `identityMaxChars` | 400 | 【长期记忆·用户】字符预算（旧键 `maxInjectChars` 仅作兜底） |
| `projectMaxChars` | 800 | 【长期记忆·本项目】字符预算 |
| `projectMinImportance` | 3 | 项目块只收重要度 ≥ 此值（1–5） |
| `retrievalMaxChars` / `retrievalLimit` | 600 / 4 | 检索块预算与条数 |
| `captureMinChars` | 60 | 缓冲里至少这么多字才「值得」抽取 |
| `captureTurnChars` | 300 | 回合结束、缓冲达到这么多字就抽一次 |
| `captureIdleMinutes` | 8 | 兜底：空闲多久后抽（可被 `AGENTMEMORY_CAPTURE_IDLE_MINUTES` 覆盖） |
| `mergeSimilarity` | 0.55 | 整理时判「同一条」 |
| `staleDays` | 90 | 多久没确认标「待复核」（0 关闭） |
| `dreamIntervalDays` / `dreamMinMemories` | 7 / 8 | 后台整理的两道量/时门 |

写死在库层的：`plugin/lib/block.js:43` 行预算默认 800；`plugin/lib/retrieval.js` 默认 600 字符、`similarity ≥ 0.85` 视为重复；`plugin/lib/store.js` `makeAbstract` 40 字、检索候选取 `limit*4`、覆盖率门 `minHits = max(1, floor(tokens*0.15))`、LIKE 兜底探测 `probeTokens(...,3)`；`plugin/lib/dream.js:16` containment 0.85。内存上限：`lastInjected` 128 条、`coreCache` 64、`question` 截断 200、单条消息正文 4000。

两个「行为」也在这里钉一下：

- **检索去重**（`plugin/lib/retrieval.js:36-38`）：`coreIds.has(row.id)` 跳过 + `similarity(coreText, content) >= 0.85` 跳过。**不是**消息 digest，也不查 `turn_trace`；`turn_trace` 只用于回合栏展示。
- **抽取失败**：`flush()` 先把缓冲置空再调模型；模型报错/超时的 `.catch` 会把这段文字拼回缓冲、`syncPending()` 并写 `captureStats.reason = '抽取失败，内容已放回缓冲'`，下一轮再抽（没有独立重试队列）。密钥命中则是**整条拒绝**（`looksSecret`，抽取循环 `continue` / `POST /save` 返回 400），不做脱敏。

### 5.7 Trae 接入配置（MCP + Hook，2026-11-20 实测）

三处配置都在仓库外，不受版本管理；换机要照下面手工重建。

**1）MCP：`%APPDATA%\Trae CN\User\mcp.json`**（`TRAE SOLO CN` 下还有一份同样的）

```json
"AgentMemory": {
  "command": "E:\\Tool\\Node.js\\node.exe",
  "args": ["<repo>\\server\\mcp.js"],
  "env": { "AGENTMEMORY_DB": "<home>\\.dsh\\agentmemory\\memory.db" }
}
```

**不要写 `AGENTMEMORY_CWD`**：写死会让其他工作区的项目归属出错。MCP 默认取进程 cwd（即工作区根），工具也支持每次传 `cwd`。

**2）全局 Hook：`%USERPROFILE%\.trae-cn\hooks.json`**（对本机所有工作区生效）

- `SessionStart` → `server/hooks/session-start.mjs`：会话建立时下发 5 条记忆约定。
- `UserPromptSubmit` → `server/hooks/context.mjs`：注入三段记忆 + 「用工具查」提示。
- 两条命令都带前缀 `$env:AGENTMEMORY_HOOK_SCOPE='global';`。脚本据此判断：若当前工作区自带 `.trae/hooks.json`，全局这份直接退出，避免重复注入。
- 命令里的仓库路径是写死的，仓库搬家要同步改。

**3）用户规则：`%USERPROFILE%\.trae-cn\user_rules\rule-*.md`**（设置 → 规则 的输入框）

- 文件末尾 4 条「长期记忆约定」，标题声明「所有工作区生效；项目记忆按当前工作区自动隔离」。
- 这是目前唯一被证实能进入模型上下文的规则通道（SessionStart 在部分版本未生效），删改前先验证 Hook。

仓库内另有项目级 `.trae/hooks.json`（同样两个事件）。global 与 project 同时存在时的去重逻辑见上。

生效方式：改 `mcp.json` / hooks 需重启 Trae；`SessionStart` 只在新建会话时触发；`UserPromptSubmit` 每次提问都执行（约 30–50ms）。

---

## 6. 已完成（含验证方式）

| 能力 | 状态 | 验证 |
|---|---|---|
| 存储层：槽位唯一、版本链、事务、审计 | ✅ | `plugin/test/store.test.js` 34 例；实际库里能看到 superseded 链 |
| 中文检索：二元组影子列 + bm25 + 停用词 + 缩写展开 | ✅ | `retrieval.test.js` 6 例；`eval/` 跨会话命中 85% |
| 检索相关度闸门：按「命中 bigram 数」而非固定覆盖率过滤 | ✅ | 长问题只与记忆重叠 1–2 个 bigram，旧的 0.34 覆盖率会把所有真实命中全过滤掉（曾导致检索块几乎从不触发）；现规则 `minHits = max(1, floor(tokens*0.15))`，`eval/` B 组从 0% 提到 85% |
| 两段常驻注入 + 检索块去重 | ✅ | DSH 里实测 system-reminder 同时出现【长期记忆·用户】【长期记忆·本项目】；`state.injection = {chars:294, entries:4, projectChars:101, projectEntries:1}` |
| 回合记忆栏（每轮检索/新增了几条，可展开） | ✅ | `Slots.listSubTree({root:'conversation.chat.turnTail'})` 有 `agentmemory-turn-tail`；`GET /api/agentmemory/turn` 返回真实 trace |
| 回答下方「存入记忆」书签（手填/预填 + 密钥拦截） | ✅ | 线上 `GET /message`、`POST /save` 全链路通过；`password=hunter2` 被拒 |
| 自动抽取（回合结束、缓冲 ≥300 字符） | ✅ | `capture.test.js` 14 例；真实对话里跑通过一次 |
| 后台整理闸门（≥8 条、≥7 天、无待处理建议） | ✅ | `dream.test.js` 13 例（含闸门 4 例） |
| 面板：概览、分组、版本链、回滚、stale 提示、最近使用 | ✅ | 人工验证 |
| 生命周期：过期、陈旧复核、使用计数 | ✅ | `lifecycle.test.js` 7 例 |
| Markdown 导出 | ✅ | `export.test.js` 3 例 + 面板按钮 |
| 独立引擎 `engine.js` | ✅ | `server/test/engine.test.js` 6 例 |
| 记忆面板（列表/详情/编辑/软删/恢复/版本链/注入预览） | ✅ | 浏览器实测：8 条种子、展开显示旧值、控制台无报错 |
| MCP stdio + Streamable HTTP | ✅ 协议层 | 官方 SDK 客户端两种传输都跑通（initialize / tools/list / save / context / isError） |
| 评测脚本 | ✅ v1 | 40 条用例，A 组 100%、B 组 85%（见 `eval/report.md`） |

**测试怎么跑**（沙箱里 `node --test` 会 spawn 失败，只能逐个文件跑）：

```powershell
cd plugin; node test/store.test.js; node test/capture.test.js; ...
# 或
npm test          # 只在不受沙箱限制的环境里可靠
cd ../server; node test/engine.test.js
cd ..; node eval/run.js
```

---

## 7. 未完成 / 已知限制（按重要性）

1. **MCP 只在 Trae CN 里实连过**（8 个工具、读写共享库、`initialize.instructions`、密钥写入被拒）。Claude Code / Cursor / Codex 仍未实测，配置按官方格式写在 `docs/mcp-clients.md`。
2. **检索是纯词法**。同义改写会漏：评测里 3 条漏检是「数据量 vs 万条行情快照」这类无语汇重叠的问题。85% 是这套方案的诚实上限；论文里要写清楚，向量检索列为 future work。
3. **评测规模小**（40 条、自建语料）。够证明机制，不够宣称通用性能。下一步可以扩到 100+ 条，并加一组「长对话（50 轮后仍能召回早期事实）」。
4. **自动抽取依赖模型**，抽取提示词的召回/精度没有量化。抽取失败会在面板状态行显示原因，但没有重试队列。
5. **SSE 传输没实现**（MCP 里 Streamable HTTP 已够用；老客户端可能要 SSE）。
6. **并发写已压测两进程，仍未测多进程与长事务**：`eval/concurrency.mjs` 用 2 进程各写 500 / 2000 条，零 `SQLITE_BUSY`、落库数与槽位数一致（490ms / 2369ms）。配置是 `journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`foreign_keys=ON`（`plugin/lib/store.js:16-19`），每进程一份长连接。3 个以上进程、单事务超过 5 秒、以及 WAL checkpoint 由谁触发，仍未验证。

**这项怎么验证**（三项未验证项的测法，不要只写「未验证」）：

| 项 | 测法 |
|---|---|
| 多进程并发写 | 起 `server/mcp.js`（或用 `node -e` 起一个持锁脚本）与插件同时写同一个库，各写 500 条不同 `topicKey`，断言零 `SQLITE_BUSY`、总量 = 1000、无一条 `tombstoned` 误标 |
| compaction 后自愈 | 在 GUI 里把会话跑到自动压缩，压缩后立刻问一条只存在于身份块的记忆（如「我的毕设方向是什么」），看注入是否仍在；再查 `turn_trace` 是否继续写新回合 |
| 子代理隔离 | 让主会话派一个 subagent 去问「你看到我的长期记忆了吗」，断言子代理上下文里没有【长期记忆·用户】；同时确认主会话注入未受影响 |

7. **子代理不注入**（`origin:'subagent'` 直接跳过），是有意为之，但没做过对照实验。
8. `.tmp/` 里有早期探针脚本（schema/fts/merge 实验），可删，删前看一眼有没有想留的数据。
9. 仓库已初始化并推送到 `github.com/6alex776/AgentMemory`（`main`）。开源前仍需脱敏：HANDOFF、`docs/mcp-clients.md` 里还有本机绝对路径。

---

## 8. 环境与工程坑（别重复踩）

1. **Node 必须绝对路径**：`E:\Tool\Node.js\node.exe`（v22.22.1）。PATH 里可能命中 nvm 的 v20.9.0，`node:sqlite` 直接 `Cannot find module`。所有 MCP 客户端配置同理。
2. **插件重载**：改 `plugin/index.js`（host 侧）**不会**热重载。用 `plugin_manager` 先 `set_plugin({enabled:false, target:'include:agentmemory'})` 再 enable；target 写 `dsh-agentmemory` 会报 `unknown-plugin`。只改 `client.js` 则刷新页面即可。
3. **插件目录是 Junction**：`~/.dsh/profiles/desktop/node_modules/dsh-agentmemory → Desktop\AgentMemory\plugin`，改文件即生效，不要重新安装、不要复制。
4. **`/api/*` 未注册返回 401 文本 `unauthorized`**——看到 401 说明路由没挂上（没重载），不是鉴权问题。`/api/agentmemory/state` 不需 token。
5. **npm**：`.cmd` shim 在沙箱里 exit 126，用 `node /e/Tool/Node.js/node_modules/npm/bin/npm-cli.js`；默认 cache 在 `E:\Tool\Node.js\node_cache` 不可写，加 `--cache ../.npm-cache`；默认 registry 是已失效的 taobao，用 `--registry=https://registry.npmmirror.com`。
6. **沙箱下不能以读写方式打开真实库**（`attempt to write a readonly database`），只能 `readOnly: true` 读。要写就用插件/服务的 HTTP 接口。
7. **PowerShell 5.1 会按 ANSI 读改写文件**，直接用 shell 改含中文的源码会毁掉编码——只用文件工具改源码。发中文 JSON 要 `UTF8.GetBytes` + `charset=utf-8`。
8. **测试输出坑**：`node test/x.js | Select-Object -Last 5` 会把 `$LASTEXITCODE` 变成 1，必须重定向到文件再读退出码。
9. **spawn 受限**：沙箱里起子进程（尤其 MCP stdio 测试）需要 `danger-full-access` 批准，否则 `EPERM`。
10. **演示库的 WAL**：`server/demo.db` 本体可能只有 4KB，数据全在 `demo.db-wal`（593KB 量级）里——**只拷 `.db` 单文件会丢数据**。要带走就在停服后拷 `db` + `-wal` + `-shm` 三个文件，或先 `PRAGMA wal_checkpoint(TRUNCATE)`。`POST /api/reset` 是**删库重建**（`engine.close()` → 删 `demo.db`/`-wal`/`-shm` → reopen + `seed()`），不是清表。`.gitignore` 已忽略 `*.db*`，这是对的，别把演示数据提交进仓库。
11. **改完 host 侧代码要重载再验证**，且重载会重置内存态（`injectionStats`、`captureStats`、`turnTrace`），面板上的「上次注入/上次检查」会短暂归零，不是 bug。

---

## 9. 关键决策（为什么是这样，改之前先想清楚）

| 决策 | 理由 |
|---|---|
| SQLite + FTS5，不引外部检索引擎 | 单机可跑、零部署、可直接 demo；CJK 二元组影子列解决了 FTS5 中文分词问题（实测 trigram 对「毕业设计」不命中） |
| `topic_key` 槽位 + 部分唯一索引 | 把「更新语义」压到 schema 层，靠数据库保证一个槽位只有一条 active，而不是靠应用层自觉 |
| 两段常驻（身份/项目），不是一段 | 身份跨项目稳定可以冻结，项目内容每轮变化；分开才能各自定预算、各自失效 |
| 项目块门槛 importance ≥3 | 防止低价值条目挤占 800 字符预算；低重要度条目仍可被检索块捞回来（B 组评测就是验证这条路径） |
| 演示页零依赖单文件 | 答辩现场不能赌网络和构建；`node server/http.js` 就能开 |
| MCP 接在 engine 而非插件 | 证明引擎可移植；插件与 MCP 共享 `plugin/lib`，避免两份实现漂移 |
| 自动抽取放在回合结束 + 300 字符闸门 | 早期只在空闲 8 分钟触发，实际一次都没触发过（教训：触发条件必须可观测，面板状态行就是因此加的） |

---

## 10. 接手第一步（建议顺序）

1. `git init` → 提交当前状态。
2. 跑一遍：`node eval/run.js`（应看到 A 100% / B 85%）、`node server/test/engine.test.js`、逐个跑 `plugin/test/*.test.js`（应 89 通过）。
3. `node server/http.js` → 打开 http://127.0.0.1:7788 → 点右上「重置演示」→ 走一遍 README 里的 3 分钟演示脚本。
4. 读 `plugin/lib/store.js` 的 `add()`（374 行）与 `search()`（588 行）——这两处是全部语义的核心。
5. 读 `plugin/index.js` 的三段注入注册（搜 `agentmemory:core` 与 `agentmemory:project`）与 `turn/end` 分支。
6. 明确要做什么再动手：想补评测就先扩 `eval/cases.js`；想加向量就先在 `store.search` 里做并行召回再融合，别动槽位逻辑。

---

## 11. 文档索引

| 想了解 | 看 |
|---|---|
| 怎么用、怎么演示 | `README.md` |
| 为什么这么设计（论文素材） | `DESIGN.md` |
| 调研证据（DSH 契约、FTS5 实测） | `RESEARCH.md` |
| 插件自己的配置与限制 | `plugin/README.md` |
| 在各家 agent 工具里接 MCP | `docs/mcp-clients.md` |
| 评测口径与逐条结果 | `eval/report.md` + `eval/cases.js` |
