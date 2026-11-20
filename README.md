# AgentMemory

面向 AI Agent 的跨会话长期记忆系统。核心是一个与宿主无关的引擎（SQLite + FTS5 + 槽位/版本链），外面套两个适配层：**DSH 插件**与 **MCP server**。

> 当前状态：引擎 + 三个可运行形态都已跑通。同一个 SQLite 文件，既能在 DSH 里当插件用，也能在任意 MCP 客户端里用，还能用一个独立网页直接演示「旧值被新值替换」。

```
                ┌──────────────────────────┐
浏览器演示页 ←──│ server/http.js（node:http）│
                ├──────────────────────────┤
MCP 客户端  ←──│ server/mcp.js（stdio）     │──→ engine.js ──→ store.js（SQLite）
                ├──────────────────────────┤        ▲
DSH 侧栏面板 ←──│ plugin/index.js + client.js│───────┘
                └──────────────────────────┘
```

`server/` 里一行 DSH API 都没有，`plugin/index.js` 是适配层。这是这个项目「不只是个插件」的证据，也是论文里可移植性的那一节。

---

## 快速开始

插件在本仓库的 `plugin/` 目录，已通过 `install_bundle` 装进 `desktop` profile：

- 侧栏出现「记忆」入口（图标 + 标签），点开后是按「用户背景 / 偏好 / 项目」分组的记忆页。
- 每轮对话会自动注入一段「长期记忆」，子代理会话不注入。
- 模型可调用 `memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_update` / `memory_forget` / `memory_history`（7 个）。
- 数据在 `$DSH_HOME/agentmemory/memory.db`（单文件 SQLite，WAL）。

改 `plugin/` 下的 Host 代码后，用插件管理开关一次（或重启）让新模块生效；只改 `client.js` 则刷新页面即可。

---

## 三种运行形态

**1. 记忆面板（不需要 DSH，也不需要模型）**

```bash
cd server && npm start          # 或 node server/http.js
# → http://127.0.0.1:7788/
```

两种库，用 `AGENTMEMORY_DB` 切换：

| 库 | 启动方式 | 内容 |
|---|---|---|
| 演示库（默认） | 直接启动 | `server/demo.db`，首次启动 seed 8 条湖仓相关记忆 |
| 真实库 | `$env:AGENTMEMORY_DB="$env:USERPROFILE\.dsh\agentmemory\memory.db"` | 与 DSH 插件、MCP 共用同一份记忆 |

面板功能：搜索与筛选（范围 / 状态 / 类型）、详情、编辑内容与重要度、软删除与恢复、版本链、变更历史、按问题预览三段注入、导出 Markdown。`POST /api/reset` 只在 `demo.db` 上可用，指向真实库时返回 403。

**2. MCP server（Claude Code / Cursor / Codex / Gemini CLI…）**

```bash
node server/mcp.js              # stdio，JSON-RPC 2.0
curl -X POST localhost:7788/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 或 HTTP
```

数据库默认 `~/.agentmemory/memory.db`，可用 `AGENTMEMORY_DB` 覆盖；项目归属用 `AGENTMEMORY_CWD` 或每次调用传 `cwd`。暴露 8 个工具：`memory_context` / `memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_update` / `memory_history` / `memory_forget`，定义在 [server/tools.js](server/tools.js)，stdio 与 HTTP 共用一份。比插件多一个 `memory_context`：DSH 插件自己会注入上下文，MCP 客户端不会，所以得给它一个「现在该注入什么」的入口。

各客户端的具体配置（含「必须用绝对路径指向 Node ≥22.5」这个坑）见 [docs/mcp-clients.md](./docs/mcp-clients.md)。

**3. DSH 插件**（下面「快速开始」那节）

---

## 面板怎么用（答辩 3 分钟）

1. 打开面板，顶部显示「生效 N · 全局 x / 项目 y」，左列按重要度排序。
2. 点一条带槽位的记忆（如 `tech.datastore`）：右侧出现内容、版本链和变更历史。同一槽位被替换过几次，一眼可见。
3. 「新建记忆」写一条同槽位的新值（例如把 ClickHouse 换成 Doris）：旧值变「已替换」，新值「生效」，版本链多一条。**这就是本项目与普通记忆插件的区别。**
4. 右下「注入预览」输入「我们的数据存储用什么？」：三段各多少字符当场可见，预算分工不用口头解释。
5. 删一条再切到「已删除」恢复：证明是软删除，变更历史里出现 delete / restore。

---

## 文档导航

