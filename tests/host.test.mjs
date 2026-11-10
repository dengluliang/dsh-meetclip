import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { MeetClipRuntime } from '../src/host/runtime.js'
import { registerAppRoutes } from '../src/host/routes.js'
import { inspectDir } from '../src/host/storage.js'

const TEST_PYTHON = process.env.MEETCLIP_TEST_PYTHON
  || path.join(os.homedir(), '.dsh', 'meetclip', 'venv', 'bin', 'python')
const HAS_PYTHON = fs.existsSync(TEST_PYTHON)

function tempDir(prefix = 'meetclip-host-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function response() {
  return {
    headersSent: false,
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body ? Buffer.from(body).toString('utf8') : ''
    }
  }
}

function request({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const stream = body === undefined
    ? new Readable({ read() { this.push(null) } })
    : Readable.from([Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

function fakeContext({ reject = null, services = {} } = {}) {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      }
    },
    get(name) {
      if (name === 'connection') {
        return { requestRejection: () => reject }
      }
      return services[name]
    },
    effect(callback) {
      return callback()
    }
  }
  return { ctx, routes }
}

function fakeWorkspaceRegistry({ initial = [] } = {}) {
  const workspaces = initial.map((entry) => ({ ...entry }))
  return {
    list: () => [...workspaces],
    create: async (dir, title) => {
      // The real registry stores canonical paths, so /var and /private/var must
      // not look like two different workspaces.
      const canonical = fs.realpathSync(dir)
      const existing = workspaces.find((entry) => entry.path === canonical)
      if (existing) return existing
      const workspace = { id: `w${workspaces.length + 1}`, title: title || canonical, path: canonical }
      workspaces.unshift(workspace)
      return workspace
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

test('config resolves archived data by default and honors prefs', () => {
  const stateDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir })
  assert.equal(runtime.settings.stateDir, stateDir)
  assert.ok(runtime.settings.dataDir.endsWith(path.sep + 'data'))
  assert.equal(runtime.settings.port, 8321)
})

test('fresh install treats a missing data directory as writable', async () => {
  const stateDir = tempDir()
  const dataDir = path.join(stateDir, 'missing-data')
  const runtime = new MeetClipRuntime({ stateDir, dataDir, python: TEST_PYTHON })
  try {
    const status = await runtime.status()
    assert.equal(status.locations.dataDirExists, false)
    assert.equal(status.locations.dataDirWritable, true)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('storage inspection accepts a missing directory when its parent is writable', () => {
  const stateDir = tempDir()
  try {
    const current = path.join(stateDir, 'current')
    const target = path.join(stateDir, 'new', 'library')
    const info = inspectDir({ dataDir: current }, target, { measure: false })
    assert.equal(info.exists, false)
    assert.equal(info.writable, true)

    const blocker = path.join(stateDir, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const blocked = inspectDir({ dataDir: current }, path.join(blocker, 'child'), { measure: false })
    assert.equal(blocked.writable, false)
    assert.equal(blocked.exists, false)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('app routes require browser trust and expose status', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18500, python: TEST_PYTHON })
  const { ctx, routes } = fakeContext({ reject: 401 })
  registerAppRoutes(ctx, runtime)

  const denied = response()
  await routes.get('/meetclip/app/status').handler(request({ url: '/meetclip/app/status' }), denied)
  assert.equal(denied.status, 401)

  const allowedCtx = fakeContext()
  registerAppRoutes(allowedCtx.ctx, runtime)
  const ok = response()
  await allowedCtx.routes.get('/meetclip/app/status').handler(request({ url: '/meetclip/app/status' }), ok)
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.backend.port, 18500)
  assert.equal(path.resolve(payload.locations.dataDir), path.resolve(dataDir))

  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('prefs can change dataDir and port, and reject while running', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const nextDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18501, python: TEST_PYTHON })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)

  const saved = response()
  await routes.get('/meetclip/app/prefs').handler(request({
    method: 'POST',
    url: '/meetclip/app/prefs',
    body: { dataDir: nextDir, port: 18502 }
  }), saved)
  assert.equal(saved.status, 200)
  assert.equal(runtime.settings.port, 18502)
  assert.equal(path.resolve(runtime.settings.dataDir), path.resolve(nextDir))

  const bad = response()
  await routes.get('/meetclip/app/prefs').handler(request({
    method: 'POST',
    url: '/meetclip/app/prefs',
    body: { port: 99999 }
  }), bad)
  assert.equal(bad.status, 400)

  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(nextDir, { recursive: true, force: true })
})

test('attaches to an existing backend and refuses a mismatched data dir', { skip: !HAS_PYTHON }, async () => {
  const stateDirA = tempDir()
  const stateDirB = tempDir()
  const stateDirC = tempDir()
  const dataDir = tempDir()
  const otherDir = tempDir()
  const port = await freePort()
  const first = new MeetClipRuntime({ stateDir: stateDirA, dataDir, port, python: TEST_PYTHON })
  try {
    await first.backend.ensure()
    const second = new MeetClipRuntime({ stateDir: stateDirB, dataDir, port, python: TEST_PYTHON })
    const attached = await second.backend.ensure()
    assert.equal(attached.state, 'running')
    assert.equal(attached.mode, 'attached')
    await second.backend.stop()
    const health = await first.backend.json('/api/health')
    assert.equal(health.app, 'meetclip')
    const mismatch = new MeetClipRuntime({ stateDir: stateDirC, dataDir: otherDir, port, python: TEST_PYTHON })
    await assert.rejects(() => mismatch.backend.ensure(), (error) => error.code === 'data_dir_mismatch')
  } finally {
    await first.dispose()
    for (const dir of [stateDirA, stateDirB, stateDirC, dataDir, otherDir]) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('managed backend starts, proxies requests and stops', { skip: !HAS_PYTHON }, async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const port = await freePort()
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port, python: TEST_PYTHON })
  const proxy = http.createServer((req, res) => { runtime.backend.forward(req, res) })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = proxy.address().port
  try {
    const started = await runtime.backend.ensure()
    assert.equal(started.state, 'running')
    const health = await runtime.backend.json('/api/health')
    assert.equal(health.app, 'meetclip')
    assert.equal(path.resolve(health.data_dir), path.resolve(dataDir))
    const list = await fetch(`http://127.0.0.1:${proxyPort}/meetclip/api/sessions`)
    assert.equal(list.status, 200)
    assert.deepEqual(await list.json(), [])
    const created = await fetch(`http://127.0.0.1:${proxyPort}/meetclip/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'host test' })
    })
    assert.equal(created.status, 200)
    const row = await created.json()
    assert.equal(row.title, 'host test')
  } finally {
    await runtime.dispose()
    await new Promise((resolve) => proxy.close(resolve))
    fs.rmSync(stateDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('tool registration exposes meetclip_status', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const { ToolHost } = await import('./tool-host-fixture.mjs')
  const host = new ToolHost()
  const plugin = await import('../index.js')
  plugin.apply({
    webServer: { register: () => () => {} },
    get: (name) => (name === 'tools' ? host.tools : name === 'connection' ? { requestRejection: () => undefined } : undefined),
    effect: (callback) => callback()
  }, { stateDir, dataDir, port: 18503, python: TEST_PYTHON })
  const names = host.definitions.map((definition) => definition.name)
  assert.ok(names.includes('meetclip_status'))
  assert.ok(names.includes('meetclip_records'))
  assert.ok(names.includes('meetclip_capture'))
  assert.ok(names.includes('meetclip_minutes'))
  assert.ok(names.includes('meetclip_calendar'))
  assert.equal(names.length, 9)
  const value = await host.definitions[0].execute({}, {})
  assert.equal(value.ok, true)
  assert.equal(value.workspace.available, false)
  assert.equal(value.workspace.workspace, null)
  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('cloud ASR key test route validates key without backend', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18522, python: TEST_PYTHON })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, text: async () => 'data: [DONE]\n\n' }
  }
  try {
    const ok = response()
    await routes.get('/meetclip/app/asr/test').handler(request({
      method: 'POST', url: '/meetclip/app/asr/test',
      body: { api_key: 'sk-test-key', base_url: 'https://gateway.example.test/v1', model: 'demo-asr' }
    }), ok)
    assert.equal(ok.status, 200, ok.body)
    assert.equal(JSON.parse(ok.body).ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.headers.authorization, 'Bearer sk-test-key')
    assert.equal(calls[0].url, 'https://gateway.example.test/v1/chat/completions')
    // 没有服务地址就不该发请求，而是提示先填写。
    const noBase = response()
    await routes.get('/meetclip/app/asr/test').handler(request({
      method: 'POST', url: '/meetclip/app/asr/test', body: { api_key: 'sk-test-key' }
    }), noBase)
    assert.equal(noBase.status, 502)
    assert.match(JSON.parse(noBase.body).detail, /Base URL/)
    const denied = response()
    await routes.get('/meetclip/app/asr/test').handler(request({
      method: 'POST', url: '/meetclip/app/asr/test', body: { api_key: '' }
    }), denied)
    assert.equal(denied.status, 502)
  } finally {
    globalThis.fetch = original
    fs.rmSync(stateDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('model catalog route lists gateway models without backend', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18530, python: TEST_PYTHON })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/models$/)
    assert.equal(options.headers.authorization, 'Bearer sk-test-key')
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'mimo-v2.5-asr' }, { id: 'gpt-4o' }, { id: 'x:batch' }] }) }
  }
  try {
    const ok = response()
    await routes.get('/meetclip/app/models').handler(request({
      method: 'POST', url: '/meetclip/app/models',
      body: { api_key: 'sk-test-key', base_url: 'https://gateway.example.test/v1' }
    }), ok)
    assert.equal(ok.status, 200, ok.body)
    assert.deepEqual(JSON.parse(ok.body).models, ['mimo-v2.5-asr', 'gpt-4o'])

    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{}' })
    const denied = response()
    await routes.get('/meetclip/app/models').handler(request({
      method: 'POST', url: '/meetclip/app/models',
      body: { api_key: 'bad', base_url: 'https://gateway.example.test/v1' }
    }), denied)
    assert.equal(denied.status, 502)
    assert.match(JSON.parse(denied.body).detail, /无效/)

    const empty = response()
    await routes.get('/meetclip/app/models').handler(request({
      method: 'POST', url: '/meetclip/app/models',
      body: { api_key: '', base_url: 'https://gateway.example.test/v1' }
    }), empty)
    assert.equal(empty.status, 502)
  } finally {
    globalThis.fetch = original
    fs.rmSync(stateDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('storage inspection reports libraries, nesting and the current directory', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const libraryDir = tempDir()
  fs.writeFileSync(path.join(libraryDir, 'zhibo.db'), 'db')
  fs.writeFileSync(path.join(libraryDir, 'note.md'), 'hello')

  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18530, python: TEST_PYTHON })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)

  const current = response()
  await routes.get('/meetclip/app/data-dir/inspect').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir/inspect', body: { path: dataDir }
  }), current)
  assert.equal(current.status, 200, current.body)
  const currentPayload = JSON.parse(current.body)
  assert.equal(currentPayload.isCurrent, true)
  assert.equal(currentPayload.writable, true)
  assert.equal(currentPayload.hasLibrary, false)

  const library = response()
  await routes.get('/meetclip/app/data-dir/inspect').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir/inspect', body: { path: libraryDir }
  }), library)
  const libraryPayload = JSON.parse(library.body)
  assert.equal(libraryPayload.hasLibrary, true)
  assert.equal(libraryPayload.empty, false)
  assert.equal(libraryPayload.entryCount, 2)

  const missing = response()
  await routes.get('/meetclip/app/data-dir/inspect').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir/inspect',
    body: { path: path.join(dataDir, 'new', 'library'), measure: false }
  }), missing)
  const missingPayload = JSON.parse(missing.body)
  assert.equal(missingPayload.exists, false)
  assert.equal(missingPayload.writable, true)
  assert.equal(missingPayload.sizeBytes, 0)

  const nested = response()
  await routes.get('/meetclip/app/data-dir/inspect').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir/inspect', body: { path: path.join(dataDir, 'inner') }
  }), nested)
  const nestedPayload = JSON.parse(nested.body)
  assert.equal(nestedPayload.exists, false)
  assert.equal(nestedPayload.insideCurrent, true)

  const relative = response()
  await routes.get('/meetclip/app/data-dir/inspect').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir/inspect', body: { path: 'relative/dir' }
  }), relative)
  assert.equal(relative.status, 400)
  assert.equal(JSON.parse(relative.body).code, 'storage_path_relative')

  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(libraryDir, { recursive: true, force: true })
})

test('switching the storage directory rewrites prefs and rejects bad targets', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const nextDir = path.join(tempDir(), 'nested', 'store')
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18531, python: TEST_PYTHON })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)

  const ok = response()
  await routes.get('/meetclip/app/data-dir').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir', body: { path: nextDir }
  }), ok)
  assert.equal(ok.status, 200, ok.body)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.dataDir, nextDir)
  assert.equal(payload.previous, dataDir)
  assert.equal(payload.moved, false)
  assert.equal(payload.restarted, false)
  assert.equal(runtime.settings.dataDir, nextDir)
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'prefs.json'), 'utf8')).dataDir, nextDir)

  async function expectRejected(body, code) {
    const reply = response()
    await routes.get('/meetclip/app/data-dir').handler(request({
      method: 'POST', url: '/meetclip/app/data-dir', body
    }), reply)
    assert.equal(reply.status, 400, reply.body)
    assert.equal(JSON.parse(reply.body).code, code)
    assert.equal(runtime.settings.dataDir, nextDir)
  }

  await expectRejected({ path: nextDir }, 'storage_unchanged')
  await expectRejected({ path: path.join(nextDir, 'inner') }, 'storage_nested')
  await expectRejected({ path: path.dirname(nextDir) }, 'storage_parent')

  const fileTarget = path.join(tempDir(), 'not-a-dir')
  fs.writeFileSync(fileTarget, 'x')
  await expectRejected({ path: fileTarget }, 'storage_not_directory')

  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(nextDir, { recursive: true, force: true })
  fs.rmSync(fileTarget, { force: true })
})

test('moving the library keeps its files and removes the old directory', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  fs.writeFileSync(path.join(dataDir, 'zhibo.db'), 'db')
  const recordDir = path.join(dataDir, 'abc123')
  fs.mkdirSync(recordDir)
  fs.writeFileSync(path.join(recordDir, 'media.m4a'), 'audio')
  const nextDir = tempDir()

  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18532, python: TEST_PYTHON })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)

  const ok = response()
  await routes.get('/meetclip/app/data-dir').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir', body: { path: nextDir, move: true }
  }), ok)
  assert.equal(ok.status, 200, ok.body)
  assert.equal(JSON.parse(ok.body).moved, true)
  assert.equal(fs.existsSync(dataDir), false)
  assert.equal(fs.readFileSync(path.join(nextDir, 'zhibo.db'), 'utf8'), 'db')
  assert.equal(fs.readFileSync(path.join(nextDir, 'abc123', 'media.m4a'), 'utf8'), 'audio')

  const busy = tempDir()
  fs.writeFileSync(path.join(busy, 'keep.txt'), 'x')
  const conflict = response()
  await routes.get('/meetclip/app/data-dir').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir', body: { path: busy, move: true }
  }), conflict)
  assert.equal(conflict.status, 400, conflict.body)
  assert.equal(JSON.parse(conflict.body).code, 'storage_not_empty')
  assert.equal(fs.existsSync(path.join(busy, 'keep.txt')), true)

  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(nextDir, { recursive: true, force: true })
  fs.rmSync(busy, { recursive: true, force: true })
})

test('storage switch refuses an externally managed engine', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const nextDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18533, python: TEST_PYTHON })
  runtime.backend.attached = true
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)

  const reply = response()
  await routes.get('/meetclip/app/data-dir').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir', body: { path: nextDir }
  }), reply)
  assert.equal(reply.status, 409, reply.body)
  assert.equal(JSON.parse(reply.body).code, 'storage_backend_external')
  assert.equal(runtime.settings.dataDir, dataDir)

  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(nextDir, { recursive: true, force: true })
})

test('workspace routes create and reuse the storage directory', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18534, python: TEST_PYTHON })
  const registry = fakeWorkspaceRegistry()
  const { ctx, routes } = fakeContext({ services: { workspaceRegistry: registry } })
  registerAppRoutes(ctx, runtime)

  const first = response()
  await routes.get('/meetclip/app/workspace').handler(request({
    method: 'POST', url: '/meetclip/app/workspace', body: {}
  }), first)
  assert.equal(first.status, 200, first.body)
  const created = JSON.parse(first.body)
  assert.equal(created.created, true)
  assert.equal(created.workspace.path, fs.realpathSync(dataDir))
  assert.equal(created.workspace.title, path.basename(dataDir))

  const second = response()
  await routes.get('/meetclip/app/workspace').handler(request({
    method: 'POST', url: '/meetclip/app/workspace', body: {}
  }), second)
  assert.equal(JSON.parse(second.body).created, false)
  assert.equal(registry.list().length, 1)

  const statusReply = response()
  await routes.get('/meetclip/app/workspace').handler(request({
    url: '/meetclip/app/workspace'
  }), statusReply)
  const statusPayload = JSON.parse(statusReply.body)
  assert.equal(statusPayload.available, true)
  assert.equal(statusPayload.workspace.path, fs.realpathSync(dataDir))

  const dataNamed = path.join(tempDir(), 'data')
  fs.mkdirSync(dataNamed, { recursive: true })
  const titled = response()
  await routes.get('/meetclip/app/workspace').handler(request({
    method: 'POST', url: '/meetclip/app/workspace', body: { path: dataNamed }
  }), titled)
  assert.equal(JSON.parse(titled.body).workspace.title, '会摘资料')

  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(path.dirname(dataNamed), { recursive: true, force: true })
})

test('workspace route explains a missing registry', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18535, python: TEST_PYTHON })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)

  const reply = response()
  await routes.get('/meetclip/app/workspace').handler(request({
    method: 'POST', url: '/meetclip/app/workspace', body: {}
  }), reply)
  assert.equal(reply.status, 501, reply.body)
  const payload = JSON.parse(reply.body)
  assert.equal(payload.code, 'workspace_unavailable')
  assert.match(payload.detail, /工作区/)

  const statusReply = response()
  await routes.get('/meetclip/app/workspace').handler(request({
    url: '/meetclip/app/workspace'
  }), statusReply)
  assert.equal(JSON.parse(statusReply.body).available, false)

  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('feishu routes expose status and validate input', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const dsh = tempDir()
  const previousDsh = process.env.DSH_HOME
  process.env.DSH_HOME = dsh
  try {
    const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18520 })
    const { ctx, routes } = fakeContext()
    registerAppRoutes(ctx, runtime)

    const status = response()
    await routes.get('/meetclip/app/feishu/status').handler(request({ url: '/meetclip/app/feishu/status' }), status)
    assert.equal(status.status, 200)
    const payload = JSON.parse(status.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.dsh.patchPath, path.join(dsh, 'cordis.patch.yml'))
    assert.equal(payload.dsh.entryPresent, false)
    assert.equal(payload.dsh.entryLive, null)
    assert.ok(typeof payload.auth.loggedIn === 'boolean')
    assert.ok(!JSON.stringify(payload).includes('access_token'))
    assert.ok(!JSON.stringify(payload).includes('refresh_token'))

    const remove = response()
    await routes.get('/meetclip/app/feishu/config').handler(request({
      method: 'POST',
      url: '/meetclip/app/feishu/config',
      body: { action: 'remove' }
    }), remove)
    assert.equal(remove.status, 200)
    assert.equal(JSON.parse(remove.body).changed, false)

    const bad = response()
    await routes.get('/meetclip/app/feishu/config').handler(request({
      method: 'POST',
      url: '/meetclip/app/feishu/config',
      body: { action: 'rename' }
    }), bad)
    assert.equal(bad.status, 400)

    const add = response()
    await routes.get('/meetclip/app/feishu/config').handler(request({
      method: 'POST',
      url: '/meetclip/app/feishu/config',
      body: { action: 'add' }
    }), add)
    assert.equal(add.status, 409)

    runtime.feishu.job = {
      action: 'install', state: 'running', step: '', log: '', url: '', error: '', done: false, startedAt: Date.now()
    }
    const conflict = response()
    await routes.get('/meetclip/app/feishu/install').handler(request({
      method: 'POST',
      url: '/meetclip/app/feishu/install',
      body: {}
    }), conflict)
    assert.equal(conflict.status, 409)
    runtime.feishu.cancel()

    const blocked = response()
    await routes.get('/meetclip/app/open').handler(request({
      method: 'POST',
      url: '/meetclip/app/open',
      body: { target: 'url', url: 'https://evil.example.com/x' }
    }), blocked)
    assert.equal(blocked.status, 400)
  } finally {
    if (previousDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDsh
    fs.rmSync(stateDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(dsh, { recursive: true, force: true })
  }
})

test('feishu doc-card route reads via MCP and rejects bad input', async () => {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const tools = {
    executable: () => true,
    async execute({ calls }) {
      assert.equal(calls[0].name, 'mcp__feishu__doc_read')
      return {
        results: [{
          callId: calls[0].id,
          result: {
            isError: false,
            content: [{
              type: 'text',
              text: JSON.stringify({ title: '会议纪要：物模型白皮书', content: '物模型正文', revision_id: 2 })
            }]
          }
        }]
      }
    }
  }
  try {
    const runtime = new MeetClipRuntime({ stateDir, dataDir, port: 18521 })
    const posted = []
    runtime.backend.json = async (pathname, init) => {
      posted.push({ pathname, init })
      return { ok: true, created: true, card: { title: '会议纪要：物模型白皮书', path: '会摘卡片/会议纪要.md' } }
    }
    const { ctx, routes } = fakeContext({ services: { tools } })
    registerAppRoutes(ctx, runtime)

    const ok = response()
    await routes.get('/meetclip/app/feishu/doc-card').handler(request({
      method: 'POST',
      url: '/meetclip/app/feishu/doc-card',
      body: { url: 'https://example.feishu.cn/docx/ExampleDocToken1' }
    }), ok)
    assert.equal(ok.status, 200, ok.body)
    const payload = JSON.parse(ok.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.link_only, false)
    assert.equal(posted.length, 1)
    assert.equal(posted[0].pathname, '/api/cards/doc')
    const body = JSON.parse(posted[0].init.body)
    assert.equal(body.document_id, 'ExampleDocToken1')
    assert.equal(body.content, '物模型正文')

    const preview = response()
    await routes.get('/meetclip/app/feishu/doc-preview').handler(request({
      method: 'POST',
      url: '/meetclip/app/feishu/doc-preview',
      body: { url: 'https://example.feishu.cn/docx/ExampleDocToken1' }
    }), preview)
    assert.equal(preview.status, 200, preview.body)
    const previewPayload = JSON.parse(preview.body)
    assert.equal(previewPayload.title, '会议纪要：物模型白皮书')
    assert.equal(previewPayload.doc_type, 'docx')
    assert.equal(previewPayload.has_content, true)
    assert.equal(posted.length, 1)

    const bad = response()
    await routes.get('/meetclip/app/feishu/doc-card').handler(request({
      method: 'POST',
      url: '/meetclip/app/feishu/doc-card',
      body: { url: 'https://example.feishu.cn/minutes/obcn1g2429f9e82rg5euo348' }
    }), bad)
    assert.equal(bad.status, 400)

    const empty = fakeContext()
    registerAppRoutes(empty.ctx, runtime)
    const unavailable = response()
    await empty.routes.get('/meetclip/app/feishu/doc-card').handler(request({
      method: 'POST',
      url: '/meetclip/app/feishu/doc-card',
      body: { url: 'https://example.feishu.cn/docx/ExampleDocToken1', link_only: true }
    }), unavailable)
    assert.equal(unavailable.status, 200)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
