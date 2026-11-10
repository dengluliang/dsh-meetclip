// 摘录墙的散落画布：Hero 居中、无限平移缩放，所有卡片一起避让。
// 布局求解在 scatter-layout.js，相机在 useScatterCamera.js；这里只负责交互和持久化。
import React from 'react'
import { PIN_IMAGE } from '../../lib/pin-image.js'
import { looksLikeImageFile } from '../../lib/paste.js'
import { NoteEditor } from './NoteEditor.jsx'
import { buildLayout, entryKey, nudgeOutOf, SCATTER_GAP } from './scatter-layout.js'
import { hitTestPackTarget, PACK_ARM_DELAY_MS } from './pack-model.js'
import { centerOn, frameHome, nudgeIntoView, screenRectOf, screenToWorld } from './scatter-camera.js'
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
  onToast,
  onMergeCards,
  onBlankContextMenu,
  layoutApiRef = null
}) {
  const stageRef = React.useRef(null)
  const worldRef = React.useRef(null)
  const gridRef = React.useRef(null)
  const { cam, flyTo, halt, zoomAt, home, stageSize: getStageSize } = useScatterCamera({ stageRef, worldRef, gridRef })

  const [manual, setManual] = React.useState(readManual)
  const manualRef = React.useRef(manual)
  manualRef.current = manual
  const [drag, setDrag] = React.useState(null)
  const dragRef = React.useRef(null)
  const armTimerRef = React.useRef(null)
  const packBusyRef = React.useRef(false)
  const panRef = React.useRef(null)
  // 指针/滚轮可能一帧来好几次（120Hz 触控板、惯性滚动）：只记最新目标，一帧写一次 DOM。
  const camRafRef = React.useRef(0)
  const camTargetRef = React.useRef(null)
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

  // 每帧最多写一次相机：同一帧里的多个 pointermove / wheel 只保留最后一个目标。
  const flyInstant = React.useCallback((target) => {
    camTargetRef.current = target
    if (camRafRef.current) return
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback) => setTimeout(() => callback(Date.now()), 16)
    camRafRef.current = schedule(() => {
      camRafRef.current = 0
      const next = camTargetRef.current
      camTargetRef.current = null
      if (next) flyTo(next, { instant: true })
    })
  }, [flyTo])

  // 松手或开始拖卡片之前把挂起的相机目标落地，避免惯性被上一帧的旧目标盖掉。
  const flushCam = React.useCallback(() => {
    if (!camRafRef.current && !camTargetRef.current) return
    if (camRafRef.current) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(camRafRef.current)
      else clearTimeout(camRafRef.current)
      camRafRef.current = 0
    }
    const next = camTargetRef.current
    camTargetRef.current = null
    if (next) flyTo(next, { instant: true })
  }, [flyTo])

  React.useEffect(() => () => {
    if (!camRafRef.current) return
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(camRafRef.current)
    else clearTimeout(camRafRef.current)
    camRafRef.current = 0
  }, [])

  const entriesSig = React.useMemo(() => entries.map((entry) => {
    const key = entryKey(entry)
    const item = entry?.item || {}
    const seed = entry?.type === 'note' || entry?.type === 'image' ? `${Number(item.x) || 0},${Number(item.y) || 0}` : ''
    const size = entry?.type === 'pack'
      ? 'pack'
      : entry?.type === 'batch'
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
        // 同一帧里可能来好几个滚轮事件：在「还没落地的目标」上累加，别拿同一个旧 tx 互相覆盖。
        const base = camTargetRef.current || { x: cam.current.tx, y: cam.current.ty, s: cam.current.ts }
        flyInstant({ x: base.x - event.deltaX, y: base.y - event.deltaY, s: base.s })
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
      if (event.key !== 'Escape' || packBusyRef.current) return
      if (armTimerRef.current) clearTimeout(armTimerRef.current)
      armTimerRef.current = null
      resetDragVisual(dragRef.current?.key)
      dragRef.current = null
      setDrag(null)
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }
    return undefined
  }, [drag])

  React.useEffect(() => () => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current)
    armTimerRef.current = null
  }, [])

  function applyManual(next) {
    manualRef.current = next
    setManual(next)
    writeManual(next)
  }

  // 给 HomePage 一个「先把位置写进 manual，再让 entry 出现」的入口：
  // 卡包/解散出来的卡片因此不会先闪到螺旋点再飞回目标位置。
  React.useEffect(() => {
    const ref = layoutApiRef
    if (!ref || typeof ref !== 'object') return undefined
    function place(key, point) {
      if (!key || key === 'null' || !isFinitePoint(point)) return
      applyManual({
        ...manualRef.current,
        [key]: { x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) }
      })
    }
    function placeMany(map) {
      if (!map || typeof map !== 'object') return
      const next = { ...manualRef.current }
      let changed = false
      for (const [key, point] of Object.entries(map)) {
        if (!key || !isFinitePoint(point)) continue
        next[key] = { x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) }
        changed = true
      }
      if (changed) applyManual(next)
    }
    function remove(key) {
      if (!key || !(key in manualRef.current)) return
      const next = { ...manualRef.current }
      delete next[key]
      applyManual(next)
    }
    function getPosition(key) {
      const position = layoutRef.current?.positions?.[key]
      return position ? { x: position.x, y: position.y, w: position.w, h: position.h } : null
    }
    const api = { place, placeMany, remove, getPosition }
    ref.current = api
    return () => {
      if (ref.current === api) ref.current = null
    }
  }, [layoutApiRef])

  function clearArmTimer() {
    if (armTimerRef.current) clearTimeout(armTimerRef.current)
    armTimerRef.current = null
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
    if (packBusyRef.current || event.button !== 0 || pins[key]) return
    if (event.target?.closest?.('button, a, input, textarea, label, select, [contenteditable="true"]')) return
    const position = layout.positions[key]
    if (!position) return
    event.stopPropagation?.()
    flushCam()
    halt()
    // 不在这里抓指针：一旦 setPointerCapture，随后的 click 会被派发到这张卡的外壳上，
    // 卡内的「整卡点击打开」就收不到了（表现为点一下只抖不动）。等真的拖动超过阈值再抓。
    const node = cardRefs.current.get(key)
    if (node?.style) node.style.transform = ''
    dragRef.current = {
      key,
      stageRect: readStageRect(stageRef.current),
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      tilt: position.tilt || 0,
      x: position.x,
      y: position.y,
      moved: false,
      targetKey: '',
      armed: false,
      mode: '',
      sealing: false
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
    let stateChanged = false
    if (!current.moved) {
      current.moved = true
      stateChanged = true
      try {
        event.currentTarget?.setPointerCapture?.(event.pointerId)
      } catch {
        // 指针捕获不可用时仍靠卡片上的事件移动。
      }
    }
    event.stopPropagation?.()
    // 直接写 transform，避免每个 pointermove 都让整面墙重渲染。
    const node = cardRefs.current.get(current.key)
    if (node?.style) {
      node.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${Number(current.tilt || 0) * 0.35}deg) scale(1.04)`
    }
    if (!packBusyRef.current) {
      const point = screenToWorld(cam.current, current.stageRect, event.clientX, event.clientY)
      const hit = hitTestPackTarget({
        entries: visibleEntries,
        positions: layout.positions,
        point,
        sourceKey: current.key,
        pins
      })
      const targetKey = hit?.key || ''
      if (targetKey !== current.targetKey) {
        current.targetKey = targetKey
        current.armed = false
        current.mode = hit?.mode || ''
        stateChanged = true
        clearArmTimer()
        if (targetKey) {
          armTimerRef.current = setTimeout(() => {
            const live = dragRef.current
            if (!live || live.key !== current.key || live.targetKey !== targetKey) return
            live.armed = true
            setDrag({
              key: live.key, targetKey: live.targetKey,
              armed: true, mode: live.mode, sealing: false
            })
          }, PACK_ARM_DELAY_MS)
        }
      }
    }
    if (stateChanged) {
      setDrag({
        key: current.key, targetKey: current.targetKey,
        armed: current.armed, mode: current.mode, sealing: false
      })
    }
  }

  function resetDragVisual(key) {
    const node = key ? cardRefs.current.get(key) : null
    if (node?.style) node.style.transform = ''
  }

  async function finishCardDrag(event) {
    const current = dragRef.current
    if (!current) return
    clearArmTimer()
    dragRef.current = null
    if (!current.moved) {
      resetDragVisual(current.key)
      setDrag(null)
      return
    }
    const position = layout.positions[current.key]
    if (!position) {
      resetDragVisual(current.key)
      setDrag(null)
      return
    }
    suppressRef.current[current.key] = true
    setTimeout(() => {
      suppressRef.current[current.key] = false
    }, 0)

    let targetKey = current.targetKey || ''
    let armed = Boolean(current.armed)
    let mode = current.mode || ''
    if (event && Number.isFinite(Number(event.clientX)) && Number.isFinite(Number(event.clientY))) {
      const hit = packBusyRef.current ? null : hitTestPackTarget({
        entries: visibleEntries,
        positions: layout.positions,
        point: screenToWorld(cam.current, current.stageRect, event.clientX, event.clientY),
        sourceKey: current.key,
        pins
      })
      if (!hit || hit.key !== targetKey) {
        targetKey = hit?.key || ''
        armed = false
        mode = hit?.mode || ''
      }
    }

    const targetEntry = targetKey
      ? visibleEntries.find((entry) => entryKey(entry) === targetKey)
      : null
    const targetPosition = targetKey ? layout.positions[targetKey] : null
    if (targetKey && armed && targetEntry && targetPosition && typeof onMergeCards === 'function') {
      const sourceEntry = entries.find((entry) => entryKey(entry) === current.key) || null
      packBusyRef.current = true
      setDrag({ key: current.key, targetKey, armed: true, mode, sealing: true })
      let merged = false
      try {
        merged = Boolean(await onMergeCards({
          sourceKey: current.key,
          targetKey,
          sourceEntry,
          targetEntry,
          sourceOrigin: { x: current.originX, y: current.originY },
          dropPoint: { x: current.x, y: current.y },
          targetPosition: { x: targetPosition.x, y: targetPosition.y, w: targetPosition.w, h: targetPosition.h }
        }))
      } catch {
        merged = false
      } finally {
        packBusyRef.current = false
        resetDragVisual(current.key)
        setDrag(null)
      }
      if (!merged) {
        // 合成失败也至少让卡片留在松手的位置，不要突然弹回原处。
        applyManual({
          ...manualRef.current,
          [current.key]: { x: Math.round(current.x), y: Math.round(current.y) }
        })
      }
      return
    }

    resetDragVisual(current.key)
    setDrag(null)
    const settled = nudgeOutOf(
      { x: current.x, y: current.y, w: position.w, h: position.h },
      fixedObstacles(current.key),
      SCATTER_GAP
    )
    applyManual({
      ...manualRef.current,
      [current.key]: { x: Math.round(settled.x), y: Math.round(settled.y) }
    })
  }

  function cancelCardDrag() {
    const current = dragRef.current
    clearArmTimer()
    dragRef.current = null
    resetDragVisual(current?.key)
    setDrag(null)
  }

  function onStagePointerDown(event) {
    if (event.button !== 0) return
    if (event.target?.closest?.('.mc-scatter-card, .mc-scatter-hero, .mc-scatter-controls, .mc-note-editor, .mc-scatter-empty')) return
    flushCam()
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
    flyInstant({ x: pan.baseX + dx, y: pan.baseY + dy, s: cam.current.ts })
  }

  function endPan() {
    flushCam()
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

  function onStageContextMenu(event) {
    if (typeof onBlankContextMenu !== 'function') return
    if (event.target?.closest?.('.mc-scatter-card, .mc-scatter-hero, .mc-scatter-controls, .mc-note-editor, .mc-scatter-empty, .mc-drop-zone, .mc-pack-hint, .mc-context')) return
    event.preventDefault?.()
    event.stopPropagation?.()
    onBlankContextMenu(event, worldPointOf(event))
  }

  function packHintNode() {
    if (!drag?.targetKey) return null
    const position = layout.positions[drag.targetKey]
    if (!position) return null
    const entry = visibleEntries.find((row) => entryKey(row) === drag.targetKey)
    if (!entry) return null
    const rect = screenRectOf(cam.current, position)
    const box = getStageSize()
    const below = rect.top < 54
    const left = Math.max(86, Math.min(Math.max(86, box.w - 86), rect.left + rect.width / 2))
    const top = Math.max(8, Math.min(Math.max(8, box.h - 52), below ? rect.bottom + 12 : rect.top - 42))
    const count = Number(entry.item?.count) || 0
    const text = drag.sealing
      ? '正在收进卡包…'
      : drag.armed
        ? (drag.mode === 'add' ? `松手放进卡包 · ${count} 张` : '松手叠成卡包')
        : (drag.mode === 'add' ? '停一下，放进卡包' : '停一下，叠成卡包')
    return (
      <React.Fragment key="pack-hint">
        <span
          className="mc-pack-glow"
          data-ready={drag.armed ? 'true' : 'false'}
          style={{
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12
          }}
          aria-hidden="true"
        />
        <div
          className={`mc-pack-hint${drag.armed ? ' is-ready' : ''}${drag.sealing ? ' is-busy' : ''}`}
          style={{ left, top }}
          role="status"
          aria-live="polite">
          <i aria-hidden="true" />
          <span>{text}</span>
        </div>
      </React.Fragment>
    )
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
      onContextMenu={onStageContextMenu}
      onFocus={revealFocused}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mc-scatter-grid" ref={gridRef} aria-hidden="true" />
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
          const x = position.x
          const y = position.y
          const pinned = Boolean(pins[key])
          const isPackTarget = Boolean(drag?.targetKey) && drag.targetKey === key
          return (
            <div
              key={key}
              ref={(node) => {
                if (node) cardRefs.current.set(key, node)
                else cardRefs.current.delete(key)
              }}
              className={`mc-scatter-card${pinned ? ' is-pinned' : ''}${pinned && pinningKey === key ? ' is-pinning' : ''}${moved ? ' is-dragging' : ''}${isPackTarget ? (drag.armed ? ' is-pack-ready' : ' is-pack-hover') : ''}${isPackTarget && drag.sealing ? ' is-pack-sealing' : ''}`}
              data-node={key}
              data-type={entry.type}
              data-active={entry.type === 'session' && ['recording', 'processing', 'queued'].includes(entry.item?.status) ? 'true' : undefined}
              data-pinned={pinned ? 'true' : undefined}
              data-pack-target={isPackTarget ? 'true' : undefined}
              style={{
                left: x - position.w / 2,
                top: y - position.h / 2,
                width: position.w || CARD_W,
                height: position.h,
                '--tilt': `${position.tilt ?? 0}deg`,
                zIndex: moved ? 20 : isPackTarget ? 15 : undefined
              }}
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onPointerDown={(event) => beginCardDrag(event, key)}
              onPointerMove={moveCardDrag}
              onPointerUp={finishCardDrag}
              onPointerCancel={cancelCardDrag}
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

      {packHintNode()}

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
      <div className="mc-scatter-hint">拖动重排 · 卡片相叠成卡包 · 双击空白写便利签 · ⌘V 粘贴</div>
    </div>
  )
}
