// 摘录墙的散落画布：Hero 居中、无限平移缩放，所有卡片一起避让。
// 布局求解在 scatter-layout.js，相机在 useScatterCamera.js；这里只负责交互和持久化。
import React from 'react'
import { PIN_IMAGE } from '../../lib/pin-image.js'
import { looksLikeImageFile } from '../../lib/paste.js'
import { NoteEditor } from './NoteEditor.jsx'
import { buildLayout, entryKey, nudgeOutOf, SCATTER_GAP } from './scatter-layout.js'
import { centerOn, frameHome, nudgeIntoView, screenToWorld } from './scatter-camera.js'
import { reducedMotion, stageSize, stageRect as readStageRect, useScatterCamera } from './useScatterCamera.js'

const LAYOUT_KEY = 'meetclip.scatter.layout.v2'
const CARD_W = 272

function isFinitePoint(value) {
  return Number.isFinite(Number(value?.x)) && Number.isFinite(Number(value?.y))
}

function readManual() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')
    const out = {}
    for (const [key, value] of Object.entries(raw || {})) {
      if (isFinitePoint(value)) out[key] = { x: Math.round(Number(value.x)), y: Math.round(Number(value.y)) }
    }
    return out
  } catch {
    return {}
  }
}

function writeManual(map) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(map))
  } catch {
    // 隐私模式或配额满：位置只在本次会话生效。
  }
}

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

export function PinMark() {
  return (
    <span className="mc-scatter-pin" title="已固定，右键可解除" aria-label="已固定">
      <img src={PIN_IMAGE} alt="" draggable={false} />
    </span>
  )
}

