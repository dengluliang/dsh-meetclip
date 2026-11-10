import test from 'node:test'
import assert from 'node:assert/strict'
import { CardSyncManager } from '../src/host/cards.js'

function runtimeWith(backend) {
  return { backend }
}

test('后端停止时不主动拉起引擎', async () => {
  const calls = []
  const manager = new CardSyncManager(runtimeWith({
    state: 'stopped',
    ensure: async () => { calls.push('ensure') },
    json: async () => { calls.push('json') }
  }))
  assert.deepEqual(await manager.sync(), { skipped: 'backend_down' })
  assert.deepEqual(calls, [])
  assert.equal(manager.snapshot().ok, null)
  manager.dispose()
})

test('后端运行中调用卡片同步并保留摘要', async () => {
  const calls = []
  const manager = new CardSyncManager(runtimeWith({
    state: 'running',
    json: async (path, init) => {
      calls.push({ path, init })
      return { ok: true, total: 12, created: 2, updated: 1, removed: 0, skipped: 9, errors: [] }
    }
  }))
  const result = await manager.sync()
  assert.equal(result.total, 12)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/cards/sync')
  assert.equal(calls[0].init.method, 'POST')
  const snapshot = manager.snapshot()
  assert.equal(snapshot.ok, true)
  assert.deepEqual(snapshot.result, {
    total: 12, created: 2, updated: 1, removed: 0, skipped: 9, errors: 0, updated_at: null
  })
  manager.dispose()
})

test('force 参数与 404 熔断', async () => {
  const calls = []
  let fail = true
  const manager = new CardSyncManager(runtimeWith({
    state: 'running',
    json: async (path) => {
      calls.push(path)
      if (fail) {
        const error = new Error('not found')
        error.status = 404
        throw error
      }
      return { ok: true }
    }
  }))
  await manager.sync({ force: true })
  assert.equal(calls[0], '/api/cards/sync?force=1')
  assert.equal(manager.snapshot().unsupported, true)
  fail = false
  assert.deepEqual(await manager.sync(), { skipped: 'unsupported' })
  assert.equal(calls.length, 1)
  manager.reset()
  await manager.sync()
  assert.equal(calls.length, 2)
  assert.equal(manager.snapshot().unsupported, false)
  manager.dispose()
})
