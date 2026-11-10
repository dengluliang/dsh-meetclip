// 相机数学：屏幕坐标 <-> 世界坐标、Hero 取景、指针处缩放。
// 世界原点是 Hero 中心，相机 transform 为 translate(x, y) scale(s)。

export const ZOOM_MIN = 0.35
export const ZOOM_MAX = 2
export const GRID = 28

export function clampZoom(scale) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

/** 首次打开和「回到中心」用的缩放：窗口越窄，站得越远。 */
export function scaleForWidth(width) {
  if (width < 760) return 0.66
  if (width < 1040) return 0.8
  if (width < 1400) return 0.92
  return 1
}

export function frameHome(stageWidth, stageHeight) {
  const w = Number(stageWidth) || 1000
  const h = Number(stageHeight) || 700
  return { x: w / 2, y: h / 2 + 8, s: scaleForWidth(w) }
}

/** 以屏幕点 (mx, my) 为锚点缩放，锚点下的世界坐标保持不动。 */
export function zoomCamera(cam, factor, mx, my) {
  const from = Number.isFinite(cam?.s) && cam.s > 0 ? cam.s : 1
  const s = clampZoom(from * factor)
  const k = s / from
  const x = Number(cam?.x) || 0
  const y = Number(cam?.y) || 0
  return {
    x: mx - (mx - x) * k,
    y: my - (my - y) * k,
    s
  }
}

export function screenToWorld(cam, rect, clientX, clientY) {
  const left = Number(rect?.left) || 0
  const top = Number(rect?.top) || 0
  const s = cam?.s > 0 ? cam.s : 1
  return {
    x: (clientX - left - (Number(cam?.x) || 0)) / s,
    y: (clientY - top - (Number(cam?.y) || 0)) / s
  }
}

/** 卡片在屏幕上的矩形（世界坐标 -> 屏幕坐标）。 */
export function screenRectOf(cam, position) {
  const s = cam?.s > 0 ? cam.s : 1
  const w = Number(position?.w) || 200
  const h = Number(position?.h) || 180
  const cx = Number(position?.x) || 0
  const cy = Number(position?.y) || 0
  const left = cam.x + (cx - w / 2) * s
  const top = cam.y + (cy - h / 2) * s
  return { left, top, right: left + w * s, bottom: top + h * s, width: w * s, height: h * s }
}

/** 让某张卡落在视口中心（新卡入镜、Tab 聚焦跟随共用）。 */
export function centerOn(cam, position, stageWidth, stageHeight) {
  const s = cam?.s > 0 ? cam.s : 1
  return {
    x: (Number(stageWidth) || 1000) / 2 - (Number(position?.x) || 0) * s,
    y: (Number(stageHeight) || 700) / 2 - (Number(position?.y) || 0) * s,
    s
  }
}

/** 卡片超出安全边距时，返回需要平移的屏幕距离；否则 null。 */
export function nudgeIntoView(cam, position, stageWidth, stageHeight, margin = 90) {
  const rect = screenRectOf(cam, position)
  const w = Number(stageWidth) || 1000
  const h = Number(stageHeight) || 700
  const dx = rect.left < margin ? margin - rect.left : rect.right > w - margin ? w - margin - rect.right : 0
  const dy = rect.top < margin ? margin - rect.top : rect.bottom > h - margin ? h - margin - rect.bottom : 0
  if (!dx && !dy) return null
  return { x: rect.width > w - margin * 2 ? w / 2 - (rect.left + rect.width / 2) : dx, y: rect.height > h - margin * 2 ? h / 2 - (rect.top + rect.height / 2) : dy }
}
