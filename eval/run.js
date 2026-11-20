/**
 * 评测脚本：跑 A 组（更新语义）与 B 组（跨会话指代），输出指标表与 markdown 报告。
 *
 *   node eval/run.js
 *
 * 每个用例用独立的临时数据库，避免用例之间互相污染。指标口径写在 README 的
 * 「评测」一节，论文里那张表就用这份脚本的输出。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEngine } from '../server/engine.js'
import { A_CASES, B_CASES, DISTRACTORS } from './cases.js'

const root = mkdtempSync(join(tmpdir(), 'agentmemory-eval-'))
const cwd = join(root, 'demo-project')
mkdirSync(cwd, { recursive: true })

let seq = 0
function withEngine(fn) {
  const dbFile = join(root, `case-${++seq}.db`)
  const engine = openEngine({ dbFile })
  try {
    return fn(engine)
  } finally {
    engine.close()
  }
}

const short = (text, limit = 26) => (text.length <= limit ? text : `${text.slice(0, limit)}…`)

// ---- A 组：更新语义 -------------------------------------------------------
const aRows = []
for (const item of A_CASES) {
  const row = withEngine((engine) => {
    const first = engine.save({ scope: 'project', cwd, kind: 'decision', topicKey: item.slot, content: item.old, importance: 4 })
    const second = engine.save({ scope: 'project', cwd, kind: 'decision', topicKey: item.slot, content: item.new, importance: 4 })
    const injected = engine.inject({ cwd, question: item.question })
    const text = injected.project.text
    const chain = engine.chain(item.slot, 'project')
    return {
      slot: item.slot,
      replaced: second.result.status === 'superseded' && second.result.replaced === first.result.id,
      oldGone: !text.includes(short(item.old, 12).replace('…', '')),
      newShown: text.includes(short(item.new, 10).replace('…', '')),
      chainOk: chain.length === 2 && chain[0].status === 'superseded' && chain[1].status === 'active',
      chars: injected.chars,
    }
  })
  aRows.push(row)
  console.log(`A ${row.replaced && row.oldGone && row.newShown && row.chainOk ? '✓' : '✗'} ${row.slot}`)
}

// ---- B 组：跨会话指代 -----------------------------------------------------
// 目标和干扰项都写成重要度 2（低于项目块门槛 3），所以它们不会进常驻块——
// 能不能出现在这一轮上下文里，完全取决于检索块。
const bRows = []
for (const [index, item] of B_CASES.entries()) {
  const row = withEngine((engine) => {
    const saved = engine.save({ scope: 'project', cwd, kind: 'fact', content: item.target, importance: 2 })
    for (let n = 0; n < 4; n += 1) {
      engine.save({ scope: 'project', cwd, kind: 'fact', content: DISTRACTORS[(index + n) % DISTRACTORS.length], importance: 2 })
    }
    const injected = engine.inject({ cwd, question: item.question })
    const projectId = engine.store.resolveProject(cwd)?.id
    const ranked = engine.search(item.question, { projectId, limit: 8 }).map((row2) => row2.id)
    return {
      question: item.question,
      hit: injected.retrieval.ids.includes(saved.result.id),
      top1: ranked[0] === saved.result.id,
      top3: ranked.slice(0, 3).includes(saved.result.id),
      emptyProject: injected.project.text.length === 0,
      chars: injected.chars,
      retrievalChars: injected.retrieval.chars,
    }
  })
  bRows.push(row)
  console.log(`B ${row.hit ? '✓' : '✗'} ${row.question}`)
}

// ---- 汇总 -----------------------------------------------------------------
const pct = (n, total) => `${((n / total) * 100).toFixed(1)}%`
const avg = (values) => (values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length))

const aSummary = {
  total: aRows.length,
  replaceRate: pct(aRows.filter((r) => r.replaced).length, aRows.length),
  oldGoneRate: pct(aRows.filter((r) => r.oldGone).length, aRows.length),
  newShownRate: pct(aRows.filter((r) => r.newShown).length, aRows.length),
  chainRate: pct(aRows.filter((r) => r.chainOk).length, aRows.length),
  avgChars: avg(aRows.map((r) => r.chars)),
}
const bSummary = {
  total: bRows.length,
  hitRate: pct(bRows.filter((r) => r.hit).length, bRows.length),
  top1: pct(bRows.filter((r) => r.top1).length, bRows.length),
  top3: pct(bRows.filter((r) => r.top3).length, bRows.length),
  emptyProject: pct(bRows.filter((r) => r.emptyProject).length, bRows.length),
  avgChars: avg(bRows.map((r) => r.chars)),
  avgRetrievalChars: avg(bRows.map((r) => r.retrievalChars)),
}

console.log('\n== A 更新语义 ==')
console.log(JSON.stringify(aSummary, null, 2))
console.log('\n== B 跨会话指代 ==')
console.log(JSON.stringify(bSummary, null, 2))

const lines = [
  '# 评测报告',
  '',
  `生成时间：${new Date().toISOString()}`,
  `用例：A 组 ${aRows.length} 条（更新语义）/ B 组 ${bRows.length} 条（跨会话指代）`,
  '',
  '## A 组：更新语义',
  '',
  '| 指标 | 值 | 口径 |',
  '| --- | --- | --- |',
  `| 替换正确率 | ${aSummary.replaceRate} | 二次写入返回 superseded 且 replaced 指向旧 id |`,
  `| 旧值不再出现 | ${aSummary.oldGoneRate} | 注入的项目块文本里不含旧值 |`,
  `| 新值可见 | ${aSummary.newShownRate} | 注入的项目块文本里含新值 |`,
  `| 版本链完整 | ${aSummary.chainRate} | 同一 topicKey 两条，旧=superseded、新=active |`,
  `| 平均注入字符 | ${aSummary.avgChars} | 项目块 + 身份块 + 检索块合计 |`,
  '',
  '| 槽位 | 替换 | 旧值消失 | 新值可见 | 版本链 | 注入字符 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...aRows.map((r) => `| ${r.slot} | ${r.replaced ? '✓' : '✗'} | ${r.oldGone ? '✓' : '✗'} | ${r.newShown ? '✓' : '✗'} | ${r.chainOk ? '✓' : '✗'} | ${r.chars} |`),
  '',
  '## B 组：跨会话指代',
  '',
  '| 指标 | 值 | 口径 |',
  '| --- | --- | --- |',
  `| 注入命中率 | ${bSummary.hitRate} | 目标出现在本轮检索块的 id 列表里 |`,
  `| 检索 Top-1 | ${bSummary.top1} | memory_search 第一条就是目标 |`,
  `| 检索 Top-3 | ${bSummary.top3} | 前三条含目标 |`,
  `| 常驻块不含目标 | ${bSummary.emptyProject} | 目标重要度 2 低于门槛 3，常驻块应为空 |`,
  `| 平均注入字符 | ${bSummary.avgChars} | 三段合计 |`,
  `| 平均检索块字符 | ${bSummary.avgRetrievalChars} | 只有检索块 |`,
  '',
  '| 问题 | 注入命中 | Top-1 | Top-3 | 检索块字符 |',
  '| --- | --- | --- | --- | --- |',
  ...bRows.map((r) => `| ${r.question} | ${r.hit ? '✓' : '✗'} | ${r.top1 ? '✓' : '✗'} | ${r.top3 ? '✓' : '✗'} | ${r.retrievalChars} |`),
  '',
  '## 说明',
  '',
  '- 用例是自建中文语料（`eval/cases.js`），不是 LongMemEval 翻译；规模小，适合证明机制，不适合宣称通用性能。',
  '- B 组每条 = 1 条目标 + 4 条无关干扰，5 条候选里选 1；这个规模下随机命中率约 20%。',
  '- 每个用例独立临时库，跑完即删；不读写真实记忆库。',
  '',
]

writeFileSync(join(import.meta.dirname, 'report.md'), lines.join('\n'), 'utf8')
console.log(`\n报告已写入 ${join(import.meta.dirname, 'report.md')}`)
rmSync(root, { recursive: true, force: true })
