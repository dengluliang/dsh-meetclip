import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appResourcesDir, encodePackageName, findInstaller, findNodeRuntime, installLocalPackage,
  launcherScript, localPaths, localStatus, pickBinEntry, pickLatestVersion, resolveStrategy
} from '../src/host/feishu-local.js'
import { FeishuManager, probeMcpServer, readPatchText } from '../src/host/feishu.js'

const TEST_PACKAGE = '@mi/feishu-mcp-pro'
const TEST_REGISTRY = 'https://npm.example.test/'

function tempDir(prefix = 'meetclip-feishu-local-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function withEnv(name, value) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  return () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

/** 一个只做 initialize / tools/list 的最小 MCP 服务，用来验证启动器真的能跑起来。 */
const FAKE_MCP_SERVER = `
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'fake-feishu', version: '1.0.0' }
        }
      }) + '\\n')
    } else if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
      }) + '\\n')
    }
  }
})
`

/**
 * 假 pnpm：按 `add --dir DIR pkg@version` 的约定，在 DIR 里"装"出一个带 bin 的包。
 * 真正的 pnpm 行为由 installLocalPackage 之后对 package.json 的解析来验证。
 */
const FAKE_PNPM = `
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const dirIndex = args.indexOf('--dir')
if (dirIndex < 0) { console.error('missing --dir'); process.exit(2) }
const dir = args[dirIndex + 1]
const spec = args[dirIndex + 2] || ''
const version = (spec.match(/@([^@/]+)$/) || [])[1] || '0.0.0'
const name = process.env.FAKE_PKG_NAME || ${JSON.stringify(TEST_PACKAGE)}
const packageDir = path.join(dir, 'node_modules', ...name.split('/'))
fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true })
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
  name, version, bin: { 'feishu-mcp-pro': 'dist/cli.js' }, main: 'dist/cli.js'
}, null, 2))
fs.writeFileSync(path.join(packageDir, 'dist', 'cli.js'), ${JSON.stringify(FAKE_MCP_SERVER)})
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
  name: 'meetclip-feishu-local-test', private: true, dependencies: { [name]: version }
}, null, 2))
process.exit(0)
`

function makeFakeInstaller(root) {
  const file = path.join(root, 'fake-pnpm.cjs')
  fs.writeFileSync(file, FAKE_PNPM)
  return file
}

test('包名编码：scoped 只编码斜杠，本地路径保持原样', () => {
  assert.equal(encodePackageName('@mi/feishu-mcp-pro'), '@mi%2Ffeishu-mcp-pro')
  assert.equal(encodePackageName('feishu-mcp-pro'), 'feishu-mcp-pro')
  assert.equal(encodePackageName(''), '')
})

test('registry metadata 取最新版本：latest 优先，允许 candidate 兜底', () => {
  assert.equal(pickLatestVersion({ 'dist-tags': { latest: '0.27.4' } }), '0.27.4')
  assert.equal(pickLatestVersion({ 'dist-tags': { candidate: '0.27.4', latest: 'garbage' } }), '0.27.4')
  assert.equal(pickLatestVersion({ version: '1.2.3' }), '1.2.3')
  assert.equal(pickLatestVersion({ 'dist-tags': {} }), '')
  assert.equal(pickLatestVersion(null), '')
})

test('bin 字段的三种写法都能定位入口', () => {
  assert.equal(pickBinEntry({ bin: 'cli.js' }, 'pkg'), 'cli.js')
  assert.equal(pickBinEntry({ bin: { 'feishu-mcp-pro': 'dist/bin/cli.js', other: 'x.js' } }, TEST_PACKAGE), 'dist/bin/cli.js')
  assert.equal(pickBinEntry({ bin: { aaa: 'a.js', bbb: 'b.js' } }, 'pkg'), 'a.js')
  assert.equal(pickBinEntry({ main: 'index.js' }, 'pkg'), 'index.js')
  assert.equal(pickBinEntry({}, 'pkg'), '')
})

test('启动器固化 node、入口与 ELECTRON_RUN_AS_NODE', () => {
  const script = launcherScript({
    node: { exec: '/Applications/DSH.app/Contents/MacOS/DSH' },
    entry: '/Users/me/.dsh/meetclip/feishu-mcp/node_modules/@mi/feishu-mcp-pro/dist/bin/cli.js',
    version: '0.27.4',
    generatedAt: '2026-11-18T00:00:00.000Z'
  })
  assert.match(script, /^#!\/bin\/sh/)
  assert.match(script, /export ELECTRON_RUN_AS_NODE=1/)
  assert.match(script, /exec "\/Applications\/DSH\.app\/Contents\/MacOS\/DSH" "\/Users\/me\/\.dsh\/meetclip\/feishu-mcp\/node_modules\/@mi\/feishu-mcp-pro\/dist\/bin\/cli\.js" "\$@"/)
  assert.match(script, /0\.27\.4/)
  assert.match(script, /export HOME="\$\{HOME:-/)
})

test('resources 目录可以从可执行文件反推', () => {
  const root = tempDir('meetclip-app-')
  const macos = path.join(root, 'Fake.app', 'Contents', 'MacOS')
  const resources = path.join(root, 'Fake.app', 'Contents', 'Resources')
  fs.mkdirSync(macos, { recursive: true })
  fs.mkdirSync(resources, { recursive: true })
  const exec = path.join(macos, 'Fake')
  fs.writeFileSync(exec, '')
  assert.equal(appResourcesDir(exec), resources)
  assert.equal(appResourcesDir(path.join(root, 'no-such-binary')), '')
})

test('包管理器优先级：config → DSH 自带 pnpm → PATH', () => {
  const root = tempDir('meetclip-installer-')
  const bundled = path.join(root, 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
  fs.mkdirSync(path.dirname(bundled), { recursive: true })
  fs.writeFileSync(bundled, '')
  assert.deepEqual(
    findInstaller({ settings: {}, env: { PATH: '/definitely/missing' }, resources: path.join(root, 'Resources') }),
    { kind: 'pnpm', path: bundled, source: 'dsh' }
  )
  const override = path.join(root, 'custom-pnpm.cjs')
  fs.writeFileSync(override, '')
  assert.equal(
    findInstaller({ settings: { feishuPnpm: override }, env: { PATH: '/definitely/missing' }, resources: '' }).source,
    'config'
  )
  assert.equal(findInstaller({ settings: {}, env: { PATH: '/definitely/missing' }, resources: '', extraDirs: [] }), null)
})

test('策略选择：默认本地，缺包管理器时退回 npx', () => {
  const root = tempDir('meetclip-strategy-')
  const pnpm = path.join(root, 'pnpm.cjs')
  fs.writeFileSync(pnpm, '')
  const local = resolveStrategy({
    settings: { feishuPnpm: pnpm },
    binaries: { node: null, npx: null },
    env: { PATH: '/definitely/missing' }
  })
  assert.equal(local.mode, 'local')
  assert.equal(local.installer.kind, 'pnpm')
  assert.equal(local.node.source, 'dsh')

  const forced = resolveStrategy({ settings: { feishuMode: 'npx' }, binaries: {}, env: { PATH: '/definitely/missing' } })
  assert.equal(forced.mode, 'npx')

  const noInstaller = resolveStrategy({
    settings: {},
    binaries: { node: null, npx: null },
    env: { PATH: '/definitely/missing' },
    extraDirs: []
  })
  assert.equal(noInstaller.mode, 'npx')
  assert.match(noInstaller.reason, /包管理器/)

  const systemNode = findNodeRuntime({ settings: { feishuNode: process.execPath }, binaries: {} })
  assert.equal(systemNode.source, 'system')
})

test('本地安装：假 pnpm 装出包、写启动器、能真连 MCP', async () => {
  const root = tempDir('meetclip-local-install-')
  const stateDir = path.join(root, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const settings = { stateDir, feishuPnpm: makeFakeInstaller(root) }
  const node = { exec: process.execPath, source: 'system', electron: false, env: {} }
  const installer = { kind: 'pnpm', path: settings.feishuPnpm, source: 'config' }
  const { execFile } = await import('node:child_process')
  const runCommand = (command, args, { env, cwd }) => new Promise((resolve, reject) => {
    execFile(command, args, { env, cwd }, (error) => (error ? reject(error) : resolve('')))
  })

  const result = await installLocalPackage({
    settings, name: TEST_PACKAGE, version: '0.27.4', registry: TEST_REGISTRY,
    node, installer, runCommand
  })
  assert.equal(result.install.version, '0.27.4')
  assert.ok(fs.existsSync(result.install.launcher))
  assert.ok(fs.statSync(result.install.launcher).mode & 0o111)
  const text = fs.readFileSync(result.install.launcher, 'utf8')
  assert.match(text, new RegExp(result.install.entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const status = localStatus({ settings, name: TEST_PACKAGE })
  assert.equal(status.installed, true)
  assert.equal(status.version, '0.27.4')

  const probe = await probeMcpServer({ command: result.install.launcher, args: [], env: process.env })
  assert.equal(probe.ok, true)
  assert.equal(probe.toolCount, 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('manager 在本地模式下装完就写入 run.sh 条目并通过连接测试', async () => {
  const root = tempDir('meetclip-manager-local-')
  const home = path.join(root, 'home')
  const dsh = path.join(root, 'dsh')
  const stateDir = path.join(root, 'state')
  for (const dir of [home, dsh, stateDir]) fs.mkdirSync(dir, { recursive: true })
  const restoreHome = withEnv('HOME', home)
  const restoreDsh = withEnv('DSH_HOME', dsh)
  const restorePath = withEnv('PATH', '/definitely/missing')
  try {
    const manager = new FeishuManager({
      feishuPackage: TEST_PACKAGE,
      feishuRegistry: TEST_REGISTRY,
      feishuPnpm: makeFakeInstaller(root),
      stateDir,
      feishuStatePath: path.join(stateDir, 'feishu.json'),
      feishuLogPath: path.join(stateDir, 'feishu.log')
    })
    // 固定版本，安装流程就不会去找 registry（离线可测）。
    manager.writeState({ version: '0.27.4' })
    manager.start('install')
    for (let index = 0; index < 400 && !manager.job?.done; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const job = manager.job
    assert.equal(job.state, 'done')
    assert.match(job.log, /本地安装 v0\.27\.4/)
    assert.match(job.log, /已连接，公开 1 个工具/)

    const patch = readPatchText(path.join(dsh, 'cordis.patch.yml'))
    assert.match(patch, /# local 0\.27\.4/)
    assert.match(patch, /command: '.*feishu-mcp\/run\.sh'/)
    assert.match(patch, /args: \[\]/)
    assert.doesNotMatch(patch, /npx/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'feishu.json'), 'utf8')).mode, 'local')
  } finally {
    restorePath()
    restoreHome()
    restoreDsh()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
