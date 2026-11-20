# dsh-plugin-memory 0.20.0 · host 半源码审阅（补全）

> 范围：`.tmp/pkg/package/lib/` 中 19 个此前未读的模块，外加 `skills/memory.md` 与 `docs/*.md` 佐证。已读过的 `lib/index.js`、`boot.js`（前 200 行）、`digest-guard.js`、`schema.js` 及全部 UI 文件不在本文重复。
> 口径：行号为实测（与文件 LF 行号一致；任务书括号里的行数与实测略有差异，例如 `scaffold.js` 实测 277 行而非 212，本文一律用实测值）。只读审阅，未修改任何源文件。
> 未确认项已就地标注「未确认」。

---

## 1) 总表

| 文件 | 行数 | 一句话职责 | 关键导出 | 副作用 |
|---|---|---|---|---|
| `soul.js` | 276 | 在用户自有 `SOUL.md` 里读写一个受管块（我的名字/你的称呼/基础灵魂描述），其余正文逐字保留 | `SOUL_PROFILE_START/END`、`DEFAULT_SOUL_PROFILE`、`readSoulProfile`、`writeSoulProfile`、`hasManagedSoulProfile`、`markBootstrapComplete`、`filterBootstrapPlaceholders` | 是：写 `SOUL.md`、`BOOTSTRAP.md`（tmp+rename，`soul.js:231-233`、`259-261`）；保留 CRLF（`226-230`） |
| `skill.js` | 42 | 把随包发布的 `skills/memory.md` 作为运行时技能正文读取并缓存 | `MEMORY_SKILL_NAME/DESCRIPTION/WHEN_TO_USE`、`memorySkillContent` | 弱：首次调用同步读文件并写模块级 `cached`（`skill.js:27`、`33-41`），失败降级为 `''` |
| `scaffold.js` | 277 | 记忆库目录骨架与 5 个初始模板，只补缺不覆盖 | `CATEGORY_DIRS`、5 个 `*_TEMPLATE`、`ensureMemoryFile`、`ensureMemoryScaffold` | 是：`mkdirSync` + `writeFileSync`（`scaffold.js:243-247`、`255-276`） |
| `session-gate.js` | 232 | 全局开关／会话覆盖／workspace 默认的三层门控，覆盖持久化到 `memory-sessions.json` | `SESSION_STATE_FILENAME`、`DEFAULT_TTL_DAYS`、`matchesWorkspace`、`SessionGate` | 是：构造即 `load()`+`prune()` 可能写盘（`session-gate.js:97`、`122`、`218-231`） |
| `config-store.js` | 190 | 私有 JSON（`<DSH_HOME>/memory.json`）作为「组合默认 + 用户层」的热配置源 | `MEMORY_CONFIG_FILENAME`、`defaultConfigPath`、`MemoryConfigStore` | 是：读盘（构造时）+ 原子写盘（`config-store.js:55`、`79`、`178-189`） |
| `autocommit.js` | 203 | 轮询记忆库，静默 N 秒后自动 `git add -A && git commit` | `walkFiles`、`latestMtimeMs`、`gitAvailable`、`AutoCommitter` | 是：`setInterval` 定时器（`autocommit.js:115-122`）+ 反复起 `git` 子进程（`63`、`155`、`163`、`176`、`186`） |
| `recall-nudge.js` | 417 | 会话空闲时主动「追忆」，并承载每周成长回顾 | `randomIntervalMs`、`listRecallCandidates`、`buildRecallNudgeMessage`、`buildGrowthRecapNudgeMessage`、`RecallNudge` | 是：起 30s 轮询定时器（`recall-nudge.js:39`、`208-211`）、订阅 turn 边界（`202-204`）、注入 followup（`354`、`271`）、写 `.growth-recap.json`（`267`、`332`） |
| `proactive-lock.js` | 122 | 跨插件「谁可以先说话」的共享 JSON 仲裁锁 | `PROACTIVE_COOLDOWN_FILENAME`、`PROACTIVE_LOCK_VERSION`、`defaultProactiveCooldownPath`、`readProactiveLock`、`claimProactiveLock` | 是：原子写锁文件（`proactive-lock.js:111-115`） |
| `activity-tracker.js` | 131 | 两道礼貌闸：用户是否已开口、是否当前活跃会话 | `ActivityTracker`（`attach/noteUserMessage/hasUserSpoken/isActive/activeId/shouldInject`） | 是：订阅每人 `agent/inbox/inserted`（`activity-tracker.js:47-49`）；无定时器、无写盘 |
| `paths.js` | 57 | 跨平台路径辅助：`~`/`%VAR%`/`$HOME` 展开与换行归一（**不做越界校验**） | `normalizeNewlines`、`expandPath` | 否（纯函数） |
| `checkup.js` | 235 | 把 lint/status/insights/graph 四路读数合成一份带排序动作的体检报告 | `STALE_DAYS`、`INDEX_SHARE_WARN`、`runCheckup`、`formatCheckup`、`hasWork`、`indexBytes` | 否（只读，`checkup.js:11-12`） |
| `growth.js` | 201 | 从 `log.md` 标题与页面 mtime 推导「这周我记住了什么」 | `GROWTH_STATE_FILENAME`、`parseGrowthLogEntry`、`collectGrowth`、`renderGrowthRecap`、`readGrowthState`、`growthRecapDue`、`writeGrowthState` | 部分是：`writeGrowthState` 原子写（`growth.js:194-200`），其余只读 |
| `insights.js` | 289 | 仪表盘数据层：体量/类型/新鲜度/健康分，全部现算 | `KNOWN_TYPES`、`parseFrontmatter`、`collectInsights`、`readRecentLog` | 否（只读，`insights.js:7`） |
| `pages.js` | 241 | 页面访问记账：把 boot 块真正注入的页面 `last_access` 戳为当天 | `PAGE_DIRS`、`today`、`listPagePaths`、`extractReferencedPages`、`touchPageFile`、`touchPages`、`readLastAccess`、`accessSummary`、`listPagesWithMeta` | 是：直接改写页面文件（`pages.js:121`，**非原子**、无 tmp+rename） |
| `reveal.js` | 83 | 在 Finder/Explorer/xdg 中定位记忆页，执行前把路径限制在库内 | `resolveMemoryFile`、`revealFile` | 是：起系统进程（`reveal.js:17`、`66-81`） |
| `tone.js` | 86 | 生成 ≤12 行的「按语境微调语气」段，拼在 boot 块 SOUL 之后 | `TONE_GUIDE_MAX_LINES`、`TONE_INTENSITIES`、`buildToneGuide` | 否（零依赖纯函数，`tone.js:20`） |
| `index-page.js` | 420 | `index.md` 编译器：只按页面声明的 `summary:` 原地重写路由行 | `INDEX_LABEL_MAX`、`INDEX_LINE_MAX`、`INDEX_SUMMARY_MAX`、`clampSummary`、`clampLabel`、`declaredSummary`、`renderIndexLine`、`parseIndexPage`、`planIndex`、`applyIndex`、`syncDeclaredSummaries`、`indexIssues` | 部分是：`planIndex` 只读；`applyIndex`（`index-page.js:311`）、`syncDeclaredSummaries`（`354`）直接 `writeFileSync` |
| `timeline.js` | 164 | 把 `log.md` 标题行投影成时间线事件，并尽量挂到页面上 | `GROUP_OF`、`NOISE_KINDS`、`groupOf`、`isNoiseKind`、`buildTimeline` | 否（只读，`timeline.js:6-9`） |
| `graph.js` | 396 | 从互链/tag/type 推导记忆关系图，含后端布局与「该链谁」建议 | `EDGE_KINDS`、`buildMemoryGraph`、`suggestLinks` | 否（只读；布局在服务端算好，`graph.js:235-251`） |

