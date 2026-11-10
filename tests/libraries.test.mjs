import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { MeetClipRuntime } from '../src/host/runtime.js'
import { registerAppRoutes } from '../src/host/routes.js'
import {
  ensureSharedDir, libraryIdFor, readRegistry, validateNewLibrary
} from '../src/host/libraries.js'

const TEST_PYTHON = process.env.MEETCLIP_TEST_PYTHON
  || path.join(os.homedir(), '.dsh', 'meetclip', 'venv', 'bin', 'python')

function tempDir(prefix = 'meetclip-libraries-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 造一个「已经有会摘资料」的目录。 */
function seedLibrary(dir, { db = 'db', records = 1 } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  if (db) fs.writeFileSync(path.join(dir, 'zhibo.db'), db)
  for (let index = 0; index < records; index += 1) {
    const record = path.join(dir, (index + 1).toString(16).padStart(12, 'a'))
    fs.mkdirSync(record, { recursive: true })
    fs.writeFileSync(path.join(record, 'media.m4a'), 'audio')
  }
  return dir
}

/**
 * 假引擎：只为断言调用顺序，绝不 spawn 真进程（本机真实引擎正在被别的任务使用）。
 */
function fakeBackend({ attached = false, state = 'running', sessions = [] } = {}) {
  const fake = {
    calls: [],
    state,
    attached,
    managed: !attached,
    async json(pathname) {
      fake.calls.push(pathname)
      if (pathname === '/api/sessions') {
        return typeof sessions === 'function' ? sessions() : sessions
      }
      if (pathname.endsWith('/stop')) return { ok: true }
      return { ok: true }
    },
    async stop() {
      fake.calls.push('stop')
      fake.state = 'stopped'
      return { state: 'stopped' }
    },
    async ensure() {
      fake.calls.push('ensure')
      if (fake.failEnsure) throw fake.failEnsure
      fake.state = 'running'
      return { state: 'running' }
    },
    async restart() {
      fake.calls.push('restart')
      fake.state = 'running'
      return { state: 'running' }
    },
    refresh() {},
    status: () => ({ state: fake.state, attached: fake.attached }),
    async dispose() {}
  }
  return fake
}

function fakeContext() {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      }
    },
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      return undefined
    },
    effect(callback) {
      return callback()
    }
  }
  return { ctx, routes }
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

function prefsOf(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'prefs.json'), 'utf8'))
}

test('旧 prefs 迁移成单个资料空间，并保留 dataDir 镜像', () => {
  const stateDir = tempDir()
  const dataDir = seedLibrary(path.join(tempDir(), 'work'))
  fs.writeFileSync(path.join(stateDir, 'prefs.json'),
    JSON.stringify({ dataDir, port: 18999, keepMe: { a: 1 } }))

  const registry = readRegistry(stateDir)
  assert.equal(registry.libraries.length, 1)
  assert.equal(registry.legacy, true)
  const entry = registry.libraries[0]
  assert.equal(path.resolve(entry.dataDir), path.resolve(dataDir))
  assert.equal(entry.name, 'work')
  assert.equal(entry.id, libraryIdFor(dataDir))
  assert.equal(registry.activeLibraryId, entry.id)
  assert.equal(registry.port, 18999)

  // 迁移读取不落盘
  assert.equal(prefsOf(stateDir).libraries, undefined)

  const runtime = new MeetClipRuntime({ stateDir })
  assert.equal(path.resolve(runtime.settings.dataDir), path.resolve(dataDir))
  assert.equal(runtime.settings.library.name, 'work')
  assert.equal(runtime.settings.libraries.length, 1)

  // 第一次写入：升级格式、备份旧文件、保留未知字段与端口
  runtime.persist({ ...registry, activeLibraryId: entry.id })
  const saved = prefsOf(stateDir)
  assert.equal(saved.schema, 2)
  assert.equal(saved.dataDir, dataDir)
  assert.equal(saved.port, 18999)
  assert.deepEqual(saved.keepMe, { a: 1 })
  assert.equal(saved.libraries.length, 1)
  assert.equal(fs.existsSync(path.join(stateDir, 'prefs.json.bak-v1')), true)

  for (const dir of [stateDir, path.dirname(dataDir)]) fs.rmSync(dir, { recursive: true, force: true })
})

