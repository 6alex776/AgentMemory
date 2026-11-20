/**
 * Markdown export.
 *
 * The point is portability and a thesis appendix: the file should read like a
 * person wrote it, not like a database dump.
 */

const KIND_LABEL = {
  profile: '用户背景',
  preference: '偏好',
  fact: '事实',
  decision: '决策',
  lesson: '经验',
  episode: '事件',
}

const STATUS_LABEL = { superseded: '已被新值替换', deleted: '已删除' }

/**
 * @param {object} state output of store.state()
 * @param {Date} at
 * @returns {string} markdown document
 */
export function renderMarkdown(state, at = new Date()) {
  const lines = [
    '# AgentMemory 记忆导出',
    '',
    `- 生成时间：${at.toISOString()}`,
    `- 生效记忆：${state?.counts?.total ?? 0} 条（全局 ${state?.counts?.global ?? 0} / 项目 ${state?.counts?.project ?? 0}）`,
    '',
  ]

  for (const group of Array.isArray(state?.groups) ? state.groups : []) {
    lines.push(`## ${group.title}`)
    lines.push('')
    for (const item of group.items) {
      const kind = KIND_LABEL[item.kind] ?? item.kind
      const meta = [kind, `重要度 ${item.importance}`]
      if (item.pinned) meta.push('已固定')
      if (item.topic_key) meta.push(`槽位 ${item.topic_key}`)
      lines.push(`- ${item.content}`)
      lines.push(`  <sub>${meta.join(' · ')}</sub>`)
    }
    lines.push('')
  }

  const retired = Array.isArray(state?.superseded) ? state.superseded : []
  if (retired.length > 0) {
    lines.push('## 已失效 / 已删除')
    lines.push('')
    for (const item of retired) {
      lines.push(`- ${item.content}`)
      lines.push(`  <sub>${STATUS_LABEL[item.status] ?? item.status}</sub>`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