---

## 2) 记忆操作协议：`skills/memory.md` 要求模型做什么

### 2.1 三个入口 + 四个操作

**入口（每会话开始）**，`skills/memory.md:9-14`：

1. 先读 boot 块，恢复「我是谁 / 我记住了什么」（`:9-11`）；
2. 检查 boot 块里有没有「铸魂阶段」引导词，有则**主动发起铸魂对话**，一次问一项，确认即写回 `SOUL.md` / `user/profile.md` / `BOOTSTRAP.md`（`:12`）；
3. 没有引导词但 `BOOTSTRAP.md` 的 `status` ≠ `complete`，铸魂同样是首要任务（`:13`）；
4. 按需 drill：先 `index.md` 再读页（`:14`）。

**四个操作**（判据 + 格式）：

- **remember（记）**：判据是「跨会话仍然有价值」——稳定事实、偏好、决策与理由、项目背景、工具坑；**不记**一次性闲聊和当前对话可见的临时状态（`skills/memory.md:25`）。动作格式固定五步：蒸馏成页/更新页 → **每个新页或改动页补 1–3 条「相关页面」相对路径互链** → 标矛盾 → 更新 `index.md` → 追加 `log.md`（`:18`）。
- **recall（忆）**：先查 `index.md` 定位，再钻页；必要时 `dsh-memory search`，读完 `dsh-memory touch` 补记（`:19`）。
- **consolidate（整理）**：`dsh-memory lint` 查矛盾/过时声明/孤儿页/缺交叉引用/该归档的冷页，`dsh-memory status` 看 >90 天陈旧页（`:20`）；index 行**由页面 frontmatter `summary:` 派生**，流程为 `index`（看漂移）→ `index --write`（只改行、不动分节与顺序）→ `--check` 供机器判退出码 → `--sync-frontmatter` 回填老库（`:20`）。
- **forget（忘）**：显式遗忘（用户要求删除/修正）立即执行并同步改 index、记 log；自动衰减按 `salience` + `last_access`，**优先归档、删除谨慎**（`:21`；模板侧同规则见 `scaffold.js:104`、`119-121`）。

