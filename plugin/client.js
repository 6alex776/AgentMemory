/**
 * AgentMemory — browser half.
 *
 * Registers two slots:
 *   sidebar.panellist  id "agentmemory" → the nav row (icon only; the shell owns the button)
 *   main               key "agentmemory" → the 记忆 page
 *
 * Data comes from the Host plugin's own same-origin routes; the client never
 * touches the database or the file system.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agentmemory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const STATE_URL = '/api/agentmemory/state'
    const MUTATE_URL = '/api/agentmemory/mutate'
    const HISTORY_URL = '/api/agentmemory/history'
    const SUMMARIZE_URL = '/api/agentmemory/summarize'
    const DREAM_URL = '/api/agentmemory/dream'
    const TURN_URL = '/api/agentmemory/turn'

    const OP_LABELS = {
      create: '创建',
      update: '编辑',
      supersede: '被新值替换',
      rollback: '回滚',
      delete: '删除',
      restore: '恢复',
      pin: '固定状态变更',
      merge: '合并',
      expire: '失效',
      purge: '彻底删除',
    }

    function formatDateTime(ts) {
      const date = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    const KIND_OPTIONS = [
      ['profile', '用户背景'],
      ['preference', '偏好'],
      ['fact', '事实'],
      ['decision', '决策'],
      ['lesson', '经验'],
      ['episode', '事件'],
    ]

    const color = {
      base: 'var(--dsw-alias-bg-base)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
    }

    function relativeTime(ts, now) {
      if (!ts) return '刚刚'
      const diff = Math.max(0, (now || Date.now()) - ts)
      const minute = 60 * 1000
      const hour = 60 * minute
      const day = 24 * hour
      if (diff < minute) return '刚刚'
      if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
      if (diff < day) return `${Math.floor(diff / hour)} 小时前`
      if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
      const date = new Date(ts)
      return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
    }

    async function request(url, options) {
      const response = await fetch(url, options)
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
      return body
    }

    // ------------------------------------------------------------ nav icon
    // An open book: two facing pages with a few ruled lines.
    function MemoryIcon(props) {
      const size = (props && props.size) || 20
      const active = Boolean(props && props.active)
      const stroke = {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.55,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.8 },
      },
        h('path', {
          ...stroke,
          d: 'M12 6.9c-1.5-1.2-3.8-1.8-6.6-1.6v12.6c2.8-.2 5.1.4 6.6 1.6 1.5-1.2 3.8-1.8 6.6-1.6V5.3c-2.8-.2-5.1.4-6.6 1.6Z',
        }),
        h('path', { ...stroke, d: 'M12 6.9v12.6' }),
        h('path', { ...stroke, d: 'M7.6 9.2c.9.1 1.7.4 2.4.7' }),
        h('path', { ...stroke, d: 'M7.6 12.1c.9.1 1.7.4 2.4.7' }),
        h('path', { ...stroke, d: 'M16.4 9.2c-.9.1-1.7.4-2.4.7' }),
        h('path', { ...stroke, d: 'M16.4 12.1c-.9.1-1.7.4-2.4.7' }),
      )
    }

    // ------------------------------------------------------------ small parts
    function Pill(props) {
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          height: 20,
          padding: '0 8px',
          borderRadius: 999,
          fontSize: 11,
          lineHeight: '20px',
          color: color.muted,
          background: color.layer2,
          border: `1px solid ${color.border}`,
          whiteSpace: 'nowrap',
        },
      }, props.children)
    }

    function TextButton(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled,
        title: props.title,
        style: {
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: props.tone || color.muted,
          fontSize: 12.5,
          padding: '4px 6px',
          borderRadius: 6,
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.5 : 1,
        },
        onMouseEnter: (event) => { event.currentTarget.style.background = color.layer2 },
        onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
      }, props.children)
    }

    function PrimaryButton(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled,
        style: {
          appearance: 'none',
          border: `1px solid ${props.disabled ? color.border : color.borderStrong}`,
          background: color.layer2,
          color: color.text,
          fontSize: 13,
          fontWeight: 600,
          height: 32,
          padding: '0 14px',
          borderRadius: 8,
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.45 : 1,
          whiteSpace: 'nowrap',
        },
        onMouseEnter: (event) => {
          if (!props.disabled) event.currentTarget.style.background = color.layer1
        },
        onMouseLeave: (event) => {
          if (!props.disabled) event.currentTarget.style.background = color.layer2
        },
      }, props.children)
    }

    // ------------------------------------------------------------ page
    function MemoryPanel() {
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [query, setQuery] = useState('')
      const [editingId, setEditingId] = useState('')
      const [draft, setDraft] = useState('')
      const [confirmId, setConfirmId] = useState('')
      const [adding, setAdding] = useState(false)
      const [addDraft, setAddDraft] = useState('')
      const [addKind, setAddKind] = useState('profile')
      const [addScope, setAddScope] = useState('global')
      const [saving, setSaving] = useState(false)
      const [showTrash, setShowTrash] = useState(false)
      const [purgeConfirmId, setPurgeConfirmId] = useState('')
      const [historyId, setHistoryId] = useState('')
      const [historyRows, setHistoryRows] = useState([])
      const [historyLoading, setHistoryLoading] = useState(false)
      const [expanded, setExpanded] = useState({})
      const [summarizing, setSummarizing] = useState(false)
      const [dreaming, setDreaming] = useState(false)
      const [flushing, setFlushing] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const next = await request(STATE_URL)
          setState(next)
          setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const mutate = useCallback(async (payload) => {
        setSaving(true)
        try {
          const response = await request(MUTATE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (response.state) setState(response.state)
          setError('')
          return response.result
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          return undefined
        } finally {
          setSaving(false)
        }
      }, [])

      const groups = useMemo(() => {
        if (!state || !Array.isArray(state.groups)) return []
        const needle = query.trim().toLowerCase()
        if (needle.length === 0) return state.groups
        return state.groups
          .map((group) => ({
            ...group,
            items: group.items.filter((item) => String(item.content).toLowerCase().includes(needle)),
          }))
          .filter((group) => group.items.length > 0)
      }, [state, query])

      const startEdit = (item) => {
        setEditingId(item.id)
        setDraft(item.content)
        setConfirmId('')
        setAdding(false)
        setHistoryId('')
      }

      const loadHistory = async (item) => {
        setHistoryLoading(true)
        setHistoryRows([])
        try {
          const data = await request(`${HISTORY_URL}?id=${encodeURIComponent(item.id)}`)
          setHistoryRows(Array.isArray(data.versions) ? data.versions : [])
          setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setHistoryLoading(false)
        }
      }

      const openHistory = (item) => {
        if (historyId === item.id) {
          setHistoryId('')
          return
        }
        setHistoryId(item.id)
        setEditingId('')
        setConfirmId('')
        loadHistory(item)
      }

      const rollbackTo = async (item, version) => {
        const result = await mutate({ op: 'rollback', id: item.id, versionId: version.id })
        if (result && result.ok === true) await loadHistory(item)
      }

      const saveEdit = async () => {
        if (draft.trim().length === 0) return
        await mutate({ op: 'update', id: editingId, content: draft.trim() })
        setEditingId('')
        setDraft('')
      }

      const submitAdd = async () => {
        if (addDraft.trim().length === 0) return
        const payload = { op: 'add', content: addDraft.trim(), kind: addKind, scope: addScope, importance: 4 }
        if (addScope === 'project') {
          if (!state || state.projects.length === 0) {
            setError('还没有项目记忆：先在会话里让助手保存一条项目范围内的记忆')
            return
          }
          payload.projectId = state.projects[0].id
        }
        await mutate(payload)
        setAddDraft('')
        setAdding(false)
      }

      const counts = (state && state.counts) || { total: 0, global: 0, project: 0, superseded: 0 }

      const runDream = async () => {
        setDreaming(true)
        try {
          const response = await request(DREAM_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          if (response.state) setState(response.state)
          if (response.ok === false) setError(response.error || '整理失败')
          else if (Array.isArray(response.created) && response.created.length === 0) setError('这次没有发现值得整理的内容')
          else setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setDreaming(false)
        }
      }

      const decide = async (proposal, accept) => {
        await mutate({ op: 'decide', id: proposal.id, accept })
      }

      const flushNow = async () => {
        setFlushing(true)
        try {
          const response = await request('/api/agentmemory/flush', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          if (response.state) setState(response.state)
          if (response.ok === false) setError(response.error || '提取失败')
          else setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setFlushing(false)
        }
      }

      const exportMarkdown = () => {
        const link = document.createElement('a')
        link.href = `/api/agentmemory/export?t=${Date.now()}`
        link.download = ''
        link.style.display = 'none'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
      }

      const generateOverview = async () => {
        setSummarizing(true)
        try {
          const response = await request(SUMMARIZE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          if (response.state) setState(response.state)
          else if (response.summary && state) setState({ ...state, summary: response.summary })
          if (response.ok === false) setError(response.error || '生成失败')
          else setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setSummarizing(false)
        }
      }

      const renderItem = (item) => {
        const isEditing = editingId === item.id
        const isConfirming = confirmId === item.id
        return h('div', {
          key: item.id,
          style: { padding: '10px 0', borderBottom: `1px solid ${color.border}` },
        },
          isEditing
            ? h('div', null,
              h('textarea', {
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                rows: Math.min(8, Math.max(2, Math.ceil(draft.length / 46))),
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  fontSize: 14,
                  lineHeight: 1.7,
                  color: color.text,
                  background: color.layer2,
                  border: `1px solid ${color.borderStrong}`,
                  borderRadius: 8,
                  padding: '10px 12px',
                  outline: 'none',
                  fontFamily: 'inherit',
                },
              }),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                h(PrimaryButton, { onClick: saveEdit, disabled: saving || draft.trim().length === 0 }, '保存'),
                h(TextButton, { onClick: () => { setEditingId(''); setDraft('') } }, '取消'),
              ),
            )
            : h('div', {
              style: { display: 'flex', alignItems: 'flex-start', gap: 12 },
              onMouseEnter: (event) => {
                const actions = event.currentTarget.lastChild
                if (actions) actions.style.opacity = '1'
              },
              onMouseLeave: (event) => {
                const actions = event.currentTarget.lastChild
                if (actions) actions.style.opacity = '0'
              },
            },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', {
                  style: {
                    fontSize: 14,
                    lineHeight: 1.7,
                    color: color.text,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: item.content.length > 72 && expanded[item.id] !== true ? 2 : 'unset',
                    overflow: 'hidden',
                  },
                }, item.content),
                item.content.length > 72
                  ? h('button', {
                    type: 'button',
                    onClick: () => setExpanded({ ...expanded, [item.id]: expanded[item.id] !== true }),
                    style: {
                      appearance: 'none',
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      marginTop: 2,
                      fontSize: 11.5,
                      color: color.muted,
                      cursor: 'pointer',
                    },
                  }, expanded[item.id] === true ? '收起' : '展开')
                  : null,
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' } },
                  item.pinned ? h(Pill, null, '已固定') : null,
                  item.expired ? h(Pill, null, '已过期') : (item.stale ? h(Pill, null, '待复核') : null),
                  item.origin === 'agent' ? h(Pill, null, '自动记录') : null,
                  h('span', { style: { fontSize: 11, color: color.muted } },
                    `${relativeTime(item.updated_at, state && state.now)}更新`
                    + (item.use_count > 0 ? ` · 用过 ${item.use_count} 次` : '')
                    + (item.importance >= 4 ? ` · 重要度 ${item.importance}` : '')),
                ),
                historyId === item.id
                  ? h('div', {
                    style: {
                      marginTop: 10,
                      paddingLeft: 10,
                      borderLeft: `2px solid ${color.border}`,
                    },
                  },
                    historyLoading
                      ? h('div', { style: { fontSize: 12, color: color.muted } }, '读取历史…')
                      : historyRows.length === 0
                        ? h('div', { style: { fontSize: 12, color: color.muted } }, '没有历史记录')
                        : historyRows.map((version) => h('div', {
                          key: version.id,
                          style: {
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 10,
                            padding: '5px 0',
                          },
                        },
                          h('div', {
                            style: {
                              width: 88,
                              flexShrink: 0,
                              fontSize: 11.5,
                              lineHeight: '18px',
                              color: color.muted,
                            },
                          }, formatDateTime(version.at)),
                          h('div', {
                            style: {
                              width: 72,
                              flexShrink: 0,
                              fontSize: 11.5,
                              lineHeight: '18px',
                              color: color.muted,
                            },
                          }, OP_LABELS[version.op] ?? version.op),
                          h('div', {
                            style: {
                              flex: 1,
                              minWidth: 0,
                              fontSize: 12.5,
                              lineHeight: '18px',
                              color: color.muted,
                              wordBreak: 'break-word',
                            },
                          }, version.content.length > 0 ? version.content : '（无内容）'),
                          version.content.length > 0
                            ? h(TextButton, { onClick: () => rollbackTo(item, version) }, '回到这一版')
                            : null,
                        )),
                  )
                  : null,
              ),
              h('div', {
                style: {
                  display: 'flex',
                  gap: 2,
                  opacity: 0,
                  transition: 'opacity 120ms ease',
                  flexShrink: 0,
                },
              },
                isConfirming
                  ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                    h('span', { style: { fontSize: 12, color: color.muted } }, '删除？'),
                    h(TextButton, {
                      tone: color.danger,
                      onClick: async () => { await mutate({ op: 'delete', id: item.id }); setConfirmId('') },
                    }, '确定'),
                    h(TextButton, { onClick: () => setConfirmId('') }, '取消'),
                  )
                  : h('div', { style: { display: 'flex' } },
                    h(TextButton, { onClick: () => openHistory(item) }, historyId === item.id ? '收起历史' : '历史'),
                    (item.expired || item.stale)
                      ? h(TextButton, {
                        onClick: async () => { await mutate({ op: 'verify', id: item.id }) },
                      }, '续期')
                      : null,
                    h(TextButton, { onClick: () => startEdit(item) }, '编辑'),
                    h(TextButton, {
                      onClick: async () => { await mutate({ op: 'pin', id: item.id, pinned: !item.pinned }) },
                    }, item.pinned ? '取消固定' : '固定'),
                    h(TextButton, { tone: color.danger, onClick: () => setConfirmId(item.id) }, '删除'),
                  ),
              ),
            ),
        )
      }

      const renderAddForm = () => h('div', {
        style: {
          margin: '16px 0 8px',
          padding: 14,
          borderRadius: 12,
          background: color.layer1,
          border: `1px solid ${color.border}`,
        },
      },
        h('textarea', {
          autoFocus: true,
          value: addDraft,
          placeholder: '例如：用户本科是计算机专业，毕设方向是湖仓一体金融分析看板',
          onChange: (event) => setAddDraft(event.target.value),
          rows: 3,
          style: {
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            fontSize: 14,
            lineHeight: 1.7,
            color: color.text,
            background: color.layer2,
            border: `1px solid ${color.border}`,
            borderRadius: 8,
            padding: '10px 12px',
            outline: 'none',
            fontFamily: 'inherit',
          },
        }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('select', {
            value: addKind,
            onChange: (event) => setAddKind(event.target.value),
            style: selectStyle,
          }, KIND_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label))),
          h('select', {
            value: addScope,
            onChange: (event) => setAddScope(event.target.value),
            style: selectStyle,
          },
            h('option', { value: 'global' }, '全局'),
            h('option', { value: 'project' }, '当前项目'),
          ),
          h('div', { style: { flex: 1 } }),
          h(TextButton, { onClick: () => { setAdding(false); setAddDraft('') } }, '取消'),
          h(PrimaryButton, { onClick: submitAdd, disabled: saving || addDraft.trim().length === 0 }, '保存'),
        ),
      )

      const renderProposals = () => {
        const proposals = (state && state.proposals) || []
        if (proposals.length === 0) return null
        return h('div', {
          style: {
            marginTop: 12,
            padding: 16,
            borderRadius: 12,
            background: color.layer1,
            border: `1px solid ${color.border}`,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: color.text } }, `整理建议（${proposals.length}）`),
            h('div', { style: { flex: 1, fontSize: 11.5, color: color.muted } }, '接受后才会写入记忆'),
          ),
          proposals.map((proposal) => {
            const payload = proposal.payload || {}
            const preview = proposal.op === 'merge'
              ? `合并 ${Array.isArray(payload.ids) ? payload.ids.length : 0} 条为：${payload.content || ''}`
              : `建议失效：${payload.content || payload.id || ''}`
            return h('div', {
              key: proposal.id,
              style: {
                marginTop: 10,
                paddingTop: 10,
                borderTop: `1px solid ${color.border}`,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
              },
            },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', {
                  style: {
                    fontSize: 13.5,
                    lineHeight: 1.7,
                    color: color.text,
                    wordBreak: 'break-word',
                  },
                }, preview),
                proposal.reason
                  ? h('div', { style: { marginTop: 3, fontSize: 11.5, color: color.muted } }, proposal.reason)
                  : null,
              ),
              h('div', { style: { display: 'flex', gap: 4, flexShrink: 0 } },
                h(TextButton, { onClick: () => decide(proposal, true) }, '接受'),
                h(TextButton, { onClick: () => decide(proposal, false) }, '忽略'),
              ),
            )
          }),
        )
      }

      const renderOverview = () => {
        if (!state) return null
        const summary = state.summary || {}
        const has = typeof summary.content === 'string' && summary.content.length > 0
        return h('div', {
          style: {
            marginTop: 18,
            padding: 16,
            borderRadius: 12,
            background: color.layer1,
            border: `1px solid ${color.border}`,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: color.text } }, '概览'),
            h('div', { style: { flex: 1, fontSize: 11.5, color: color.muted } },
              has && summary.generatedAt
                ? `${relativeTime(summary.generatedAt, state.now)}生成 · ${summary.model || '模型'}`
                : '尚未生成'),
            h(PrimaryButton, {
              onClick: generateOverview,
              disabled: summarizing || counts.total === 0,
            }, summarizing ? '生成中…' : (has ? '重新生成' : '生成概览')),
          ),
          has
            ? h('div', {
              style: {
                marginTop: 10,
                fontSize: 14,
                lineHeight: 1.85,
                color: color.text,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            }, summary.content)
            : h('div', {
              style: {
                marginTop: 10,
                fontSize: 13,
                lineHeight: 1.8,
                color: color.muted,
              },
            }, '用一次模型调用把现有记忆压缩成一段摘要。结果会缓存，只有记忆变了才提示重新生成。'),
          summary.stale
            ? h('div', {
              style: {
                marginTop: 10,
                fontSize: 12,
                color: 'var(--dsw-alias-state-warn-primary)',
              },
            }, '记忆已变更，这段概览可能过期。')
            : null,
        )
      }

      return h('div', {
        style: {
          height: '100%',
          overflow: 'auto',
          background: color.base,
          color: color.text,
        },
      },
        h('div', {
          style: {
            maxWidth: 720,
            margin: '0 auto',
            padding: '40px 32px 96px',
            boxSizing: 'border-box',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
            h('div', { style: { flex: 1 } },
              h('h1', { style: { margin: 0, fontSize: 26, lineHeight: 1.3, fontWeight: 600, letterSpacing: -0.2 } }, '记忆'),
              h('div', { style: { marginTop: 6, fontSize: 12.5, color: color.muted } },
                state
                  ? `内容更新于 ${relativeTime(state.updatedAt, state.now)} · 最近使用 ${state.usedAt ? relativeTime(state.usedAt, state.now) : '还没用过'} · 共 ${counts.total} 条 · 全局 ${counts.global} / 项目 ${counts.project}`
                  : '正在读取…'),
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, paddingTop: 4 } },
              h(TextButton, { onClick: runDream, disabled: dreaming || counts.total < 2 }, dreaming ? '整理中…' : '整理记忆'),
              h(PrimaryButton, {
                onClick: () => { setAdding(!adding); setAddDraft(''); setEditingId('') },
              }, adding ? '收起' : '添加记忆'),
            ),
          ),

          renderOverview(),
          renderProposals(),

          h('div', { style: { marginTop: 18 } },
            h('input', {
              value: query,
              placeholder: '搜索记忆',
              onChange: (event) => setQuery(event.target.value),
              style: {
                width: '100%',
                boxSizing: 'border-box',
                height: 38,
                padding: '0 12px',
                fontSize: 13.5,
                color: color.text,
                background: color.layer1,
                border: `1px solid ${color.border}`,
                borderRadius: 10,
                outline: 'none',
              },
            }),
          ),

          error.length > 0
            ? h('div', {
              style: {
                marginTop: 12,
                padding: '10px 12px',
                borderRadius: 8,
                fontSize: 12.5,
                color: color.danger,
                background: color.layer2,
                border: `1px solid ${color.border}`,
              },
            }, error)
            : null,

          adding ? renderAddForm() : null,

          loading && state === null
            ? h('div', { style: { marginTop: 28, fontSize: 13, color: color.muted } }, '正在读取记忆…')
            : null,

          groups.map((group) => h('section', { key: group.key, style: { marginTop: 28 } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 } },
              h('h2', {
                style: {
                  margin: 0,
                  fontSize: 17,
                  lineHeight: 1.4,
                  fontWeight: 600,
                  color: color.text,
                },
              }, group.title),
              h('span', { style: { fontSize: 11.5, color: color.muted } }, `${group.items.length} 条`),
              h('span', { style: { fontSize: 11.5, color: color.muted, opacity: 0.65 } }, group.subtitle),
            ),
            group.items.map(renderItem),
          )),

          state !== null && groups.length === 0 && !loading
            ? h('div', {
              style: {
                marginTop: 40,
                padding: '28px 20px',
                textAlign: 'center',
                borderRadius: 12,
                border: `1px dashed ${color.border}`,
                color: color.muted,
                fontSize: 13,
                lineHeight: 1.8,
              },
            },
              query.trim().length > 0
                ? h('div', null, `没有匹配「${query.trim()}」的记忆`)
                : h('div', null,
                  h('div', { style: { fontSize: 14, color: color.text, marginBottom: 6 } }, '还没有任何记忆'),
                  h('div', null, '在对话里说「记住……」让助手保存，或点右上角「添加记忆」。'),
                  h('div', null, '记忆会自动出现在之后每个新会话的上下文里。'),
                ),
            )
            : null,

          state !== null && Array.isArray(state.superseded) && state.superseded.length > 0
            ? h('section', { style: { marginTop: 40 } },
              h('div', {
                onClick: () => setShowTrash(!showTrash),
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontSize: 12.5,
                  color: color.muted,
                },
              },
                h('span', { style: { transform: showTrash ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' } }, '▶'),
                `已失效或被删除的记忆（${state.superseded.length}）`,
              ),
              showTrash
                ? h('div', { style: { marginTop: 8 } },
                  state.superseded.map((item) => h('div', {
                    key: item.id,
                    style: {
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '8px 0',
                      borderBottom: `1px solid ${color.border}`,
                    },
                  },
                    h('div', { style: { flex: 1, minWidth: 0 } },
                      h('div', {
                        style: {
                          fontSize: 13,
                          lineHeight: 1.7,
                          color: color.muted,
                          textDecoration: item.status === 'deleted' ? 'line-through' : 'none',
                          wordBreak: 'break-word',
                        },
                      }, item.content),
                      h('div', { style: { fontSize: 11, color: color.muted, marginTop: 2 } },
                        item.status === 'deleted' ? '已删除' : '已被新值替换'),
                    ),
                    purgeConfirmId === item.id
                      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 } },
                        h(TextButton, {
                          tone: color.danger,
                          onClick: async () => { await mutate({ op: 'purge', id: item.id }); setPurgeConfirmId('') },
                        }, '彻底删除'),
                        h(TextButton, { onClick: () => setPurgeConfirmId('') }, '取消'),
                      )
                      : h('div', { style: { display: 'flex', flexShrink: 0 } },
                        h(TextButton, {
                          onClick: async () => { await mutate({ op: 'restore', id: item.id }) },
                        }, '恢复'),
                        h(TextButton, {
                          tone: color.danger,
                          onClick: () => setPurgeConfirmId(item.id),
                        }, '彻底删除'),
                      ),
                  )),
                )
                : null,
            )
            : null,

          h('div', {
            style: {
              marginTop: 40,
              paddingTop: 12,
              borderTop: `1px solid ${color.border}`,
              fontSize: 11.5,
              lineHeight: 1.9,
              color: color.muted,
            },
          },
            h('div', null,
              '本地 SQLite（$DSH_HOME/agentmemory/memory.db）· 修改都会留版本 · ',
              h('button', {
                type: 'button',
                onClick: load,
                disabled: loading,
                style: footerLink,
              }, loading ? '刷新中…' : '刷新'),
              ' · ',
              h('button', {
                type: 'button',
                onClick: exportMarkdown,
                style: footerLink,
              }, '导出 Markdown'),
            ),
            state && state.capture
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                state.capture.pending > 0
                  ? h('span', null, `待整理 ${state.capture.pending} 字符`)
                  : h('span', null,
                    state.capture.added > 0
                      ? `上次自动记录 +${state.capture.added} 条`
                      : '暂无可整理的对话内容'),
                state.capture.at > 0
                  ? h('span', null,
                    `· 上次检查 ${relativeTime(state.capture.at, state.now)}`
                    + `${state.capture.reason && state.capture.pending === 0 ? `（${state.capture.reason}）` : ''}`)
                  : null,
                state.capture.pending > 0
                  ? h('button', {
                    type: 'button',
                    onClick: flushNow,
                    disabled: flushing,
                    style: footerLink,
                  }, flushing ? '提取中…' : '立即提取')
                  : null,
              )
              : null,
            state && state.dream
              ? h('div', null,
                state.dream.running === true
                  ? '正在后台整理记忆…'
                  : state.dream.at > 0
                    ? `上次整理 ${relativeTime(state.dream.at, state.now)} · 新增 ${state.dream.created} 条建议`
                    : `还没自动整理过${state.dream.reason ? `（${state.dream.reason}）` : ''}`)
              : null,
            state && state.injection && state.injection.chars > 0
              ? h('div', null,
                `上次注入 ${state.injection.chars} 字符（用户 ${state.injection.entries} 条摘要）`
                + `${state.injection.projectChars > 0 ? ` + 本项目 ${state.injection.projectChars} 字符（${state.injection.projectEntries} 条）` : ''}`
                + `；注入全文会是 ${state.injection.fullChars} 字符，正文由 memory_search 按需取。`)
              : null,
          ),
        ),
      )
    }

    const footerLink = {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      padding: 0,
      fontSize: 11.5,
      color: color.muted,
      textDecoration: 'underline',
      cursor: 'pointer',
    }

    const selectStyle = {      height: 30,
      padding: '0 8px',
      fontSize: 12.5,
      color: color.text,
      background: color.layer2,
      border: `1px solid ${color.border}`,
      borderRadius: 8,
      outline: 'none',
      cursor: 'pointer',
    }

    // ------------------------------------------- chat action: 记住这条回答
    // The action row only hands us ids, so the text is fetched from the Host.
    const SAVE_URL = '/api/agentmemory/save'
    const MESSAGE_URL = '/api/agentmemory/message'

    const SAVE_KINDS = [
      ['profile', '背景'],
      ['preference', '偏好'],
      ['fact', '事实'],
      ['decision', '决策'],
      ['lesson', '经验'],
    ]

    function BookmarkIcon(props) {
      const stroke = {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 15,
        height: 15,
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', { ...stroke, d: 'M7 4.8h10a1 1 0 0 1 1 1v14.4l-6-3.6-6 3.6V5.8a1 1 0 0 1 1-1Z' }),
        props && props.check ? h('path', { ...stroke, d: 'm9.2 11.4 2 2 3.6-3.8' }) : null,
      )
    }

    function SaveAction(props) {
      const messageId = props && props.messageId ? String(props.messageId) : ''
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [open, setOpen] = useState(false)
      const [phase, setPhase] = useState('idle')
      const [draft, setDraft] = useState('')
      const [scope, setScope] = useState('global')
      const [kind, setKind] = useState('fact')
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const [anchor, setAnchor] = useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const close = useCallback(() => {
        setOpen(false)
        setPhase('idle')
        setError('')
        setNote('')
      }, [])

      const openPanel = useCallback(async () => {
        const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : null
        setAnchor(rect)
        setOpen(true)
        setPhase('loading')
        setError('')
        setNote('')
        try {
          const body = await request(`${MESSAGE_URL}?session=${encodeURIComponent(sessionId)}&message=${encodeURIComponent(messageId)}`)
          if (!body.ok) throw new Error(body.error || '读取失败')
          setDraft(String(body.text || '').slice(0, 1000))
        } catch (err) {
          setDraft('')
          setNote('没能自动读取这条回答，请手动填写。')
        }
        setPhase('editing')
      }, [messageId, sessionId])

      const save = useCallback(async () => {
        setPhase('saving')
        setError('')
        try {
          const body = await request(SAVE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ sessionId, messageId, content: draft, scope, kind }),
          })
          if (!body.ok) throw new Error(body.error || '保存失败')
          setPhase('done')
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
          setPhase('editing')
        }
      }, [draft, kind, scope, messageId, sessionId])

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const panel = panelRef.current
          const button = buttonRef.current
          if (panel && panel.contains(event.target)) return
          if (button && button.contains(event.target)) return
          close()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, close])

      if (!messageId || !sessionId) return null

      const panelStyle = anchor === null || !open
        ? { display: 'none' }
        : {
          position: 'fixed',
          left: Math.max(8, Math.min(anchor.left - 136, (window.innerWidth || 1200) - 352)),
          bottom: Math.max(8, (window.innerHeight || 800) - anchor.top + 8),
          width: 336,
          zIndex: 90,
          padding: 12,
          borderRadius: 12,
          background: color.base,
          border: `1px solid ${color.border}`,
          boxShadow: '0 10px 28px rgba(0,0,0,0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }

      return h('span', { style: { display: 'inline-flex' } },
        h('button', {
          ref: buttonRef,
          type: 'button',
          title: '存入长期记忆',
          'aria-label': '存入长期记忆',
          onClick: () => (open ? close() : openPanel()),
          style: {
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: open || phase === 'done' ? color.brand : color.muted,
            width: 24,
            height: 24,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            cursor: 'pointer',
            padding: 0,
          },
        }, h(BookmarkIcon, { check: phase === 'done' })),

        h('div', { ref: panelRef, style: panelStyle },
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
          },
            h('span', { style: { fontSize: 12.5, fontWeight: 600, color: color.text } }, '存入长期记忆'),
            h('button', {
              type: 'button',
              onClick: close,
              style: { ...footerLink, fontSize: 11.5 },
            }, '关闭'),
          ),

          phase === 'done'
            ? h('div', {
              style: {
                fontSize: 12.5,
                color: color.success,
                padding: '10px 0',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              },
            }, '已保存。之后的会话都会带上它。')
            : h(React.Fragment, null,
              h('textarea', {
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                placeholder: phase === 'loading' ? '正在读取这条回答…' : '这条回答里值得记住的一句话',
                rows: 4,
                maxLength: 1000,
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  minHeight: 72,
                  padding: '7px 9px',
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color: color.text,
                  background: color.layer1,
                  border: `1px solid ${color.border}`,
                  borderRadius: 8,
                  outline: 'none',
                },
              }),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('select', {
                  value: scope,
                  onChange: (event) => setScope(event.target.value),
                  style: { ...selectStyle, flex: 1 },
                },
                  h('option', { value: 'global' }, '全局'),
                  h('option', { value: 'project' }, '本项目'),
                ),
                h('select', {
                  value: kind,
                  onChange: (event) => setKind(event.target.value),
                  style: { ...selectStyle, flex: 1 },
                }, SAVE_KINDS.map(([value, label]) => h('option', { key: value, value }, label))),
              ),
              note.length > 0
                ? h('div', { style: { fontSize: 11.5, color: color.muted } }, note)
                : null,
              error.length > 0
                ? h('div', { style: { fontSize: 11.5, color: color.danger } }, error)
                : null,
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
                h(TextButton, { onClick: close }, '取消'),
                h(PrimaryButton, {
                  onClick: save,
                  disabled: phase === 'loading' || phase === 'saving' || draft.trim().length < 4,
                }, phase === 'saving' ? '保存中…' : '保存'),
              ),
            ),
        ),
      )
    }

    /**
     * Footer chip under a finished turn: what that turn actually carried.
     * Renders nothing when the turn used no memory, so quiet turns stay quiet.
     */
    function TurnTail(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const turn = props && props.turn ? Number(props.turn.turn) : Number.NaN
      const [trace, setTrace] = useState(null)
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)

      useEffect(() => {
        if (sessionId.length === 0 || !Number.isFinite(turn)) return undefined
        let cancelled = false
        let timer = null
        const load = async (attempt) => {
          try {
            const body = await request(
              `${TURN_URL}?session=${encodeURIComponent(sessionId)}&turn=${encodeURIComponent(turn)}`,
            )
            if (cancelled) return
            if (body && body.ok && body.trace) {
              setTrace(body.trace)
              return
            }
            // The turn just closed: the host may not have written the row yet.
            if (attempt < 2) timer = setTimeout(() => load(attempt + 1), 500)
          } catch {
            if (!cancelled && attempt < 2) timer = setTimeout(() => load(attempt + 1), 800)
          }
        }
        load(0)
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [sessionId, turn])

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const panel = panelRef.current
          const button = buttonRef.current
          if (panel && panel.contains(event.target)) return
          if (button && button.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (trace === null) return null
      const retrieved = Array.isArray(trace.retrieval) ? trace.retrieval : []
      const core = Array.isArray(trace.core) ? trace.core : []
      const added = Number(trace.added) || 0
      if (core.length === 0 && retrieved.length === 0 && added === 0) return null

      const kinds = new Map(KIND_OPTIONS)
      const summary = [
        core.length > 0 ? `常驻 ${core.length} 条` : '',
        retrieved.length > 0 ? `检索 ${retrieved.length} 条` : '',
        added > 0 ? `新增 ${added} 条` : '',
      ].filter(Boolean).join(' · ')

      const panelStyle = anchor === null || !open
        ? { display: 'none' }
        : {
          position: 'fixed',
          left: Math.max(8, Math.min(anchor.left, (window.innerWidth || 1200) - 348)),
          bottom: Math.max(8, (window.innerHeight || 800) - anchor.top + 8),
          width: 340,
          zIndex: 90,
          padding: 12,
          borderRadius: 12,
          background: color.base,
          border: `1px solid ${color.border}`,
          boxShadow: '0 10px 28px rgba(0,0,0,0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' } },
        h('button', {
          ref: buttonRef,
          type: 'button',
          onClick: () => {
            const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : null
            setAnchor(rect)
            setOpen(!open)
          },
          style: {
            appearance: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            alignSelf: 'flex-start',
            padding: '2px 8px',
            fontSize: 11.5,
            lineHeight: 1.7,
            color: open ? color.brand : color.muted,
            background: color.layer1,
            border: `1px solid ${color.border}`,
            borderRadius: 999,
            cursor: 'pointer',
          },
        }, `记忆 · ${summary}`),

        h('div', { ref: panelRef, style: panelStyle },
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
          },
            h('span', { style: { fontSize: 12.5, fontWeight: 600, color: color.text } }, '本轮的长期记忆'),
            h('button', {
              type: 'button',
              onClick: () => setOpen(false),
              style: { ...footerLink, fontSize: 11.5 },
            }, '关闭'),
          ),
          retrieved.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: { fontSize: 11, color: color.muted } }, `按这句话检索到 ${retrieved.length} 条`),
              ...retrieved.map((item) => h('div', {
                key: item.id,
                style: {
                  display: 'flex',
                  gap: 6,
                  fontSize: 12,
                  lineHeight: 1.65,
                  color: color.text,
                },
              },
                h('span', { style: { color: color.muted, flex: 'none' } }, kinds.get(item.kind) || '记忆'),
                h('span', { style: { minWidth: 0 } }, item.abstract || item.content || item.id),
              )),
            )
            : null,
          retrieved.length === 0
            ? h('div', { style: { fontSize: 11.5, color: color.muted, lineHeight: 1.6 } },
              '本轮没有额外的检索条目：和这句话相关的记忆都已经在常驻块里了。')
            : null,
          added > 0
            ? h('div', { style: { fontSize: 11.5, color: color.muted } }, `本轮结束后新存入 ${added} 条。`)
            : null,
          h('div', { style: { fontSize: 11, color: color.muted, borderTop: `1px solid ${color.border}`, paddingTop: 6 } },
            `常驻注入 ${core.length} 条 · 本轮检索块 ${Number(trace.retrievalChars) || 0} 字符`),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'agentmemory',
          order: 30,
          label: () => '记忆',
        }, MemoryIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'agentmemory',
        }, MemoryPanel))

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'agentmemory-save',
          order: 30,
          label: () => '存入记忆',
        }, SaveAction))

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'agentmemory-turn-tail',
          order: 30,
          label: () => '本轮记忆',
        }, TurnTail))
      },
    }
  },
})
