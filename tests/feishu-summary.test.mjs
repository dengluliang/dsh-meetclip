import test from 'node:test'
import assert from 'node:assert/strict'
import { feishuSummary } from '../client-src/lib/feishu.js'

function status(patch = {}) {
  return {
    package: { configured: true },
    runtime: { npxOk: true, nodeOk: true },
    dsh: { entryPresent: true, entryLive: true, conflict: null },
    auth: { loggedIn: true, expired: false, accessExpired: false },
    lastDocReadAt: 0,
    ...patch
  }
}

test('expired access token is not presented as ready while MCP is not live', () => {
  const summary = feishuSummary(status({
    dsh: { entryPresent: true, entryLive: false, conflict: null },
    auth: { loggedIn: true, expired: false, accessExpired: true }
  }))
  assert.equal(summary.text, '登录待刷新')
  assert.match(summary.detail, /访问令牌/)
})

test('logged in but never read a document asks for a verification read', () => {
  const summary = feishuSummary(status())
  assert.equal(summary.tone, 'warn')
  assert.match(summary.text, /建议试读/)
})

test('a recent successful document read shows ready', () => {
  const summary = feishuSummary(status({ lastDocReadAt: Date.now() }))
  assert.equal(summary.tone, 'ok')
  assert.equal(summary.text, '可以使用')
})