test('目录里的身份标记让资料空间改名/搬家后仍然是同一个', () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })
  const created = runtime.createLibrarySync({ name: '工作', dataDir: work, activate: true })
  const markerPath = path.join(work, '.meetclip-library.json')
  assert.equal(fs.existsSync(markerPath), true)

  // 目录搬到别处后，旧路径会如实标成「不存在」，不会被偷偷新建；
  // 按新路径重新收养时，标记文件让 id 与名称都保持不变。
  const renamed = path.join(root, 'work-renamed')
  fs.renameSync(work, renamed)
  const stale = readRegistry(stateDir).libraries.find((row) => row.id === created.library.id)
  assert.equal(fs.existsSync(stale.dataDir), false, 'old path is reported missing, not recreated')

  const readopted = new MeetClipRuntime({ stateDir, dataDir: renamed })
  const again = readopted.createLibrarySync({ dataDir: renamed, activate: false })
  assert.equal(again.library.id, created.library.id, 'identity survives the move')
  assert.equal(again.library.name, '工作')

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('新建资料空间拒绝危险目标', () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })
  runtime.createLibrarySync({ name: '工作', dataDir: work, activate: true })
  const registry = readRegistry(stateDir)

  const code = (fn) => {
    try {
      fn()
      return 'ok'
    } catch (error) {
      return error.code
    }
  }

  assert.equal(code(() => validateNewLibrary(registry, { dataDir: 'relative/dir' })), 'library_path_relative')
  assert.equal(code(() => validateNewLibrary(registry, { dataDir: '/' })), 'library_path_root')
  assert.equal(code(() => validateNewLibrary(registry, { dataDir: work })), 'library_exists')
  assert.equal(code(() => validateNewLibrary(registry, { dataDir: path.join(work, 'inner') })), 'library_nested')
  assert.equal(code(() => validateNewLibrary(registry, { dataDir: root })), 'library_contains')

  const notADir = path.join(root, 'file')
  fs.writeFileSync(notADir, 'x')
  assert.equal(code(() => validateNewLibrary(registry, { dataDir: notADir })), 'library_path_not_directory')

  const busy = path.join(root, 'busy')
  fs.mkdirSync(busy)
  fs.writeFileSync(path.join(busy, 'keep.txt'), 'x')
  assert.equal(code(() => validateNewLibrary(registry, { dataDir: busy })), 'library_not_empty')
  // force 之后可以收养一个非空目录，内容不会被删
  assert.equal(code(() => validateNewLibrary(registry, { dataDir: busy, force: true })), 'ok')
  assert.equal(fs.existsSync(path.join(busy, 'keep.txt')), true)

  assert.equal(code(() => validateNewLibrary(registry, { dataDir: path.join(root, 'x'), name: 'a/b' })), 'library_name_invalid')
  assert.equal(code(() => validateNewLibrary(registry, { dataDir: path.join(root, 'x'), name: '名'.repeat(41) })), 'library_name_too_long')

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('重名自动加序号，改名同步写标记文件', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const life = seedLibrary(path.join(root, 'life'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })

  const first = runtime.createLibrarySync({ name: '工作', dataDir: work, activate: true })
  const second = await runtime.createLibrary({ name: '工作', dataDir: life, activate: false })
  assert.equal(second.library.name, '工作 2')

  const renamed = await runtime.renameLibrary({ id: first.library.id, name: '工作 (公司)' })
  assert.equal(renamed.library.name, '工作 (公司)')
  const marker = JSON.parse(fs.readFileSync(path.join(work, '.meetclip-library.json'), 'utf8'))
  assert.equal(marker.name, '工作 (公司)')

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('移除只从列表删除，绝不删盘，也不许移除正在用的空间', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const life = seedLibrary(path.join(root, 'life'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })
  const workLib = runtime.createLibrarySync({ name: '工作', dataDir: work, activate: true })
  const lifeLib = runtime.createLibrarySync({ name: '生活', dataDir: life })

  await assert.rejects(
    () => runtime.forgetLibrary({ id: workLib.library.id, confirmPath: work }),
    (error) => error.code === 'library_active'
  )
  await assert.rejects(
    () => runtime.forgetLibrary({ id: lifeLib.library.id }),
    (error) => error.code === 'library_confirm_required'
  )

  const removed = await runtime.forgetLibrary({ id: lifeLib.library.id, confirmPath: life })
  assert.equal(removed.deleted, false)
  assert.equal(fs.existsSync(path.join(life, 'zhibo.db')), true, 'files are untouched')
  assert.equal(readRegistry(stateDir).libraries.length, 1)

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('切换时先拦住正在跑的任务，确认中断后才停引擎', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const life = seedLibrary(path.join(root, 'life'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })
  runtime.createLibrarySync({ name: '工作', dataDir: work, activate: true })
  const lifeLib = runtime.createLibrarySync({ name: '生活', dataDir: life })

  let recording = true
  const backend = fakeBackend({
    sessions: () => (recording
      ? [{ id: 'aaaaaaaaaaaa', title: '直播', kind: 'live', status: 'recording', queue_position: null }]
      : [{ id: 'aaaaaaaaaaaa', title: '直播', kind: 'live', status: 'done', queue_position: null }])
  })
  // 收到 /stop 就等于采集干净收尾
  const stopJson = backend.json.bind(backend)
  backend.json = async (pathname, init) => {
    const value = await stopJson(pathname, init)
    if (pathname.endsWith('/stop')) recording = false
    return value
  }
  runtime.backend = backend
  runtime.cards.sync = async () => ({ ok: true })

  await assert.rejects(
    () => runtime.activateLibrary({ id: lifeLib.library.id }),
    (error) => {
      assert.equal(error.code, 'library_busy')
      assert.equal(error.detail.work.length, 1)
      assert.equal(error.detail.work[0].status, 'recording')
      return true
    }
  )
  assert.equal(backend.calls.includes('stop'), false, 'engine must stay up without consent')
  assert.equal(path.resolve(runtime.settings.dataDir), path.resolve(work))

  const switched = await runtime.activateLibrary({ id: lifeLib.library.id, interrupt: true })
  assert.equal(switched.switched, true)
  assert.deepEqual(switched.stopped, ['aaaaaaaaaaaa'])
  assert.equal(switched.interrupted, false)
  const stopIndex = backend.calls.indexOf('/api/sessions/aaaaaaaaaaaa/stop')
  const engineStopIndex = backend.calls.indexOf('stop')
  assert.ok(stopIndex >= 0 && engineStopIndex > stopIndex, '采集先收尾，引擎后停')
  assert.equal(path.resolve(runtime.settings.dataDir), path.resolve(life))
  assert.equal(readRegistry(stateDir).activeLibraryId, lifeLib.library.id)

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('引擎起不来时回滚到原来的资料空间', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const life = seedLibrary(path.join(root, 'life'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })
  const workLib = runtime.createLibrarySync({ name: '工作', dataDir: work, activate: true })
  const lifeLib = runtime.createLibrarySync({ name: '生活', dataDir: life })

  const backend = fakeBackend({})
  backend.failEnsure = Object.assign(new Error('引擎启动失败'), { code: 'start_failed' })
  runtime.backend = backend
  runtime.cards.sync = async () => ({ ok: true })

  await assert.rejects(() => runtime.activateLibrary({ id: lifeLib.library.id }))
  assert.equal(readRegistry(stateDir).activeLibraryId, workLib.library.id, 'prefs rolled back')
  assert.equal(path.resolve(runtime.settings.dataDir), path.resolve(work))

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('外部托管的引擎不允许切换资料空间', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const life = seedLibrary(path.join(root, 'life'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })
  runtime.createLibrarySync({ name: '工作', dataDir: work, activate: true })
  const lifeLib = runtime.createLibrarySync({ name: '生活', dataDir: life })
  runtime.backend = fakeBackend({ attached: true })

  await assert.rejects(
    () => runtime.activateLibrary({ id: lifeLib.library.id }),
    (error) => error.code === 'library_locked'
  )
  assert.equal(path.resolve(runtime.settings.dataDir), path.resolve(work))

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('资料空间不存在时明确报错，不会偷偷新建空库', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const life = seedLibrary(path.join(root, 'life'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })
  runtime.createLibrarySync({ name: '工作', dataDir: work, activate: true })
  const lifeLib = runtime.createLibrarySync({ name: '生活', dataDir: life })
  runtime.backend = fakeBackend({})
  fs.rmSync(life, { recursive: true, force: true })

  await assert.rejects(
    () => runtime.activateLibrary({ id: lifeLib.library.id }),
    (error) => error.code === 'library_missing'
  )
  assert.equal(fs.existsSync(life), false)

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('共享目录只复制一次账号文件，绝不覆盖已有内容', () => {
  const root = tempDir()
  const source = path.join(root, 'work')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'settings.json'), '{"asr_provider":"mimo"}')
  fs.writeFileSync(path.join(source, 'bili_cookies.txt'), 'cookie')
  const shared = path.join(root, 'shared')

  const first = ensureSharedDir({ sharedDir: shared, sourceDir: source })
  assert.deepEqual(first.copied.sort(), ['bili_cookies.txt', 'settings.json'])
  assert.equal(fs.readFileSync(path.join(shared, 'bili_cookies.txt'), 'utf8'), 'cookie')

  fs.writeFileSync(path.join(source, 'bili_cookies.txt'), 'newer-cookie')
  const second = ensureSharedDir({ sharedDir: shared, sourceDir: source })
  assert.deepEqual(second.copied, [])
  assert.equal(fs.readFileSync(path.join(shared, 'bili_cookies.txt'), 'utf8'), 'cookie')

  assert.throws(() => ensureSharedDir({ sharedDir: 'relative', sourceDir: source }),
    (error) => error.code === 'shared_dir_invalid')

  fs.rmSync(root, { recursive: true, force: true })
})

test('新建第一个额外空间时自动准备共享目录', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  fs.writeFileSync(path.join(work, 'settings.json'), '{"shot_sensitivity":0.6}')
  fs.writeFileSync(path.join(work, 'douyin_cookies.txt'), 'dy')
  const life = seedLibrary(path.join(root, 'life'))
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work })

  assert.equal(runtime.settings.sharedDir, null, '单库时不启用共享目录')
  const created = await runtime.createLibrary({ name: '生活', dataDir: life, activate: false })
  assert.ok(created.sharing, 'sharing is prepared with the second library')
  assert.deepEqual(created.sharing.copied.sort(), ['douyin_cookies.txt', 'settings.json'])
  assert.equal(runtime.settings.sharedDir, created.sharing.sharedDir)
  assert.equal(fs.existsSync(path.join(work, 'settings.json')), true, '原件保留')

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('兼容路由：data-dir 与 prefs 仍然落到资料空间上', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'))
  const life = path.join(root, 'life')
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work, port: 18541, python: TEST_PYTHON })
  runtime.backend = fakeBackend({ state: 'stopped', attached: false })
  runtime.cards.sync = async () => ({ ok: true })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)

  const switched = response()
  await routes.get('/meetclip/app/data-dir').handler(request({
    method: 'POST', url: '/meetclip/app/data-dir', body: { path: life }
  }), switched)
  assert.equal(switched.status, 200, switched.body)
  const payload = JSON.parse(switched.body)
  assert.equal(payload.dataDir, life)
  assert.equal(payload.previous, work)
  assert.equal(payload.moved, false)
  assert.equal(payload.restarted, false)
  assert.equal(path.resolve(runtime.settings.dataDir), path.resolve(life))
  assert.equal(prefsOf(stateDir).dataDir, life)
  assert.equal(prefsOf(stateDir).libraries.length, 2)

  const pref = response()
  await routes.get('/meetclip/app/prefs').handler(request({
    method: 'POST', url: '/meetclip/app/prefs', body: { dataDir: work }
  }), pref)
  assert.equal(pref.status, 200, pref.body)
  assert.equal(path.resolve(runtime.settings.dataDir), path.resolve(work))
  assert.equal(prefsOf(stateDir).libraries.length, 2, '切回已有空间不新增条目')

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})

