import { clock, dateTime, kindInfo, statusText } from '../../lib/format.js'
import { movePackMemberToSlot, packMemberKey } from './pack-model.js'

function memberLabel(member) {
  if (!member) return ''
  if (member.type === 'session') return kindInfo(member.kind).label
  if (member.type === 'batch') return '批次'
  if (member.type === 'highlight') return '标记'
  if (member.type === 'note') return member.kind === 'todo' ? '待办清单' : '便利签'
  if (member.type === 'image') return '图片'
  if (member.type === 'doc') {
    return member.doc_type === 'wiki' ? '飞书知识库' : member.doc_type === 'sheet' ? '飞书表格'
      : member.doc_type === 'base' ? '飞书多维表格' : '飞书文档'
  }
  return '卡片'
}

function memberMeta(member, t) {
  if (!member) return ''
  if (member.type === 'session') {
    return [statusText(member.status, t), member.duration ? clock(member.duration) : '',
      dateTime(member.created_at)].filter(Boolean).join(' · ')
  }
  if (member.type === 'batch') {
    return [member.count ? `${member.count} 条` : '', member.active ? `${member.active} 进行中` : '批次']
      .filter(Boolean).join(' · ')
  }
  if (member.type === 'highlight') return `${dateTime(member.created_at)} · ${clock(member.ts)}`
  if (member.type === 'note') return dateTime(member.created_at)
  if (member.type === 'image') return [member.width && member.height ? `${member.width}×${member.height}` : '', dateTime(member.created_at)].filter(Boolean).join(' · ')
  if (member.type === 'doc') return [member.has_content ? '有正文快照' : '仅链接', dateTime(member.created_at)].filter(Boolean).join(' · ')
  return dateTime(member.created_at)
}

function canOpen(member) {
  return ['session', 'batch', 'highlight', 'doc'].includes(member?.type)
}

function FallbackCard({ member, t, onOpen }) {
  const body = (
    <>
      <span className="mc-pack-fallback-badge" data-tone={member?.type} aria-hidden="true">{memberLabel(member).slice(0, 1)}</span>
      <span className="mc-pack-fallback-main">
        <span className="mc-pack-fallback-top">
          <span>{memberLabel(member)}</span>
          <span>{memberMeta(member, t)}</span>
        </span>
        <strong>{member?.title || member?.id}</strong>
      </span>
      {canOpen(member) ? <span className="mc-pack-fallback-open">打开</span> : null}
    </>
  )
  return canOpen(member) ? (
    <button type="button" className="mc-pack-fallback-card" onClick={onOpen}>{body}</button>
  ) : (
    <div className="mc-pack-fallback-card is-static">{body}</div>
  )
}

