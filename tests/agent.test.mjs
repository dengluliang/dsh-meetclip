import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agentBridgeAvailable,
  createAgentBridge,
  installAgentBridge,
  sendPromptToAgent
} from '../client-src/lib/agent.js'

const PATH = '/Users/me/Documents/直播摘录/data'

function harness({
  workspace = { id: 'ws-1', path: PATH, title: '会摘资料' },
  available = true,
  ensured = { id: 'ws-2', path: PATH, title: '会摘资料' },
  promptResult = { ok: true }
} = {}) {
  const calls = []
  const sessions = {
    async create(options) {
      calls.push(['create', options])
      return 'session-1'
    },
    async using(sessionId, options, operation) {
      calls.push(['using', sessionId, options])
      return operation({
        binding: {
          session: {
            async prompt(content, mode) {
              calls.push(['prompt', content, mode])
              return promptResult
            }
          }
        }
      })
    }
  }
  const uiWorkspace = {
    openSession(sessionId) {
      calls.push(['open', sessionId])
    }
  }
  const api = {
    async workspaceStatus(path) {
      calls.push(['workspaceStatus', path])
      return { available, workspace }
    },
    async ensureWorkspace(body) {
      calls.push(['ensureWorkspace', body])
      return { workspace: ensured }
    }
  }
  return { calls, sessions, uiWorkspace, api }
}

test('已注册工作区：建会话、发原文、打开会话', async () => {
  const { calls, sessions, uiWorkspace, api } = harness()
  const bridge = createAgentBridge({ sessions, uiWorkspace, api })
  const result = await bridge.send('帮我总结这条发布会', { path: PATH })

  assert.deepEqual(result, { sessionId: 'session-1' })
  assert.deepEqual(calls, [
    ['workspaceStatus', PATH],
    ['create', { workspaceId: 'ws-1' }],
    ['using', 'session-1', { source: 'meetclip' }],
    ['prompt', [{ type: 'text', text: '帮我总结这条发布会' }], 'queue'],
    ['open', 'session-1']
  ])
})

test('未注册工作区：先 ensureWorkspace，再用新 id 建会话', async () => {
  const { calls, sessions, uiWorkspace, api } = harness({ workspace: null })
  const bridge = createAgentBridge({ sessions, uiWorkspace, api })
  await bridge.send('看看这个', { path: PATH })

  assert.deepEqual(calls[0], ['workspaceStatus', PATH])
  assert.deepEqual(calls[1], ['ensureWorkspace', { path: PATH }])
  assert.deepEqual(calls[2], ['create', { workspaceId: 'ws-2' }])
})

test('DSH 没有 workspace registry 时不建会话', async () => {
  const { calls, sessions, uiWorkspace, api } = harness({ available: false, workspace: null })
  const bridge = createAgentBridge({ sessions, uiWorkspace, api })

  await assert.rejects(
    () => bridge.send('你好', { path: PATH }),
    (error) => error.code === 'unsupported' && /不支持/.test(error.message)
  )
  assert.equal(calls.some(([kind]) => kind === 'create'), false)
})

test('prompt 被拒：不打开会话，错误里带底层原因', async () => {
  const { calls, sessions, uiWorkspace, api } = harness({
    promptResult: { ok: false, error: { code: 'model/missing', message: '模型不可用' } }
  })
  const bridge = createAgentBridge({ sessions, uiWorkspace, api })

  await assert.rejects(
    () => bridge.send('你好', { path: PATH }),
    (error) => error.code === 'prompt' && /模型不可用/.test(error.message)
  )
  assert.equal(calls.some(([kind]) => kind === 'open'), false)
})

test('缺会话服务或缺路径时报可操作错误', async () => {
  const empty = createAgentBridge({})
  await assert.rejects(
    () => empty.send('你好', { path: PATH }),
    (error) => error.code === 'unavailable'
  )

  const { sessions, uiWorkspace, api } = harness()
  const bridge = createAgentBridge({ sessions, uiWorkspace, api })
  await assert.rejects(
    () => bridge.send('你好', { path: '' }),
    (error) => error.code === 'no-data-dir'
  )
})

test('老版本没有 sessions.using 时用 retain/release 兜底', async () => {
  const released = []
  const prompted = []
  const sessions = {
    async create() { return 'session-9' },
    retain(sessionId, options) {
      assert.equal(options.source, 'meetclip')
      return {
        ready: Promise.resolve(),
        binding: {
          session: {
            async prompt(content, mode) {
              prompted.push([content, mode])
              return { ok: true }
            }
          }
        },
        release() { released.push(sessionId) }
      }
    }
  }
  const bridge = createAgentBridge({
    sessions,
    uiWorkspace: { openSession() {} },
    api: {
      async workspaceStatus() { return { available: true, workspace: { id: 'ws-1', path: PATH } } },
      async ensureWorkspace() { throw new Error('should not ensure') }
    }
  })

  await bridge.send('兜底', { path: PATH })
  assert.deepEqual(released, ['session-9'])
  assert.deepEqual(prompted, [[[{ type: 'text', text: '兜底' }], 'queue']])
})

test('installAgentBridge 安装/清理与 trim', async () => {
  const seen = []
  const dispose = installAgentBridge({
    async send(text, options) {
      seen.push([text, options])
      return { sessionId: 's' }
    }
  })
  assert.equal(agentBridgeAvailable(), true)
  await sendPromptToAgent('  你好  ', { path: PATH })
  assert.deepEqual(seen, [['你好', { path: PATH }]])

  dispose()
  assert.equal(agentBridgeAvailable(), false)
  await assert.rejects(() => sendPromptToAgent('你好'), /不支持/)
  await assert.rejects(() => sendPromptToAgent('   '), /还没有输入/)
})
