import { libraryMeta, sortLibraries } from '../../lib/libraries.js'

/**
 * 资料空间切换器：顶部导航右侧的玻璃胶囊。
 *
 * 切换是跨视图的全局状态，所以入口放在首页与资料库共用的头部；
 * 菜单里除了切换，还有新建与管理（管理跳设置 → 资料空间）。
 */
export function LibrarySwitcher({ rows, active, busy, onSelect, onCreate, onManage, defaultOpen = false }) {
  const [open, setOpen] = React.useState(Boolean(defaultOpen))
  const wrapRef = React.useRef(null)
  const list = sortLibraries(rows)
  const name = active?.name || '未命名空间'

  React.useEffect(() => {
    if (!open) return undefined
    function onDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
    }
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function pick(row) {
    if (!row || row.active || busy) return
    setOpen(false)
    onSelect?.(row)
  }

  return (
    <div className="mc-lib-switch" ref={wrapRef}>
      <button type="button" className="mc-lib-trigger" data-open={open ? 'true' : 'false'}
        aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'}
        title={active?.dataDir ? `${name}\n${active.dataDir}` : name}
        disabled={Boolean(busy)}
        onClick={() => setOpen((value) => !value)}>
        <span className="mc-lib-dot" aria-hidden="true" />
        <span className="mc-lib-name">{busy ? '切换中…' : name}</span>
        <span className="mc-lib-caret" aria-hidden="true">⌄</span>
      </button>

      {open ? (
        <div className="mc-lib-menu" role="menu" aria-label="切换资料空间">
          <div className="mc-lib-menu-head">切换资料空间</div>
          {list.map((row) => (
            <button key={row.id} type="button" role="menuitemradio" aria-checked={row.active ? 'true' : 'false'}
              className="mc-lib-item" data-active={row.active ? 'true' : 'false'}
              disabled={busy || (!row.active && row.exists === false)}
              onClick={() => pick(row)}>
              <span className="mc-lib-check" aria-hidden="true">{row.active ? '✓' : ''}</span>
              <span className="mc-lib-item-main">
                <span className="mc-lib-item-name">{row.name}</span>
                <span className="mc-lib-item-meta">
                  {libraryMeta(row) || (row.active ? '正在使用' : '')}
                </span>
              </span>
            </button>
          ))}
          <div className="mc-lib-sep" />
          <button type="button" role="menuitem" className="mc-lib-item mc-lib-action"
            disabled={Boolean(busy)} onClick={() => { setOpen(false); onCreate?.() }}>
            <span className="mc-lib-check" aria-hidden="true">＋</span>
            <span className="mc-lib-item-main">
              <span className="mc-lib-item-name">新建资料空间…</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="mc-lib-item mc-lib-action"
            onClick={() => { setOpen(false); onManage?.() }}>
            <span className="mc-lib-check" aria-hidden="true">⚙</span>
            <span className="mc-lib-item-main">
              <span className="mc-lib-item-name">管理资料空间…</span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