export function PackOverlay({
  pack, t, busy = false, renameFocus = false, memberEntries = null, renderEntry,
  onClose, onOpenMember, onRemoveMember, onDissolve, onRename, onReorder
}) {
  const inputRef = React.useRef(null)
  const cancelRef = React.useRef(false)
  const reorderRef = React.useRef(null)
  const bodyClassRef = React.useRef(false)
  const rowRefs = React.useRef(new Map())
  const layerRef = React.useRef(null)
  const ghostRef = React.useRef(null)
  const suppressClickRef = React.useRef(new Map())
  const [title, setTitle] = React.useState(pack?.title || '')
  const [saving, setSaving] = React.useState(false)
  const [order, setOrder] = React.useState(() => (Array.isArray(pack?.members) ? pack.members : []))
  const orderRef = React.useRef(order)
  orderRef.current = order
  const [pendingKey, setPendingKey] = React.useState('')
  const [draggingKey, setDraggingKey] = React.useState('')
  const [dropTarget, setDropTarget] = React.useState(null)
  const [savingOrder, setSavingOrder] = React.useState(false)

  React.useEffect(() => {
    setTitle(pack?.title || '')
  }, [pack?.id, pack?.title])

  // 服务端顺序变化（加/移成员、另一窗口或重新排序成功）时同步本地顺序；
  // 拖动和保存期间不覆盖用户正在操作的列表。
  React.useEffect(() => {
    if (reorderRef.current || pendingKey || draggingKey || savingOrder) return
    const next = Array.isArray(pack?.members) ? pack.members : []
    orderRef.current = next
    setOrder(next)
  }, [pack?.id, pack?.members, pendingKey, draggingKey, savingOrder])

  React.useEffect(() => {
    if (!renameFocus) return
    const node = inputRef.current
    if (!node) return
    node.focus()
    try { node.select() } catch {}
  }, [renameFocus, pack?.id])

  React.useEffect(() => {
    function onKey(event) {
      if (event.key !== 'Escape') return
      if (event.target === inputRef.current) return
      if (reorderRef.current) {
        event.stopPropagation()
        cancelReorder()
        return
      }
      event.stopPropagation()
      onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  React.useEffect(() => () => {
    removeGhost()
    if (bodyClassRef.current) {
      document.body.classList.remove('mc-pack-reordering')
      bodyClassRef.current = false
    }
  }, [])

  function setBodyReordering(on) {
    bodyClassRef.current = on
    try {
      if (on) document.body.classList.add('mc-pack-reordering')
      else document.body.classList.remove('mc-pack-reordering')
    } catch {}
  }

  function removeGhost() {
    const ghost = ghostRef.current
    ghostRef.current = null
    try { ghost?.remove?.() } catch {}
  }

  function createGhost(current) {
    removeGhost()
    const card = current?.card
    const layer = layerRef.current
    if (!card || !layer?.appendChild) return
    const rect = current.rect
    const clone = card.cloneNode(true)
    clone.classList.add('mc-pack-drag-ghost')
    clone.setAttribute('aria-hidden', 'true')
    clone.style.width = `${rect.width}px`
    clone.style.height = `${rect.height}px`
    clone.style.left = `${rect.left}px`
    clone.style.top = `${rect.top}px`
    clone.style.margin = '0'
    clone.style.pointerEvents = 'none'
    layer.appendChild(clone)
    ghostRef.current = clone
  }

  function moveGhost(event, current) {
    const ghost = ghostRef.current
    if (!ghost) return
    ghost.style.left = `${event.clientX - current.grabX}px`
    ghost.style.top = `${event.clientY - current.grabY}px`
  }

  React.useEffect(() => {
    if (!pendingKey) return undefined
    const key = pendingKey

    function onMove(event) {
      const current = reorderRef.current
      if (!current || current.key !== key) return
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY)
      if (!current.moved && distance < 7) return
      if (!current.moved) {
        current.moved = true
        try { event.preventDefault?.() } catch {}
        setBodyReordering(true)
        setDraggingKey(key)
        createGhost(current)
      }
      moveGhost(event, current)

      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-pack-member-key]')
      if (!row) {
        current.drop = null
        setDropTarget((previous) => (previous ? null : previous))
        return
      }
      const targetKey = row.getAttribute('data-pack-member-key')
      if (!targetKey || targetKey === current.key) {
        current.drop = null
        setDropTarget((previous) => (previous ? null : previous))
        return
      }
      const index = orderRef.current.findIndex((member) => packMemberKey(member) === targetKey)
      if (index < 0) {
        current.drop = null
        setDropTarget((previous) => (previous ? null : previous))
        return
      }
      const card = row.querySelector('.mc-pack-row-card') || row
      const box = card.getBoundingClientRect()
      const drop = {
        key: targetKey,
        index,
        rect: { left: box.left, top: box.top, width: box.width, height: box.height }
      }
      current.drop = drop
      setDropTarget((previous) => {
        if (previous
          && previous.key === drop.key
          && previous.rect.left === drop.rect.left
          && previous.rect.top === drop.rect.top
          && previous.rect.width === drop.rect.width
          && previous.rect.height === drop.rect.height) return previous
        return drop
      })
    }

    function onUp() {
      void finishReorder()
    }
    function onCancel() {
      cancelReorder()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey])

  async function finishReorder() {
    const current = reorderRef.current
    reorderRef.current = null
    removeGhost()
    setBodyReordering(false)
    setPendingKey('')
    setDraggingKey('')
    setDropTarget(null)
    if (!current) return
    if (!current.moved) return

    // 拖动结束后浏览器仍可能派发一次 click；用一次性开关吞掉，避免误打开卡片。
    suppressClickRef.current.set(current.key, true)
    setTimeout(() => suppressClickRef.current.delete(current.key), 0)

    if (!current.drop) return
    const next = movePackMemberToSlot(orderRef.current, current.key, current.drop.index)
    if (next === orderRef.current) return
    orderRef.current = next
    setOrder(next)
    if (typeof onReorder !== 'function') return
    setSavingOrder(true)
    const original = current.original
    try {
      const ok = await onReorder(next)
      if (!ok) {
        orderRef.current = original
        setOrder(original)
      }
    } catch {
      orderRef.current = original
      setOrder(original)
    } finally {
      setSavingOrder(false)
    }
  }

  function cancelReorder() {
    reorderRef.current = null
    removeGhost()
    setBodyReordering(false)
    setPendingKey('')
    setDraggingKey('')
    setDropTarget(null)
  }

  function startPendingDrag(event, key) {
    if (event.button !== 0 || busy || savingOrder || reorderRef.current) return
    if (event.target?.closest?.('.mc-pack-row-tools, input, textarea, select, label, a, [contenteditable="true"]')) return
    const row = rowRefs.current.get(key)
    if (!row) return
    const card = row.querySelector('.mc-pack-row-card') || row
    const rect = card.getBoundingClientRect()
    reorderRef.current = {
      key,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      row,
      card,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      moved: false,
      drop: null,
      original: orderRef.current.slice()
    }
    setPendingKey(key)
  }

  async function commitTitle() {
    if (cancelRef.current) {
      cancelRef.current = false
      return true
    }
    if (saving || busy) return false
    const value = String(title || '').trim()
    if (!value) {
      setTitle(pack?.title || '')
      return true
    }
    if (value === (pack?.title || '')) return true
    setSaving(true)
    try {
      const ok = Boolean(await onRename?.(value))
      if (!ok) setTitle(pack?.title || '')
      return ok
    } finally {
      setSaving(false)
    }
  }

  // 移出/解散先在原地保存标题，再执行动作；mousedown 已经阻止失焦，
  // 因此不会出现“改名请求把动作按钮 disabled 掉、点了没反应”的竞态。
  function runAfterTitleSave(event, action) {
    event.preventDefault()
    if (saving || savingOrder) return
    const value = String(title || '').trim()
    if (value && value !== (pack?.title || '')) {
      commitTitle().finally(() => action())
    } else {
      action()
    }
  }

  if (!pack) return null
  const members = order
  const count = members.length
  return (
    <div className="mc-modal-layer" role="dialog" aria-modal="true" aria-label={`卡包：${pack.title || '未命名卡包'}`} ref={layerRef}>
      <div className="mc-modal mc-pack-modal" data-pack-id={pack.id}>
        <div className="mc-modal-head mc-pack-modal-head">
          <div className="mc-pack-modal-title">
            <input
              ref={inputRef}
              className="mc-pack-title-input"
              value={title}
              maxLength={80}
              disabled={busy || saving || savingOrder}
              aria-label="卡包名称"
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.stopPropagation()
                  cancelRef.current = true
                  setTitle(pack.title || '')
                  event.currentTarget.blur()
                }
              }}
            />
            <span className="mc-foot-meta">
              {count} 张卡片 · 按住卡片拖动排序 · 更新 {dateTime(pack.updated_at || pack.created_at)}
              {busy || saving || savingOrder ? ' · 正在保存…' : ''}
            </span>
          </div>
          <button type="button" className="mc-icon-button" onClick={onClose} aria-label="关闭卡包">×</button>
        </div>

        {members.length === 0 ? (
          <div className="mc-pack-modal-empty">
            <strong>空卡包</strong>
            <p>把墙面上的卡片拖到这张卡包上，就会收进来。</p>
          </div>
        ) : (
          <div className="mc-pack-card-grid">
            {members.map((member) => {
              const key = packMemberKey(member)
              const entry = memberEntries?.get?.(key) || null
              return (
                <div
                  key={key}
                  className={`mc-pack-row${draggingKey === key ? ' is-dragging' : ''}`}
                  data-pack-member-key={key}
                  data-type={member.type}
                  ref={(node) => {
                    if (node) rowRefs.current.set(key, node)
                    else rowRefs.current.delete(key)
                  }}
                  onPointerDown={(event) => startPendingDrag(event, key)}
                  onClickCapture={(event) => {
                    if (!suppressClickRef.current.get(key)) return
                    suppressClickRef.current.delete(key)
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onContextMenuCapture={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}>
                  <div className="mc-pack-row-card">
                    {entry && typeof renderEntry === 'function'
                      ? renderEntry(entry, { packMode: true, onOpenMember: () => onOpenMember?.(pack, member) })
                      : <FallbackCard member={member} t={t} onOpen={() => onOpenMember?.(pack, member)} />}
                  </div>
                  <div className="mc-pack-row-tools">
                    <button type="button" className="mc-pack-row-remove" disabled={busy || savingOrder}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => runAfterTitleSave(event, () => onRemoveMember?.(pack, member))}>移出</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="mc-modal-actions mc-pack-modal-actions">
          <button type="button" className="mc-button" data-variant="danger" disabled={busy || savingOrder}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => runAfterTitleSave(event, () => onDissolve?.(pack))}>{count ? '解散卡包' : '删除卡包'}</button>
          <span className="mc-pack-modal-hint">{count ? '按住任意卡片拖动调整顺序；解散只把卡片放回墙面，不会删除记录' : ''}</span>
          <button type="button" className="mc-button" data-variant="primary" onClick={onClose}>关闭</button>
        </div>
      </div>
      {dropTarget?.rect ? (
        <div
          className="mc-pack-drop-marker"
          style={{
            left: dropTarget.rect.left,
            top: dropTarget.rect.top,
            width: dropTarget.rect.width,
            height: dropTarget.rect.height
          }}
          aria-hidden="true">
          <span className="mc-pack-drop-line" />
          <span className="mc-pack-drop-pill">插入到这里</span>
        </div>
      ) : null}
    </div>
  )
}
