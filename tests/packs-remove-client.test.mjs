import test from 'node:test'
import assert from 'node:assert/strict'
import { removePackMembers } from '../client-src/lib/api.js'

test('移出成员走 POST 兼容路由，不带 body 的 DELETE', async () => {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method, body: options?.body })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, pack: { id: 'pack-test', count: 1 } })
    }
  }
  const result = await removePackMembers('pack-test', [{ type: 'doc', id: 'doc:abc' }])
  assert.equal(result.pack.id, 'pack-test')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/meetclip/api/packs/pack-test/members/remove')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { members: [{ type: 'doc', id: 'doc:abc' }] })
})
