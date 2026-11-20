# AgentMemory 技术调研与 API 验证报告

> 版本：v2（2026-11-19）
> 目的：落实你列出的第 1–4 项与第 6 项工作，并把「已验证的事实」和「尚属推断的判断」分开。
> 配套：[DESIGN.md](./DESIGN.md)（V1.0 架构与数据库设计、分阶段计划）
> 证据口径：本机运行中的 DSH 0.2.2-rc.5（`E:\DeepSeek Harness\resources\app.asar\dsh\`）、Node v22.22.1、SQLite 3.51.2、`dsh-plugin-memory` **0.20.0**（npm tarball 解包于 `.tmp/pkg/package/`）。

---

## 0. 先说结论：三条会改变方案的发现

| # | 发现 | 影响 |
|---|---|---|
| 1 | 参照插件已经从 v0.7.2 走到 **v0.20.0**，注入方式**不再是 `agent/pre-step`**，而是 `ctx.systemPrompt.context()`；记忆写入**不再注册 7 个工具**，而是注册一个 **skill**，让模型用普通文件工具改 Markdown | 旧设计文档里「照搬它的 pre-step 注入 + 7 个工具」的结论已过期。我们应借鉴它的**注入通道选择**，但保留自己的工具化写入（可控、可测、可审计） |
| 2 | DSH 的 `systemPrompt.context()` 产物是**一条会 supersede 旧版本的 user-role 快照**，宿主按投影去重；但**内容一变就会改写前缀** | 「稳定核心块」放 context 是一个近乎免费的方案；「每轮变化的检索块」**不能**放 context，否则每轮废掉 KV cache。检索块必须走 inbox / pre-step 尾部 |
| 3 | FTS5 的 `trigram` 分词器**只对 ≥3 字符的查询有效**；中文双字词（「湖仓」「毕设」）命中为 0。实测「大字符二元组（bigram）影子列 + unicode61」可以用 bm25 正常排序 | 数据库设计要加一列 `search_text`，中文检索不再依赖 `LIKE` 兜底（兜底无排序） |

另外两条次级修正：

- `scope` 只保留 `global` / `project` 两值，`episodic` 不是 scope 而是 `kind`（旧文档已改对，此处确认）。
- 参照插件已有 **graph / timeline / insights / growth / 主动唤醒** 等一整套 UI 与「人格化」功能；「有 Dreaming」不再构成差异点，**槽位化更新 + 版本链 + 可回滚 + 可评测**才是。

---

## 1. 方法与证据等级

| 等级 | 含义 | 本报告中的例子 |
|---|---|---|
| A | 在本机运行中的 DSH 上通过 Inspect 直接读到契约 | `agent/pre-step` 的 waterfall 签名、`sessionPersistence` 的 `list/open/read` |
| B | 在本机 ASAR 内读到该版本源码/README | `systemPrompt.context()` 生成 snapshot 的实现（`src/index.ts:78,324,589`） |
| C | 在本机实际跑通的可执行验证 | `node:sqlite` + FTS5 + trigram/bigram 的命中对比 |
| D | 第三方源码阅读 | `dsh-plugin-memory` 0.20.0 的 `lib/*.js` |
| E | 外部公开资料（厂商博客、媒体报道） | OpenAI Dreaming 公告与其转述 |

凡标 D/E 的，不当作 DSH 行为依据；凡我没验证的，会在文中写「未验证」。

---

## 2. DSH 接入面核验（A/B 级）

### 2.1 注入通道：三个候选，各有明确语义

| 通道 | 契约 | 产物 | 适用 |
|---|---|---|---|
| `ctx.systemPrompt.context({name, order, text})` | `PromptContext`，`text` 可为 `(context) => string`，每次装配求值（`dsh-system-prompt/src/index.ts:78-90`） | **durable user-role 快照**，整块渲染为 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`（`:309-325`） | 稳定、量小、需要模型「一直看得见」的事实 |
| `agent/pre-step` waterfall | `payload: {agent, messages, turn, step, signal, modelSelection}`，返回 `{kind:'reject'} \| {kind:'enter', messages, startsRequestSeries?}` | 进入本步的**用户消息批次**，参与本步日志 | 每轮变化的检索结果、按问题注入 |
| `agent.inject()` / `agent.followup()` / `agent.steer()` | `inject` 不唤醒 driver、落到下一个被接纳的 step；`followup` 唤醒并起新一轮；`steer` 进入下一步（`dsh-agent/README.md:58-70`） | inbox → 日志里的 user-role 消息，`source.kind` 由产出方声明 | 后台补投、主动提醒 |

**关键细节（决定方案）**：

1. `systemPrompt.context` 的文本在**装配时**求值，但在**请求准入前**还会经过 `refreshContext()` 刷新（`dsh-system-prompt/src/index.ts:589-609`；README:68）。也就是说「变更的事实放 context provider」是被官方推荐的用法。
2. 快照是 **supersede 语义**：同一 block 的新文本替换旧快照，旧版本仍在日志里可追溯（README:102）。参照插件据此把「不重复注入」交给宿主，自己只在 `bootSnapshot: 'session'` 时冻结文本（`lib/index.js:375-380`）。**推断**（需 Phase 0 验证）：内容不变时不产生新快照，因此不必自建逐字哈希比对——这是 v0.7.2 时代的手工活。验证方法见 §9 第 1 条。
3. 但 README 的 KV Cache 一节写得很清楚：文本、顺序、工具集任一变化都可能从第一个变化 token 起失去前缀复用（README:156,170）。参照插件为此加了 `bootSnapshot: 'session'`（`lib/index.js:162-164,481-489`），把 boot 块冻结在会话内，只把「最近动态」拆到 order 900 的独立尾部（`lib/boot.js:28-44`）。
4. `agent/pre-step` 的 enter 分支要求**完整、已标识、冻结的消息批次**（`dsh-agent/README.md:98`）；改写时必须 spread 原 decision 以保留 `startsRequestSeries`（`references/practices.md:16`）。
5. 消息 `source.kind` 在 session format v4 中必须是**产出方自有的 kind**；参照插件用 `{kind:'plugin:memory'}`（`lib/digest-guard.js:103-107`）。这意味着我们可以让注入的检索块带 `plugin:agentmemory` 标记，从日志层面与真实用户消息区分开。

> **已确认（B 级）**：`AssembleContext` 的类型虽只声明 `scope` 与 `signal`（`dsh-system-prompt/src/index.ts:42-50`），但它是 merge-extensible 的；`dsh-agent/src/dispatch.ts:174-176` 的 `assembleContextFor(agent, signal)` 明确返回 `{ agent, scope: agent, signal? }`。参照插件直接读 `context.agent`（`lib/index.js:463`）与此一致。
> **剩余风险**：不是每个装配都由某个 agent 发起（例如全局预览）；`context.agent` 可能为 `undefined`，所以取用必须判空并降级。

### 2.2 生命周期与后台触发（A 级）

| 事件 | 模式 | 我们的用法 |
|---|---|---|
| `turn/end`（`session/event` 里 `event.data.reason.kind`） | emit | 一轮正常结束（`completed`）后入队整理任务；`aborted/error` 不入队 |
| `agent/turn-stopping` | serial | 参照插件用它做「digest 提醒」的时机（`lib/digest-guard.js:9-13`）；我们只观测，不阻塞 |
| `session/event` | emit | 通用增量入口；注意它是 post-commit、fire-and-forget |
| `agent/created` / `agent/disposed` | serial / emit | 绑定每会话状态；**必须 try/catch**，参照插件在注释里明确写了「在 serial listener 里抛错会让 agent 注册失败、每个会话都不可用」（`lib/index.js:276-280,571-573`） |
| `compaction` 相关 | — | 压缩会改写 surface；判断「模型还看得见吗」必须以 surface 为准，不能以「注入过」为准 |

`turn/end` 的 reason 枚举已确认：`completed / aborted / blocked / error / max-tokens / interrupted / forked`（Inspect `Service.listService('sessionPersistence')` 的 `TurnEndReasonMap`）。

### 2.3 历史会话读取（A 级，且是差异化关键）

`ctx.sessionPersistence`：

- `list(options?)` → `SessionPersistenceSnapshot[]`，含 `header`、`eventCount`、`sizeBytes`、`location`。
- `open(id, 'read')` → `SessionHandle`；`read(offset?, length?)` → `{eventState, events}`；`flush()` 是持久化屏障；`close()`。
- `SessionHeader` 含 `id / version / createdAt / cwd? / parentSession? / isSeeded / origin?: 'subagent' / delegationDepth? / agentPreset?`。

这三条支撑了参照插件**完全没有**的能力：跨会话、跨进程重启地做增量整理。判断子代理用 `header.origin === 'subagent'`（或 `parentSession` 存在），比 `agent.session.header` 更可靠。

### 2.4 工具与命令、技能（A 级）

- `ctx.tools.register(definition, options?)` → disposer；还有 `restrict()` / `guard()` / `schemas()` / `execute()`。工具是**最可控**的写入面：可校验参数、可返回结构化错误、可做 `isConcurrencySafe`。
- `ctx.commands.register({name, description, handler})`：`/memory` 这类**人类命令**走命令面，不进模型上下文（参照插件 `lib/index.js:541-556`）。
- `ctx.skills.register({name, description, whenToUse, content, resourceBase})`：把「记忆操作协议」作为技能注入。优点是零工具 schema 开销，缺点是**写入不可控、不可测试**（全靠模型自觉按 Markdown 规范改文件）。

### 2.5 配置与打包（B 级；设置面板结论来自参照插件源码，D 级）

- `Config = z.object({...})` + `cordis.patch.yml` 声明行；可热更新字段要 `.volatile()`。参照插件自己实现了一个 `MemoryConfigStore`（写 `<dshHome>/memory.json`）并把设置页配置走**自己的 HTTP 路由**，原因写在 `lib/index.js:22-27`：设置面板的 wire 只服务硬编码命名空间白名单，插件命名空间不可远程写。这是一个重要的接入事实，V1 若要设置页需要照做或只读。
- 安装：`plugin_manager install_bundle` 从工作区目录安装；profile 的 `node_modules` 只放已安装 bundle。**pnpm 10 默认拒绝执行依赖构建脚本**，所以带原生编译的依赖（better-sqlite3、sqlite-vec）会显著抬高门槛——这仍是选择 `node:sqlite` 的核心理由。

---

## 3. 运行时验证（C 级，本机实跑）

### 3.1 SQLite 能力

```
node v22.22.1 / SQLite 3.51.2
CREATE VIRTUAL TABLE ... USING fts5(...)                     OK
CREATE VIRTUAL TABLE ... USING fts5(..., tokenize='trigram') OK
bm25()                                                       OK
PRAGMA busy_timeout 默认 0（必须自己设）                      ← 新发现
```

### 3.2 中文检索：trigram 的边界（实测表）

语料：`用户是计算机专业学生，正在做金融湖仓一体的毕业设计，技术栈是 Flink + Iceberg`

| 查询 | trigram | bigram 影子列 | LIKE |
|---|---|---|---|
| `毕业设计`（4 字） | 1 | 1 | 1 |
| `湖仓`（2 字） | **0** | **1** | 1 |
| `职业方向` | 1 | 1 | 1 |
| `Java` | 1 | 1 | 1 |
| `AgentMemory` | 1 | 1 | 1 |
| `记忆`（语料里没有） | 0 | 0 | 0 |

结论：

1. `trigram` 对 <3 字符的查询一律为 0（SQLite 文档的既定行为，本机复现）。
2. **bigram 影子列**方案：写入时把每个 CJK 连续串展开为重叠二元组（`湖仓一体` → `湖仓 仓一 一体`），ASCII 按整词小写保留；查询侧同一函数展开。实测 2 字查询可命中，`bm25()` 排序正常（越低越相关）。
3. 代价：多一列、多一次预处理、索引体积约与正文同量级；对 10³–10⁴ 条记忆可忽略。
4. `LIKE '%q%'` 仍可作为最终兜底（例如 1 个字、或用户输入带非常规字符），但它**没有排序**，只能排在 bigram 命中之后。

> 这条推翻了旧设计「V1 用 trigram + LIKE 回退」的取舍：LIKE 回退对中文双字词是**主路径**而不是边角，会直接拉低检索质量。V1 就应该用 bigram 影子列。

### 3.3 数据库 schema 实跑验证（C 级）

把 DESIGN.md §3.3 的建表脚本原样喂给 `node:sqlite` 跑通，并逐条验证约束（脚本：`.tmp/schema.sql` + `.tmp/schema-check.mjs`）：

| 验证项 | 结果 |
|---|---|
| 建表 + 表达式部分唯一索引 + `STRICT` | 通过 |
| 同槽位插第二条 active | 被 `memory_slot` 唯一索引拒绝 |
| 同槽位同内容重复插入 | 被 `memory_dedupe` 唯一索引拒绝 |
| `scope='project'` 但 `project_id` 不存在 | 被外键拒绝 |
| `scope='global'` 与 `project_id` 互斥 | 被 CHECK 拒绝（插入时即报错） |
| FTS 触发器：插入后「湖仓」命中 | 1 条 |
| FTS 触发器：改 `search_text` 后新词命中、旧词残留 | 新词 1，旧词 0 |
| `bm25()` 排序 | 正常（负值，越小越相关） |

**过程中修掉的一个真 bug**：普通 FTS5 表（非 external-content）不能用 `INSERT INTO fts(fts,rowid,...) VALUES('delete',...)` 删除，会报 `SQL logic error`；必须用 `DELETE FROM memory_fts WHERE rowid = old.rowid`。这个坑不跑一遍是发现不了的，已写进脚本与设计文档。

### 3.4 其它实测

- `PRAGMA journal_mode=WAL`、`STRICT` 表、部分唯一索引均可用。
- 部分唯一索引可用于「同槽位只允许一条 active」，但要注意 `NULL` 的语义（用 `ifnull(...)` 包裹）。
- `node:sqlite` 仍标 experimental；只在 `db/open.js` 一处 import，其余层不感知。

---

## 4. 参照插件 `dsh-plugin-memory` 0.20.0 拆解（D 级）

### 4.1 形态与规模

```
lib/index.js        1167 行  装配、Config、路由、守卫、命令
lib/client.js       3210 行  Web 客户端（设置页/面板，唯一浏览器半）
lib/index-page.js    420 行  index.md 规划
lib/recall-nudge.js  417 行  空闲时主动回忆（人格化）
lib/graph*.js        959 行  记忆图谱（graph + 3d + layout + drag + view + search）
lib/boot.js          332 行  boot 块渲染 + 预算分配
lib/insights.js      289 行  健康看板数据
lib/scaffold.js      277 行  目录骨架与模板
lib/soul.js          276 行  SOUL.md 画像
lib/session-gate.js  232 行  全局/会话/workspace 三层门控
lib/digest-guard.js  228 行  「该沉淀了」提醒
lib/autocommit.js    203 行  git 自动提交
lib/...              其余 20 个模块
```

（行数为 `split('\n').length - 1` 的精确值；PowerShell `Get-Content` 在此环境会少算，别用。）

存储：纯 Markdown + git，目录默认 `~/.memory`，文件为 `SOUL.md / MEMORY.md / index.md / log.md / topics/*.md`。

逐模块的职责、导出与副作用见 [docs/plugin-module-map.md](./docs/plugin-module-map.md)（19 个模块，含 `skills/memory.md` 的四步协议与校验对齐、recall-nudge 的决策链、proactive-lock 的跨插件仲裁、session-gate 的四层优先级与 TTL、paths/reveal 的越界校验、config-store 的原子写）。

顺带发现它自己的三处「文档—实现」不一致，正好说明「靠提示词约束模型写文件」这条路的脆弱性：

- index 摘要模板写 80 字，代码硬上限是 48（`scaffold.js:159` vs `index-page.js:40`）；
- `skills/memory.md:20` 有一处字面 `\n`，破坏列表结构；
- digest 提醒的判据仍写 `source.kind === 'plugin'`，实现早已改成 `plugin:memory`（`recall-nudge.js:118-121`）。

这三处都不是「模型不听话」，而是**协议存在于自然语言里、没有类型与测试钉住**。这正是我们把写入做成工具而不是 skill 协议的理由。

### 4.2 它做对的五件事（值得借鉴）

| 设计 | 证据 | 为什么 |
|---|---|---|
| **注入走宿主快照，不自建去重** | `index.js:451-514` 注册两个 context（order -200 / 900） | 快照 supersede 由宿主负责，插件不用维护「上一次注入的哈希」 |
| **稳定块与会变块分离** | `boot.js:28-44` + `index.js:497-514` | 把易变内容放尾部，前缀缓存损失最小 |
| **会话级冻结开关** | `index.js:162-164`（`bootSnapshot: 'session'`） | 承认「live 重读会破坏前缀缓存」，把选择权交给用户 |
| **按字符预算分配，index 优先** | `boot.js:129-199` `allocateBootBudget` | 小文件不吃空额度；截断落在长文件而不是索引；用字符不用字节（CJK 3 字节） |
| **人工命令 + 会话级开关** | `index.js:541-556`、`session-gate.js` | 用户能 `/memory off`，也能按 workspace 默认关闭；记忆系统必须可关 |

### 4.3 它必须被改掉的六件事（我们的差异点）

| 问题 | 具体表现 | AgentMemory 的改法 |
|---|---|---|
| **没有「当前值」** | 事实并列在 Markdown 里，改职业方向只能新加一条或让模型自己删旧的 | `topic_key` 槽位 + `supersedes_id` + 版本链，冲突判定下沉到存储层 |
| **写入不可控** | 协议靠 skill 文本 + 模型自觉改文件；没有 schema 校验、没有事务、没有审计 | 工具化写入（`memory_save` 等）+ 同事务写 `memory_version` |
| **无跨会话整理** | 整理只看当前会话的日志尾部 | `sessionPersistence` 增量 + `session_cursor` 水位线 |
| **无检索** | 全量注入 + 关键词 `includes` | FTS5 bigram + 结构化过滤 + 时间/重要度重排 |
| **无版本/无墓碑** | 删就是删；A 删掉的条目，持有旧上下文的 B 可能写回来 | 软删除 + 版本审计 + `deleted` 参与去重 |
| **进程内弱一致** | 目录锁 + 最后写胜 | WAL + `busy_timeout` + 单写队列 + 事务内乐观校验 |

### 4.4 它的 UI 说明了什么

审阅细节见 [docs/plugin-ui-analysis.md](./docs/plugin-ui-analysis.md)（270 行，逐行给出证据）。结论：

- 真正的客户端只有 `lib/client.js` 一个文件：**3210 行 / 151 KB**，纯 JS 零构建、手写 `React.createElement`，只 `require('react')`，用 `window.__ModuleLoader__.load` 注册，占 `settings.section` 与 `conversation.input.left` 两个 slot。
- 其余 15 个 `lib/*.js` 都是 host/CLI 模块；其中 5 个纯数学模块被**逐行内联**进 client.js（因为浏览器半只能拿到平台种子）。
- 数据全部走 **9 条自建同源 HTTP 路由**（`/api/memory/config|insights|graph|timeline|control|session|soul|reveal|path`），无 Remote service、无工具调用；客户端零持久化。
- 能力边界：配置台 + 只读可视化（健康看板、3D 图谱、时间轴）+ 会话开关。**没有**记忆页编辑、没有版本历史、没有回滚、没有待确认提案。
- 维护成本实测：单文件巨型、client API 硬契约、DOM label 抢注侧栏图标、5 处手工内联副本、无类型检查、9 条路由无 schema、文档已漂移（文档称 17 个热键，面板只 POST 14 个）。

对我们的含义：

1. V1 不做面板这个决定是对的——参照实现的 UI 规模是 3210 行，而它连「编辑记忆」都没做。
2. 若 V1.5 做只读评审页，可复用的只有 5 个模式（`SectionBoundary` 失败隔离、草稿态提交、locale Context、轮询保帧、四级降级链）；「编辑/版本/回滚」**没有现成先例**，要自己设计 host 路由与并发控制。
3. 它刻意避开了写接口（9 条路由里写操作只有「改配置」和「改 SOUL 三字段」），这是它没有审计负担的原因；我们的写入是核心功能，必须自带版本与事务。

### 4.5 版本漂移提醒

你给的仓库是 `justhalfbit/dsh-plugin-memory`，而 npm 包里 `package.json` 的 `repository` 指向 `LittleBlackTong/dsh-plugin-memory`（可能是改名/镜像）。**以 npm tarball 的代码为准**，不要按旧博客或旧版本行号引用。`CHANGELOG.md` 显示 2026-11 仍在快速迭代（0.18 → 0.20）。

---

## 5. ChatGPT Memory / Dreaming 的公开资料（E 级，仅借鉴产品行为）

来源：[OpenAI 公告（2026-06-04）](https://openai.com/index/chatgpt-memory-dreaming/)、[繁体中文版](https://openai.com/zh-Hant/index/chatgpt-memory-dreaming/)、[IT之家转述](https://www.ithome.com/0/960/187.htm)、[Impress Watch](https://ai.watch.impress.co.jp/docs/news/2114939.html)。

公开可确认的事实（不含内部实现）：

1. **时间线**：2024-04 上「saved memories」（依赖用户说「记住」）→ 2025-04 引入 Dreaming 作为补充 → 2026-06-04 的 Dreaming V3 成为主架构。
2. **三条质量标准**：延续有用上下文、遵循用户偏好与约束、**随时间自动更新**。第三条正是我们 `topic_key` + `superseded` 要解决的问题。
3. **时间感知更新**：公告里的原话示例是「你七月要去新加坡」在旅行结束后被改写为「你 2026 年七月去了新加坡」。这说明它存的是**可被时间修订的断言**，不是流水账。
4. **后台合成**：在不使用 ChatGPT 时后台分析历史对话，合成「记忆状态」，而不是逐条追加。
5. **用户可见与可改**：记忆以摘要形式展示在记忆摘要页，用户可补充/修改资料、指定「哪些话题在什么场景提」，也可追问细节。
6. **规模与成本**：官方称服务 Free 用户所需的算力降到约 1/5；Plus/Pro 记忆容量翻倍。
7. **效果数字**：媒体报道的事实召回 67.9% → 82.8%、偏好遵循 55.3% → 71.3%（**二手，未见官方原文表格，引用时须注明**）。

**不能说的**：OpenAI 没有公开其抽取提示词、存储 schema、冲突判定算法、调度策略。任何「复刻其内部实现」的说法都不成立。我们能借鉴的是**产品行为契约**：后台合成、时间感知修订、摘要可读、用户可纠正、成本可控。

对我们的直接启示：

- 「记忆」应是**一份持续维护的当前状态**，而不是事件流；事件流只是它的来源（对应我们的 active 行 + 版本链）。
- 「过期」不是删除，而是**语义改写**（`going to` → `went`）；这需要 `valid_from/valid_to` 与 `supersedes`。
- 用户可见的摘要页是**信任机制**，不是装饰；V1 至少要有 `memory_list` 与导出。

---

## 6. 与参照插件的能力对照（更新到 0.20.0）

| 能力 | dsh-plugin-memory 0.20.0 | AgentMemory V1 | V1.5 | V2 |
|---|---|---|---|---|
| 持久化 | Markdown + git | SQLite（WAL） | 同 | 同 |
| 作用域 | 仅项目（按 memoryDir） | 全局 + 项目 | 同 | 同 |
| 写入面 | skill 协议 + 文件工具 | 工具（校验/事务/审计） | 同 | 同 |
| 冲突处理 | 靠模型自觉 | `topic_key` 槽位 + supersede | 同 | 语义辅助 |
| 版本/审计 | git 历史 | `memory_version` 全量 | 同 | 同 |
| 检索 | 全量注入 + includes | FTS5 bigram + 重排 | 同 | 混合检索 |
| 注入 | systemPrompt.context 快照 | context 核心块 + inbox 检索块 | 同 | 同 |
| 跨会话整理 | 无 | 无 | `sessionPersistence` 增量 | 同 |
| 人工保护 | 无（文件可被模型改） | `pinned` + `origin` 硬规则 | + 提案审核 | 同 |
| 管理界面 | 3210 行客户端 + 9 条路由（只读 + 配置写） | 工具 + 导出 | 可选只读页 | 审核页 |
| 额外功能 | 图谱/时间线/洞察/growth/主动唤醒 | — | — | — |
| 评测 | 无 | 单元 + 注入快照 | + 抽取金标 | + LongMemEval 式子集 |

---

## 7. 实现跨会话全局记忆必须解决的 DSH 接入问题（更新版）

1. **没有账号体系**：DSH 无用户身份，「全局记忆」的边界只能是 `$DSH_HOME`（单机）。多机同步要么自己造，要么明确不支持。
2. **项目键是 cwd**：同一仓库的不同子目录会分裂；`project` 表要存 `root_path` 并支持别名/合并，不要用目录名派生哈希。
3. **注入时机**：`systemPrompt.context` 会在**每次装配**求值（含没有用户消息的步骤）；必须自己判断「该不该注入」，否则空会话也会带记忆、且可能干扰标题生成等内部调用。
4. **KV cache**：稳定块放 context、易变块放尾部/inbox；`order` 要固定；不要在渲染里放时间戳或随机数。
5. **compaction**：一次注入过不等于模型还看得见；判据必须是 surface，且压缩后要能**自愈补投**。
6. **后台任务生命周期**：`ctx.effect` 返回 disposer + `AbortController`；后台异常只能 `logger.warn`，绝不能冒泡到 agent loop。
7. **配置热更新**：`Config` 字段 `.volatile()`；用户手写 `cordis.patch.yml` 是**整行替换**，文档要写清楚；插件自己的设置页需要自定义 HTTP 路由（见 §2.5）。
8. **打包**：`files` 必须包含 `cordis.patch.yml`；零构建、无原生依赖，否则用户要开 `allowBuilds`。
9. **会话格式演进**：不要自己解析会话文件；只用 `sessionPersistence` 契约。参照插件在注释里记录了 session format v4 的 source kind 变更（`digest-guard.js:103-107`）。
10. **多 profile / 多进程**：同一 `$DSH_HOME` 下 web 与 headless 可能同时写同一库；接受「最后写胜 + 事务重试」，并写进文档。
11. **子代理**：`header.origin === 'subagent'` 的会话不应写入全局记忆，也不应触发整理；否则子代理的临时上下文会污染用户画像。
12. **模型选择**：整理用的 LLM 应与聊天模型解耦（可单独指定 provider/model），否则用户换模型时后台成本不可预期。

---

## 8. 对 DESIGN.md 的修正清单

| 旧结论 | 现状 | 处理 |
|---|---|---|
| 注入用 `agent/pre-step` | 参照插件改走 `systemPrompt.context`；宿主负责快照 supersede | 核心块用 context；检索块用 pre-step/inbox |
| 需要自己实现「可见面摘要去重」 | 宿主已按投影去重；剩余问题是「prefix cache」而非「重复注入」 | 删掉自建哈希比对，改为「稳定块 + 会话冻结 + 尾部易变块」 |
| 中文检索 trigram + LIKE 回退 | trigram 对 2 字词完全无效，LIKE 无排序 | 改为 bigram 影子列（实测通过） |
| 参照插件 v0.7.2，5 个文件 | v0.20.0，30 个模块 + 3210 行客户端 | 更新拆解章节与对照表 |
| 「有 Dreaming」是差异点 | 生态里已有多个实现；参照插件有图谱/时间线 | 差异点改为「槽位化更新 + 版本链 + 可回滚 + 可评测」 |
| V1 不做 Web UI | 仍然成立，但理由更硬：参照插件为此写了 3210 行 | 保留，并给出 V1.5 的进入条件 |

---

## 9. 仍然未验证、需要在 Phase 0 打掉的点

1. **`systemPrompt.context` 在文本不变时是否真的不产生新快照**——这决定核心块的缓存成本。验证方式：同一会话连续两轮，比对日志里 runtime-context 节点的 seq 与 `surfaceOp`；只读两条 seq 即可，不需要长会话。
2. 非 agent 发起的装配（若存在这类调用）是否会执行 context provider；若会，必须保证此时不注入、且不发生 DB 查询。
3. 在 `agent/pre-step` 里追加带 `source.kind='plugin:agentmemory'` 的消息，是否被 session format 接受、UI 是否显示为普通用户消息。参照插件的 digest nudge 用的是 `followup`，不是 pre-step 追加；**这条必须实测**。
4. 注入块在 compaction 之后能否自愈（需要构造长会话）。
5. `sessionPersistence.list()` 在桌面版的实际规模与耗时（有多少会话、读一个会话多快）。
6. 多个 profile 同时运行时的写冲突表现（需要两个进程压测）。

这六点已写入 DESIGN.md 的 Phase 0 验收标准。
