import {
  backendAction, deleteSessions, deps, duplicateSession, listSessions, meetingOptions,
  renameSession, revealRecord
} from '../lib/api.js'
import { clock, dateTime, duration, groupSessions, kindInfo, statusTone } from '../lib/format.js'
import { SessionDetail } from './SessionDetail.jsx'
import { ContextMenu, useContextMenu } from './ContextMenu.jsx'

const FILTERS = ['all', 'live', 'link_video', 'meeting']

function isActive(session) {
  return session?.status === 'recording' || session?.status === 'processing' || session?.status === 'queued'
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
    return Promise.resolve()
  } catch (failure) {
    return Promise.reject(failure)
  }
}

export function RecordsBrowser({ t, statusData, onStatusRefresh, focus, onFocusConsumed }) {
  const [sessions, setSessions] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [filter, setFilter] = React.useState(() => localStorage.getItem('meetclip.filter') || 'all')
  const [query, setQuery] = React.useState('')
  const [selectedId, setSelectedId] = React.useState(() => localStorage.getItem('meetclip.selected') || '')
  const [selectedIds, setSelectedIds] = React.useState(() => new Set())
  const [anchorId, setAnchorId] = React.useState('')
  const [renamingId, setRenamingId] = React.useState('')
  const [renameDraft, setRenameDraft] = React.useState('')
  const [starting, setStarting] = React.useState(false)
  const [confirm, setConfirm] = React.useState(null)
  const [toast, setToast] = React.useState('')
  const [health, setHealth] = React.useState({ depsReady: null, asrReady: null })
  const pinnedRef = React.useRef('')
  const revealRef = React.useRef('')
  const listRef = React.useRef(null)
  const { menu, open: openMenu, close: closeMenu } = useContextMenu()

  const load = React.useCallback(async (quiet = true) => {
    if (!quiet) setLoading(true)
    try {
      const rows = await listSessions()
      setSessions(Array.isArray(rows) ? rows : [])
      setError('')
      if (Array.isArray(rows) && rows.length > 0) {
        const remembered = localStorage.getItem('meetclip.selected')
        let target = pinnedRef.current || selectedId
        if (!pinnedRef.current && (!target || !rows.some((row) => row.id === target))) {
          target = remembered && rows.some((row) => row.id === remembered) ? remembered : rows[0].id
        }
        if (pinnedRef.current && rows.some((row) => row.id === pinnedRef.current)) pinnedRef.current = ''
        if (target !== selectedId) setSelectedId(target)
        setSelectedIds((current) => {
          const next = new Set([...current].filter((id) => rows.some((row) => row.id === id)))
          if (next.size === 0 && target) next.add(target)
          return next
        })
      }
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  React.useEffect(() => {
    load(false)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true)
    }, 3000)
    return () => clearInterval(timer)
  }, [load])

  // 首页卡片 / 搜索结果 / 新建采集把「要看的记录」交给资料库：选中它，必要时放宽左列
  // 类型筛选让该行可见；数据到位后把这一行滚进视野。
  React.useEffect(() => {
    if (!focus?.id) return
    pinnedRef.current = focus.id
    revealRef.current = focus.id
    setSelectedId(focus.id)
    setSelectedIds(new Set([focus.id]))
    setAnchorId(focus.id)
    const kind = String(focus.kind || '')
    if (filter !== 'all' && filter !== kind) setFilter('all')
  }, [focus?.id, focus?.nonce])

  // focus 只交给「已经选中」的那条记录：进入时先换选中项，等 SessionDetail 用它做时间点
  // 跳转后再消费掉，避免 seek 落空，也避免之后点别的记录时旧时间点被重放。
  const [appliedFocus, setAppliedFocus] = React.useState(0)
  React.useEffect(() => {
    if (!focus?.id || focus.id !== selectedId) return
    setAppliedFocus(focus.nonce)
    onFocusConsumed?.()
  }, [focus?.id, focus?.nonce, selectedId, onFocusConsumed])

  // 目标行可能在列表下方（例如批次里的旧记录）：只对刚打开的那次定位滚动一次。
  React.useEffect(() => {
    if (!selectedId || revealRef.current !== selectedId) return undefined
    const timer = setTimeout(() => {
      const node = listRef.current?.querySelector?.('.mc-item[data-active="true"]')
      if (node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'nearest' })
        revealRef.current = ''
      }
    }, 80)
    return () => clearTimeout(timer)
  }, [selectedId, sessions.length])

  React.useEffect(() => {
    localStorage.setItem('meetclip.filter', filter)
  }, [filter])

  React.useEffect(() => {
    if (selectedId) localStorage.setItem('meetclip.selected', selectedId)
  }, [selectedId])

  React.useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  React.useEffect(() => {
    let cancelled = false
    async function loadHealth() {
      const next = {}
      try { next.depsReady = Boolean((await deps())?.ready) } catch {}
      try { next.asrReady = Boolean((await meetingOptions())?.asr_ready) } catch {}
      if (!cancelled) setHealth(next)
    }
    loadHealth()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') loadHealth() }, 30000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const filtered = sessions.filter((session) => {
    if (filter !== 'all' && (session.kind || 'live') !== filter) return false
    const needle = query.trim().toLowerCase()
    if (needle && !String(session.title || '').toLowerCase().includes(needle)) return false
    return true
  })
  const groups = groupSessions(filtered)
  const flat = groups.flatMap((group) => group.items)
  const selected = sessions.find((session) => session.id === selectedId)
    || (selectedId ? {
      id: selectedId,
      title: focus?.id === selectedId ? focus.title || '' : '',
      kind: (focus?.id === selectedId && focus.kind) || 'live',
      status: 'pending'
    } : null)
  const detailFocus = focus && focus.id === selected?.id && focus.nonce !== appliedFocus ? focus : null
  const backendStopped = statusData?.backend?.state !== 'running'
  const envReady = statusData?.env?.ready !== false
  const chosen = sessions.filter((session) => selectedIds.has(session.id))

  function selectRow(session, event) {
    if (renamingId) return
    const additive = event.metaKey || event.ctrlKey
    const range = event.shiftKey && anchorId
    let next
    if (additive) {
      next = new Set(selectedIds)
      if (next.has(session.id)) next.delete(session.id)
      else next.add(session.id)
      setAnchorId(session.id)
    } else if (range) {
      const from = flat.findIndex((row) => row.id === anchorId)
      const to = flat.findIndex((row) => row.id === session.id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        next = new Set(flat.slice(start, end + 1).map((row) => row.id))
      } else {
        next = new Set([session.id])
      }
    } else {
      next = new Set([session.id])
      setAnchorId(session.id)
    }
    setSelectedIds(next)
    if (next.size === 1) setSelectedId([...next][0])
    else if (!next.has(session.id)) setSelectedId('')
  }

  function isPartial(session) {
    return session?.status === 'error'
      && (session.asr_status === 'partial' || Number(session.missing_chunks) > 0)
  }

  function statusLabel(session) {
    if (isPartial(session)) return t('status.partial')
    return t(`status.${session.status || 'pending'}`) || session.status || ''
  }

  function infoText(rows) {
    return rows.map((session) => {
      const lines = [
        session.title || session.id,
        `时间：${dateTime(session.created_at)}`,
        `状态：${statusLabel(session)}`
      ]
      if (session.duration > 0) lines.push(`时长：${duration(session.duration)}`)
      if (session.source_url) lines.push(`来源：${session.source_url}`)
      const counts = []
      if (session.transcripts) counts.push(`${session.transcripts} 段转写`)
      if ((session.kind || 'live') !== 'meeting' && session.screenshots) counts.push(`${session.screenshots} 张截图`)
      if (session.marks) counts.push(`${session.marks} 个标记`)
      if (counts.length) lines.push(counts.join(' · '))
      return lines.join('\n')
    }).join('\n\n')
  }

  async function copyInfo(rows) {
    try {
      await copyText(infoText(rows))
      setToast(rows.length > 1 ? `已复制 ${rows.length} 条记录信息` : '已复制标题与链接')
    } catch (failure) {
      setToast(failure?.message || '复制失败')
    }
  }

  async function copyLink(session) {
    try {
      await copyText(session.source_url || '')
      setToast('已复制直播链接')
    } catch (failure) {
      setToast(failure?.message || '复制失败')
    }
  }

  async function reveal(rows) {
    try {
      for (const row of rows) await revealRecord(row.id)
      setToast(rows.length > 1 ? `已在 Finder 中显示 ${rows.length} 条记录` : '已在 Finder 中显示记录目录')
    } catch (failure) {
      setToast(failure?.message || '无法在 Finder 中显示')
    }
  }

  function startRename(session) {
    setRenamingId(session.id)
    setRenameDraft(session.title || '')
    setSelectedIds(new Set([session.id]))
    setSelectedId(session.id)
  }

  async function commitRename(session) {
    const next = renameDraft.trim()
    setRenamingId('')
    if (!next || next === session.title) return
    try {
      await renameSession(session.id, next)
      await load(true)
      setToast('已重命名')
    } catch (failure) {
      setToast(failure?.message || '重命名失败')
    }
  }

  async function duplicate(session) {
    try {
      const created = await duplicateSession(session.id)
      await load(true)
      if (created?.id) {
        setSelectedId(created.id)
        setSelectedIds(new Set([created.id]))
      }
      setToast('已创建副本')
    } catch (failure) {
      setToast(failure?.message || '创建副本失败')
    }
  }

  function askDelete(rows) {
    if (!rows.length) return
    const title = rows.length > 1 ? `删除 ${rows.length} 条记录？` : `删除「${rows[0].title || rows[0].id}」？`
    setConfirm({
      title,
      body: '媒体、截图、转写与标记会移到废纸篓，清空废纸篓前可找回。'
        + (rows.some(isActive) ? '正在采集或处理中的记录不会删除，请先停止。' : ''),
      label: '移到废纸篓',
      run: async () => {
        try {
          const result = await deleteSessions(rows.map((row) => row.id))
          const deleted = Array.isArray(result?.deleted) ? result.deleted : rows.map((row) => row.id)
          if (deleted.includes(selectedId)) { setSelectedId(''); pinnedRef.current = '' }
          setSelectedIds((current) => new Set([...current].filter((id) => !deleted.includes(id))))
          await load(true)
          if (Array.isArray(result?.failed) && result.failed.length) {
            setToast(`${result.failed.length} 条记录未能删除：${result.failed[0]?.message || '未知原因'}`)
          } else {
            setToast('已移到废纸篓')
          }
        } catch (failure) {
          setToast(failure?.message || '删除失败')
        }
      }
    })
  }

  function menuFor(session) {
    const rows = selectedIds.has(session.id) && chosen.length > 0 ? chosen : [session]
    const single = rows.length === 1
    const active = rows.some(isActive)
    const items = []
    if (single) {
      items.push({ id: 'rename', label: '重命名', hint: '↵', onSelect: () => startRename(session) })
      items.push({
        id: 'duplicate',
        label: '创建副本',
        disabled: active || (session.kind || 'live') === 'link_video',
        onSelect: () => duplicate(session)
      })
      items.push({ separator: true })
    }
    items.push({
      id: 'copy',
      label: single ? '复制标题与链接' : `复制 ${rows.length} 条信息`,
      hint: '⌘C',
      onSelect: () => copyInfo(rows)
    })
    if (single && session.source_url) {
      items.push({ id: 'copyLink', label: '复制直播链接', onSelect: () => copyLink(session) })
    }
    items.push({ id: 'reveal', label: '在 Finder 中显示', onSelect: () => reveal(rows) })
    items.push({ separator: true })
    items.push({
      id: 'delete',
      label: single ? '删除…' : `删除 ${rows.length} 项…`,
      danger: true,
      onSelect: () => askDelete(rows)
    })
    return items
  }

  React.useEffect(() => {
    function onKey(event) {
      const active = document.activeElement
      if (!active || !active.closest('.mc-side') || active.closest('.mc-detail')) return
      if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) return
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!chosen.length) return
        event.preventDefault()
        askDelete(chosen)
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        if (!chosen.length) return
        event.preventDefault()
        copyInfo(chosen)
      } else if (event.key === 'Enter') {
        if (chosen.length !== 1) return
        event.preventDefault()
        startRename(chosen[0])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function startEngine() {
    setStarting(true)
    try {
      await backendAction('start')
      onStatusRefresh?.()
      await load(false)
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="mc-workspace">
      <aside className="mc-side">
        <div className="mc-side-head">
          <div className="mc-side-title">
            <strong>资料库</strong>
            <span>{filtered.length} 条</span>
          </div>
          <input
            className="mc-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选此列表"
            aria-label="筛选此列表"
          />
          <div className="mc-filters" role="tablist">
            {FILTERS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className="mc-chip mc-chip-button"
                data-active={filter === id}
                onClick={() => setFilter(id)}
              >
                {t(`list.${id}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="mc-list" role="list" ref={listRef}>
          {loading && sessions.length === 0 ? (
            <div className="mc-list-placeholder">{t('list.loading')}</div>
          ) : null}

          {!loading && filtered.length === 0 ? (
            <div className="mc-list-placeholder">
              <strong>{sessions.length === 0 ? t('list.empty') : t('list.noMatch')}</strong>
              <span>{sessions.length === 0 ? t('list.emptyHint') : ''}</span>
            </div>
          ) : null}

          {groups.map((group) => (
            <div key={group.id} className="mc-group">
              <div className="mc-group-label">{t(`list.${group.id}`)}</div>
              {group.items.map((session) => {
                const multi = selectedIds.has(session.id)
                const active = session.id === selectedId
                return (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={active}
                    multi={multi}
                    renaming={renamingId === session.id}
                    renameDraft={renameDraft}
                    t={t}
                    onSelect={(event) => selectRow(session, event)}
                    onContextMenu={(event) => {
                      if (!selectedIds.has(session.id)) {
                        setSelectedIds(new Set([session.id]))
                        setSelectedId(session.id)
                        setAnchorId(session.id)
                      }
                      openMenu(event, menuFor(session))
                    }}
                    onRenameChange={setRenameDraft}
                    onRenameCommit={() => commitRename(session)}
                    onRenameCancel={() => setRenamingId('')}
                  />
                )
              })}
            </div>
          ))}
        </div>

        <div className="mc-side-foot">
          {selectedIds.size > 1 ? (
            <div className="mc-foot-meta">已选 {selectedIds.size} 项</div>
          ) : null}
          {health.depsReady === false ? (
            <div className="mc-side-card" data-tone="warn">
              <strong>缺少采集组件</strong>
              <span>直播采集暂不可用；请在首页「配置进度」中安装采集组件。</span>
            </div>
          ) : null}
          {health.asrReady === false ? (
            <div className="mc-side-card" data-tone="warn">
              <strong>云端语音未配置</strong>
              <span>采集照常保存，暂不生成转写；请到 设置 → 会摘 → 模型 填写 API Key。</span>
            </div>
          ) : null}
          {error ? (
            <div className="mc-foot-error" role="alert">
              <span>{t('list.error')}</span>
              <button type="button" className="mc-button mc-button-small" onClick={() => load(false)}>{t('common.retry')}</button>
            </div>
          ) : null}
          {!envReady ? (
            <div className="mc-foot-note">{t('engine.notReady')}</div>
          ) : null}
          {backendStopped ? (
            <button type="button" className="mc-button mc-button-small" onClick={startEngine} disabled={starting}>
              {starting ? t('status.loading') : t('list.startEngine')}
            </button>
          ) : null}
          <div className="mc-foot-meta">{t('list.footer').replace('{count}', String(sessions.length))}</div>
        </div>
      </aside>

      <section className="mc-content">
        {selected ? (
          <SessionDetail
            key={selected.id}
            sessionId={selected.id}
            summary={selected}
            t={t}
            backendStopped={backendStopped}
            onBackendRefresh={onStatusRefresh}
            focus={detailFocus}
            onChanged={() => load(true)}
            onDeleted={() => { pinnedRef.current = ''; setSelectedId(''); setSelectedIds(new Set()); load(false) }}
            onCreated={(id) => { pinnedRef.current = id; setSelectedId(id); setSelectedIds(new Set([id])); load(true) }}
          />
        ) : (
          <Welcome t={t} />
        )}
      </section>

      <ContextMenu menu={menu} onClose={closeMenu} />

      {confirm ? (
        <div className="mc-modal-layer" role="dialog" aria-modal="true">
          <div className="mc-modal mc-confirm">
            <div className="mc-modal-head"><h3>{confirm.title}</h3></div>
            <p className="mc-card-text">{confirm.body}</p>
            <div className="mc-modal-actions">
              <button type="button" className="mc-button" onClick={() => setConfirm(null)}>{t('new.cancel')}</button>
              <button type="button" className="mc-button" data-variant="primary" onClick={() => {
                const run = confirm.run
                setConfirm(null)
                run?.()
              }}>{confirm.label}</button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="mc-toast" role="status">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast('')} aria-label="关闭">×</button>
        </div>
      ) : null}
    </div>
  )
}

function SessionRow({
  session, active, multi, renaming, renameDraft, t,
  onSelect, onContextMenu, onRenameChange, onRenameCommit, onRenameCancel
}) {
  const info = kindInfo(session.kind)
  const queued = session.queue_position
  const recording = session.status === 'recording'
  const partial = session.status === 'error'
    && (session.asr_status === 'partial' || Number(session.missing_chunks) > 0)
  const tone = partial ? 'warn' : statusTone(session.status)
  const dotState = tone === 'ok' ? 'ok' : tone === 'error' ? 'error' : (tone === 'busy' || tone === 'warn') ? 'warn' : 'idle'
  const [tick, setTick] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!recording) return undefined
    const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [recording])
  const counts = []
  if (session.transcripts) counts.push(`${session.transcripts} 段`)
  if ((session.kind || 'live') !== 'meeting' && session.screenshots) counts.push(`${session.screenshots} 张截图`)
  if (session.marks) counts.push(`${session.marks} 个标记`)
  let meta
  if (recording && session.started_at) meta = clock(tick / 1000 - session.started_at)
  else if (queued) meta = `排队第 ${queued} 位`
  else if (session.status === 'processing') meta = '正在处理'
  else meta = [
    dateTime(session.started_at || session.created_at),
    session.duration ? duration(session.duration) : '',
    partial && session.missing_chunks ? `缺 ${session.missing_chunks} 段` : ''
  ].filter(Boolean).join(' · ')
  if (renaming) {
    return (
      <div className="mc-item" data-active={active} data-multi={multi} role="listitem">
        <span className={`mc-kind-dot mc-kind-${info.tone}`} aria-hidden="true" />
        <span className="mc-item-main">
          <input
            className="mc-input mc-title-input"
            autoFocus
            value={renameDraft}
            onChange={(event) => onRenameChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); onRenameCommit() }
              if (event.key === 'Escape') { event.preventDefault(); onRenameCancel() }
            }}
            onBlur={onRenameCommit}
            aria-label="标题"
          />
          <span className="mc-item-meta"><span>回车保存 · Esc 取消</span></span>
        </span>
      </div>
    )
  }
  return (
    <button
      type="button"
      role="listitem"
      className="mc-item"
      data-active={active}
      data-multi={multi}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={session.title}
    >
      <span className={`mc-kind-dot mc-kind-${info.tone}`} aria-hidden="true" />
      <span className="mc-item-main">
        <span className="mc-item-title">{session.title || session.id}</span>
        <span className="mc-item-meta">
          <span>{t(`kind.${session.kind || 'live'}`)}</span>
          <span title={counts.join(' · ')}>{meta}</span>
        </span>
      </span>
      <span className="mc-status" data-tone={tone}>
        <span className="mc-dot" data-state={dotState} />
        {partial ? t('status.partial') : t(`status.${session.status || 'pending'}`)}
      </span>
    </button>
  )
}

function Welcome({ t }) {
  const cards = [
    { id: 'live', title: t('welcome.live'), tone: 'live' },
    { id: 'video', title: t('welcome.video'), tone: 'video' },
    { id: 'meeting', title: t('welcome.meeting'), tone: 'meeting' }
  ]
  return (
    <div className="mc-welcome">
      <div className="mc-welcome-head">
        <h2>{t('welcome.title')}</h2>
        <p>{t('welcome.desc')}</p>
      </div>
      <div className="mc-entry-cards">
        {cards.map((card) => (
          <button key={card.id} type="button" className="mc-entry-card" disabled>
            <span className={`mc-kind-dot mc-kind-${card.tone}`} aria-hidden="true" />
            <span>{card.title}</span>
            <span className="mc-entry-next">{t('welcome.next')}</span>
          </button>
        ))}
      </div>
      <p className="mc-welcome-note">{t('list.readOnlyPhase')}</p>
    </div>
  )
}