**digest 是强制义务**：每次会话收尾必须写回（页面 + `index.md` + `log.md`），收到插件注入的 digest 提醒要**立即执行**；确无内容则在 `log.md` 记 `## [日期] digest | 无新增` 解除提醒（`skills/memory.md:27`）。会话级开关关闭时，除用户显式说「记住这个」外，不 remember/recall/consolidate、不写库（`:28`）。

### 2.2 与 `lib/*.js` 的校验对齐

| 协议要求 | 谁在机器上兑现 | 位置 |
|---|---|---|
| 固定的文件/目录骨架 | `ensureMemoryScaffold` 建 8 个分类目录（`identity user skills decisions projects/active projects/archive concepts raw`）+ 5 个根文件，**只补缺不覆盖** | `scaffold.js:21-30`、`265-275`、`243-247` |
| frontmatter 字段约定 | 模板承诺 `title/date/type/salience/last_access/tags/sources`（`scaffold.js:125-135`）；代码实际解析的只有 `title/type/salience/tags/last_access/summary` | `pages.js:212-241`、`insights.js:80-91`、`index-page.js:145-149` |
| `last_access` 自动维护 | boot 块实际引用的页 → `extractReferencedPages` → `touchPages` 戳当天（每页每天至多一次），无该字段的页**不臆造** | `pages.js:80-94`、`136-145`、`113-118` |
| salience 衰减（1 热/2 温/3 冷，90/180 天） | 只被**报告**，不被执行：`STALE_DAYS=90` 与新鲜度分桶 | `scaffold.js:104`、`checkup.js:25`、`79-97`、`pages.js:166-191` |
| index 是路由表（一行一页） | `planIndex` 比对、`applyIndex` 原地重写、`indexIssues` 报 `line-too-long/summary-too-long/missing/removed/no-summary` | `index-page.js:229-286`、`297-313`、`372-419` |
| checkup 查什么 | 四项一致性：index 链接完整、无孤儿页、frontmatter 完整、index 与页面同步；再给 7 类按优先级排序的动作 | `checkup.js:125-134`、`137-158` |
| 互链骨架 | 图只把**非 index 边**算作真关系，`lonely` = 只有索引入口的页；建议链按 共享 tag×3 + 标题词×2 + 同类型×1 打分 | `checkup.js:100-113`、`graph.js:291-396`、`332-356` |

### 2.3 三处已知错位（值得记录）

1. **摘要字数**：模板与技能都说「≤ 80 字」（`scaffold.js:159`、`skills/memory.md:18`），代码硬上限却是 `INDEX_SUMMARY_MAX = 48`（`index-page.js:40`），行上限 132 字符、标签上限 32（`:35-38`）。声明超 48 会被 `clampSummary` 截断（`index-page.js:76-84`），`indexIssues` 也会报 `summary-too-long`（`385-393`）。
2. **`skills/memory.md:20` 里有一处字面 `\n`**（`…分布。\n- **index 同步**：…`），导致「index 同步」这条没有成为独立列表项；模型读到的 markdown 结构是坏的。
3. **digest 消息的 source 判据过期**：协议说提醒是 `source.kind === 'plugin'`（`skills/memory.md:27`），而实现早已改为 `{ kind: 'plugin:memory' }`（`recall-nudge.js:118-121`、`145`；CHANGELOG 记录 v4 只接受 producer-owned kind）。照文档写判定的模型识别不到提醒；反过来按 `plugin:memory` 写才与 v4 校验一致（另见 `docs/DESIGN.md:45` 的措辞未更新，未确认是否有意）。

