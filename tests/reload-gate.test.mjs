import test from 'node:test'
import assert from 'node:assert/strict'
import { createReloadGate } from '../client-src/lib/reload-gate.js'

// 假时钟 + 假定时器：让「间隔/合并」这些行为可以被确定性地断言。
function harness({ gap = 900, duration = 0 } = {}) {
  let clock = 0
  const timers = []
  let seq = 0
  const calls = []
  const gate = createReloadGate({
    gap,
    now: () => clock,
    schedule: (fn, ms) => { const id = ++seq; timers.push({ id, at: clock + ms, fn }); return id },
    cancel: (id) => { const index = timers.findIndex((t) => t.id === id); if (index >= 0) timers.splice(index, 1) },
    task: async (priority) => { calls.push({ at: clock, priority }); clock += duration }
  })
  function advance(ms) {
    const target = clock + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > target) break
      timers.shift()
      clock = next.at
      next.fn()
    }
    clock = target
  }
  const restart = () => new Promise((resolve) => setImmediate(resolve))
  return { gate, calls, advance, timers: () => timers.length, restart }
}

test('并发请求只跑一次，剩下的合并成一次补拉', async () => {
  const { gate, calls, advance, restart } = harness({ gap: 900 })
  gate.request(false)
  gate.request(false)
  gate.request(false)
  await restart()
  assert.equal(calls.length, 1, '同一时刻只允许一个请求')
  assert.equal(gate.pending, true, '被挡下的请求排队')
  advance(900)
  await restart()
  assert.equal(calls.length, 2, '三次触发只补拉一次')
  advance(5000)
  await restart()
  assert.equal(calls.length, 2, '补拉之后不再重复')
})

test('间隔之内到达的请求排队，而不是并发发出', async () => {
  const { gate, calls, advance, restart } = harness({ gap: 900 })
  gate.request(true)
  await restart()
  assert.equal(calls.length, 1)
  gate.request(false)                 // 刚跑完，还在间隔内
  await restart()
  assert.equal(calls.length, 1, '没到间隔不发')
  assert.equal(gate.pending, true)
  advance(900)
  await restart()
  assert.equal(calls.length, 2, '到点补拉一次')
  assert.equal(calls[1].at, 900)
})

test('采集时每 0.5 秒一条事件：两秒内最多 3 次请求，而不是 4 次以上', async () => {
  const { gate, calls, advance, restart } = harness({ gap: 900 })
  for (let second = 0; second < 2; second += 0.5) {
    gate.request(false)
    await restart()
    advance(500)
  }
  assert.ok(calls.length <= 3, `实际发了 ${calls.length} 次`)
  assert.ok(calls.every((call, index) => index === 0 || call.at - calls[index - 1].at >= 900), '间隔不足')
})

test('priority 请求忽略间隔，立刻执行（换记录要马上出内容）', async () => {
  const { gate, calls, restart } = harness({ gap: 900 })
  gate.request(true)
  await restart()
  gate.request(true)
  await restart()
  assert.equal(calls.length, 2)
})

test('跑着的时候来的请求，等当前这次结束、再隔够 gap 才补', async () => {
  const { gate, calls, advance, restart } = harness({ gap: 900, duration: 200 })
  gate.request(true)
  gate.request(false)
  await restart()
  assert.equal(calls.length, 1)
  assert.equal(gate.pending, true)
  advance(1000)
  await restart()
  assert.equal(calls.length, 2)
  assert.ok(calls[1].at - calls[0].at >= 900)
})

test('stop 之后不再执行，也不留下定时器', async () => {
  const { gate, calls, advance, restart, timers } = harness({ gap: 900 })
  gate.request(true)
  await restart()
  gate.request(false)
  assert.equal(timers(), 1)
  gate.stop()
  assert.equal(timers(), 0)
  advance(5000)
  await restart()
  assert.equal(calls.length, 1)
  gate.request(true)
  await restart()
  assert.equal(calls.length, 1, '停掉后不再执行')
})

test('任务抛错不会让闸门卡死', async () => {
  let count = 0
  let clock = 0
  const gate = createReloadGate({
    gap: 0,
    now: () => clock,
    schedule: (fn, ms) => setTimeout(fn, 0),
    cancel: (id) => clearTimeout(id),
    task: async () => { count += 1; throw new Error('boom') }
  })
  gate.request(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(count, 1)
  clock += 10
  gate.request(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(count, 2)
})