| 文件 | 内容 | 读它的时机 |
|---|---|---|
| [HANDOFF.md](./HANDOFF.md) | 交接文档：文件职责、接口契约、已完成/未完成、环境坑、接手第一步 | **换人或换 agent 接手时先读这个** |
| [RESEARCH.md](./RESEARCH.md) | DSH 接入面核验（含契约与源码证据）、运行时实测、参照插件 0.20.0 拆解、GPT Dreaming 公开资料、与同类实现的对照、接入风险清单 | 想知道「为什么这么设计」「哪些已证实、哪些还没验证」 |
| [DESIGN.md](./DESIGN.md) | V1.0 架构、数据模型、SQLite schema、注入与检索策略、Dreaming 设计、安全策略、分阶段计划与验收标准 | 想知道「具体怎么做」 |
| [PROPOSAL.md](./PROPOSAL.md) | 毕业设计开题报告底稿（题目、研究问题、章节写法、答辩口径） | 要交开题申请时 |
| [docs/mcp-clients.md](./docs/mcp-clients.md) | 在 Claude Code / Cursor / Codex / Gemini CLI / Continue / Windsurf / Zed 里接入 MCP 的逐份配置 | 想在其他 agent 工具里用这套记忆 |
| [docs/schema-v1.sql](./docs/schema-v1.sql) | 可直接执行的建表脚本（已在本机 SQLite 3.51.2 跑通） | 开始写存储层时 |
| [eval/report.md](./eval/report.md) | 40 条中文用例的评测结果（更新替换 100%、跨会话检索 85%）与逐条明细 | 要写论文实验章时 |
| [docs/plugin-ui-analysis.md](./docs/plugin-ui-analysis.md) | 参照插件客户端/UI 面的逐行审阅（3210 行 client.js、9 条路由、能力边界） | 决定要不要做管理面板时 |
| [docs/plugin-module-map.md](./docs/plugin-module-map.md) | 参照插件 host 半的 19 个模块地图（职责/导出/副作用、记忆协议、门控与仲裁） | 想复用它的某个机制时 |

---

## 三句话结论

1. **不用改 DSH 框架**：`systemPrompt.context` 注入、`tools.register` 写入、`session/event` 触发、`sessionPersistence` 读历史，四处接口够用。
2. **注入拆两条链路**：稳定的「核心块」走 `systemPrompt.context`（宿主管快照），每轮变化的「检索块」走 `agent/pre-step` 尾部追加（保 KV cache）。
3. **中文检索用 bigram 影子列**：实测 FTS5 `trigram` 对「湖仓」这类双字查询命中为 0，不能当主路径。

---

## 目录说明

```
.
├─ RESEARCH.md          调研与验证报告
├─ DESIGN.md            V1.0 技术设计与计划
├─ PROPOSAL.md          开题报告底稿
├─ server/              宿主无关的引擎与两个适配器
│  ├─ engine.js         openEngine()：注入/检索/保存/版本，零 DSH 依赖
│  ├─ http.js           记忆面板 API + 静态页（端口 7788）
│  └─ mcp.js            MCP stdio server（JSON-RPC 2.0）
├─ demo/index.html      记忆面板（列表 / 详情 / 版本链 / 注入预览）
├─ plugin/              DSH 插件（可直接安装）
│  ├─ index.js          Host：路由 + 注入 + 工具
│  ├─ client.js         浏览器半：侧栏面板 + 三个 slot
│  ├─ lib/store.js      SQLite 存储与槽位/版本规则
│  ├─ lib/block.js      身份块/项目块的取材与预算
│  └─ lib/bigram.js     中文二元组检索
├─ docs/                证据与可直接执行的产物
├─ .tmp/                验证脚本与参照插件源码解包（非交付物）
│  ├─ fts-check.mjs     FTS5 trigram 边界验证
│  ├─ cjk-search.mjs    trigram vs bigram 对比
│  ├─ schema-check.mjs  建表 + 约束 + 触发器验证
│  └─ pkg/package/      dsh-plugin-memory@0.20.0 解包源码（审阅用）
└─ .npm-cache/          npm 缓存（可删）
```

---

## 功能现状

- 侧栏「记忆」入口（书本图标，位于「上下文洞察」与「更多」之间）
- 页面：概览卡（模型生成 + 哈希失效）、整理建议（两步法：模型分组 + 规则合并，接受/忽略）、搜索、分组列表、添加/编辑/固定/删除/恢复/彻底删除、版本历史与回滚
- 注入分三段：**身份块**（全局背景与偏好，400 字符，会话内冻结）+ **项目块**（本项目决策/事实/经验，重要度 ≥3，800 字符，每轮重建）+ **检索块**（针对当前问题，600 字符，与常驻块去重；未命中就不注入）
- 回答下方的「存入记忆」书签：浮层里正文自动从会话日志取，可改成全局/本项目；含密钥的文本拒绝保存
- 每轮结束的「记忆」胶囊：常驻 N 条 · 检索 M 条 · 新增 K 条，点开看本轮细节；三者都为空时不占位
- 自动记录：回合结束且缓冲 ≥300 字符时抽取一次（会话空闲 8 分钟是兜底），面板显示上次检查时间与原因
- 自动整理：生效记忆 ≥8 条、距上次 ≥7 天、无待处理建议时，在本轮结束后后台跑一次两步法整理；状态持久化，重启不复位
- 时效：`expires_at` 过期不注入并标「已过期」；超 90 天未确认标「待复核」，可续期；记录使用次数与最近使用时间
- 会话控制：`/memory on|off|status`（存库，重启有效）
- 导出：Markdown（面板一键下载，含已失效历史）
- 8 个 MCP 工具（`plugin/` 侧 7 个 + 自动注入；MCP 多一个 `memory_context`）：save / search / list / get / update / forget / history / context
- 数据：`$DSH_HOME/agentmemory/memory.db`，schema v8（v8 加 `turn_trace`：每轮注入了什么、新增了几条）
- 独立形态：`server/http.js` 起记忆面板（端口 7788）；默认读 `server/demo.db`，可用 `AGENTMEMORY_DB` 指向真实库；`server/mcp.js` 暴露 8 个 MCP 工具（库默认 `~/.agentmemory/memory.db`）
- Trae 接入：`mcp.json` 里配 `AgentMemory`，项目级 `.trae/hooks.json` 的 `UserPromptSubmit` 负责自动注入（读）；写入仍需模型调用 `memory_save`
- 测试：89 个插件用例（34 store + 14 capture + 13 dream + 3 export + 7 lifecycle + 6 retrieval + 5 session-text + 7 block）+ 6 个引擎用例（`node server/test/engine.test.js`）

