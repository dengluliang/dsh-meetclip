import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { MeetClipRuntime } from '../src/host/runtime.js'
import { registerAppRoutes } from '../src/host/routes.js'
import { UpdateError } from '../src/host/update.js'

function tempDir(prefix = 'mc-update-routes-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function request({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const stream = body === undefined
    ? new Readable({ read() { this.push(null) } })
    : Readable.from([Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
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

function fakeContext({ reject = null } = {}) {
  const routes = new Map()
  return {
    ctx: {
      webServer: {
        register(route) {
          routes.set(route.path, route)
          return () => {}
        }
      },
      get(name) {
        if (name === 'connection') return { requestRejection: () => reject }
        return undefined
      },
      effect(callback) {
        return callback()
      }
    },
    routes
  }
}

function stubUpdater(overrides = {}) {
  const calls = []
  const base = {
    status: () => ({
      ok: true,
      currentVersion: '0.9.0',
      installedVersion: '0.9.0',
      restartRequired: false,
      repo: 'dengluliang/dsh-meetclip',
      target: { path: '/tmp/x', kind: 'installed', writable: true },
      latest: { version: '0.9.0' },
      updateAvailable: false,
      lastCheckAt: 0,
      job: null
    }),
    startCheck(options) {
      calls.push(['check', options])
      return { state: 'checking', phase: '检查更新' }
    },
    startInstall() {
      calls.push(['install'])
      return { state: 'downloading', phase: '下载中' }
    },
    startRollback(version) {
      calls.push(['rollback', version])
      return { state: 'installing', phase: '回退中', kind: 'rollback' }
    },
    cancel() {
      calls.push(['cancel'])
      return { status: 'cancelled' }
    },
    jobSnapshot: () => ({ state: 'checking' }),
    dispose() {},
    ...overrides
  }
  return { updater: base, calls }
}

async function setup(overrides = {}, { reject = null } = {}) {
  const stateDir = tempDir()
  const dataDir = tempDir()
  const runtime = new MeetClipRuntime({ stateDir, dataDir })
  const { updater, calls } = stubUpdater(overrides)
  runtime.update = updater
  const { ctx, routes } = fakeContext({ reject })
  registerAppRoutes(ctx, runtime)
  return { runtime, routes, calls, stateDir, dataDir }
}

test('GET /meetclip/app/update returns the updater snapshot', async () => {
  const { runtime, routes } = await setup()
  const res = response()
  await routes.get('/meetclip/app/update').handler(request(), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.currentVersion, '0.9.0')
  assert.equal(body.repo, 'dengluliang/dsh-meetclip')
  await runtime.dispose()
})

test('POST check forwards auto_install and returns the job immediately', async () => {
  const { runtime, routes, calls } = await setup()
  const res = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'check', auto_install: false } }), res
  )
  assert.equal(res.status, 200)
  assert.deepEqual(calls[0], ['check', { autoInstall: false }])
  assert.equal(JSON.parse(res.body).job.state, 'checking')
  await runtime.dispose()
})

test('POST check不带 auto_install 时只检查，不自动安装', async () => {
  const { runtime, routes, calls } = await setup()
  const res = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'check' } }), res
  )
  assert.equal(res.status, 200)
  assert.deepEqual(calls[0], ['check', { autoInstall: false }])
  assert.equal(JSON.parse(res.body).job.state, 'checking')
  await runtime.dispose()
})

test('POST check只有显式 auto_install: true 才顺带安装', async () => {
  const { runtime, routes, calls } = await setup()
  const res = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'check', auto_install: true } }), res
  )
  assert.equal(res.status, 200)
  assert.deepEqual(calls[0], ['check', { autoInstall: true }])
  await runtime.dispose()
})

test('POST install and cancel map to the manager actions', async () => {
  const { runtime, routes, calls } = await setup()
  const installRes = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'install' } }), installRes
  )
  assert.equal(installRes.status, 200)
  assert.equal(JSON.parse(installRes.body).job.state, 'downloading')

  const cancelRes = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'cancel' } }), cancelRes
  )
  assert.equal(cancelRes.status, 200)
  assert.equal(JSON.parse(cancelRes.body).status, 'cancelled')
  assert.deepEqual(calls.map((row) => row[0]), ['install', 'cancel'])
  await runtime.dispose()
})

test('POST rollback forwards the requested version and returns the job', async () => {
  const { runtime, routes, calls } = await setup()
  const withVersion = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'rollback', version: '0.9.0' } }), withVersion
  )
  assert.equal(withVersion.status, 200)
  assert.equal(JSON.parse(withVersion.body).job.kind, 'rollback')

  const latest = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'rollback' } }), latest
  )
  assert.equal(latest.status, 200)
  assert.deepEqual(calls, [['rollback', '0.9.0'], ['rollback', '']])
  await runtime.dispose()
})

test('a rollback without a backup surfaces its 409', async () => {
  const { runtime, routes } = await setup({
    startRollback() {
      throw new UpdateError('没有可回退的备份', 'no-rollback', 409)
    }
  })
  const res = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'rollback' } }), res
  )
  assert.equal(res.status, 409)
  assert.equal(JSON.parse(res.body).code, 'no-rollback')
  await runtime.dispose()
})

test('an unknown action is rejected with 400', async () => {
  const { runtime, routes } = await setup()
  const res = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'destroy' } }), res
  )
  assert.equal(res.status, 400)
  assert.match(JSON.parse(res.body).detail, /check \/ install \/ rollback \/ cancel/)
  await runtime.dispose()
})

test('a busy updater surfaces its 409 status', async () => {
  const { runtime, routes } = await setup({
    startCheck() {
      throw new UpdateError('已有更新任务在进行中', 'update-busy', 409)
    }
  })
  const res = response()
  await routes.get('/meetclip/app/update').handler(
    request({ method: 'POST', body: { action: 'check' } }), res
  )
  assert.equal(res.status, 409)
  const body = JSON.parse(res.body)
  assert.equal(body.code, 'update-busy')
  assert.match(body.detail, /已有更新/)
  await runtime.dispose()
})

test('requests without a browser session are rejected', async () => {
  const { runtime, routes } = await setup({}, { reject: 401 })
  const res = response()
  await routes.get('/meetclip/app/update').handler(request(), res)
  assert.equal(res.status, 401)
  await runtime.dispose()
})
