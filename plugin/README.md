# AgentMemory

DSH 的跨会话长期记忆插件：侧栏一个「记忆」页面 + 每轮自动注入 + 给模型用的记忆工具。

## 它做什么

- **侧栏「记忆」页**：按「用户背景 / 偏好 / 决策 / 项目」分组展示当前生效的记忆，可搜索、添加、编辑、固定、删除、恢复、彻底删除；每条可展开版本历史并回滚。
- **概览**：点「生成概览」用一次模型调用把记忆压成一段话，结果缓存；记忆一变就提示「可能过期」（按生效集合的哈希判定，撤回后自动恢复为新鲜）。
- **整理建议（两步法）**：点「整理记忆」→ ① 模型只负责「按主题分组」；② 代码在同一组内按二元组相似度（默认 ≥0.6）聚类，把重复的合成一条（保留信息最全的那条）。**不直接改数据**，逐条「接受 / 忽略」后才落库。回合正常结束后也会自动跑，但有体积、间隔、待办三道闸门（见下文「后台整理」）。
- **渐进披露注入**：每条记忆有一个 ≤40 字的短摘要（`abstract`），注入只放摘要；正文要 `memory_get` / `memory_search` 才取。面板底部会显示上次注入的字符数，以及「若注入全文会是多少」。
- **两段常驻注入**：`【长期记忆·用户】`（全局 profile/preference，400 字符，会话内冻结）与 `【长期记忆·本项目】`（本项目 fact/decision/lesson、重要度 ≥3，800 字符，每轮重建）分开注入。身份信息不会被项目条目挤掉，而当轮写下的项目决策下一轮就生效。
- **注入带 id，可引用**：每条注入的记忆前面带 `[m_xxxxxxxxxxxx]`；模型可用 `memory_get` 按 id 取全文，回答里也能指明依据哪条。`includeIds: false` 可关。
- **时效与复核**：记忆可带 `expires_at`（工具参数 `expires_in_days`）；过期条目**不再注入**，面板标「已过期」。超过 `staleDays`（默认 90 天）没被确认/使用的标「待复核」，点「续期」恢复。
- **记忆工具**：`memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_update` / `memory_forget` / `memory_history`。
- **槽位更新**：带 `topic_key` 的记忆再次写入时，旧值转为 `superseded` 并保留版本，新值成为当前值。

## 数据在哪

`$DSH_HOME/agentmemory/memory.db`（默认 `C:\Users\<你>\.dsh\agentmemory\memory.db`）。单文件 SQLite，WAL 模式，可直接备份或删除后重建。

## 使用方式

1. 打开侧栏的「记忆」。
2. 点右上角「添加记忆」，或用默认的全局范围手动加一条。
3. 在任意会话里对助手说「记住：我本科是计算机专业」，助手会调用 `memory_save`。
4. 也可以直接点某条回答下面的「存入记忆」书签图标：浮层会带出这条回答的正文，改成一句话再保存（不经过模型，存什么就是什么）。
5. 新开一个会话，问「我的毕设方向是什么」，助手会拿到注入的记忆，也能用 `memory_search` 补充检索。

## 范围与限制

- **全局记忆是单机的**：以 `$DSH_HOME` 为边界，不同步到其它机器。
- **项目记忆按工作目录派生**：同一仓库的不同子目录会被视为不同项目。
- **注入只覆盖稳定事实**：身份块＝全局 `profile` / `preference`；项目块＝当前项目的 `fact` / `decision` / `lesson` 且 `importance >= projectMinImportance`（默认 3）。完整内容仍需 `memory_search`。
- **自动记录是有选择的**：靠信号词 + 长度 + 重复检测 + 冷却四道闸门，只对「像是长期事实」的句子发一次小模型调用；普通闲聊零调用。只在**回合结束且缓冲 ≥300 字符**时触发。
- **身份块按会话冻结**：默认 `coreSnapshot: 'session'`，会话中途新增的用户背景/偏好不会立刻出现在上下文里（新会话可见），代价换的是不反复重写提示词前缀。项目块不受此限，每轮重建。
- **子代理不写入**：`header.origin === 'subagent'` 的会话不注入，也不自动保存。

## 配置

在 profile 的 `cordis.patch.yml` 里给这一行加 `config`（不需要 schema，键都在 `apply(ctx, config)` 里读）：

