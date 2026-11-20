# dsh-plugin-memory 0.20.0 客户端 / UI 管理面源码审阅

审阅对象：`dsh-plugin-memory@0.20.0` 已解包产物 `C:\Users\29390\OneDrive\Desktop\AgentMemory\.tmp\pkg\package\`
方法：只读下列 16 个文件（未读 `lib/index.js`、`lib/soul.js`、`lib/boot.js` 等 host 半），另用 `docs/CONFIGURATION.md`、`skills/memory.md`、`README.md`、`package.json` 互相印证。所有结论均给出 `文件:行号`。

> 行数复核：`client.js` 实际 **3210 行**（`[IO.File]::ReadAllLines` 与 LF 计数均为 3210/151,686 B）。交接说明里的「3173 行」是 PowerShell `Get-Content` 的统计结果，本报告以 3210 为准，行号引用全部基于该计数。

---

## 0. 先纠正一个前提：这 16 个文件里只有 1 个是「客户端半」

`package.json` 只导出一个浏览器入口：`"./client": "./lib/client.js"`（`package.json:17`），并以 `dsh.client.platform: "web"` 声明（`package.json:24-26`）。其余文件都是 **Node 端（host / CLI）模块**，靠 `node:fs` 等内置模块运行，浏览器里根本加载不了：

| 文件 | 行数 | 性质 | 证据 |
|---|---|---|---|
| `client.js` | 3210 | **唯一浏览器半（UI）** | 无任何 `node:` import；`require` 只有一次（`client.js:17`） |
| `settings-nav-icon.js` | 104 | 纯 DOM 字符串/纯函数模块，**被内联进 client.js** | 无 `node:` import；`client.js:2995-3004` 声明「Inlined from lib/settings-nav-icon.js」 |
| `graph-drag.js` / `graph-view.js` / `graph-search.js` / `graph-3d.js` | 100 / 98 / 69 / 158 | 纯数学模块，**被内联进 client.js** | `graph-drag.js:6-8`、`graph-view.js:5-7`、`graph-search.js:4-6`、`graph-3d.js:4-8` |
| `insights.js` | 289 | host 端数据生产（`/api/memory/insights` 的载荷） | `insights.js:15` `import { existsSync, readFileSync, statSync } from 'node:fs'` |
| `graph.js` | 394 | host 端图谱构建 | `graph.js:23-28` 同样 import `node:fs` |
| `timeline.js` | 164 | host 端时间轴投影 | `timeline.js:14` |
| `pages.js` | 241 | host 端页/`last_access` 账本 | `pages.js:21` |
| `index-page.js` | 419 | host / CLI 的 `index.md` 编译器（**与 UI 无关**） | `index-page.js:28-31` |
| `checkup.js` | 234 | CLI 文本体检报告（**与 UI 无关**） | `checkup.js:17-22`、`checkup.js:191-224` 输出终端字符串 |
| `growth.js` | 201 | host 端成长回顾文本生成 | `growth.js:19-21` |
| `tone.js` | 86 | host 端语气段注入文本 | `tone.js:20`「depends only on `node:*`」 |
| `reveal.js` | 83 | host 端 `execFile` 打开文件管理器 | `reveal.js:17` |

**结论**：真正的「UI 管理面」= `lib/client.js` 一个文件（3210 行 / 151 KB），外加被它内联抄了一遍的 5 个纯函数模块。`index-page.js`、`checkup.js`、`pages.js`、`tone.js`、`growth.js`、`insights.js` 都不是客户端代码，审阅时不能把它们算作 UI 功能。

---

## 1. 客户端如何注册进 DSH Web UI

### 1.1 加载协议：没有 `defineClient`，直接写 `window.__ModuleLoader__`

```js
// client.js:12-17
window.__ModuleLoader__.load({
  id: 'dsh-plugin-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')
```

- 全程 **没有 `defineClient`**（`grep defineClient` 在 client.js 0 命中）。
- 只向平台要一个种子：`react`（`client.js:17`，唯一一次 `require`）。不引 UI 组件库、不引宿主组件、不引图标包。
- 导出契约只有两项：

```js
// client.js:3146-3147
exports.apply = apply
exports.inject = ['slots', 'locale']
```

- 另有一块 `exports.__test = {…}`（`client.js:3151-3207`，约 56 个条目）公开内部纯函数给 vm 测试用，注释明确「host only reads `apply`/`inject`」（`client.js:3148-3150`）。

### 1.2 用了哪些 slot

| Slot | 注册内容 | 证据 |
|---|---|---|
| `settings.section` | `id: 'memory'`、`order: 100`、`locale: 'memory'`、`label: labelOf`、组件 `MemorySection` | `client.js:3110-3116` |
| `conversation.input.left` | `id: 'memory-session-toggle'`、`order: 100`、`locale: 'memory'`、组件 `MemoryChip` | `client.js:3123-3128` |

两处都用 `ctx.slots.inject(name, () => ctx.slots.register({…}, Component))` 的「先 inject 再 register」写法，且各自包在 `try/catch` 里——slot 不存在时只丢这一个入口（`client.js:3109-3119`、`3120-3131`；注释原文：「no settings panel entry on this host」/「no composer slot on this host」）。

### 1.3 依赖的 client API 名称（全部实测自源码）

| API | 用法 | 证据 |
|---|---|---|
| `ctx.effect(fn, label)` | 注册词典、注册导航图标、注入 chip 样式 | `client.js:3096`、`3134`、`3137` |
| `ctx.locale.register(ns, dict)` | 注册 `memory` 命名空间双语词典 | `client.js:3096` |
| `ctx.locale.getSnapshot().active` | 读当前语言（`'en'` 否则 `zh`） | `client.js:3101` |
| `ctx.slots.inject` / `ctx.slots.register` | 见上表 | `client.js:3110`、`3113`、`3123`、`3126` |
| `ctx.reflect.get(name, false)` | **懒解析**右侧栏服务，候选名 `sidebarRight` / `rightSidebar` / `sidebar`，`strict=false` 容忍未激活 | `client.js:3014-3024` |
| `sidebar.openResource(address)` | 用 `dsh-resource://file/session/<sessionId>/<rel>` 地址在右侧栏打开 md | `client.js:2688-2711` |
| React 上下文/生命周期 | `createContext`（`422`）、`useState/useEffect/useMemo/useRef/memo`、`getDerivedStateFromError`（`580-592`） | 全文 |

**版本敏感点**（对 Q5 重要）：
- 注释明确「Some hosts (e.g. DSH 0.2.2-rc.2) render this slot without a sessionId」（`client.js:1169-1171`），于是 chip 自己做了 `sessionId` 缺省回退。
- 右侧栏是「可选服务」：解析不到就回退到系统文件管理器（`client.js:2686-2688`、`2135-2150`）。
- 语言/设置侧栏图标是**绕开官方字段**实现的：`settings.section` 只投影 `id/order/label`，没有 icon，所以按 **label 文本**认领自己那行 DOM 再注入 mask（`client.js:3001-3004`、`3061-3088`、`settings-nav-icon.js:1-16`）。选择器硬编码 `[role="dialog"] nav button`（`client.js:3005`）。
- `package.json` 声明 `engines.dsh: "^0.2.1-rc.5 || ^0.2.2-rc.2"`（`package.json:46`），`docs/CONFIGURATION.md:74` 明确「`locale`（0.11+）与 session 投影（0.12+）是载荷相关」。

### 1.4 代码规模与构建形态

- **零构建、预打包的纯 JS**：没有 JSX、没有 TSX 编译产物痕迹——全部 `React.createElement(...)` 手写（如 `client.js:530`、`613-651`、`955-1006`）；`package.json` 无 `build` 脚本（`package.json:39-43`），`files` 直接发布 `lib/**`。注释自称「零构建」（`client.js:2`、`README.md:53`）。
- 规模：单文件 3210 行 / 151,686 B。内部结构大致为：i18n 词典 ~360 行（`42-399`）＋工具/上下文 ~110 行 ＋ 卡片组件 ~1450 行 ＋ 内联数学 ~640 行 ＋ 注册收尾 ~120 行。
- 双语词典：`zh` 42-220、`en` 221-399，两包键必须逐一对齐（`client.js:36-37` 注释指向 `test/client-i18n.test.mjs`）。占位符由自写的 `fill()` 填充（`client.js:402-409`），因为「即使 host 的 `t` 不做插值也要能渲染」（`client.js:38-39`）。
- 样式策略：**全部内联 style 对象** + 少量注入 `<style>`（焦点环 `1290-1297`、图谱过渡 `1697-1713`、时间轴 `2651-2679`、chip hover `3137-3143`、导航图标 `3068-3070`），颜色一律走 `--dsw-alias-*` 主题令牌（如 `514-527`、`547-548`）。

---

## 2. 管理界面到底提供哪些用户操作，走什么通道

### 2.1 先说通道：全部是插件自建的同源 HTTP 路由，没有 Remote service、没有工具调用

`client.js:5-7` 把理由写在文件头：

> 「数据通道：settings wire 只服务硬编码白名单（memory 不在其中），因此本区块直连插件自建的 HTTP 路由（`/api/memory/config`）：GET 读配置、POST 部分更新」

两个 slot 组件（设置面板区块 + composer chip）都**不注册任何 Host Service 调用**；除了 §1.3 的 `sidebar.openResource`，所有数据都来自 `fetch`。全文 `fetch(` 共 23 处，目标 URL 全部是下面 9 个常量：

| 常量 | 路径 | 声明 |
|---|---|---|
| `CONFIG_URL` | `/api/memory/config` | `client.js:20` |
| `CONTROL_URL` | `/api/memory/control` | `client.js:21` |
| `INSIGHTS_URL` | `/api/memory/insights` | `client.js:22` |
| `GRAPH_URL` | `/api/memory/graph` | `client.js:23` |
| `SESSION_URL` | `/api/memory/session` | `client.js:25` |
| `SOUL_URL` | `/api/memory/soul` | `client.js:885` |
| `GRAPH_REVEAL_URL` | `/api/memory/reveal` | `client.js:1974` |
| `GRAPH_PATH_URL` | `/api/memory/path` | `client.js:1975` |
| `TIMELINE_URL` | `/api/memory/timeline` | `client.js:2501` |

方法面：只有 `GET` 与 `POST`；**全文没有 PUT / PATCH / DELETE**（23 处 fetch 逐一核对：`710/896/1021/1176/1334/2086/2126/2692/2724/2764/2968` 为 GET，`925/1033/1208/1308/1357/2104` 为 POST）。没有任何一处调用 Agent 工具、也没有 `ctx.remote`/service RPC。

### 2.2 用户可做的操作（逐项 + 证据）

`MemorySection` 的版式即功能地图（`client.js:594-651`）：

1. **人格基础（快速铸魂）** — `SoulCard`（`887-1007`）：改「我的名字 / 你的称呼 / 基础人格描述」三项，`POST /api/memory/soul`，写入 SOUL.md 受管区块并把 BOOTSTRAP 标记为 complete（注释 `881-884`）；当 `bootstrapChanged` 为真时提示「已保存，铸魂标记为完成」（`client.js:935`）。
2. **配置热改（14 个控件）** — `MemoryForm`（`1278-1616`），每个控件改动立刻 `POST /api/memory/config` 打补丁并按响应回填（`1354-1372`）：
   `enabled`(1392)、`memoryDir`(1404)、`autoInject`(1416)、`bootSnapshot`(1428，映射 `session`/`live`)、`deferUntilUserSpeaks`(1440)、`activeSessionOnly`(1452)、`registerSkill`(1464)、`recallEnabled`(1476)、`recallIntervalMinMinutes`(1490)、`recallIntervalMaxMinutes`(1498)、`recallMaxPerSession`(1512)、`toneGuideEnabled`(1524)、`toneIntensity`(1541)、`growthRecapEnabled`(1553)。
3. **手动触发周回顾** — 「立即回顾」按钮（`1565-1582`）→ `POST /api/memory/control {action:'growth-now'}`（`1308-1312`），按返回的 `delivered`/`reason` 分 8 种文案（`1316-1324`），5 秒后自动消失（`1299-1303`）。
4. **会话级记忆开关（设置页内）** — `SessionControls`（`1014-1087`）：`GET /api/memory/session` 读 `effective` / `workspaceDisabled` / `cwd`，切换时 `POST {action:'on'|'off'|'workspace-on'|'workspace-off'}`（`1066-1079`）。
5. **会话级记忆开关（composer chip）** — `MemoryChip`（`1161-1276`）：输入框左侧 chip，10 秒轮询 `session` 路由（`1188`），点开下拉分「本会话 / 此工作区默认」各「开 / 关」四组（`1236-1253`）。
6. **记忆健康看板（只读）** — `InsightsCard`（`703-814`）：打开面板拉一次 `GET /api/memory/insights`（`710`），渲染分数、三格指标（页数 / index 路由 / 字数 `754-767`）、新鲜度条形（`770-780`）、四条体检项（`783-790`）、陈旧候选（`792-801`）、最近动态（`803-812`）。失败时**静默隐藏**，不影响设置页可用（`731-732`）。
7. **记忆图谱（3D canvas，只读、轮询）** — `GraphCard`（`2954-2993`）25 秒轮询 `GET /api/memory/graph`（`27`、`2984`），`GraphView`（`2008-2491`）支持：拖空白旋转（`2243-2255`）、滚轮缩放（`2275-2282`）、拖节点整理布局（`2223-2242`）、悬停/点击高亮邻居（`2194-2197`、`2258-2274`）、双击节点打开文件（`2283-2295`）、自动旋转开关与重置视图（`2348-2362`）、**客户端模糊搜索并聚焦**（`2074-2081`、`2369-2422`，算法 `1977-1998` 只打分 `label/id/type/tags`）、选中节点后「在 Finder 中显示」（`2457-2461`）与「复制路径」（`2462-2466`）。
8. **记忆时间轴（只读、轮询）** — `TimelineCard`（`2747-2952`）20 秒轮询 `GET /api/memory/timeline`（`2502`、`2779`）：拖动平移（`2819-2831`）、滚轮缩放且日/周/月/年粒度自动联动（`2520-2525`、`2843-2861`）、单击看详情（`2922`、`2931-2938`）、双击打开页面（`2923` → `openTimelineEvent` `2719-2745`，无对应页时退回 `log.md`）、「显示全部事件（含笔记/过程）」过滤（`2876`、`2506`、`2527-2533`）。
9. **视图切换** — 图谱 / 时间轴两个 tab（`618-633`），非活动视图卸载以停掉它的轮询（`598-600`、`636-642`）。
10. **外部反馈入口** — 「🐛 反馈 / 提 issue」外链（`1594-1614`，URL `3028`）。
11. **导航图标** — 设置侧栏「记忆」行的齿轮被替换为大脑电路 glyph（`3001-3088`）。

### 2.3 界面**没有**提供的能力（同为证据）

- **没有记忆正文检索**：图谱搜索只在已加载的 node 上按 `label/id/type/tags` 打分（`client.js:1977-1998`），不读页面内容；全文检索只在 CLI（`README.md:81`、`skills/memory.md:19`）。
- **没有「建议链接」视图**：`graph.js:256-258` 有 `includeSuggestions` 能力，但面板请求 `/api/memory/graph` 后只消费 `nodes/edges/stats`（`client.js:2011-2013`、`2331`），从不渲染 `suggestions`；建议只在 CLI `graph --suggest`（`checkup.js:70-71`、`145`）。
- **没有 `checkup` 报告进 UI**：面板只有 4 条 `insights.health.checks`（`client.js:783`），`checkup` 的体量/连接度/行动清单（`checkup.js:136-181`）只出现在终端（`checkup.js:191-224`）；`docs/CONFIGURATION.md` 也未承诺。
- **文档与实现的键位漂移**：`README.md:75` 与 `docs/CONFIGURATION.md:42` 称面板可改 **17 个 hot key**（`README.md:65` 又说「sixteen settings」，自相矛盾），但 client.js 实际只 POST 上面 14 个键；`proactiveCooldownSeconds`、`growthRecapIntervalDays`、`disabledWorkspaces` 在 client.js 中 **grep 0 命中**（工作区默哀仅通过 `session` 路由的 `workspace-off` 间接影响，落到哪个键属 host 侧，本次未读 host 半 → 未确认）。

---

## 3. 记忆编辑 / 版本历史 / 回滚 / 审核提案：**明确没有**

基于源码，逐项否定（不是「没找到」，是代码结构上不存在）：

| 能力 | 结论 | 证据 |
|---|---|---|
| 记忆页正文编辑 | **没有**。UI 里唯一可写文本是 SOUL 卡片的 3 个字段（两个 `input` + 一个 `textarea maxLength:2000`），目标是 `/api/memory/soul`，写的是 SOUL.md 受管区块，不碰任何记忆页 | `client.js:941-979`、`885`、`883-884` 注释 |
| 页面写接口 | **没有**。9 条路由中没有任何一条接受页面内容；无 PUT/PATCH/DELETE | §2.1 路由表 + 23 处 fetch 全量核对 |
| 版本历史 | **没有**。UI 不读 git 日志、不读快照；`git` 只在 host 侧 `autocommit.js:176` 出现，客户端零引用 | `grep rollback\|revert\|undo\|diff\|history` 在 client.js 仅命中 `timelineHint` 文案里的「历史」（`client.js:189`） |
| 回滚 / 撤销 | **没有** | 同上；无任何带 undo 语义的按钮或路由 |
| 审核 / 待确认提案 | **没有**。无队列、无 diff 视图、无 approve/reject 控件 | `grep approve\|approval\|pending\|proposal\|提案\|审核` 在 client.js 0 命中（`pending` 仅出现在 host 的 `boot.js:228-234`、`soul.js:238`，与 UI 无关） |
| 删除记忆页 | **没有**。图谱节点只有 Reveal / Copy path 两个动作；时间轴只有查看/打开 | `client.js:2456-2467`、`2922-2929` |

也就是说：**这个 UI 是「配置台 + 只读可视化」，不是记忆内容编辑器**。记忆的增删改查依旧由 agent 通过 `memory` 技能（remember / recall / consolidate / forget，`skills/memory.md:16-21`）或 CLI 完成；UI 能改的只有「插件怎么工作」和「agent 的人格基础」。

---

## 4. 客户端半 ↔ host 半的数据契约

### 4.1 逐路由字段清单（客户端实际读/写的字段）

**`GET/POST /api/memory/config`**（`client.js:20`、`1334`、`1357`）
读/写字段：`enabled`、`memoryDir`、`autoInject`、`bootSnapshot`（`'session'`/`'live'`）、`deferUntilUserSpeaks`、`activeSessionOnly`、`registerSkill`、`recallEnabled`、`recallIntervalMinMinutes`、`recallIntervalMaxMinutes`、`recallMaxPerSession`、`toneGuideEnabled`、`toneIntensity`、`growthRecapEnabled`（`1392-1553`）。
POST 语义：**部分更新**（只发改动的一个键，`1354-1361`），响应即新配置并整体回填（`1365`）。布尔一律用 `!== false` 判默认开（如 `1390`、`1414`），`bootSnapshot` 用 `=== 'session'`（`1426`）。与 `docs/CONFIGURATION.md:7-23` 的 hot key 表一致（除未暴露的 3 个，见 §2.3）。

**`GET/POST /api/memory/soul`**（`client.js:885`、`896`、`925`）
请求体：`{agentName, userName, summary}`（`916-929`，`maxLength` 64/64/2000）。
响应读：`profile.{agentName,userName,summary,managed}`、`needsBootstrap`、`bootstrapStatus`、`bootstrapChanged`（`914-920`、`933-935`、`958-962`）。

**`GET/POST /api/memory/session`**（`client.js:25`、`1021`、`1033`、`1176`、`1208`）
查询：可选 `?sessionId=`（`1173-1175`）。
响应读：`{ok, sessionId, cwd, effective, workspaceDisabled}`（`1055`、`1069`、`1076`、`1081`、`2696-2697`）。
请求体：`{action: 'on'|'off'|'workspace-on'|'workspace-off'}`（`1036`、`1071`、`1078`、`1211`）；chip 额外把 `ok:false` 当失败抛出（`1216`）。

**`GET /api/memory/insights`**（`client.js:22`、`710`）
客户端读：`overview.{pages, indexEntries, chars}`（`734-765`）、`freshness.{buckets[{key,label,count}], never}`（`737`、`778-779`）、`health.{score, checks}`（`736`）、`checks[].{id, ok, label, detail, data}`（`783-790`）、`stalePages[].{path,title,daysSinceAccess}`（`738`、`795-798`）、`recent[]`（`739`、`806-810`）。
`data` 子键：`{routes, missing}` / `{count, sample}` / `{missingSalience, missingType}` / `{atRisk}`（`client.js:466-489` 与 `insights.js:171/178/187/194` 逐字对应）。

**`GET /api/memory/graph`**（`client.js:23`、`2968`）
客户端读：`nodes[].{id,label,type,color,degree,hub}`（`2032-2042`）、`edges[].{source,target,kind}`（`2012`、`1842-1851` 用 `kind` 分 `link/index/tag`）、`stats.{pages,links,tagEdges,indexLinks,isolated}`（`2331`、`2365-2367`）。
**冗余点**：host 已经算好 2D 坐标并塞进 `nodes[].x/y/r`（`graph.js:238-246`），但 3D 视图完全不用它们，自己在客户端用 Fibonacci 球重排（`client.js:2044-2051`、`1727-1759`）。也就是说服务端布局计算对当前 UI 是死代码，只服务 CLI/静态报告（`graph-layout.js:1-9` 的注释）。

**`GET /api/memory/timeline`**（`client.js:2501`、`2764`）
客户端读：`events[].{date,kind,group,title,path}`（`2527-2533`、`2615-2626`）、`stats.{first,last}`（`2944`）。
**冗余点**：`events[].group` 由 host 算（`timeline.js:18-31`、`150`），客户端又内联了一份同样的映射表并优先用它（`client.js:2507-2514`、`2615`）；`stats.events` / `stats.pages` 客户端不读，长度自己数（`2944` 用 `events.length`）。

**`GET /api/memory/path?id=`** → `{ok, path}`（`client.js:2086-2088`、`2126-2130`）
**`POST /api/memory/reveal {id}`** → 成功即无体，失败 `{error}`（`client.js:2104-2118`；host 侧实现 `reveal.js:56-83`，非法 id 抛 `invalid-id`、执行失败 `exec-failed`）。
**`POST /api/memory/control {action:'growth-now'}`** → `{delivered, reason}`，客户端穷举 `deferred/no-content/disabled/growth-disabled/busy/no-session/error/agent-gone/disposed`（`client.js:1316-1324`）。

### 4.2 耦合点（host 是唯一数据源）

客户端**不持久化任何东西**：没有 localStorage、没有内存缓存跨挂载复用、不读文件系统（唯一的「FS」能力是把绝对路径交给 host 的 `/api/memory/reveal` 或右侧栏）。每一次渲染都是「某条路由响应的直接函数」。因此耦合点集中在**字符串协议**上：

1. **配置键名**（14 个，§4.1）——host 改名即面板失联；未知键客户端会静默保留但不再显示。
2. **会话 action 动词**：`on` / `off` / `workspace-on` / `workspace-off`（`1071`、`1078`、`1244-1249`）。
3. **体检项 id**：`index` / `orphans` / `frontmatter` / `freshness`（`client.js:449-453`），未知 id 回落到 host 的 `label`（`454`）——设计上向后兼容。
4. **体检 `data` 子键**：`routes/missing/count/sample/missingSalience/missingType/atRisk`（`466-489`）；老 host 无 `data` 时直接用 `detail` 中文串（`465`、`488`，`insights.js:161-164` 明确这是刻意保留的双轨）。
5. **新鲜度桶 key**：`today/week/month/quarter/stale`（`437-445` vs `insights.js:34-40`），未知 key 回落到 `bucket.label`（`443`）。
6. **页面 type 词表**：`identity/user/user-preference/project/skill/decision/concept/fact/unknown`（`494-504` vs `insights.js:20`、`graph-layout.js:16-27`）。
7. **图谱边 kind**：`link/index/tag/type`（`graph.js:31`、`212`、`229`；客户端 `1842-1851` 只认前三个，`type` 边即使出现也按 `link` 画）。
8. **时间轴 kind 词表**：`TIMELINE_NOISE` 13 个「过程噪声」（`client.js:2506`）必须与 `timeline.js:37-51` 一致，否则过滤失效。
9. **文件定位协议**：`cwd` + `memoryDir` 拼接出的绝对路径（`2728-2736`），再转成 `dsh-resource://file/session/<id>/<encodedRelative>`（`2700-2709`）；**该地址格式是 DSH 侧契约**，一变「双击打开」即失效（已用 `outside-workspace` 分支兜底，`2705-2707`）。
10. **错误形状**：客户端约定 `!response.ok` → `body.error` 或 `body.reason`（`1215-1216`、`1364`、`2111`）。

---

## 5. 对我们自己的 AgentMemory 意味着什么维护成本

### 5.1 成本项

| 成本 | 量级 / 具体表现 | 证据 |
|---|---|---|
| **单文件体量** | 一个 3210 行 / 151 KB 的浏览器文件承担 UI 全部：i18n、14 个配置控件、2 个可视化、3 个轮询器、DOM hack。改任何一处都要读整个文件 | §1.4 |
| **client API 版本依赖** | 依赖 `__ModuleLoader__.load` 协议、`slots.inject/register`、`locale.register/getSnapshot`、`effect`、`reflect.get(…, false)`；两个 slot 名 + `settings.section` 的投影字段（`name/id/order/locale/label`）都是硬契约 | `client.js:3096-3143`、`3110-3116` |
| **DOM 级 hack 的脆弱性** | 侧栏图标靠 `[role="dialog"] nav button` + label 精确匹配 + `MutationObserver` 抢注，注释自己说「官方哪天给 `settings.section` 长出 icon 字段，本段即可删除」 | `client.js:3001-3004`、`3061-3088`、`settings-nav-icon.js:1-16` |
| **手工内联复制带来的漂移风险** | 5 个纯模块被逐行抄进 client.js（drag / view / search / 3d / nav-icon），因为「client bundle 只能 require 平台种子」。两边靠测试对齐（`graph-view.js:5-7` 称「a test asserts the two agree」），但每次改数学要改两处 | `client.js:1626-1660`、`1663-1694`、`1739-1815`、`1977-2006`、`2995-3060` |
| **i18n 双包对齐** | 中英各 ~180 键，缺键/多键由测试强制；新增文案要两处同时加 | `client.js:36-37`、`42-399` |
| **无构建 ≠ 无工程约束** | 没有 TS/TSX，所以没有类型检查兜底：字段名写错只能靠运行期「静默失败/静默隐藏」（`730-732`、`2991`、`2866`）。反过来也没有打包链要维护 | `package.json:39-43` |
| **轮询开销** | 面板打开期间：图谱 25s、时间轴 20s、chip 10s，各一个 `setInterval`；切换 tab 靠卸载止损 | `client.js:27`、`2502`、`1188`、`598-600` |
| **文档漂移已发生** | README/配置文档写「17 个 hot key 可在面板编辑」，client.js 只 POST 14 个 | `docs/CONFIGURATION.md:42` vs §2.3 |
| **数据契约无 schema** | 9 条路由的字段全靠字面量约定，host 侧改字段 = 面板静默空白；唯一的兼容垫片是「`data` 缺失回落到中文 `detail`」这一处 | `client.js:463-489`、`insights.js:161-164` |

### 5.2 可直接复用的交互模式（这才是最值钱的部分）

1. **`settings.section` 卡片的健壮骨架**：每个卡片独立包 `SectionBoundary`（`580-592`），任何渲染异常退化成一行错误文案而非白屏；只读卡片失败直接 `return null`（`730-732`、`2991`、`2866`）——「附加信息绝不拖垮设置页」。
2. **草稿态输入，blur/Enter 才提交**：`DirInput` / `NumberInput` 先本地 `draft`，`onBlur` 或 Enter 才写 Host，避免每次按键触发 Host 重排（`816-867`，注释 `816`）。这套模式对任何「设置即热应用」的面板都通用。
3. **locale 走 React Context 而不是逐层传 props**：`LocaleContext` + `useT(props)`（`422-428`），`t` 既可由 slot 注入也可由 context 兜底；占位符自填，不依赖 host 的 `t` 是否插值（`38-39`、`402-409`）。
4. **轮询投影「保留上一帧」**：刷新失败不清空画面（`2979-2981`、`2774-2776`），只有首帧失败才判 failed。
5. **「纯函数数学 + 客户端内联 + Node 测试钉住」的三段式**：几何/命中/搜索写在可测模块里，客户端抄一份，测试对拍。这是**零构建插件里做复杂可视化的可行解**（`graph-3d.js:4-8`、`graph-search.js:4-6`）。
6. **降级链**：双击节点 → 侧栏 `openResource` → 失败 `POST /reveal` → 再失败「复制路径」并提示手动跳转（`2135-2150`、`2084-2100`、`2115-2119`）。跨平台降级写得很完整。
7. **`dsh-resource://file/session/...` 打开文件的正确姿势**：绝对路径必须先确认落在 `session.cwd` 内，再转「会话相对地址」，否则侧栏拒收（`2697-2709`）——我们的 AgentMemory 若要「在看板里点开记忆页」，这段是现成实现。
8. **i18n 与服务端「locale-neutral data」双轨**：host 同时给中文 `label/detail` 和 `data` 数字，新客户端用 `data` 自渲染、旧消费者继续读 `detail`（`insights.js:161-164`）。这是向后兼容的教科书式做法。

### 5.3 给我们的取舍建议（基于上述事实）

- 若我们要做**记忆内容编辑/版本/回滚/审核**，这套代码**没有可复用的先例**，需要新设计 host 路由（现有 9 条全是读或「配置写」），并会引入本插件刻意避免的风险面（写文件、并发、审计）。
- 若我们只做**只读看板 + 配置台**，`client.js` 的卡片骨架、草稿提交、轮询保帧、降级链可以直接照搬，但要接受同一量级的体量（仅设置面板 + 两张卡片 ≈ 1500 行）与「零类型检查」的维护现实。
- 若我们要做**图谱/时间轴**，务必照搬「纯模块 + 内联副本 + 对拍测试」结构，否则零构建下的 canvas 数学无法回归。

---

## 6. 小结表格

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 注册方式 | `window.__ModuleLoader__.load({id, factory})`，**无 `defineClient`**；只 require `react`；导出 `apply` + `inject:['slots','locale']` | `client.js:12-17`、`3146-3147` |
| 1 | 占用 slot | `settings.section`（id `memory`, order 100）＋ `conversation.input.left`（id `memory-session-toggle`, order 100），各自 try/catch 可缺省 | `client.js:3110-3116`、`3123-3128` |
| 1 | client API | `slots.inject/register`、`locale.register/getSnapshot`、`effect`、`reflect.get(name,false)`、`sidebar.openResource` | `client.js:3096-3134`、`3014-3024`、`2711` |
| 1 | 代码规模/形态 | 单文件 3210 行 / 151 KB，**纯 JS 零构建**、手写 `React.createElement`、无 TSX、无 build 脚本 | §1.4、`package.json:39-43` |
| 2 | 提供哪些操作 | 铸魂卡片、14 项热配置、立即回顾、会话/工作区开关（面板 + chip）、只读健康看板、3D 只读图谱、只读时间轴、反馈外链、侧栏图标 | §2.2 |
| 2 | 走什么通道 | **只用插件自建同源 HTTP 路由**（9 条，GET/POST）；无 Remote service、无工具调用；唯一非 HTTP 交互是 `sidebar.openResource` | `client.js:5-7`、20-25、885、1974-1975、2501 |
| 3 | 编辑/版本/回滚/审核 | **全部没有**。唯一可写文本是 SOUL 三字段；无页面写路由、无 PUT/PATCH/DELETE、无 git/history/diff/approve/pending 相关代码 | §3（`client.js:941-979`、23 处 fetch 全核对） |
| 4 | 数据契约 | host 是唯一数据源；契约 = 14 个配置键 + session 四动词 + insights 的 check id/`data` 子键 + graph 的 node/edge/stats + timeline 的 kind/group + `dsh-resource://` 地址格式；客户端零持久化 | §4.1、§4.2 |
| 4 | 已知冗余/漂移 | host 算的 `graph.nodes.x/y/r` 无人消费；`timeline.group` 双份映射；`stats.events/pages` 不读；文档称 17 个热键而面板只暴露 14 个 | `graph.js:238-246` vs `client.js:2044`；`timeline.js:150` vs `client.js:2615`；`docs/CONFIGURATION.md:42` |
| 5 | 维护成本 | 高：单文件巨型、client API 硬契约、DOM label 抢注、5 处手工内联副本、无类型检查、无路由 schema | §5.1 |
| 5 | 可复用模式 | 卡片 `SectionBoundary` + 失败隐藏、草稿态提交、locale Context、轮询保帧、纯数学内联+对拍、四级降级链、`dsh-resource` 打开文件、locale-neutral data 双轨 | §5.2 |

---

## 7. 未确认 / 主动排除

- **未确认**：host 侧路由的实际实现（`lib/index.js` 未读，按约束排除）——本报告中「host 提供什么」全部是**客户端所期望**的形状，以及 host 模块（`insights.js`/`graph.js`/`timeline.js`/`reveal.js`）产出的字段；两者是否逐字一致未运行验证。
- **未确认**：`workspace-off` 最终写入 `disabledWorkspaces` 还是别的存储（host 半未读）。
- **未确认**：DSH 侧 slot 名的当前有效性。本会话的客户端 inspect 查询两次超时（`Slots.listSubTree` 10s timeout），DSH 源码目录 `E:\DeepSeek Harness\resources\app.asar\dsh\` 在本机不可达，因此 `settings.section` / `conversation.input.left` 这两个 slot 名是否仍由当前 DSH 暴露，**未做运行期交叉验证**；仅依据本插件源码与 `docs/CONFIGURATION.md:74` 的版本声明。
- **主动排除**：`index-page.js` / `checkup.js` / `pages.js` / `tone.js` / `growth.js` 被交接清单列为「UI 管理面」，但源码显示它们与浏览器无关（§0），本报告只为「数据契约」引用了其中 `insights.js`、`graph.js`、`timeline.js`、`reveal.js` 四者的产出形状。
