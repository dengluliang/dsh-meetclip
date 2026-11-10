import assert from 'node:assert/strict'
import test from 'node:test'
import {
  centerOn,
  clampZoom,
  frameHome,
  nudgeIntoView,
  screenRectOf,
  screenToWorld,
  zoomCamera
} from '../client-src/components/home/scatter-camera.js'

test('frameHome 按窗口宽度选缩放，并把 Hero 中心放到视口中间', () => {
  assert.deepEqual(frameHome(1440, 1000), { x: 720, y: 508, s: 1 })
  assert.equal(frameHome(1200, 800).s, 0.92)
  assert.equal(frameHome(900, 700).s, 0.8)
  assert.equal(frameHome(600, 700).s, 0.66)
})

test('指针处缩放时，锚点下的世界坐标保持不动', () => {
  const before = screenToWorld({ x: 100, y: 50, s: 1 }, { left: 0, top: 0 }, 300, 200)
  const next = zoomCamera({ x: 100, y: 50, s: 1 }, 2, 300, 200)
  const after = screenToWorld(next, { left: 0, top: 0 }, 300, 200)
  assert.ok(Math.abs(before.x - after.x) < 1e-9)
  assert.ok(Math.abs(before.y - after.y) < 1e-9)
  assert.equal(next.s, 2)
})

test('缩放被钳制在可读区间内', () => {
  assert.equal(clampZoom(0.01), 0.35)
  assert.equal(clampZoom(8), 2)
  assert.equal(zoomCamera({ x: 0, y: 0, s: 2 }, 4, 0, 0).s, 2)
})

test('屏幕矩形和世界坐标可以互相还原', () => {
  const cam = { x: 300, y: 200, s: 0.9 }
  const rect = screenRectOf(cam, { x: 100, y: -50, w: 240, h: 180 })
  const center = screenToWorld(cam, { left: 0, top: 0 }, rect.left + rect.width / 2, rect.top + rect.height / 2)
  assert.ok(Math.abs(center.x - 100) < 1e-9)
  assert.ok(Math.abs(center.y + 50) < 1e-9)
})

test('新卡在视口外时返回平移量，在视口内返回 null', () => {
  const cam = { x: 720, y: 508, s: 1 }
  const inside = nudgeIntoView(cam, { x: 0, y: 0, w: 240, h: 180 }, 1440, 1000, 90)
  assert.equal(inside, null)
  const left = nudgeIntoView(cam, { x: -900, y: 0, w: 240, h: 180 }, 1440, 1000, 90)
  assert.ok(left && left.x > 0)
  const right = nudgeIntoView(cam, { x: 1200, y: 0, w: 240, h: 180 }, 1440, 1000, 90)
  assert.ok(right && right.x < 0)
})

test('centerOn 把卡片中心对到视口中心', () => {
  const next = centerOn({ x: 0, y: 0, s: 0.8 }, { x: 320, y: -160, w: 200, h: 180 }, 1200, 800)
  assert.ok(Math.abs(next.x - (600 - 320 * 0.8)) < 1e-9)
  assert.ok(Math.abs(next.y - (400 + 160 * 0.8)) < 1e-9)
})
