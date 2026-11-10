// 相机 hook：弹簧飞行动画 + 惯性平移 + 指针处缩放。
// 相机存在 ref 里直接写 DOM transform，避免每帧 re-render 整个卡片墙。
import React from 'react'
import { GRID, frameHome, zoomCamera } from './scatter-camera.js'

const FALLBACK = { w: 1000, h: 700 }

export function reducedMotion() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function stageSize(stage) {
  const w = Number(stage?.clientWidth) || FALLBACK.w
  const h = Number(stage?.clientHeight) || FALLBACK.h
  return { w, h }
}

export function stageRect(stage) {
  if (typeof stage?.getBoundingClientRect !== 'function') return { left: 0, top: 0, width: FALLBACK.w, height: FALLBACK.h }
  const rect = stage.getBoundingClientRect()
  return {
    left: Number(rect?.left) || 0,
    top: Number(rect?.top) || 0,
    width: Number(rect?.width) || FALLBACK.w,
    height: Number(rect?.height) || FALLBACK.h
  }
}

function nowFrame() {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (callback) => setTimeout(() => callback(Date.now()), 16)
}

function cancelFrame(id) {
  if (!id) return
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

export function useScatterCamera({ stageRef, worldRef }) {
  const cam = React.useRef({
    x: 0, y: 0, s: 1,
    tx: 0, ty: 0, ts: 1,
    vx: 0, vy: 0, vs: 0,
    stiffness: 90, damping: 17,
    raf: 0
  })

  const apply = React.useCallback(() => {
    const current = cam.current
    const world = worldRef?.current
    const stage = stageRef?.current
    if (world?.style) {
      world.style.transform = `translate3d(${current.x}px, ${current.y}px, 0) scale(${current.s})`
    }
    if (stage?.style && typeof stage.style.setProperty === 'function') {
      stage.style.setProperty('--grid-x', `${current.x}px`)
      stage.style.setProperty('--grid-y', `${current.y}px`)
      stage.style.setProperty('--grid-size', `${GRID * current.s}px`)
    }
  }, [stageRef, worldRef])

  const tick = React.useCallback(() => {
    const current = cam.current
    const dt = 1 / 60
    const stiffness = current.stiffness
    const damping = current.damping
    current.vx += (stiffness * (current.tx - current.x) - damping * current.vx) * dt
    current.vy += (stiffness * (current.ty - current.y) - damping * current.vy) * dt
    current.vs += (stiffness * (current.ts - current.s) - damping * current.vs) * dt
    current.x += current.vx * dt
    current.y += current.vy * dt
    current.s = Math.max(0.05, current.s + current.vs * dt)
    apply()
    const idle = Math.abs(current.tx - current.x) < 0.2
      && Math.abs(current.ty - current.y) < 0.2
      && Math.abs(current.ts - current.s) < 0.0005
      && Math.abs(current.vx) + Math.abs(current.vy) < 0.5
      && Math.abs(current.vs) < 0.0005
    if (idle) {
      current.x = current.tx
      current.y = current.ty
      current.s = current.ts
      current.vx = 0
      current.vy = 0
      current.vs = 0
      current.raf = 0
      apply()
      return
    }
    current.raf = nowFrame()(tick)
  }, [apply])

  const flyTo = React.useCallback((target = {}, { instant = false, stiffness = 90, damping = 17 } = {}) => {
    const current = cam.current
    current.tx = Number.isFinite(target.x) ? target.x : current.x
    current.ty = Number.isFinite(target.y) ? target.y : current.y
    current.ts = Number.isFinite(target.s) ? target.s : current.s
    current.stiffness = stiffness
    current.damping = damping
    if (instant || reducedMotion()) {
      cancelFrame(current.raf)
      current.x = current.tx
      current.y = current.ty
      current.s = current.ts
      current.vx = 0
      current.vy = 0
      current.vs = 0
      current.raf = 0
      apply()
      return
    }
    if (!current.raf) current.raf = nowFrame()(tick)
  }, [apply, tick])

  const halt = React.useCallback(() => {
    const current = cam.current
    cancelFrame(current.raf)
    current.raf = 0
    current.vx = 0
    current.vy = 0
    current.vs = 0
    current.tx = current.x
    current.ty = current.y
    current.ts = current.s
  }, [])

  const zoomAt = React.useCallback((factor, mx, my, instant = true) => {
    const current = cam.current
    const next = zoomCamera({ x: current.tx, y: current.ty, s: current.ts }, factor, mx, my)
    flyTo(next, { instant, stiffness: 160, damping: 24 })
  }, [flyTo])

  const home = React.useCallback((instant = false) => {
    const size = stageSize(stageRef?.current)
    flyTo(frameHome(size.w, size.h), { instant })
  }, [flyTo, stageRef])

  React.useEffect(() => () => cancelFrame(cam.current.raf), [])

  return {
    cam,
    apply,
    flyTo,
    halt,
    zoomAt,
    home,
    stageSize: () => stageSize(stageRef?.current),
    stageRect: () => stageRect(stageRef?.current)
  }
}
