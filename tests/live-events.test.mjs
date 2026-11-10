import test from 'node:test'
import assert from 'node:assert/strict'
import { isIndicatorEvent, motionOf, shouldReloadForEvent } from '../client-src/lib/liveEvents.js'

test('motion 事件不触发详情重拉', () => {
  // 采集时每 0.5 秒一条：重拉等于每半秒解析并重绘整份记录，整窗会点不动。
  assert.equal(shouldReloadForEvent({ kind: 'motion', score: 3.1, threshold: 4 }), false)
  assert.equal(isIndicatorEvent({ kind: 'motion' }), true)
})

test('noop/closed/heartbeat 也不重拉', () => {
  for (const kind of ['noop', 'closed', 'heartbeat', 'ping', 'tick']) {
    assert.equal(shouldReloadForEvent({ kind }), false, kind)
  }
})

test('内容类事件仍然重拉：转写、截图、标记、状态、结束', () => {
  for (const kind of ['status', 'transcript', 'shot', 'mark', 'warn', 'end_prompt', 'done', 'error', 'cancelled']) {
    assert.equal(shouldReloadForEvent({ kind }), true, kind)
  }
})

test('未知/缺失 kind 保守地重拉，避免漏掉新事件类型', () => {
  assert.equal(shouldReloadForEvent({}), true)
  assert.equal(shouldReloadForEvent({ kind: 'something_new' }), true)
  assert.equal(shouldReloadForEvent(null), false)
})

test('motionOf 只接受有限的 score，阈值缺失时给 null', () => {
  assert.deepEqual(motionOf({ kind: 'motion', score: '3.2', threshold: 4 }), { score: 3.2, threshold: 4 })
  assert.deepEqual(motionOf({ kind: 'motion', score: 2 }), { score: 2, threshold: null })
  assert.equal(motionOf({ kind: 'motion', score: 'x' }), null)
  assert.equal(motionOf({ kind: 'status', score: 2 }), null)
})
