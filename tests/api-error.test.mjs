import test from 'node:test'
import assert from 'node:assert/strict'
import { formatApiError } from '../client-src/lib/api.js'

test('FastAPI validation arrays become readable text', () => {
  const message = formatApiError(422, {
    detail: [{ loc: ['body', 'items', 0, 'url'], msg: 'field required' }]
  })
  assert.equal(message, 'items.0.url: field required')
})

test('object details use their message instead of [object Object]', () => {
  const message = formatApiError(502, { detail: { message: '本地引擎返回了空响应' } })
  assert.equal(message, '本地引擎返回了空响应')
  assert.ok(!message.includes('[object'))
})

test('empty details fall back to a Chinese status message', () => {
  assert.match(formatApiError(404, {}), /接口不存在/)
  assert.match(formatApiError(409, { detail: '' }), /当前状态/)
  assert.match(formatApiError(503, null), /本地引擎/)
})