```yaml
- insert:
    - id: agentmemory
      name: 'dsh-agentmemory'
      config:
        dbPath: 'D:/backup/agentmemory.db'   # 默认 $DSH_HOME/agentmemory/memory.db
        identityMaxChars: 400                 # 【长期记忆·用户】字符上限
        projectBlock: true                    # 是否注入【长期记忆·本项目】这一段
        projectMaxChars: 800                  # 项目块字符上限
        projectMinImportance: 3               # 项目块只收重要度 ≥ 此值的条目
        # maxInjectChars: 1200                # 旧版单一上限；仍可写，会被当作 identityMaxChars 的兜底
        coreSnapshot: session                # session（默认，会话内冻结）| live（每次重算）
        allowRemote: false                    # 面板路由默认只接受本机回环
        overviewProvider: deepseek-account    # 概览/抽取用哪个模型；留空用默认模型
        overviewModel: deepseek-flash
        autoCapture: true                     # false 则完全不自动记录
        captureMinChars: 60                   # 缓冲里至少这么多字符才值得抽取
        captureTurnChars: 300                 # 回合结束时缓冲达到这么多字符就抽一次
        captureIdleMinutes: 8                 # 兜底：会话空闲多久后触发一次抽取
        retrieval: true                       # 关闭则不做按问题检索
        retrievalMaxChars: 600                # 检索块字符上限
        retrievalLimit: 4                     # 最多注入几条
        mergeSimilarity: 0.6                  # 整理时判定「同一条」的相似度阈值
        autoDream: true                       # 回合结束后自动跑一次整理（有闸门）
        dreamIntervalDays: 7                  # 距上次自动整理至少这么多天才再跑
        dreamMinMemories: 8                   # 生效记忆少于这么多条就不跑
        includeIds: true                      # 注入里是否带 [m_xxxx] 引用 id
        staleDays: 90                         # 多久没确认就标「待复核」，0 关闭
```

## 会话级开关

```
/memory off     本会话不再注入、不再检索、不再自动记录
/memory on      恢复
/memory status  查看当前状态
```

开关存在数据库 `session_flag` 表里（重启后仍然有效），命中后注入块、检索块、自动记录三处全部跳过。命令走 DSH 的命令面，不进入模型上下文。

## 面板底部的状态行

- **上次检查 / 待整理 N 字符**：回合结束时缓冲没达到阈值也会留一行时间，并写明原因（「没有记忆信号」「信号文本不足（12/300 字符）」），所以「为什么没自动记录」在面板上能直接看到；缓冲够了就点「立即提取」立刻跑一次。
- **上次整理**：显示上次自动整理的时间与新增建议数；还没跑过时显示闸门原因（「记忆还不够 8 条」/「还有 2 条整理建议没处理」）。
- **导出 Markdown**：把全部记忆（含已失效/已删除）下载成一份可读的 `.md`，论文附录直接用。

## 后台整理（自动）

每条 `turn/end`（正常完成）之后都会问一次要不要整理，但默认极少真的跑：

- 生效记忆 ≥ `dreamMinMemories`（8 条）；
- 距上次整理 ≥ `dreamIntervalDays`（7 天）——这个时间写在 `meta` 表里，重启插件不会重置；
- 当前没有待处理的整理建议（否则会不断堆重复卡片）。

三条都满足才调一次「分组」小模型，产出的建议仍然要你逐条「接受 / 忽略」。没跑时把原因记在状态行；失败了也只写状态行，不影响对话。

## 回答下方的「存入记忆」

每条回答的动作行里多一个书签图标（`conversation.chat.assistant-actions`，order 30）：

- 点开时客户端只有 `messageId`/`sessionId`，正文由 Host 从会话日志里读出来（`GET /api/agentmemory/message`），填进浮层的 textarea；
- 只保留 `text` 块，reasoning 与工具调用不会进记忆；
- 保存走 `POST /api/agentmemory/save`，**不经过模型**——存进去的就是你改过的那句话，`origin: 'user'`；
- 选「本项目」时会用会话的 `cwd` 找/建项目，找不到目录就报错而不是静默存成全局；
- 手存也过一遍密钥检测（`sk-…` / `AKIA…` / 私钥头 / `password=…`），命中直接拒绝，不进库。

## 按问题检索（per-turn）

核心块是会话级、稳定的；另外还有一块**按当前问题检索**的内容，走独立的 `systemPrompt.context`（order 900）：

- 取本会话最近一条用户消息作为 query；
- 检索当前项目 + 全局记忆，取前 N 条；
- 去掉已经在核心块里的条目（按 id 和文本相似度双重去重）；
- 预算 `retrievalMaxChars`（默认 600 字符），一条都没命中就不注入。

中文查询做了三件事：**缩写展开**（毕设→毕业设计、大模型→大语言模型…）、**停用二元组过滤**（什么/怎么/哪一…）、**OR 匹配 + 覆盖率 ≥0.34 过滤**。只做 AND 的话「我毕设做到哪一步了」这种自然问句一条都命中不了。

实测：

| 查询 | 命中 | 注入字符 |
|---|---|---|
| 我毕设做到哪一步了 | 2 | 142 |
| 存储用什么 | 1 | 84 |
| 毕业设计进度 | 2 | 142 |
| 机器学习 | 0 | 0 |

调试用：`GET /api/agentmemory/retrieve?q=...` 可以直接看到某条 query 会注入什么。

## 自动记录怎么省 token

记忆不是每轮都写，而是**缓冲区攒够一段、且一轮结束**时才写一次——和 ChatGPT 的后台合成是一个思路。

