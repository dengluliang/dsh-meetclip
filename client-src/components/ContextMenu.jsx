export function useContextMenu() {
  const [menu, setMenu] = React.useState(null)
  const open = React.useCallback((event, items) => {
    if (!event || !Array.isArray(items) || items.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, items })
  }, [])
  const close = React.useCallback(() => setMenu(null), [])
  return { menu, open, close }
}

export function ContextMenu({ menu, onClose }) {
  const ref = React.useRef(null)
  const [pos, setPos] = React.useState(null)

  React.useLayoutEffect(() => {
    if (!menu || !ref.current) { setPos(null); return }
    const rect = ref.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))
    setPos({ left, top })
  }, [menu])

  React.useEffect(() => {
    if (!menu) return undefined
    const onPointer = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose()
    }
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    const onBlur = () => onClose()
    window.addEventListener('mousedown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    document.addEventListener('scroll', onBlur, true)
    return () => {
      window.removeEventListener('mousedown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
      document.removeEventListener('scroll', onBlur, true)
    }
  }, [menu, onClose])

  if (!menu) return null
  return (
    <div ref={ref} className="mc-context" role="menu" style={{
      left: pos ? pos.left : 0,
      top: pos ? pos.top : 0,
      visibility: pos ? 'visible' : 'hidden'
    }} onContextMenu={(event) => event.preventDefault()}>
      {menu.items.map((item, index) => {
        if (item.separator) return <div key={`sep-${index}`} className="mc-context-sep" role="separator" />
        if (Array.isArray(item.submenu)) {
          return (
            <div key={item.id || item.label || index} className="mc-context-sub">
              <button type="button" role="menuitem" disabled={item.disabled}>
                <span>{item.label}</span><span className="mc-context-arrow">›</span>
              </button>
              <div className="mc-context-submenu" role="menu">
                {item.submenu.map((child) => (
                  <button key={child.id || child.label} type="button" role="menuitem" disabled={child.disabled}
                    onClick={() => { onClose(); child.onSelect?.() }}>{child.label}</button>
                ))}
              </div>
            </div>
          )
        }
        return (
          <button key={item.id || item.label || index} type="button" role="menuitem"
            className={item.danger ? 'mc-context-danger' : undefined}
            disabled={item.disabled}
            onClick={() => { onClose(); item.onSelect?.() }}>
            {item.label}
            {item.hint ? <span className="mc-context-hint">{item.hint}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