---

## 3) 后台/主动机制

### 3.1 `recall-nudge` 何时主动说话

判定链（任一不满足即沉默），`recall-nudge.js:297-320`：

1. agent 仍存活于注册表，否则自我 `dispose()`（`:299-302`）；
2. `config.enabled` 且 `recallEnabled !== false`（`:304`）；
3. **两道礼貌闸**：`tracker.shouldInject` = 用户已开口 + 是当前活跃会话（`:307` → `activity-tracker.js:120-124`）；
4. 本会话未超 `maxPerSession`（默认 3，`:308`）；
5. `agent.status === 'idle'` 且 `inbox.nextStep` 为空（`:309-311`）——只在真空闲、没有下一步排队时插话；
6. **首次合格空闲只「上弦」不立即开火**（`:313-319`），避免用户第一轮刚结束就被打断；之后 `now >= nextRecallAt` 才due（`:320`）；间隔在 `[min,max]` 分钟随机（默认 30–240，`:48-52`），每次命中后重抽（`:355`）；
7. 有成长回顾到期则**先走回顾、本次不追忆**（`:322-343`）；无 `log.md` 候选则直接不说话（`:63-72`、`345-346`）；
8. recall 本身**不写库**，只给候选标题作为引子（`:16-17`、`98-100`）。

节奏来源：turn 边界事件 + 30s 轮询双通道（`:200-212`）；`POLL_INTERVAL_MS=30_000`（`:39`）。文案硬约束：只提真实存在的、第一人称、一到三句、不许先打草稿（`:107-116`）。

### 3.2 跨插件仲裁（speech floor）

- 协议文件 `${DSH_HOME:-~/.dsh}/proactive-cooldown.json`，内容 `{version:1, speaker, at}`，两端各自实现、**零跨插件 import**（`proactive-lock.js:9-20`、`31-44`；`docs/PROACTIVE-PROTOCOL.md:3-23`）。
- 只拦**别人**：`current.speaker !== speaker` 且 `at > now - cooldown` 才返回 `{ok:false, deferredBy}`；自己可随时刷新（`proactive-lock.js:102-108`、`110`）。
- 读坏/缺失 = 无锁（`:53-69`）；`cooldownSeconds === 0` 直接放行且**不写文件**（`:100`）；写失败也放行（`{ok:true, disabled:true}`，`:116-120`）——礼貌而非硬依赖。
- 调用侧把它当「尽力而为」：claim 抛异常也返回 `ok:true`（`recall-nudge.js:368-380`）。

### 3.3 如何避免刷屏

1. 每会话硬上限 `maxPerSession`（`recall-nudge.js:308`）；
2. 随机间隔去节拍感（`:48-52`）；
3. 被别人占住时**只让出本次、不消耗自己的节奏**（`:327-330`、`348-352`），下个触发点重试；
4. 手动「Review now」也算一次主动发言，会把 `nextRecallAt` 往后推，避免自动回顾紧跟着再来一条（`:273-278`）；
5. 只在 idle 且无 `nextStep` 时注入（`:309-311`）；
6. 成长回顾用 `.growth-recap.json` 记上次投递时间，重启不重播（`growth.js:181-186`、`194-200`；`recall-nudge.js:403`）。

### 3.4 `autocommit` 怎么做 git 提交、失败怎么办