test('资料空间路由暴露列表、预检与创建', async () => {
  const stateDir = tempDir()
  const root = tempDir()
  const work = seedLibrary(path.join(root, 'work'), { records: 2 })
  const runtime = new MeetClipRuntime({ stateDir, dataDir: work, port: 18542, python: TEST_PYTHON })
  runtime.backend = fakeBackend({ state: 'stopped', attached: false })
  const { ctx, routes } = fakeContext()
  registerAppRoutes(ctx, runtime)

  const listed = response()
  await routes.get('/meetclip/app/libraries').handler(request({ url: '/meetclip/app/libraries' }), listed)
  assert.equal(listed.status, 200, listed.body)
  const list = JSON.parse(listed.body)
  assert.equal(list.libraries.length, 1)
  assert.equal(list.libraries[0].hasLibrary, true)
  assert.equal(list.libraries[0].records, 2)
  assert.equal(list.libraries[0].active, true)

  const inspected = response()
  await routes.get('/meetclip/app/libraries/inspect').handler(request({
    method: 'POST', url: '/meetclip/app/libraries/inspect', body: { path: path.join(root, 'new') }
  }), inspected)
  assert.equal(inspected.status, 200)
  assert.equal(JSON.parse(inspected.body).exists, false)
  assert.equal(JSON.parse(inspected.body).suggestedName, 'new')

  const created = response()
  await routes.get('/meetclip/app/libraries').handler(request({
    method: 'POST',
    url: '/meetclip/app/libraries',
    body: { name: '生活', dataDir: path.join(root, 'new'), activate: false }
  }), created)
  assert.equal(created.status, 200, created.body)
  assert.equal(JSON.parse(created.body).created, true)

  const renamed = response()
  await routes.get('/meetclip/app/libraries/rename').handler(request({
    method: 'POST', url: '/meetclip/app/libraries/rename', body: { id: readRegistry(stateDir).libraries[0].id, name: '公司' }
  }), renamed)
  assert.equal(renamed.status, 200, renamed.body)

  const missing = response()
  await routes.get('/meetclip/app/libraries/activate').handler(request({
    method: 'POST', url: '/meetclip/app/libraries/activate', body: { id: 'nope' }
  }), missing)
  assert.equal(missing.status, 404)

  for (const dir of [stateDir, root]) fs.rmSync(dir, { recursive: true, force: true })
})
