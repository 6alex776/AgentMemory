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
- 模型可调用 `memory_save` / `memory_search` / `memory_list` / `memory_update` / `memory_forget` / `memory_history`。
- 数据在 `$DSH_HOME/agentmemory/memory.db`（单文件 SQLite，WAL）。

改 `plugin/` 下的 Host 代码后，用插件管理开关一次（或重启）让新模块生效；只改 `client.js` 则刷新页面即可。

---

## 三种运行形态

**1. 独立网页演示（不需要 DSH，也不需要模型）**

```bash
cd server && npm start          # 或 node server/http.js
# → http://127.0.0.1:7788/
```

首次启动会在 `server/demo.db` 里写入 8 条演示记忆（身份 2 条、项目 6 条）。页面上的「抽取」是演示用的规则抽取器（命中 `把 A 从 B 换成 C` 这类句式），真实部署里这一步由模型的抽取提示词完成；面板上直接写了这句说明，不要假装它是模型。

**2. MCP server（Claude Code / Cursor / Codex / Gemini CLI…）**

```bash
node server/mcp.js              # stdio，JSON-RPC 2.0
curl -X POST localhost:7788/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 或 HTTP
```

数据库默认 `~/.agentmemory/memory.db`，可用 `AGENTMEMORY_DB` 覆盖；项目归属用 `AGENTMEMORY_CWD` 或每次调用传 `cwd`。暴露 6 个工具：`memory_context` / `memory_save` / `memory_search` / `memory_list` / `memory_history` / `memory_forget`，定义在 [server/tools.js](server/tools.js)，stdio 与 HTTP 共用一份。

各客户端的具体配置（含「必须用绝对路径指向 Node ≥22.5」这个坑）见 [docs/mcp-clients.md](./docs/mcp-clients.md)。

**3. DSH 插件**（下面「快速开始」那节）

---

## 演示脚本（3 分钟）

1. 打开演示页。左栏是**两个互不相干的会话**，右栏是记忆库（8 条）。
2. 点会话 A 的「发送」：句子里把数据存储从 PostgreSQL 换成了 ClickHouse。
   - 页面显示「抽取出：决策 · 槽位 `tech.datastore`」；
   - 结果标记是**替换**，不是新增：旧值划掉、新值生效；
   - 右栏那一组的条目已经变成 ClickHouse，旧条目进了版本链（点「项目」里任意条目可展开）。
3. 在会话 B 输入「我们的数据存储用什么？」点「提问」：会话 B 从没参与过上面的对话，但它的注入块里第一行就是 ClickHouse。**记忆存在会话之外**，这就是跨会话。
4. 再问「行情数据是怎么模拟的？」：这一条重要度只有 2，进不了常驻的项目块，只在**检索块**里出现——三段注入的分工当场可见。
5. 点「重置演示」可以回到初始状态，重复讲。

讲的顺序建议：先讲「替换」再讲「跨会话」，最后讲「预算怎么切」。评审最容易记住的是第 2 步那张「旧值划掉、新值生效」。

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
│  ├─ http.js           独立 HTTP 服务 + 演示 API（端口 7788）
│  └─ mcp.js            MCP stdio server（JSON-RPC 2.0）
├─ demo/index.html      独立演示页（两个会话 + 记忆库 + 版本链）
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
- 7 个记忆工具：save / search / list / get / update / forget / history
- 数据：`$DSH_HOME/agentmemory/memory.db`，schema v8（v8 加 `turn_trace`：每轮注入了什么、新增了几条）
- 独立形态：`server/http.js` 起演示页（端口 7788，库在 `server/demo.db`）；`server/mcp.js` 暴露 6 个 MCP 工具（库默认 `~/.agentmemory/memory.db`）
- 测试：89 个插件用例（34 store + 14 capture + 13 dream + 3 export + 7 lifecycle + 6 retrieval + 5 session-text + 7 block）+ 6 个引擎用例（`node server/test/engine.test.js`）

## 已验证 / 未验证

| 项 | 状态 |
|---|---|
| 插件安装与激活、Host 侧工具注册 | ✅ 已验证（Inspect 可见 7 个工具） |
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
| 独立演示页 | ✅ API 全链路（seed → 替换 → 跨会话注入 → 版本链）；⚠️ 页面视觉未人工确认（此环境没有浏览器控制） |
| MCP server | ✅ `initialize` / `tools/list` / `save` / `context` / `search` 走通；⚠️ 还没在真实 MCP 客户端里连过 |
| 注入带 id | ✅ 本轮 system-reminder 每条前缀 `[m_xxxx]`；注入 352 字符（全文 393） |
| `memory_get` | ✅ 按 id 取回全文与元数据 |
| 过期不注入 | ✅ 标记过期后 `expired=true`（注入过滤由单测覆盖，下一轮生效） |
| 导出 Markdown | ✅ `GET /api/agentmemory/export` 返回 `text/markdown`，582 字节 |
| 立即提取 | ✅ `POST /api/agentmemory/flush` 返回 ok |
| 按问题检索 | ✅ 「我毕设做到哪一步了」命中 2 条 142 字符；「机器学习」0 条不注入 |
| 整理建议的模型质量 | ⚠️ 结构可用，但 `deepseek-flash` 在 6 条记忆上倾向返回 `{"ops":[]}`，需要更强模型或分组式提示词 |
| 面板的视觉呈现 | ⚠️ 需要刷新页面人工确认（当前环境没有浏览器控制） |
| 子代理隔离、多进程写并发、compaction 后自愈 | ⬜ 未验证 |

## 下一步

1. 在真实 MCP 客户端（Claude Code / Cursor）里连一次 `server/mcp.js`，确认 `memory_context` 的调用时机与 token 成本。
2. 评测脚本：自建中文语料（20 组「旧值→新值」+ 20 组跨会话指代），量三个数——替换正确率、跨会话召回、注入字符数；论文「实验」一节要用。
3. 页面视觉人工过一遍（演示页 + DSH 面板），把截图放进论文。
4. 概览生成并入后台整理批处理，避免两处各调一次模型。