- 启动门槛：目录下有 `.git` 且 PATH 上有 `git`，否则只记一条日志后**不轮询**（`autocommit.js:101-110`）；轮询间隔 ≥15s（默认 60s，`:90`、`115-121`），`unref` 不阻止退出（`:122`）。
- 去抖：**不信任 mtime**，用 `git status --porcelain` 作为权威脏标记（`:137-142`、`184-194`）；从「第一次看到脏」开始计静默窗口（默认 60s，`:89`、`149-151`），窗口内不动手。
- 启动时先 `check(true)` 冲掉上次会话遗留未提交的改动（`:112-114`）。
- 提交：`git -C <store> add -A` → `git diff --cached --quiet` 判是否有暂存（无则视为干净并清零 `dirtySince`，`:155-161`）→ `git commit -m "digest: auto-commit memory store <ISO>"`（`:162-163`）；`committing` 标志防止轮询重入（`:143`、`153`）。
- 失败：捕获后**限流告警**（30 分钟最多一条，`:167`、`196-202`），且 `dirtySince` 只有成功才清零（`:164`），所以下次轮询仍会重试——代价是持续失败时会每分钟起一次 git 子进程。单文件里 `walkFiles`/`latestMtimeMs` 已不再用于判定（仅保留导出，`:26-58`）。

---

## 4) 会话门控：`session-gate`

- **优先级（高→低）**：① `globalEnabled === false` 直接关（压过一切）；② 会话级覆盖（`/memory off`、输入框 chip、面板）；③ `disabledWorkspaces` 与 cwd 的路径边界匹配；④ 默认开。文档注释在 `session-gate.js:9-14`，实现是唯一入口 `effectiveEnabled`（`:204-210`）。
- **路径匹配**：按路径分隔符边界比较，`/x/work` 覆盖 `/x/work/repo` 但不覆盖 `/x/work2`；`~`/`%VAR%` 展开（`session-gate.js:64-78` → `paths.js:41-56`）；Windows 下 lower-case 比较（`:66-70`）。
- **持久化格式**：`<DSH_HOME>/memory-sessions.json`，`{version:1, sessions:{ [sessionId]: {enabled:boolean, updatedAt:number, cwd?} }}`（`session-gate.js:33`、`39-41`、`218-227`）；tmp+rename 原子写，写失败**吞掉**（`:225-230`）。载入时逐条校验类型，坏条目跳过而不是整文件放弃（`:112-121`）。
- **TTL**：`DEFAULT_TTL_DAYS = 7`（`:36`），可由 `sessionTtlDays` 覆盖（`docs/CONFIGURATION.md:31`）；`prune()` 删 `updatedAt < now - ttl` 的条目并在有删除时落盘（`:126-137`）；`getOverride` 对过期项**惰性删除**并返回 `undefined`（即回落到 workspace/默认，`:146-156`）。
- 细节：`toggle()` 的当前值取 `getOverride(id) ?? true`（`:189-194`）——它把「无覆盖」当作「开」，因此**在 `disabledWorkspaces` 命中的工作区里第一次 toggle 会得到 `false`**，方向可能和用户预期相反；这是设计取舍，未确认是否有意。

---

## 5) 安全 / 边界

**`paths.js` 不做越界校验**：`expandPath` 只做 `~`、`%VAR%`、`$HOME` 展开（`paths.js:41-56`），未知变量原样保留（`:47-53`），非字符串返回 `undefined`（`:42`）。也就是说**任何绝对路径都能通过**，安全边界完全不在这里：`config-store` 对 `memoryDir` 只校验「非空字符串」（`config-store.js:94`、`134-136`），用户可以把它指到任意目录——这是有意的可配置点，但意味着「库根」不可信。

**真正的围栏在 `reveal.js`**（`reveal.js:28-37`）：

1. `resolve(memoryDir)` 取根、`resolve(root, raw)` 取候选（`:29-32`）；
2. 空串或含 `\0` 直接拒（`:31`）；
3. `candidate === root` 或 `startsWith(root + sep)` 之外一律抛 `path escapes the memory store`（`:33`）；
4. 必须 `existsSync` 且 `isFile()`，目录/不存在都拒（`:34-35`）；
5. 只把**解析后的绝对路径**交给 `execFile(command, argsArray)`（`:44`、`66-74`），不经 shell，Windows 用 `/select,` 与路径分两个 argv 以免空格断裂（`:42-45`）。
   缺口：没有 `realpath`/符号链接解析，库内一个指向库外的 symlink 仍会被放行（`reveal.js:29-36`，未确认是否属于威胁模型）；Windows 上 `explorer` 退出码 1 被当作成功（`:70-73`），这是必要的兼容，但也意味着「命令真的失败」在该平台上无法区分。

**`config-store` 的原子写**（`config-store.js:178-189`）：`mkdirSync(recursive)` → 写 `${path}.tmp` → `renameSync` 覆盖；失败时抛 `config persisted in memory but not to disk`（`:184-188`）。三个注意点：

