// 多资料空间端到端：真引擎、真端口、真目录，但全部在临时目录里，绝不碰正在用的资料库。
// 用法：node build/libraries-e2e.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { MeetClipRuntime } from '../src/host/runtime.js'

const PYTHON = process.env.MEETCLIP_TEST_PYTHON
  || path.join(os.homedir(), '.dsh', 'meetclip', 'venv', 'bin', 'python')

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const stateDir = tempDir('mc-e2e-state-')
const work = path.join(tempDir('mc-e2e-work-'), 'work')
const life = path.join(tempDir('mc-e2e-life-'), 'life')
const port = await freePort()
const runtime = new MeetClipRuntime({ stateDir, dataDir: work, port, python: PYTHON })

try {
  if (!fs.existsSync(PYTHON)) throw new Error(`缺少 python：${PYTHON}`)

  const first = await runtime.backend.ensure()
  check('引擎启动', first.state === 'running', `port=${port}`)
  let health = await runtime.backend.json('/api/health')
  check('第一个空间绑定到 work', path.resolve(health.data_dir) === path.resolve(work), health.data_dir)
  check('work 目录已有数据库', fs.existsSync(path.join(work, 'zhibo.db')))
  check('work 目录已有 token', fs.existsSync(path.join(work, '.api-token')))

  const created = await runtime.createLibrary({ name: '生活', dataDir: life, activate: true })
  check('创建并切换返回 switched', created.switched === true)
  check('新建空间是收养而不是复制', created.created === true && created.adopt === false)
  health = await runtime.backend.json('/api/health')
  check('引擎已指向 life', path.resolve(health.data_dir) === path.resolve(life), health.data_dir)
  check('life 目录生成自己的数据库与 token',
    fs.existsSync(path.join(life, 'zhibo.db')) && fs.existsSync(path.join(life, '.api-token')))
  check('共享目录已就绪（第二个空间触发）',
    Boolean(created.sharing?.sharedDir) && fs.existsSync(created.sharing.sharedDir), created.sharing?.sharedDir)

  const prefs = JSON.parse(fs.readFileSync(path.join(stateDir, 'prefs.json'), 'utf8'))
  check('prefs 记录两个空间', prefs.libraries.length === 2, `active=${prefs.activeLibraryId}`)
  check('prefs.dataDir 镜像激活空间', path.resolve(prefs.dataDir) === path.resolve(life))
  check('prefs 备份存在', fs.existsSync(path.join(stateDir, 'prefs.json.bak-v1')))

  const rows = await runtime.libraries()
  check('列表标出激活空间', rows.libraries.filter((row) => row.active).length === 1)
  const workId = rows.libraries.find((row) => path.resolve(row.dataDir) === path.resolve(work))?.id
  const lifeId = rows.libraries.find((row) => path.resolve(row.dataDir) === path.resolve(life))?.id
  check('两个空间都在列表里', Boolean(workId) && Boolean(lifeId))
  check('列表里每个空间的记录数可读',
    rows.libraries.every((row) => Number.isInteger(row.records)), rows.libraries.map((row) => `${row.name}:${row.records}`).join(' '))

  // 在生活空间建一条记录，切回工作空间后必须看不到它。
  const made = await runtime.backend.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '生活记录' })
  })
  check('生活空间可新建记录', made.ok, `HTTP ${made.status}`)
  const lifeList = await runtime.backend.json('/api/sessions')
  check('生活空间里能看到这条', lifeList.length === 1, `${lifeList.length} 条`)

  const back = await runtime.activateLibrary({ id: workId })
  check('切回工作空间', back.switched === true)
  health = await runtime.backend.json('/api/health')
  check('引擎回到 work', path.resolve(health.data_dir) === path.resolve(work), health.data_dir)

  const listA = await runtime.backend.json('/api/sessions')
  check('工作空间看不到生活空间的记录', listA.length === 0, `${listA.length} 条`)

  const again = await runtime.activateLibrary({ id: lifeId })
  const lifeAgain = await runtime.backend.json('/api/sessions')
  check('切回生活空间记录还在', again.switched === true && lifeAgain.length === 1, `${lifeAgain.length} 条`)

  const sharedFiles = fs.readdirSync(created.sharing.sharedDir)
  check('共享目录只放账号与设置', sharedFiles.every((name) => ['settings.json', 'bili_cookies.txt', 'douyin_cookies.txt'].includes(name)),
    sharedFiles.join(',') || '(空)')
} finally {
  await runtime.dispose()
  for (const dir of [stateDir, path.dirname(work), path.dirname(life)]) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) process.exit(1)
