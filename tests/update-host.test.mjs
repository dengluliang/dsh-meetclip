import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  allowedUpdateUrl,
  compareVersions,
  parseLatestFeed,
  UpdateManager
} from '../src/host/update.js'
import { extractTarball, TarError } from '../src/host/tar.js'

const PACKAGE_NAME = '@meetclip/dsh-meetclip'
const REQUIRED = {
  'index.js': 'export const inject = []\n',
  'client.js': '/* built client */\n',
  'src/host/routes.js': 'export function registerAppRoutes() {}\n',
  'backend/app/main.py': 'app = None\n'
}

function tempDir(prefix = 'mc-update-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function packageEntries(version, extra = {}) {
  const entries = {
    ...REQUIRED,
    'package.json': JSON.stringify({ name: PACKAGE_NAME, version }),
    ...extra
  }
  return Object.entries(entries).map(([name, data]) => ({ name: `package/${name}`, data: Buffer.from(data) }))
}

function tarHeader({ name, size, mode = 0o644, type = '0', linkname = '' }) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write(type, 156, 1, 'ascii')
  header.write(linkname, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function makeTarGz(entries) {
  const chunks = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '')
    chunks.push(tarHeader({ name: entry.name, size: data.length, mode: entry.mode, type: entry.type, linkname: entry.linkname }))
    if (data.length) {
      chunks.push(data)
      const padding = (512 - (data.length % 512)) % 512
      if (padding) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(chunks))
}

async function cleanupTarget(target) {
  const parent = path.dirname(target)
  const base = path.basename(target)
  for (const name of fs.readdirSync(parent)) {
    if (name.startsWith(`${base}.update-bak-`) || name.startsWith(`${base}.corrupt-`)) {
      await fsp.rm(path.join(parent, name), { recursive: true, force: true })
    }
  }
  await fsp.rm(target, { recursive: true, force: true })
}

function writeTarget(version = '0.9.0') {
  const dir = tempDir('mc-update-target-')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }))
  fs.writeFileSync(path.join(dir, 'index.js'), 'old index')
  return dir
}

/** 完整的安装副本（与 validatePackage 要求的文件一致），用于回退测试。 */
function writePackage(dir, version, extra = {}) {
  const files = {
    ...REQUIRED,
    'package.json': JSON.stringify({ name: PACKAGE_NAME, version }),
    'index.js': `index ${version}`,
    ...extra
  }
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
  }
  return dir
}

function rollbackTarget(version = '0.9.1') {
  const parent = tempDir('mc-rollback-')
  return { parent, target: writePackage(path.join(parent, 'dsh-meetclip'), version) }
}

function backupDir(parent, version, stamp = '20261110-135408-48172') {
  return writePackage(path.join(parent, `dsh-meetclip.update-bak-${version}-${stamp}`), version)
}

function readVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
}