缓冲阶段（零调用）：

1. **本地信号词**：只有「我是 / 我喜欢 / 以后都 / 改成 / 计划 / 记住…」这类句子进缓冲，问句直接丢。
2. **重复检测**：与现有记忆的二元组 Jaccard ≥0.72，直接跳过。

写入阶段（一次调用）：

3. **回合结束**时缓冲区 ≥ `captureTurnChars`（默认 300 字符）就立刻抽取——这是实际会发生的触发点；会话空闲 `captureIdleMinutes`（默认 8 分钟）或会话关闭只是兜底，工作型会话里几乎等不到空闲。
4. 抽取结果仍要过置信度 / 长度 / 问句 / 密钥四道校验才落库。

所以一次长对话通常是每几轮一次抽取调用，而不是每轮一次，也不是等到会话结束才写。想立刻跑一次就点面板上的「立即提取」。

读取侧：注入块默认 `coreSnapshot: 'session'`，会话内只渲染一次；本轮新写入的记忆在**下一个会话**才会出现。想立刻看到就设 `live`，代价是每次记忆变化都会重写一次上下文快照。

## 每轮结束的「记忆」提示

一轮回答结束后，输入框上方会多一行小标签（`conversation.chat.turnTail`，order 30），例如「记忆 · 检索 2 条 · 新增 1 条」：

- 点开能看到这一轮**实际注入了什么**：按这句话检索到的条目（类别 + 摘要），以及这轮结束后该会话新存入的条数；
- 数据来自 `turn_trace` 表：每轮 `turn/end` 时写一行，记下本轮的问题、注入的核心块 id、检索块 id 与字符数、回合开始时间；
- 这一轮既没检索到记忆、也没新增时**整行不出现**，不给普通闲聊加噪音；
- 「新增」按时间窗口实时重算（本轮到下一轮开始之间、来源会话等于本会话的记忆数），所以点开时看到的是最新数字。

## 数据与迁移

- 库在 `$DSH_HOME/agentmemory/memory.db`，WAL 模式，单文件。
- `meta.schema_version` 目前是 **8**（v1 记忆表 / v2 概览缓存 / v3 `abstract` / v4 整理建议 / v5 使用反馈 / v6 会话开关 / v7 时效与复核 / v8 每轮轨迹 `turn_trace`）。打开时若发现库版本高于插件支持版本，**直接拒绝打开**而不是降级写入。
- 新增字段时在 `lib/store.js` 的 `SCHEMA_VERSION` 上追加迁移，不要改历史表定义。

## 测试

```
cd plugin && npm test
```

89 个用例（34 store + 14 capture + 6 retrieval + 13 dream + 3 export + 7 lifecycle + 5 session-text + 7 block），覆盖：槽位替换、内容判重、墓碑、Git 项目归一、会话开关、时效与复核、项目隔离、中文二字检索、版本回滚、恢复、彻底删除、概览哈希、整理建议的聚类与合并、自动整理的体积/间隔/待办三道闸门、整理时间戳跨重启保留、每轮轨迹的写入与补丁、回合窗口内的新增计数、信号词命中/问句丢弃、回合结束的抽取闸门、检索块去重与预算、Markdown 导出、「拒绝打开更新版本的库」、从会话日志里取回答正文、身份块/项目块的取材与预算。

> 在 DSH 的 workspace-write 沙箱里跑 `node --test` 会因为子进程 `spawn EPERM` 失败，所以脚本直接执行测试文件（单进程）。

## 安全边界

面板路由（`/api/agentmemory/*`）**默认只接受 127.0.0.1 / ::1**；非本机来源返回 403。若把 DSH 暴露到局域网并确实需要远程访问面板，才设置 `allowRemote: true`——那等于把全部记忆的读写权限开放给能访问端口的人。

## 卸载

禁用插件会立即停止注入与工具；数据库文件保留在磁盘，需要的话手动删除。

## 已知限制

- 客户端文案目前只有中文，没有走 locale 服务。
- 概览生成依赖默认模型；模型不可用时按钮会报错，不影响其余功能。
- 「存入记忆」只挂在最终回答上；工具调用过程中的中间消息没有入口。
- 后台整理依赖默认模型；模型不可用时只在面板状态行里显示失败原因，不会重试。

## 开发

```
index.js           Host 插件：路由、注入、工具、概览生成
lib/block.js       两段常驻注入的渲染（身份块 / 项目块）
lib/store.js       SQLite 存储（memory / memory_version / memory_summary / turn_trace / FTS）
lib/bigram.js      CJK 二元组检索文本（FTS5 trigram 对两字词无效）
lib/session-text.js 从会话日志里取一条回答的正文（只保留 text 块）
client.js          浏览器半：sidebar.panellist + main + assistant-actions + turnTail 四个 slot
```

零构建：`client.js` 直接是 `window.__ModuleLoader__.load` 格式，没有打包步骤，也没有原生依赖。