export function ScatterCanvas({
  entries = [],
  visibleKeys = null,
  hero,
  renderEntry,
  onCreateNote,
  onDropImages,
  pastePointRef = null,
  pins = {},
  pinningKey = '',
  focusKey = '',
  onShowAll,
  onToast
}) {
  const stageRef = React.useRef(null)
  const worldRef = React.useRef(null)
  const { cam, flyTo, halt, zoomAt, home, stageSize: getStageSize } = useScatterCamera({ stageRef, worldRef })

  const [manual, setManual] = React.useState(readManual)
  const manualRef = React.useRef(manual)
  manualRef.current = manual
  const [drag, setDrag] = React.useState(null)
  const dragRef = React.useRef(null)
  const panRef = React.useRef(null)
  const suppressRef = React.useRef({})
  const enteredRef = React.useRef(new Set())
  const knownRef = React.useRef(null)
  const cardRefs = React.useRef(new Map())
  const layoutRef = React.useRef(null)
  const [editor, setEditor] = React.useState(null)
  const [dropActive, setDropActive] = React.useState(false)
  const [resetEpoch, setResetEpoch] = React.useState(0)

  const visible = visibleKeys instanceof Set ? visibleKeys : null
  const isVisible = React.useCallback((key) => !visible || visible.has(key), [visible])

  const entriesSig = React.useMemo(() => entries.map((entry) => {
    const key = entryKey(entry)
    const item = entry?.item || {}
    const seed = entry?.type === 'note' || entry?.type === 'image' ? `${Number(item.x) || 0},${Number(item.y) || 0}` : ''
    const size = entry?.type === 'batch'
      ? 'batch'
      : entry?.type === 'note'
        ? '246x' + (item.kind === 'todo' ? 224 : 190)
        : entry?.type === 'image'
          ? `img${Number(item.width) || 0}x${Number(item.height) || 0}`
          : entry?.type === 'highlight'
            ? '196'
            : `s${item.cover?.value ? 1 : 0}${String(item.id).length}`
    return `${key}:${size}:${seed}`
  }).join('|'), [entries])

  const pinsSig = React.useMemo(() => Object.keys(pins).sort().join(','), [pins])
  const manualSig = React.useMemo(() => Object.keys(manual).sort().map((key) => `${key}=${manual[key].x},${manual[key].y}`).join('|'), [manual])

  const layout = React.useMemo(() => {
    const next = buildLayout(entries, { manual, pins, previous: layoutRef.current })
    layoutRef.current = next
    return next
  }, [entriesSig, pinsSig, manualSig, resetEpoch])

  const visibleEntries = React.useMemo(
    () => entries.filter((entry) => isVisible(entryKey(entry))),
    [entries, isVisible]
  )

  React.useLayoutEffect(() => {
    const box = getStageSize()
    flyTo(frameHome(box.w, box.h), { instant: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 首页 ⌘V 通过这里取「视野中心」的世界坐标，粘贴的卡片就落在眼前。
  React.useEffect(() => {
    const ref = pastePointRef
    if (!ref || typeof ref !== 'object') return undefined
    ref.current = () => {
      const rect = readStageRect(stageRef.current)
      return screenToWorld(cam.current, rect, rect.left + rect.width / 2, rect.top + rect.height / 2)
    }
    return () => {
      if (ref.current) ref.current = null
    }
  }, [pastePointRef])

  // 窗口变宽/变窄时，按宽度差平移，保持视野中心不跳。
  React.useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    let last = stageSize(stage).w
    const shift = (width) => {
      if (!(width > 0)) return
      if (!(last > 0)) {
        last = width
        flyTo(frameHome(width, stageSize(stage).h), { instant: true })
        return
      }
      const delta = width - last
      last = width
      if (!delta) return
      flyTo({ x: cam.current.tx + delta / 2, y: cam.current.ty, s: cam.current.ts }, { stiffness: 140, damping: 24 })
    }
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver((rows) => {
        for (const row of rows) {
          if (row.target === stage) shift(row.contentRect?.width || stageSize(stage).w)
        }
      })
      observer.observe(stage)
      return () => observer.disconnect()
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onResize = () => shift(stageSize(stage).w)
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 滚轮：触控板直接平移，⌘/Ctrl + 滚轮按指针位置缩放。
  React.useEffect(() => {
    const stage = stageRef.current
    if (!stage || typeof stage.addEventListener !== 'function') return undefined
    const onWheel = (event) => {
      // 便利签编辑器和搜索浮层里保留原生滚动。
      if (event.target?.closest?.('.mc-note-editor, .mc-home-search-pop')) return
      event.preventDefault()
      const rect = readStageRect(stage)
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top, true)
      } else {
        flyTo({ x: cam.current.tx - event.deltaX, y: cam.current.ty - event.deltaY, s: cam.current.ts }, { instant: true })
      }
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新卡片可能在屏幕外：相机带过去，让人看到它落在哪。
  React.useEffect(() => {
    const keys = entries.map(entryKey)
    const known = knownRef.current
    knownRef.current = new Set(keys)
    if (!known || known.size === 0) return
    const added = keys.find((key) => !known.has(key) && isVisible(key))
    if (!added) return
    const position = layout.positions[added]
    if (!position) return
    const box = getStageSize()
    const delta = nudgeIntoView(cam.current, position, box.w, box.h, 90)
    if (delta) flyTo({ x: cam.current.tx + delta.x, y: cam.current.ty + delta.y, s: cam.current.ts })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesSig])

  // 提交批次后定位到批次卡：把目标卡带到视口中心。
  React.useEffect(() => {
    if (!focusKey) return
    const position = layout.positions[focusKey]
    if (!position) return
    const box = getStageSize()
    flyTo(centerOn(cam.current, position, box.w, box.h), { stiffness: 90, damping: 20 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, entriesSig])

  // 新卡片入场：从 Hero 方向轻轻飞出来，按顺序错峰。
  React.useLayoutEffect(() => {
    if (reducedMotion()) return
    visibleEntries.forEach((entry, index) => {
      const key = entryKey(entry)
      if (enteredRef.current.has(key)) return
      enteredRef.current.add(key)
      const node = cardRefs.current.get(key)
      const position = layout.positions[key]
      if (!node || !position || typeof node.animate !== 'function') return
      try {
        node.animate([
          { opacity: 0, translate: `${-position.x * 0.22}px ${-position.y * 0.22}px`, scale: '0.88' },
          { opacity: 1, translate: '0 0', scale: '1' }
        ], {
          duration: 560,
          delay: Math.min(index * 28, 420),
          easing: 'cubic-bezier(.2, 1.1, .3, 1)',
          fill: 'backwards'
        })
      } catch {
        // 老 WebView 不支持 WAAPI 时直接显示。
      }
    })
  }, [layout, visibleEntries])

  React.useEffect(() => {
    if (!drag) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      dragRef.current = null
      setDrag(null)
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }
    return undefined
  }, [drag])

  function applyManual(next) {
    manualRef.current = next
    setManual(next)
    writeManual(next)
  }

  function fixedObstacles(exceptKey) {
    const heroRect = { x: 0, y: 0, w: layout.hero.w, h: layout.hero.h }
    const obstacles = [heroRect]
    const keys = new Set([...Object.keys(pins), ...Object.keys(manualRef.current)])
    for (const key of keys) {
      if (key === exceptKey) continue
      const position = layout.positions[key]
      if (position) obstacles.push({ x: position.x, y: position.y, w: position.w, h: position.h })
    }
    return obstacles
  }

  function beginCardDrag(event, key) {
    if (event.button !== 0 || pins[key]) return
    if (event.target?.closest?.('button, a, input, textarea, label, select, [contenteditable="true"]')) return
    const position = layout.positions[key]
    if (!position) return
    event.stopPropagation?.()
    halt()
    // 不在这里抓指针：一旦 setPointerCapture，随后的 click 会被派发到这张卡的外壳上，
    // 卡内的「整卡点击打开」就收不到了（表现为点一下只抖不动）。等真的拖动超过阈值再抓。
    dragRef.current = {
      key,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      x: position.x,
      y: position.y,
      moved: false
    }
  }

  function moveCardDrag(event) {
    const current = dragRef.current
    if (!current) return
    const scale = cam.current.s || 1
    const dx = (event.clientX - current.startX) / scale
    const dy = (event.clientY - current.startY) / scale
    current.x = current.originX + dx
    current.y = current.originY + dy
    if (!current.moved && Math.hypot(dx, dy) < 4) return
    if (!current.moved) {
      current.moved = true
      try {
        event.currentTarget?.setPointerCapture?.(event.pointerId)
      } catch {
        // 指针捕获不可用时仍靠卡片上的事件移动。
      }
    }
    event.stopPropagation?.()
    setDrag({ key: current.key, x: current.x, y: current.y })
  }

  function finishCardDrag() {
    const current = dragRef.current
    if (!current) return
    dragRef.current = null
    if (!current.moved) return
    const position = layout.positions[current.key]
    if (!position) {
      setDrag(null)
      return
    }
    const settled = nudgeOutOf(
      { x: current.x, y: current.y, w: position.w, h: position.h },
      fixedObstacles(current.key),
      SCATTER_GAP
    )
    setDrag(null)
    suppressRef.current[current.key] = true
    setTimeout(() => {
      suppressRef.current[current.key] = false
    }, 0)
    applyManual({
      ...manualRef.current,
      [current.key]: { x: Math.round(settled.x), y: Math.round(settled.y) }
    })
  }

  function onStagePointerDown(event) {
    if (event.button !== 0) return
    if (event.target?.closest?.('.mc-scatter-card, .mc-scatter-hero, .mc-scatter-controls, .mc-note-editor, .mc-scatter-empty')) return
    halt()
    const stage = stageRef.current
    try {
      stage?.setPointerCapture?.(event.pointerId)
    } catch {
      // 忽略：平移仍可在画布内继续。
    }
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: cam.current.tx,
      baseY: cam.current.ty,
      lastX: event.clientX,
      lastY: event.clientY,
      lastT: nowMs(),
      velocityX: 0,
      velocityY: 0,
      moved: false
    }
    stage?.classList?.add('is-panning')
  }

  function onStagePointerMove(event) {
    const pan = panRef.current
    if (!pan) return
    const dx = event.clientX - pan.startX
    const dy = event.clientY - pan.startY
    if (!pan.moved && Math.hypot(dx, dy) > 4) pan.moved = true
    if (!pan.moved) return
    const now = nowMs()
    const dt = Math.max(now - pan.lastT, 1)
    pan.velocityX = (event.clientX - pan.lastX) / dt
    pan.velocityY = (event.clientY - pan.lastY) / dt
    pan.lastX = event.clientX
    pan.lastY = event.clientY
    pan.lastT = now
    flyTo({ x: pan.baseX + dx, y: pan.baseY + dy, s: cam.current.ts }, { instant: true })
  }

  function endPan() {
    const pan = panRef.current
    if (!pan) return
    panRef.current = null
    stageRef.current?.classList?.remove('is-panning')
    if (!pan.moved) return
    if (Math.hypot(pan.velocityX, pan.velocityY) > 0.05) {
      flyTo({
        x: cam.current.tx + pan.velocityX * 180,
        y: cam.current.ty + pan.velocityY * 180,
        s: cam.current.ts
      }, { stiffness: 42, damping: 13 })
    }
  }

  function revealFocused(event) {
    const node = event.target?.closest?.('[data-node]')
    if (!node || typeof node.getBoundingClientRect !== 'function') return
    try {
      if (typeof event.target.matches === 'function' && !event.target.matches(':focus-visible')) return
    } catch {
      // 某些 WebView 不支持 :focus-visible，按普通聚焦处理。
    }
    const stage = stageRef.current
    if (typeof stage?.getBoundingClientRect !== 'function') return
    const box = stage.getBoundingClientRect()
    const rect = node.getBoundingClientRect()
    const margin = 72
    let dx = 0
    let dy = 0
    if (rect.left < box.left + margin) dx = box.left + margin - rect.left
    else if (rect.right > box.right - margin) dx = box.right - margin - rect.right
    if (rect.top < box.top + margin) dy = box.top + margin - rect.top
    else if (rect.bottom > box.bottom - margin) dy = box.bottom - margin - rect.bottom
    if (dx || dy) flyTo({ x: cam.current.tx + dx, y: cam.current.ty + dy, s: cam.current.ts })
  }

  function worldPointOf(event) {
    return screenToWorld(cam.current, readStageRect(stageRef.current), event.clientX, event.clientY)
  }

  function openEditor(event) {
    if (event.target?.closest?.('.mc-scatter-card, .mc-scatter-hero, .mc-scatter-controls, .mc-note-editor, .mc-scatter-empty')) return
    const stage = stageRef.current
    if (!stage) return
    const rect = readStageRect(stage)
    const left = event.clientX - rect.left
    const top = event.clientY - rect.top
    const point = worldPointOf(event)
    setEditor({
      left: Math.max(8, Math.min(rect.width - 300, left)),
      top: Math.max(8, Math.min(rect.height - 190, top)),
      x: point.x,
      y: point.y,
      text: ''
    })
  }

  function saveEditor() {
    const value = editor?.text?.trim()
    if (!value) {
      setEditor(null)
      return
    }
    onCreateNote?.({ text: value, x: editor.x, y: editor.y })
    setEditor(null)
  }

  function hasImageFiles(event) {
    if (Array.from(event.dataTransfer?.items || []).some((item) => item.kind === 'file' && String(item.type).startsWith('image/'))) return true
    if (Array.from(event.dataTransfer?.files || []).some((file) => looksLikeImageFile(file))) return true
    return Array.from(event.dataTransfer?.types || []).includes('Files')
  }

  function onDragOver(event) {
    if (!hasImageFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!dropActive) setDropActive(true)
  }

  function onDragLeave(event) {
    if (event.currentTarget?.contains?.(event.relatedTarget)) return
    setDropActive(false)
  }

  function onDrop(event) {
    const files = Array.from(event.dataTransfer?.files || []).filter((file) => looksLikeImageFile(file))
    if (event.dataTransfer?.files?.length) {
      event.preventDefault()
      setDropActive(false)
    }
    if (!files.length) return
    onDropImages?.(files, worldPointOf(event))
  }

  function resetLayout() {
    layoutRef.current = null
    applyManual({})
    setDrag(null)
    setResetEpoch((value) => value + 1)
    home()
    onToast?.('已重新散落')
  }

  const center = () => {
    const box = getStageSize()
    return [box.w / 2, box.h / 2]
  }

  return (
    <div
      className={`mc-scatter${dropActive ? ' is-dropping' : ''}`}
      ref={stageRef}
      onPointerDown={onStagePointerDown}
      onPointerMove={onStagePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={openEditor}
      onFocus={revealFocused}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mc-scatter-world" ref={worldRef}>
        <div
          className="mc-scatter-hero"
          style={{
            left: -layout.hero.w / 2,
            top: -layout.hero.h / 2,
            width: layout.hero.w
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {hero}
        </div>
        {visibleEntries.map((entry, index) => {
          const key = entryKey(entry)
          const position = layout.positions[key]
          if (!position) return null
          const moved = drag?.key === key ? drag : null
          const x = moved ? moved.x : position.x
          const y = moved ? moved.y : position.y
          const pinned = Boolean(pins[key])
          return (
            <div
              key={key}
              ref={(node) => {
                if (node) cardRefs.current.set(key, node)
                else cardRefs.current.delete(key)
              }}
              className={`mc-scatter-card${pinned ? ' is-pinned' : ''}${pinned && pinningKey === key ? ' is-pinning' : ''}${moved ? ' is-dragging' : ''}`}
              data-node={key}
              data-type={entry.type}
              data-active={entry.type === 'session' && ['recording', 'processing', 'queued'].includes(entry.item?.status) ? 'true' : undefined}
              data-pinned={pinned ? 'true' : undefined}
              style={{
                left: x - position.w / 2,
                top: y - position.h / 2,
                width: position.w || CARD_W,
                height: position.h,
                '--tilt': `${position.tilt ?? 0}deg`,
                zIndex: moved ? 20 : undefined
              }}
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onPointerDown={(event) => beginCardDrag(event, key)}
              onPointerMove={moveCardDrag}
              onPointerUp={finishCardDrag}
              onPointerCancel={finishCardDrag}
              onClickCapture={(event) => {
                if (suppressRef.current[key]) {
                  event.preventDefault()
                  event.stopPropagation()
                }
              }}
            >
              {pinned ? <PinMark /> : null}
              {renderEntry(entry)}
            </div>
          )
        })}
      </div>

      {dropActive ? (
        <div className="mc-drop-zone">
          <span>松开鼠标，把图片贴到画板</span>
          <em>PNG / JPEG / WebP / GIF / HEIC · 单张最大 25 MB</em>
        </div>
      ) : null}

      {visibleEntries.length === 0 && entries.length > 0 ? (
        <div className="mc-scatter-empty">
          <p>没有符合条件的摘录</p>
          <span>换一个筛选，或者回到全部。</span>
          <div>
            <button type="button" onClick={() => onShowAll?.()} onPointerDown={(event) => event.stopPropagation()}>查看全部</button>
          </div>
        </div>
      ) : null}

      {editor ? (
        <NoteEditor
          left={editor.left}
          top={editor.top}
          text={editor.text}
          onChange={(text) => setEditor((current) => (current ? { ...current, text } : current))}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      ) : null}

      <div className="mc-scatter-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => zoomAt(0.85, ...center(), false)} aria-label="缩小" title="缩小">−</button>
        <button type="button" onClick={() => home()} aria-label="回到中心" title="回到中心">◎</button>
        <button type="button" onClick={() => zoomAt(1.18, ...center(), false)} aria-label="放大" title="放大">＋</button>
        <button type="button" onClick={resetLayout} aria-label="重新散落" title="重新散落（清除手动位置）">↺</button>
      </div>
      <div className="mc-scatter-hint">拖动卡片重排 · 双击空白写便利签 · 双击卡片编辑 · 拖入或 ⌘V 粘贴</div>
    </div>
  )
}