async function startServer({ tgz, feed, chunkDelay = 0 }) {
  let port = 0
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    if (req.url.startsWith('/latest.json')) {
      const body = JSON.stringify(feed(port))
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    if (req.url.startsWith('/pkg.tgz')) {
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': tgz.length })
      if (!chunkDelay) {
        res.end(tgz)
        return
      }
      let offset = 0
      const tick = setInterval(() => {
        if (offset >= tgz.length) {
          clearInterval(tick)
          res.end()
          return
        }
        const next = Math.min(tgz.length, offset + Math.max(1, Math.floor(tgz.length / 8)))
        res.write(tgz.subarray(offset, next))
        offset = next
      }, chunkDelay)
      res.on('close', () => clearInterval(tick))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  return {
    port,
    requests,
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }
}

async function waitForIdle(manager) {
  for (let i = 0; i < 400; i += 1) {
    const job = manager.jobSnapshot()
    if (job && !['checking', 'downloading', 'verifying', 'installing'].includes(job.state)) return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return manager.whenIdle()
}

test('compareVersions follows semver ordering', () => {
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0)
  assert.equal(compareVersions('v0.9.0', '0.9.0'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.9.0-beta.1', '0.9.0'), -1)
  assert.equal(compareVersions('0.9.0-beta.2', '0.9.0-beta.1'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.throws(() => compareVersions('abc', '1.0.0'))
})

test('parseLatestFeed accepts a complete feed and rejects unsafe ones', () => {
  const digest = 'a'.repeat(64)
  const feed = parseLatestFeed({
    version: '0.9.1',
    tag: 'v0.9.1',
    notes: 'x'.repeat(9000),
    asset: { name: 'dsh-meetclip-0.9.1.tgz', url: 'https://github.com/a/b/releases/download/v0.9.1/x.tgz', sha256: digest, size: 12 }
  }, { repo: 'a/b' })
  assert.equal(feed.version, '0.9.1')
  assert.equal(feed.asset.sha256, digest)
  assert.equal(feed.notes.length, 8000)
  assert.equal(feed.url, 'https://github.com/a/b/releases/tag/v0.9.1')
  assert.throws(() => parseLatestFeed({ version: 'nope' }), /版本号/)
  assert.throws(() => parseLatestFeed({ version: '1.0.0', asset: { name: 'x.tgz', url: 'https://x/y', sha256: 'bad' } }), /SHA-256/)
  assert.throws(() => parseLatestFeed({ version: '1.0.0', asset: { name: 'x.zip', url: 'https://x/y', sha256: digest } }), /tgz/)
})

test('allowedUpdateUrl only accepts GitHub hosts or loopback test feeds', () => {
  assert.equal(allowedUpdateUrl('https://github.com/a/b/releases/download/v1/x.tgz'), true)
  assert.equal(allowedUpdateUrl('https://objects.githubusercontent.com/x'), true)
  assert.equal(allowedUpdateUrl('https://evil.example.com/x.tgz'), false)
  assert.equal(allowedUpdateUrl('http://127.0.0.1:1234/pkg.tgz'), false)
  assert.equal(allowedUpdateUrl('http://127.0.0.1:1234/pkg.tgz', { allowLocal: true }), true)
  assert.equal(allowedUpdateUrl('https://user:pass@github.com/x'), false)
})

test('extractTarball accepts a regular npm-style package', async () => {
  const dest = tempDir('mc-tar-ok-')
  const result = extractTarball(makeTarGz(packageEntries('0.9.1')), dest)
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version, '0.9.1')
  assert.ok(fs.existsSync(path.join(dest, 'backend/app/main.py')))
  await fsp.rm(dest, { recursive: true, force: true })
})

test('extractTarball rejects traversal, absolute paths and links', async () => {
  const cases = [
    [{ name: 'package/../../evil.txt', data: 'x' }, /相对路径/],
    [{ name: '/etc/passwd', data: 'x' }, /绝对路径/],
    [{ name: 'package/link', data: '', type: '2', linkname: '/etc/passwd' }, /链接/]
  ]
  for (const [entry, pattern] of cases) {
    const dest = tempDir('mc-tar-bad-')
    assert.throws(() => extractTarball(makeTarGz([entry]), dest), (error) => {
      assert.ok(error instanceof TarError)
      assert.match(error.message, pattern)
      return true
    })
    assert.equal(fs.existsSync(path.join(dest, 'evil.txt')), false)
    await fsp.rm(dest, { recursive: true, force: true })
  }
})

test('extractTarball enforces the uncompressed size limit', async () => {
  const dest = tempDir('mc-tar-size-')
  const big = Buffer.alloc(4096, 1)
  assert.throws(
    () => extractTarball(makeTarGz(packageEntries('0.9.1', { 'big.bin': big })), dest, { maxFileBytes: 1024 }),
    /大小上限/
  )
  await fsp.rm(dest, { recursive: true, force: true })
})

test('check reports up to date without touching the installed package', async () => {
  const target = writeTarget('0.9.1')
  const tgz = makeTarGz(packageEntries('0.9.1'))
  const server = await startServer({
    tgz,
    feed: (port) => ({ version: '0.9.1', asset: { name: 'x.tgz', url: `http://127.0.0.1:${port}/pkg.tgz`, sha256: sha256(tgz), size: tgz.length } })
  })
  const manager = new UpdateManager(
    { packageRoot: target, stateDir: tempDir('mc-state-'), updateFeed: `http://127.0.0.1:${server.port}/latest.json` },
    { targetDir: target, stateDir: tempDir('mc-state-'), currentVersion: '0.9.1', allowSourceTarget: true, feedUrl: `http://127.0.0.1:${server.port}/latest.json` }
  )
  manager.startCheck({ autoInstall: true })
  const job = await waitForIdle(manager)
  assert.equal(job.state, 'done')
  assert.match(job.message, /已经是最新版本/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.9.1')
  await server.close()
  await cleanupTarget(target)
})

test('full install downloads with progress, verifies the hash and swaps the package', async () => {
  const target = writeTarget('0.9.0')
  const tgz = makeTarGz(packageEntries('0.9.1'))
  const server = await startServer({
    tgz,
    chunkDelay: 10,
    feed: (port) => ({ version: '0.9.1', tag: 'v0.9.1', asset: { name: 'dsh-meetclip-0.9.1.tgz', url: `http://127.0.0.1:${port}/pkg.tgz`, sha256: sha256(tgz), size: tgz.length } })
  })
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir, updateFeed: `http://127.0.0.1:${server.port}/latest.json` },
    { targetDir: target, stateDir, currentVersion: '0.9.0', allowSourceTarget: true, feedUrl: `http://127.0.0.1:${server.port}/latest.json` }
  )
  manager.startCheck({ autoInstall: true })
  const job = await waitForIdle(manager)
  assert.equal(job.state, 'done')
  assert.equal(job.percent, 100)
  assert.equal(job.received, tgz.length)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.9.1')
  assert.ok(fs.existsSync(path.join(target, 'client.js')))
  const backups = fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith(`${path.basename(target)}.update-bak-`))
  assert.equal(backups.length, 1)
  assert.match(backups[0], /0\.9\.0/)
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'update-state.json'), 'utf8'))
  assert.equal(state.installedVersion, '0.9.1')
  assert.equal(manager.status().restartRequired, true)
  await server.close()
  await cleanupTarget(target)
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('an installed update waiting for restart is not offered or downloaded again', async () => {
  const target = writeTarget('0.9.1')
  const tgz = makeTarGz(packageEntries('0.9.1'))
  const server = await startServer({
    tgz,
    feed: (port) => ({ version: '0.9.1', asset: { name: 'x.tgz', url: `http://127.0.0.1:${port}/pkg.tgz`, sha256: sha256(tgz), size: tgz.length } })
  })
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir, updateFeed: `http://127.0.0.1:${server.port}/latest.json` },
    { targetDir: target, stateDir, currentVersion: '0.9.0', allowSourceTarget: true, feedUrl: `http://127.0.0.1:${server.port}/latest.json` }
  )
  assert.equal(manager.status().restartRequired, true)
  assert.equal(manager.status().updateAvailable, false)
  manager.startCheck({ autoInstall: true })
  const job = await waitForIdle(manager)
  assert.equal(job.state, 'done')
  assert.match(job.message, /重启 DeepSeek Harness/)
  assert.equal(server.requests.filter((url) => url.startsWith('/pkg.tgz')).length, 0)
  await server.close()
  await cleanupTarget(target)
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('a bad sha256 is rejected and the running version stays intact', async () => {
  const target = writeTarget('0.9.0')
  const tgz = makeTarGz(packageEntries('0.9.1'))
  const server = await startServer({
    tgz,
    feed: (port) => ({ version: '0.9.1', asset: { name: 'x.tgz', url: `http://127.0.0.1:${port}/pkg.tgz`, sha256: 'b'.repeat(64), size: tgz.length } })
  })
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir, updateFeed: `http://127.0.0.1:${server.port}/latest.json` },
    { targetDir: target, stateDir, currentVersion: '0.9.0', allowSourceTarget: true, feedUrl: `http://127.0.0.1:${server.port}/latest.json` }
  )
  manager.startCheck({ autoInstall: true })
  const job = await waitForIdle(manager)
  assert.equal(job.state, 'error')
  assert.match(job.error, /校验失败/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.9.0')
  await server.close()
  await cleanupTarget(target)
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('cancelling a download leaves no partial file and no installed change', async () => {
  const target = writeTarget('0.9.0')
  const tgz = makeTarGz(packageEntries('0.9.1', { 'big.bin': Buffer.alloc(256 * 1024, 7) }))
  const server = await startServer({
    tgz,
    chunkDelay: 40,
    feed: (port) => ({ version: '0.9.1', asset: { name: 'x.tgz', url: `http://127.0.0.1:${port}/pkg.tgz`, sha256: sha256(tgz), size: tgz.length } })
  })
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir, updateFeed: `http://127.0.0.1:${server.port}/latest.json` },
    { targetDir: target, stateDir, currentVersion: '0.9.0', allowSourceTarget: true, feedUrl: `http://127.0.0.1:${server.port}/latest.json` }
  )
  manager.startCheck({ autoInstall: true })
  for (let i = 0; i < 100; i += 1) {
    const job = manager.jobSnapshot()
    if (job?.state === 'downloading' && job.received > 0) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const result = manager.cancel()
  assert.equal(result.status, 'cancelled')
  const job = await waitForIdle(manager)
  assert.equal(job.state, 'cancelled')
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.9.0')
  const work = path.join(stateDir, 'updates', '0.9.1')
  if (fs.existsSync(work)) {
    assert.equal(fs.readdirSync(work).filter((name) => name.endsWith('.part')).length, 0)
  }
  await server.close()
  await cleanupTarget(target)
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('a failed install restores the previous package from backup', async () => {
  const target = writeTarget('0.9.0')
  const stage = tempDir('mc-stage-')
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.9.1' }))
  fs.writeFileSync(path.join(stage, 'index.js'), 'new')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir: tempDir('mc-state-'), updateFeed: 'http://127.0.0.1:1/none' },
    { targetDir: target, stateDir: tempDir('mc-state-'), currentVersion: '0.9.0', allowSourceTarget: true, feedUrl: 'http://127.0.0.1:1/none' }
  )
  manager.previousVersion = '0.9.0'
  await assert.rejects(() => manager.applyStage(stage, '0.9.1'), /缺少/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.9.0')
  assert.equal(fs.readFileSync(path.join(target, 'index.js'), 'utf8'), 'old index')
  await cleanupTarget(target)
  await fsp.rm(stage, { recursive: true, force: true })
})

test('an interrupted swap is recovered from the updater backup on startup', async () => {
  const parent = tempDir('mc-recover-')
  const target = path.join(parent, 'dsh-meetclip')
  const backup = path.join(parent, 'dsh-meetclip.update-bak-0.9.0-20260101-120000-1')
  fs.mkdirSync(backup, { recursive: true })
  fs.writeFileSync(path.join(backup, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.9.0' }))
  fs.writeFileSync(path.join(backup, 'index.js'), 'recovered')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir: tempDir('mc-state-'), updateFeed: '' },
    { targetDir: target, stateDir: tempDir('mc-state-'), currentVersion: '0.9.0', allowSourceTarget: true }
  )
  assert.equal(manager.readInstalledVersion(), '0.9.0')
  assert.ok(manager.recovery?.restoredFrom)
  await fsp.rm(parent, { recursive: true, force: true })
})

test('source checkouts are not overwritten by the automatic installer', async () => {
  const target = writeTarget('0.9.0')
  const tgz = makeTarGz(packageEntries('0.9.1'))
  const server = await startServer({
    tgz,
    feed: (port) => ({ version: '0.9.1', asset: { name: 'x.tgz', url: `http://127.0.0.1:${port}/pkg.tgz`, sha256: sha256(tgz), size: tgz.length } })
  })
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir, updateFeed: `http://127.0.0.1:${server.port}/latest.json` },
    { targetDir: target, stateDir, currentVersion: '0.9.0', feedUrl: `http://127.0.0.1:${server.port}/latest.json` }
  )
  manager.startCheck({ autoInstall: true })
  const job = await waitForIdle(manager)
  assert.equal(job.state, 'error')
  assert.match(job.error, /源码方式/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.9.0')
  await server.close()
  await cleanupTarget(target)
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('GitHub API fallback converts a release into the feed shape', async () => {
  const target = writeTarget('0.9.0')
  const tgz = makeTarGz(packageEntries('0.9.1'))
  const digest = sha256(tgz)
  const manager = new UpdateManager(
    { packageRoot: target, stateDir: tempDir('mc-state-') },
    {
      targetDir: target,
      stateDir: tempDir('mc-state-'),
      currentVersion: '0.9.0',
      allowSourceTarget: true,
      fetchImpl: async (url) => {
        if (url.includes('/releases/latest/download/latest.json')) return new Response('not found', { status: 404 })
        if (url.includes('api.github.com')) {
          return new Response(JSON.stringify({
            tag_name: 'v0.9.1',
            html_url: 'https://github.com/dengluliang/dsh-meetclip/releases/tag/v0.9.1',
            body: 'notes',
            published_at: '2026-11-10T00:00:00Z',
            assets: [{
              name: 'dsh-meetclip-0.9.1.tgz',
              size: tgz.length,
              digest: `sha256:${digest}`,
              browser_download_url: 'https://github.com/dengluliang/dsh-meetclip/releases/download/v0.9.1/dsh-meetclip-0.9.1.tgz'
            }]
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('not found', { status: 404 })
      }
    }
  )
  // 不传参数就是只检查：默认不再自动下载、安装。
  manager.startCheck()
  const job = await waitForIdle(manager)
  assert.equal(job.state, 'done')
  assert.match(job.message, /发现 v0\.9\.1/)
  assert.equal(manager.status().latest.version, '0.9.1')
  assert.equal(manager.status().updateAvailable, true)
  // 只检查时安装目录不动，仍然是被测的旧版本。
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.9.0')
  await cleanupTarget(target)
})

test('a repository without releases reports a friendly error', async () => {
  const target = writeTarget('0.9.0')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir: tempDir('mc-state-') },
    {
      targetDir: target,
      stateDir: tempDir('mc-state-'),
      currentVersion: '0.9.0',
      // A custom feed never falls back to the API; this makes the 404 explicit.
      feedUrl: 'http://127.0.0.1:1/latest.json',
      fetchImpl: async () => new Response('not found', { status: 404 })
    }
  )
  manager.startCheck({ autoInstall: true })
  const job = await waitForIdle(manager)
  assert.equal(job.state, 'error')
  assert.match(job.error, /还没有发布版本|HTTP 404|连不上/)
  await cleanupTarget(target)
})

test('rollback puts the pre-upgrade local copy back and keeps the current one as a backup', async () => {
  const { parent, target } = rollbackTarget('0.9.1')
  backupDir(parent, '0.9.0')
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir },
    { targetDir: target, stateDir, currentVersion: '0.9.1', allowSourceTarget: true }
  )

  const before = manager.status()
  assert.equal(before.rollback.canRollback, true)
  assert.deepEqual(before.rollback.available.map((row) => row.version), ['0.9.0'])
  assert.equal(before.rollback.available[0].direction, 'older')

  const started = manager.startRollback()
  assert.equal(started.kind, 'rollback')
  assert.equal(started.state, 'installing')
  await manager.whenIdle()
  const done = manager.jobSnapshot()
  assert.equal(done.state, 'done')
  assert.equal(done.kind, 'rollback')
  assert.match(done.message, /已回退到 v0\.9\.0/)

  // 换回来的是升级前的本地副本，不是从 GitHub 下载的包。
  assert.equal(readVersion(target), '0.9.0')
  assert.equal(fs.readFileSync(path.join(target, 'src/host/routes.js'), 'utf8'), REQUIRED['src/host/routes.js'])

  const after = manager.status()
  assert.equal(after.installedVersion, '0.9.0')
  assert.equal(after.restartRequired, true)
  assert.equal(after.restartDirection, 'rollback')
  assert.deepEqual(after.rollback.available.map((row) => row.version), ['0.9.1'])
  assert.equal(after.rollback.available[0].direction, 'newer')

  // 回退前的版本也被留成备份，所以回退本身还能再切回来。
  manager.startRollback('0.9.1')
  await manager.whenIdle()
  assert.equal(readVersion(target), '0.9.1')
  assert.equal(manager.jobSnapshot().state, 'done')

  await cleanupTarget(target)
  await fsp.rm(parent, { recursive: true, force: true })
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('rollback can pick a specific older local backup', async () => {
  const { parent, target } = rollbackTarget('0.9.2')
  backupDir(parent, '0.8.11', '20261110-122613-73983')
  backupDir(parent, '0.9.0')
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir },
    { targetDir: target, stateDir, currentVersion: '0.9.2', allowSourceTarget: true }
  )
  assert.deepEqual(manager.status().rollback.available.map((row) => row.version), ['0.9.0', '0.8.11'])
  manager.startRollback('0.8.11')
  await manager.whenIdle()
  assert.equal(readVersion(target), '0.8.11')
  // 另一个本地备份没有被吃掉，随时可以再换。
  assert.deepEqual(manager.status().rollback.available.map((row) => row.version), ['0.9.2', '0.9.0'])

  await cleanupTarget(target)
  await fsp.rm(parent, { recursive: true, force: true })
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('incomplete or unknown local backups are not offered', async () => {
  const { parent, target } = rollbackTarget('0.9.1')
  const broken = path.join(parent, 'dsh-meetclip.update-bak-0.9.0-20261110-135408-48172')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.9.0' }))
  fs.writeFileSync(path.join(broken, 'index.js'), 'x')
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir },
    { targetDir: target, stateDir, currentVersion: '0.9.1', allowSourceTarget: true }
  )
  assert.deepEqual(manager.status().rollback.available, [])
  assert.equal(manager.status().rollback.canRollback, false)
  assert.throws(() => manager.startRollback(), (error) => {
    assert.equal(error.code, 'no-rollback')
    assert.match(error.message, /没有可回退/)
    return true
  })
  // 直接调用时也要先拒绝残缺备份，别把能用的版本换掉。
  await assert.rejects(
    () => manager.performRollback({ version: '0.9.0', path: broken }, '0.9.1'),
    /备份 v0\.9\.0 不完整/
  )
  assert.equal(readVersion(target), '0.9.1')
  assert.ok(fs.existsSync(broken))

  await cleanupTarget(target)
  await fsp.rm(parent, { recursive: true, force: true })
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('a failed swap restores the installed version and keeps the rollback backup', async () => {
  const { parent, target } = rollbackTarget('0.9.1')
  const backup = backupDir(parent, '0.9.0')
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir },
    { targetDir: target, stateDir, currentVersion: '0.9.1', allowSourceTarget: true }
  )
  const original = manager.validatePackage.bind(manager)
  let calls = 0
  manager.validatePackage = async (...args) => {
    calls += 1
    // 第一次校验备份，第二次校验换过去的目录：模拟交换后校验失败。
    if (calls === 2) throw new Error('模拟校验失败')
    return original(...args)
  }
  manager.startRollback()
  const job = await manager.whenIdle()
  assert.equal(job.state, 'error')
  assert.match(job.error, /回退失败：模拟校验失败/)
  assert.equal(readVersion(target), '0.9.1')
  assert.equal(readVersion(backup), '0.9.0')

  await cleanupTarget(target)
  await fsp.rm(parent, { recursive: true, force: true })
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('rollback rejects an unknown version and lists what is available', async () => {
  const { parent, target } = rollbackTarget('0.9.1')
  backupDir(parent, '0.9.0')
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir },
    { targetDir: target, stateDir, currentVersion: '0.9.1', allowSourceTarget: true }
  )
  assert.throws(() => manager.startRollback('0.9.9'), (error) => {
    assert.equal(error.code, 'no-rollback')
    assert.match(error.message, /没有 v0\.9\.9/)
    assert.match(error.message, /v0\.9\.0/)
    return true
  })
  assert.equal(readVersion(target), '0.9.1')

  await cleanupTarget(target)
  await fsp.rm(parent, { recursive: true, force: true })
  await fsp.rm(stateDir, { recursive: true, force: true })
})

test('a source checkout refuses to roll back the installed copy', async () => {
  const { parent, target } = rollbackTarget('0.9.1')
  backupDir(parent, '0.9.0')
  const stateDir = tempDir('mc-state-')
  const manager = new UpdateManager(
    { packageRoot: target, stateDir },
    { targetDir: target, stateDir, currentVersion: '0.9.1' }
  )
  assert.equal(manager.status().rollback.available.length, 1)
  assert.equal(manager.status().rollback.canRollback, false)
  assert.throws(() => manager.startRollback(), (error) => error.code === 'target-source')

  await cleanupTarget(target)
  await fsp.rm(parent, { recursive: true, force: true })
  await fsp.rm(stateDir, { recursive: true, force: true })
})

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}
