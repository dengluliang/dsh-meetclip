import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSettings, packageVersion } from '../src/host/config.js'
import { BackendManager } from '../src/host/backend.js'

// 假后端：只回答 /api/health，字段与真后端一致（含 version / app_dir / pid）。
const FAKE_BACKEND = `
const http = require('node:http')
const payload = JSON.parse(process.argv[1])
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url.startsWith('/api/sessions')) {
    res.end(JSON.stringify(payload.sessions || []))
    return
  }
  res.end(JSON.stringify({
    ok: true, protocol: 3, app: 'meetclip', pid: process.pid,
    data_dir: payload.dataDir, version: payload.version, app_dir: payload.appDir
  }))
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('ready ' + server.address().port + '\\n')
})
const stop = () => { try { server.close() } catch {} process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
`

function startFakeBackend({ version, appDir, dataDir, sessions = [] }) {
  const child = spawn(process.execPath, ['-e', FAKE_BACKEND, JSON.stringify({ version, appDir, dataDir, sessions })], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('假后端启动超时')), 10_000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const match = buffer.match(/ready (\d+)/)
      if (!match) return
      clearTimeout(timer)
      resolve({ child, port: Number(match[1]) })
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// child.exitCode / 'exit' 事件在部分运行时下会迟到，判断进程有没有走掉直接看 pid。
async function waitGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `meetclip-attach-${name}-`))
}

// dataDir 与 /api/health 报的一致才能被接管（adopt 会比对数据目录）。
function prepareRoot(name) {
  const root = tempRoot(name)
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, '.api-token'), 't'.repeat(43), 'utf8')
  return { root, dataDir }
}

function makeSettings(port, root, extra = {}) {
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  return resolveSettings({ port, dataDir, stateDir: path.join(root, 'state'), ...extra })
}

test('接管前先比对版本：旧后端会被结束，不带着旧代码继续跑', async (t) => {
  const { root, dataDir } = prepareRoot('stale')
  const { child, port } = await startFakeBackend({ version: '0.0.1', appDir: root, dataDir })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })

  const manager = new BackendManager(makeSettings(port, root))
  // 旧后端被杀掉后走 spawn：测试环境没有 venv 里的 python，因此必然 no_env。
  await assert.rejects(manager.ensure(), (error) => error.code === 'no_env')
  assert.equal(await waitGone(child.pid), true, '旧后端进程应已被结束')
  assert.equal(manager.state, 'stopped')
  assert.equal(manager.pid, null)
})

test('旧版本后端正在采集时不替换它，等它空下来再说', async (t) => {
  const { root, dataDir } = prepareRoot('busy')
  const { child, port } = await startFakeBackend({
    version: '0.0.1', appDir: root, dataDir, sessions: [{ status: 'recording' }]
  })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })

  const manager = new BackendManager(makeSettings(port, root))
  const status = await manager.ensure()
  assert.equal(status.mode, 'attached')
  assert.equal(status.phase, 'stale_busy')
  assert.equal(isAlive(child.pid), true, '采集中不替换后端')
})

test('版本一致的后端照旧接管成 attached', async (t) => {
  const { root, dataDir } = prepareRoot('adopt')
  const { child, port } = await startFakeBackend({ version: packageVersion, appDir: root, dataDir })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })

  const manager = new BackendManager(makeSettings(port, root))
  const status = await manager.ensure()
  assert.equal(status.state, 'running')
  assert.equal(status.mode, 'attached')
  assert.equal(status.pid, child.pid)
})

test('不上报版本的更老后端按安装目录判断，不同目录同样视为过期', async (t) => {
  const { root, dataDir } = prepareRoot('dir')
  const { child, port } = await startFakeBackend({
    version: '', appDir: path.join(root, 'elsewhere'), dataDir
  })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })

  const manager = new BackendManager(makeSettings(port, root))
  await assert.rejects(manager.ensure(), (error) => error.code === 'no_env')
  assert.equal(await waitGone(child.pid), true, '不同目录的后端也应被结束')
})

test('attached 后端掉线后不再假装 running', async (t) => {
  const { root, dataDir } = prepareRoot('liveness')
  const { child, port } = await startFakeBackend({ version: packageVersion, appDir: root, dataDir })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })

  const manager = new BackendManager(makeSettings(port, root))
  await manager.ensure()
  child.kill('SIGINT')
  await waitGone(child.pid)

  await assert.rejects(manager.ensure(), (error) => error.code === 'no_env')
  assert.equal(manager.state, 'stopped')
  assert.equal(manager.pid, null)
})

test('external 模式不替别人重启后端，只继续接管', async (t) => {
  const { root, dataDir } = prepareRoot('external')
  const { child, port } = await startFakeBackend({ version: '0.0.1', appDir: root, dataDir })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })

  const manager = new BackendManager(makeSettings(port, root, { backendMode: 'external' }))
  const status = await manager.ensure()
  assert.equal(status.mode, 'attached')
  assert.equal(isAlive(child.pid), true, '外部管理的后端不归插件结束')
})

test('stop() 对 attached 后端真的结束进程，restart() 才有意义', async (t) => {
  const { root, dataDir } = prepareRoot('stop')
  const { child, port } = await startFakeBackend({ version: packageVersion, appDir: root, dataDir })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })

  const manager = new BackendManager(makeSettings(port, root))
  await manager.ensure()
  await manager.stop()
  assert.equal(await waitGone(child.pid), true, 'attached 进程应被结束')
  assert.equal(manager.state, 'stopped')
  assert.equal(manager.pid, null)
})
