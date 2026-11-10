import { globalSearch } from '../lib/api.js'
import { dateTime } from '../lib/format.js'

const SCOPES = ['all', 'live', 'link_video', 'meeting']

export function GlobalSearchDialog({ t, onClose, onOpenResult, initialQuery = '' }) {
  const [query, setQuery] = React.useState(initialQuery)
  const [scope, setScope] = React.useState('all')
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState(0)
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    inputRef.current?.focus()
    if (initialQuery) inputRef.current?.select?.()
  }, [initialQuery])

  React.useEffect(() => {
    const value = query.trim()
    if (!value) { setData(null); return undefined }
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const result = await globalSearch(value, scope === 'all' ? 'all' : scope, 0, 50)
        if (!cancelled) {
          setData(result)
          setSelected(0)
        }
      } catch (failure) {
        if (!cancelled) setError(failure?.message || String(failure))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 260)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, scope])

  const results = (data?.results || []).filter((result) => result.kind !== 'calendar')
  const counts = data?.counts || {}

  React.useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(results.length - 1, value + 1)) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)) }
      else if (event.key === 'Enter' && results[selected]) { event.preventDefault(); open(results[selected]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results, selected])

  function open(result) {
    onOpenResult(result)
    onClose()
  }

  return (
    <div className="mc-modal-layer" role="dialog" aria-modal="true" aria-label="搜索">
      <div className="mc-modal mc-search-modal">
        <div className="mc-search-head">
          <input ref={inputRef} className="mc-input mc-search-input" value={query}
            onChange={(event) => setQuery(event.target.value)} placeholder="搜索记录、转写与笔记" />
          <button type="button" className="mc-icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="mc-filters">
          {SCOPES.map((id) => (
            <button key={id} type="button" className="mc-chip mc-chip-button" data-active={scope === id} onClick={() => setScope(id)}>
              {scopeLabel(id)}{counts[id] ? ` ${counts[id]}` : ''}
            </button>
          ))}
        </div>
        <div className="mc-search-results">
          {loading ? <div className="mc-inline-note">正在搜索…</div> : null}
          {error ? <div className="mc-error-text" role="alert">{error}</div> : null}
          {!loading && !error && query.trim() && results.length === 0 ? (
            <div className="mc-inline-empty"><strong>没有匹配结果</strong></div>
          ) : null}
          {results.map((result, index) => (
            <button key={`${result.kind}-${result.id}`} type="button" className="mc-search-result"
              data-active={index === selected} onClick={() => open(result)}
              onMouseEnter={() => setSelected(index)}>
              <span className="mc-search-kind">{scopeLabel(result.kind)}</span>
              <span className="mc-search-main">
                <span className="mc-search-title">{result.title}</span>
                <span className="mc-search-snippet">{highlight(result.snippet, query)}</span>
              </span>
              <span className="mc-search-meta">
                <span>{dateTime(result.date)}</span>
                <span>{result.field_label || result.field}{result.match_count > 1 ? ` · ${result.match_count}` : ''}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="mc-search-foot">
          <span>{data ? `${data.total} 条结果` : '输入关键词开始搜索'}</span>
          <span className="mc-foot-meta">↑↓ 选择 · Enter 打开 · Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}

function scopeLabel(id) {
  return ({ all: '全部', live: '直播', link_video: '视频', meeting: '会议' })[id] || id
}

function highlight(text, query) {
  const value = String(text || '')
  const needle = query.trim()
  if (!needle) return value
  const lower = value.toLowerCase()
  const target = needle.toLowerCase()
  const parts = []
  let from = 0
  let index = lower.indexOf(target)
  while (index >= 0) {
    if (index > from) parts.push(value.slice(from, index))
    parts.push(<mark key={`${index}-${parts.length}`}>{value.slice(index, index + needle.length)}</mark>)
    from = index + needle.length
    index = lower.indexOf(target, from)
  }
  if (from < value.length) parts.push(value.slice(from))
  return parts
}