## 已验证 / 未验证

| 项 | 状态 |
|---|---|
| 插件安装与激活、Host 侧工具注册 | ✅ 已验证（Inspect 可见 7 个工具；MCP 侧另加 `memory_context` 共 8 个） |
| `agentmemory:core` 注入 | ✅ 上次对话的 system-reminder 里就是注入结果 |
| 侧栏入口 + 主面板 slot 注册 | ✅ Inspect 显示 `sidebar.panellist` 有 `agentmemory`、`main` 有 key `agentmemory` |
| 增删改查 / 恢复 / 版本 / 中文检索（HTTP 层） | ✅ 已用真实请求跑通 |
| 版本历史回滚 | ✅ 实测 create→A→B→回到 A→回到 create，原文完整恢复 |
| 概览生成 | ✅ 实测 2s 返回 183 字，模型 `deepseek-account/deepseek-flash` |
| 概览失效 | ✅ 加一条记忆 → stale=true；删掉它 → stale 回到 false（哈希回到原值） |
| 摘要注入 | ✅ 最后一条 prompt 里长记忆只显示 40 字摘要；面板读数 212 字符 vs 全文 234 |
| store 单测 | ✅ 89/89 通过（含时效/复核、Git 项目归一、会话开关、整理聚类、回合轨迹、双块预算） |
| 双块注入 | ✅ system-reminder 里同时出现【长期记忆·用户】与【长期记忆·本项目】；`state.injection = {chars:294, entries:4, projectChars:101, projectEntries:1}` |
| 回合记忆栏 | ✅ `Slots.listSubTree` 见 `agentmemory-turn-tail`（order 30）；`GET /api/agentmemory/turn` 返回真实 trace |
| 手动存入 | ✅ 按 messageId 从会话日志取正文，`POST /save` 落库；含 `password=` 的文本被拒 |
| 自动整理闸门 | ✅ 三道门（条数/间隔/待处理建议）+ `meta` 持久化，均有单测 |
| 记忆面板 | ✅ 列表 / 详情 / 编辑 / 软删 / 恢复 / 版本链 / 变更历史 / 注入预览 / 导出，浏览器实测通过 |
| MCP server | ✅ Trae CN 实连：8 个工具、读写共享库、`initialize.instructions` 下发、密钥写入被拒（`isError`） |
| 注入带 id | ✅ 本轮 system-reminder 每条前缀 `[m_xxxx]`；注入 352 字符（全文 393） |
| `memory_get` | ✅ 按 id 取回全文与元数据 |
| 过期不注入 | ✅ 标记过期后 `expired=true`（注入过滤由单测覆盖，下一轮生效） |
| 导出 Markdown | ✅ `GET /api/agentmemory/export` 返回 `text/markdown`，582 字节 |
| 立即提取 | ✅ `POST /api/agentmemory/flush` 返回 ok |
| 按问题检索 | ✅ 「我毕设做到哪一步了」命中 2 条 142 字符；「机器学习」0 条不注入 |
| 整理建议的模型质量 | ⚠️ 结构可用，但 `deepseek-flash` 在 6 条记忆上倾向返回 `{"ops":[]}`，需要更强模型或分组式提示词 |
| 面板的视觉呈现 | ✅ 网页面板已浏览器实测（列表 / 详情 / 版本链 / 注入预览）；DSH 侧栏面板仍待人工过一遍 |
| 子代理隔离、compaction 后自愈 | ⬜ 未验证；多进程并发写 ✅ 已验证（2×2000 条零 `SQLITE_BUSY`，见 `eval/concurrency.mjs`） |

## 下一步

1. 在第二个 MCP 客户端（Claude Code 或 Cursor）里连一次，确认 `memory_context` 的调用时机与 token 成本 —— Trae CN 已实连。
2. 把 `eval/report.md` 的指标写进论文「实验」一节：A 组替换正确率 100%、旧值残留 0；B 组跨会话召回 85%（17/20）；平均注入 95 字符。
3. DSH 侧栏面板视觉人工过一遍，截图放论文（网页面板已完成）。
4. 概览生成并入后台整理批处理，避免两处各调一次模型。
5. 开源前做路径脱敏：HANDOFF.md、docs/mcp-clients.md 里的本机绝对路径仍在。