- **先改内存再落盘**：`update()` 在 `:142-161` 就替换了 `this.config`，`persist()`（`:161`）若抛错，watcher 循环（`:162-168`）不会执行，于是「内存新值、磁盘旧值、订阅者没收到通知」三者不一致，直到重启；
- 没有 `fsync`，掉电时 rename 语义由文件系统决定（未确认目标平台保证）；
- `load()` 对损坏文件**静默保留上次好配置**（`:83-90`、`:115-117`），不会把用户文件覆盖掉。

**写入原子性横向对照**：`soul.js:231-233`/`259-261`、`session-gate.js:225-227`、`proactive-lock.js:112-115`、`growth.js:197-199`、`config-store.js:181-183` 都是 tmp+rename；只有 `pages.js:121`（戳 `last_access`）和 `index-page.js:311` 是**原地 `writeFileSync`**，中途失败会截断用户页/index。

---

## 6) 对我们 AgentMemory 的可借鉴点与陷阱

### 可借鉴（5）

1. **受管块写用户文件**：机器只写 `<!-- ...:start/end -->` 围起来的三四个字段，其余正文逐字保留，插入点跳过 frontmatter 与 `# ` 标题，写回时按原文件的 CRLF 还原——`soul.js:162-174`、`180-200`、`226-233`。这套「机器字段 + 用户散文」共存的做法，比整文件模板化安全得多。
2. **一个谓词服务所有注入点**：`shouldInject` 把「用户开口了」「是活跃会话」两条合并（`activity-tracker.js:120-124`），`effectiveEnabled` 把三层开关合并（`session-gate.js:204-210`），boot 块/recall/digest 共用，避免三处各自判断导致口径不一。
3. **咨询式跨组件锁**：单个 JSON + tmp/rename + 「坏文件等于无锁」+「写不进去就放行」，再用 `deferredBy` 让调用方知道被谁让出——`proactive-lock.js:100-121`。这是零依赖解耦协作的好范式，可直接用于我们多个 watcher 之间的发言权。
4. **index 当路由表且只原地重写**：摘要一律取自页面自己声明的 `summary:`（绝不从正文猜，`index-page.js:135-149`），只重写已存在的行、新页只报告不插入（`:281-285`、`297-313`），把「编辑判断」留给人和模型，把「格式纪律」交给机器。
5. **「首次合格只上弦」与「让出不吃节奏」**：主动行为最容易被投诉的两件事就是「刚说完就插话」和「被拦一次就永远错过」，`recall-nudge.js:313-319` 与 `327-330`/`348-352` 分别给出了很轻的解法。

### 陷阱（5）

1. **文档承诺的字数与代码上限不一致**：80 字（`scaffold.js:159`、`skills/memory.md:18`）vs `INDEX_SUMMARY_MAX = 48`（`index-page.js:40`）。照文档写摘要会被静默截断，且 checkup 会把它算成漂移。
2. **协议文本里的字面 `\n`**（`skills/memory.md:20`）——模型读到的列表结构是坏的；同时 digest 判据仍写 `source.kind === 'plugin'`（`:27`），实现已改成 `plugin:memory`（`recall-nudge.js:118-121`）。这类「文档-实现漂移」会让模型照着错规则办事，比没有规则更糟。
3. **`last_access` 记账会污染其它信号**：`pages.js:121` 直接改写页面文件 → mtime 变化 → `growth.js:105-107` 把「本周改了几页」算高，`checkup` 的体量/新鲜度统计也会随之抖动。记账写盘如果和「内容写盘」共用一个时间戳维度，观测指标就会自激。另外这条写路径**非原子**（`pages.js:121`），与库内其它写入点不一致。
4. **配置先改内存后落盘**：`config-store.js:142-168` 在 `persist()` 抛错时既没回滚内存、也没通知 watcher，运行态与磁盘长期分叉；建议改成「落盘成功后再切换 + 通知」或至少把失败显式回传给 UI 状态。
5. **静默降级点太多**：`session-gate.js:228-230`、`proactive-lock.js:116-120`、`recall-nudge.js:368-380`、`config-store.js:83-90` 四处「失败即放行/即忽略」。单看每一处都合理（可用性优先），叠加起来会让「为什么不说话 / 为什么说了」几乎无法排查；我们做同类机制时应至少留一条可查询的降级原因，像 `deferredBy` 那样可观测。
