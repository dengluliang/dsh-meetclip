// 便利签 / 待办的浮动编辑器：新建（双击空白）和编辑（双击卡片）共用同一套外观与快捷键。
export function NoteEditor({ left, top, text = '', title = '便利签', hint = '以 “- ” 开头会自动变成待办',
  onChange, onCancel, onSave }) {
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    const node = inputRef.current
    if (!node) return undefined
    const timer = setTimeout(() => {
      node.focus()
      try { node.setSelectionRange(node.value.length, node.value.length) } catch {}
    }, 20)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      className="mc-note-editor"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="mc-note-editor-head">
        <span>{title}</span>
        <span>{hint}</span>
      </div>
      <textarea
        ref={inputRef}
        className="mc-note-editor-input"
        value={text}
        onChange={(event) => onChange?.(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel?.()
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onSave?.()
          }
        }}
        placeholder={'写点什么…\n- 记得跟进这件事'}
      />
      <div className="mc-note-editor-actions">
        <span>⌘Enter 保存 · Esc 取消</span>
        <button type="button" className="mc-button mc-button-small" onClick={onCancel}>取消</button>
        <button type="button" className="mc-button mc-button-small" data-variant="primary" onClick={onSave}>保存</button>
      </div>
    </div>
  )
}
