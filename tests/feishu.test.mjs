import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FEISHU_ENTRY_ID, FEISHU_MARKER, FEISHU_SERVER_NAME,
  FeishuManager, authPathFor, compareVersions, entryPresent, extractAuthUrl, foreignFeishuEntry,
  insertEntry, maskOpenId, parseVersion, patchAppendable, patchPathFor, probeMcpServer, readAuthState,
  removeEntry, renderEntryBlock, resolveBinaries, validOpenUrl, versionMajor, writePatchText, readPatchText
} from '../src/host/feishu.js'

// 源码内置一份默认包名与源，测试用一个独立的示例值，避免依赖默认值。
const TEST_PACKAGE = 'feishu-mcp-pro'
const TEST_REGISTRY = 'https://npm.example.test/'

function tempDir(prefix = 'meetclip-feishu-test-') {
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

function entryBlock(overrides = {}) {
  return renderEntryBlock({
    command: "/opt/homebrew/bin/npx",
    args: ['-y', `--registry=${TEST_REGISTRY}`, `${TEST_PACKAGE}@0.27.4`],
    envPath: '/opt/homebrew/bin:/usr/bin:/bin',
    version: '0.27.4',
    ...overrides
  })
}

function fakeBinaries() {
  const dir = tempDir('meetclip-feishu-bin-')
  const node = path.join(dir, 'node')
  const npx = path.join(dir, 'npx')
  fs.writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(npx, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { dir, node, npx }
}

test('entry block is valid YAML-ish and pins the version', () => {
  const block = entryBlock()
  assert.match(block, new RegExp(FEISHU_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(block, /- insert:/)
  assert.match(block, new RegExp(`id: ${FEISHU_ENTRY_ID}`))
  assert.match(block, /name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(block, new RegExp(`serverName: ${FEISHU_SERVER_NAME}`))
  assert.match(block, /transport: stdio/)
  assert.match(block, /command: '\/opt\/homebrew\/bin\/npx'/)
  assert.match(block, /- 'feishu-mcp-pro@0\.27\.4'/)
  assert.match(block, /PATH: '\/opt\/homebrew\/bin:\/usr\/bin:\/bin'/)
  assert.match(block, /failOnStartupError: false/)
  // `- insert:` stays at column 0; everything under it is indented so the list never ends early.
  const rows = block.trimEnd().split('\n')
  assert.equal(rows[0], FEISHU_MARKER)
  assert.equal(rows[1], '- insert:')
  for (const row of rows.slice(2)) assert.match(row, /^\s+-|^\s+\w|^\s+#/, `unexpected row: ${row}`)
})

test('entry block escapes single quotes in paths', () => {
  const block = renderEntryBlock({ command: "/Users/me/My Npx'npx", args: [], envPath: '' })
  assert.match(block, /command: '\/Users\/me\/My Npx''npx'/)
  assert.match(block, /args: \[\]/)
})

test('insertEntry fills an empty patch', () => {
  const { text, changed } = insertEntry('', entryBlock())
  assert.equal(changed, true)
  assert.ok(entryPresent(text))
  assert.ok(text.startsWith(FEISHU_MARKER))
})

test('insertEntry replaces the empty flow sequence', () => {
  const { text, changed } = insertEntry('[]\n', entryBlock())
  assert.equal(changed, true)
  assert.ok(entryPresent(text))
  assert.ok(!text.trimStart().startsWith('[]'))
})

test('insertEntry keeps existing content and comments', () => {
  const existing = `# my tweaks\n- id: ui-chat\n  name: '@deepseek-ai/dsh-client-ui-chat'\n  config:\n    transcriptView: standard\n`
  const { text, changed } = insertEntry(existing, entryBlock())
  assert.equal(changed, true)
  assert.ok(text.startsWith('# my tweaks'))
  assert.ok(text.includes("  config:\n    transcriptView: standard"))
  assert.ok(entryPresent(text))
  const rows = text.split('\n')
  const markerRow = rows.indexOf(FEISHU_MARKER)
  assert.ok(markerRow > 0)
  assert.equal(rows[markerRow - 1], '')
})

test('insertEntry is idempotent', () => {
  const first = insertEntry('', entryBlock()).text
  const second = insertEntry(first, entryBlock())
  assert.equal(second.changed, false)
  assert.equal(second.reason, 'present')
  assert.equal(second.text, first)
  assert.equal(first.split(FEISHU_MARKER).length - 1, 1)
})

test('insertEntry refuses a file that is not a YAML sequence', () => {
  const { changed, reason } = insertEntry('foo: bar\n', entryBlock())
  assert.equal(changed, false)
  assert.equal(reason, 'unreadable')
  assert.equal(patchAppendable('foo: bar\n'), false)
  assert.equal(patchAppendable('# only a comment\n'), true)
})

test('removeEntry restores the previous document', () => {
  const existing = `# my tweaks\n- id: ui-chat\n  name: '@deepseek-ai/dsh-client-ui-chat'\n  config:\n    enabled: true\n`
  const withEntry = insertEntry(existing, entryBlock()).text
  const removed = removeEntry(withEntry)
  assert.equal(removed.changed, true)
  assert.ok(!entryPresent(removed.text))
  assert.ok(!removed.text.includes(FEISHU_MARKER))
  assert.ok(removed.text.includes("    enabled: true"))
  assert.equal(removed.text.replace(/\s+/g, ' ').trim(), existing.replace(/\s+/g, ' ').trim())
})

test('removeEntry leaves [] when it removes the only row', () => {
  const only = insertEntry('', entryBlock()).text
  const removed = removeEntry(only)
  assert.equal(removed.changed, true)
  assert.equal(removed.text, '[]\n')
})

test('removeEntry is a no-op without our row', () => {
  const existing = '- id: ui-chat\n  config: {}\n'
  const removed = removeEntry(existing)
  assert.equal(removed.changed, false)
  assert.equal(removed.text, existing)
})

test('removeEntry deletes a hand-written row that lost the marker', () => {
  const text = [
    '- id: ui-chat',
    '  config: {}',
    '- insert:',
    `    - id: ${FEISHU_ENTRY_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: feishu',
    '- id: another',
    '  config: {}',
    ''
  ].join('\n')
  const removed = removeEntry(text)
  assert.equal(removed.changed, true)
  assert.ok(!removed.text.includes(FEISHU_ENTRY_ID))
  assert.ok(removed.text.includes('- id: another'))
})

test('foreign server name is reported as a conflict', () => {
  const other = "- insert:\n    - id: mcp-feishu-old\n      name: x\n      config:\n        serverName: feishu\n"
  assert.equal(foreignFeishuEntry(other), 'mcp-feishu-old')
  assert.equal(foreignFeishuEntry(insertEntry('', entryBlock()).text), '')
  assert.equal(foreignFeishuEntry('- id: ui-chat\n  config: {}\n'), '')
  assert.equal(entryPresent('- id: mcp-feishu-pro\n'), true)
  assert.equal(entryPresent('- id: mcp-feishu-pro-extra\n'), false)
})

test('readAuthState reports login metadata without tokens', () => {
  const home = tempDir('meetclip-feishu-home-')
  const missing = readAuthState(home)
  assert.equal(missing.loggedIn, false)
  assert.equal(missing.needsLogin, true)

  const now = Math.floor(Date.now() / 1000)
  fs.mkdirSync(path.dirname(authPathFor(home)), { recursive: true })
  fs.writeFileSync(authPathFor(home), JSON.stringify({
    access_token: 'a-secret',
    refresh_token: 'r-secret',
    tenant_key: 'tenant',
    open_id: 'ou_1234567890abcdef',
    expires_at: now + 3600,
    refresh_expires_at: now + 86400,
    token_source: 'authcode'
  }))
  const valid = readAuthState(home)
  assert.equal(valid.loggedIn, true)
  assert.equal(valid.expired, false)
  assert.equal(valid.openId, 'ou_1****cdef')
  assert.equal(valid.tokenSource, 'authcode')
  const serialized = JSON.stringify(valid)
  assert.ok(!serialized.includes('a-secret'))
  assert.ok(!serialized.includes('r-secret'))
  assert.ok(!serialized.includes('tenant'))

  fs.writeFileSync(authPathFor(home), JSON.stringify({
    access_token: 'a-secret',
    refresh_token: 'r-secret',
    expires_at: now - 10,
    refresh_expires_at: now - 10
  }))
  const expired = readAuthState(home)
  assert.equal(expired.loggedIn, false)
  assert.equal(expired.expired, true)
  assert.equal(expired.needsLogin, true)

  fs.writeFileSync(authPathFor(home), '{not json')
  const broken = readAuthState(home)
  assert.equal(broken.loggedIn, false)
  assert.ok(broken.detail)

  fs.rmSync(home, { recursive: true, force: true })
})

test('resolveBinaries honors PATH order and explicit overrides', () => {
  const home = tempDir('meetclip-feishu-home-')
  const bin = fakeBinaries()
  const resolved = resolveBinaries({ pathValue: `${bin.dir}:/usr/bin:/bin`, homeDir: home })
  assert.equal(resolved.node, path.join(bin.dir, 'node'))
  assert.equal(resolved.npx, path.join(bin.dir, 'npx'))
  assert.ok(resolved.envPath.startsWith(bin.dir))

  // A Finder-launched app has a short PATH; the common install dirs are searched anyway.
  const shortPath = resolveBinaries({ pathValue: '/definitely/missing', homeDir: home })
  assert.ok(shortPath.node, 'node should be found outside PATH')
  assert.ok(shortPath.npx, 'npx should be found outside PATH')
  const ignoredOverride = resolveBinaries({
    pathValue: `${bin.dir}:/usr/bin:/bin`,
    homeDir: home,
    nodeOverride: '/definitely/missing/node'
  })
  assert.equal(ignoredOverride.node, path.join(bin.dir, 'node'))

  const override = resolveBinaries({
    pathValue: '/definitely/missing',
    homeDir: home,
    nodeOverride: bin.node,
    npxOverride: bin.npx
  })
  assert.equal(override.node, bin.node)
  assert.equal(override.npx, bin.npx)

  fs.rmSync(bin.dir, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test('version helpers parse and compare', () => {
  assert.equal(parseVersion('0.27.4'), '0.27.4')
  assert.equal(parseVersion('v24.19.0\n'), '24.19.0')
  assert.equal(parseVersion('nope'), '')
  assert.equal(versionMajor('v24.19.0'), 24)
  assert.equal(versionMajor(''), 0)
  assert.equal(compareVersions('0.27.10', '0.27.9'), 1)
  assert.equal(compareVersions('0.26.0', '0.27.4'), -1)
  assert.equal(maskOpenId('ou_1234567890abcdef'), 'ou_1****cdef')
  assert.equal(maskOpenId('abc'), 'ab****')
})

test('only Feishu https URLs may be opened', () => {
  assert.equal(validOpenUrl('https://example.feishu.cn/docx/abc'), true)
  assert.equal(validOpenUrl('https://accounts.feishu.cn/oauth/v1/device'), true)
  assert.equal(validOpenUrl('http://example.feishu.cn/docx/abc'), false)
  assert.equal(validOpenUrl('https://evil.example.com/x'), false)
  assert.equal(validOpenUrl('file:///etc/passwd'), false)
  assert.equal(validOpenUrl(''), false)
  const line = 'Open this URL to authorize:\nhttps://accounts.feishu.cn/oauth/v1/device?user_code=ABCD-1234\n'
  assert.equal(extractAuthUrl(line), 'https://accounts.feishu.cn/oauth/v1/device?user_code=ABCD-1234')
  assert.equal(extractAuthUrl('nothing here'), '')
})

test('writePatchText keeps a backup and never leaves a temp file', () => {
  const dir = tempDir('meetclip-feishu-patch-')
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, '- id: ui-chat\n')
  const first = writePatchText(file, '- id: ui-chat\n- id: two\n')
  assert.equal(readPatchText(file), '- id: ui-chat\n- id: two\n')
  assert.ok(first.backup && fs.existsSync(first.backup))
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('meetclip-tmp')).length, 0)
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('manager status reflects patch, auth and binaries', async () => {
  const home = tempDir('meetclip-feishu-home-')
  const dsh = tempDir('meetclip-feishu-dsh-')
  const bin = fakeBinaries()
  const stateDir = tempDir('meetclip-feishu-state-')
  const restoreHome = withEnv('HOME', home)
  const restoreDsh = withEnv('DSH_HOME', dsh)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin.dir}:/usr/bin:/bin`
  try {
    const manager = new FeishuManager({
      feishuPackage: TEST_PACKAGE,
      feishuRegistry: TEST_REGISTRY,
      stateDir,
      feishuStatePath: path.join(stateDir, 'feishu.json'),
      feishuLogPath: path.join(stateDir, 'feishu.log'),
      feishuNode: bin.node,
      feishuNpx: bin.npx
    })
    const before = await manager.status()
    assert.equal(before.ok, true)
    assert.equal(before.runtime.npxOk, true)
    assert.equal(before.dsh.patchPath, path.join(dsh, 'cordis.patch.yml'))
    assert.equal(before.dsh.entryPresent, false)
    assert.equal(before.dsh.entryLive, null)
    assert.equal(before.auth.loggedIn, false)
    assert.ok(!JSON.stringify(before).includes('access_token'))

    manager.writeState({ version: '0.27.4', installedAt: 1 })
    const write = manager.writeEntry('0.27.4')
    assert.equal(write.changed, true)
    assert.ok(fs.existsSync(path.join(dsh, 'cordis.patch.yml')))
    const after = await manager.status()
    assert.equal(after.dsh.entryPresent, true)
    assert.equal(after.pinnedVersion, '0.27.4')
    assert.ok(fs.readFileSync(path.join(dsh, 'cordis.patch.yml'), 'utf8').includes(FEISHU_ENTRY_ID))

    const again = manager.writeEntry('0.27.4')
    assert.equal(again.changed, false)

    const removed = manager.removeEntry()
    assert.equal(removed.changed, true)
    assert.equal(fs.readFileSync(path.join(dsh, 'cordis.patch.yml'), 'utf8'), '[]\n')
  } finally {
    process.env.PATH = previousPath
    restoreHome()
    restoreDsh()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dsh, { recursive: true, force: true })
    fs.rmSync(bin.dir, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('manager refuses a foreign feishu server name', async () => {
  const home = tempDir('meetclip-feishu-home-')
  const dsh = tempDir('meetclip-feishu-dsh-')
  const bin = fakeBinaries()
  const stateDir = tempDir('meetclip-feishu-state-')
  const restoreHome = withEnv('HOME', home)
  const restoreDsh = withEnv('DSH_HOME', dsh)
  try {
    const manager = new FeishuManager({
      feishuPackage: TEST_PACKAGE,
      feishuRegistry: TEST_REGISTRY,
      stateDir,
      feishuStatePath: path.join(stateDir, 'feishu.json'),
      feishuLogPath: path.join(stateDir, 'feishu.log'),
      feishuNode: bin.node,
      feishuNpx: bin.npx
    })
    writePatchText(path.join(dsh, 'cordis.patch.yml'),
      "- insert:\n    - id: someone-else\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: feishu\n")
    assert.throws(() => manager.writeEntry('0.27.4'), /已被占用|占用了 serverName|server_conflict/ )
    const status = await manager.status()
    assert.equal(status.dsh.conflict, 'someone-else')
    assert.equal(status.dsh.entryPresent, false)
  } finally {
    restoreHome()
    restoreDsh()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dsh, { recursive: true, force: true })
    fs.rmSync(bin.dir, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('manager reports a readable error when npx is missing', async () => {
  const home = tempDir('meetclip-feishu-home-')
  const dsh = tempDir('meetclip-feishu-dsh-')
  const stateDir = tempDir('meetclip-feishu-state-')
  const restoreHome = withEnv('HOME', home)
  const restoreDsh = withEnv('DSH_HOME', dsh)
  const previousPath = process.env.PATH
  process.env.PATH = '/definitely/missing'
  try {
    const manager = new FeishuManager({
      feishuPackage: TEST_PACKAGE,
      feishuRegistry: TEST_REGISTRY,
      stateDir,
      feishuStatePath: path.join(stateDir, 'feishu.json'),
      feishuLogPath: path.join(stateDir, 'feishu.log')
    })
    // Simulate a machine without npx without depending on this host's install dirs.
    manager.binaries = () => ({ node: null, npx: null, dirs: [], envPath: '' })
    const status = await manager.status()
    assert.equal(status.runtime.npxOk, false)
    assert.throws(() => manager.requireBinaries(), /没有找到 npx/)
  } finally {
    process.env.PATH = previousPath
    restoreHome()
    restoreDsh()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dsh, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('manager rejects a second job while one is running', async () => {
  const home = tempDir('meetclip-feishu-home-')
  const dsh = tempDir('meetclip-feishu-dsh-')
  const stateDir = tempDir('meetclip-feishu-state-')
  const restoreHome = withEnv('HOME', home)
  const restoreDsh = withEnv('DSH_HOME', dsh)
  try {
    const manager = new FeishuManager({
      feishuPackage: TEST_PACKAGE,
      feishuRegistry: TEST_REGISTRY,
      stateDir,
      feishuStatePath: path.join(stateDir, 'feishu.json'),
      feishuLogPath: path.join(stateDir, 'feishu.log')
    })
    manager.job = { action: 'login', state: 'running', step: '等待', log: '', url: '', error: '', done: false, startedAt: Date.now() }
    assert.throws(() => manager.start('install'), (error) => error.status === 409)
    assert.equal(manager.cancel(), true)
    assert.equal(manager.job.state, 'cancelled')
  } finally {
    restoreHome()
    restoreDsh()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dsh, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('mcp probe reports a failure instead of hanging', { timeout: 15_000 }, async () => {
  const result = await probeMcpServer({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    env: process.env,
    timeoutMs: 5_000
  })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /退出|失败/)
})

test('a row living in the profile patch counts as present and is not duplicated', async () => {
  const home = tempDir('meetclip-feishu-home-')
  const dsh = tempDir('meetclip-feishu-dsh-')
  const profileDir = tempDir('meetclip-feishu-profile-')
  const bin = fakeBinaries()
  const stateDir = tempDir('meetclip-feishu-state-')
  const restoreHome = withEnv('HOME', home)
  const restoreDsh = withEnv('DSH_HOME', dsh)
  const restoreProfile = withEnv('DSH_PROFILE_DIR', profileDir)
  try {
    const manager = new FeishuManager({
      feishuPackage: TEST_PACKAGE,
      feishuRegistry: TEST_REGISTRY,
      stateDir,
      feishuStatePath: path.join(stateDir, 'feishu.json'),
      feishuLogPath: path.join(stateDir, 'feishu.log'),
      feishuNode: bin.node,
      feishuNpx: bin.npx
    })
    const profilePatch = path.join(profileDir, 'cordis.patch.yml')
    writePatchText(profilePatch, entryBlock())
    const status = await manager.status()
    assert.equal(status.dsh.entryPresent, true)
    assert.equal(status.dsh.patchPath, profilePatch)
    assert.equal(status.dsh.patchScope, 'profile')
    assert.equal(status.dsh.conflict, null)

    const write = manager.writeEntry('0.27.4')
    assert.equal(write.changed, false)
    assert.equal(write.scope, 'profile')
    assert.equal(fs.existsSync(path.join(dsh, 'cordis.patch.yml')), false)

    const removed = manager.removeEntry()
    assert.equal(removed.changed, false)
    assert.equal(removed.path, profilePatch)
    assert.ok(fs.readFileSync(profilePatch, 'utf8').includes(FEISHU_ENTRY_ID))
  } finally {
    restoreHome()
    restoreDsh()
    restoreProfile()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dsh, { recursive: true, force: true })
    fs.rmSync(profileDir, { recursive: true, force: true })
    fs.rmSync(bin.dir, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a foreign feishu server in the profile patch is reported as a conflict', async () => {
  const home = tempDir('meetclip-feishu-home-')
  const dsh = tempDir('meetclip-feishu-dsh-')
  const profileDir = tempDir('meetclip-feishu-profile-')
  const bin = fakeBinaries()
  const stateDir = tempDir('meetclip-feishu-state-')
  const restoreHome = withEnv('HOME', home)
  const restoreDsh = withEnv('DSH_HOME', dsh)
  const restoreProfile = withEnv('DSH_PROFILE_DIR', profileDir)
  try {
    const manager = new FeishuManager({
      feishuPackage: TEST_PACKAGE,
      feishuRegistry: TEST_REGISTRY,
      stateDir,
      feishuStatePath: path.join(stateDir, 'feishu.json'),
      feishuLogPath: path.join(stateDir, 'feishu.log'),
      feishuNode: bin.node,
      feishuNpx: bin.npx
    })
    writePatchText(path.join(profileDir, 'cordis.patch.yml'),
      "- insert:\n    - id: mify-feishu\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: feishu\n")
    const status = await manager.status()
    assert.equal(status.dsh.conflict, 'mify-feishu')
    assert.throws(() => manager.writeEntry('0.27.4'), (error) => error.code === 'server_conflict')
    assert.equal(fs.existsSync(path.join(dsh, 'cordis.patch.yml')), false)
  } finally {
    restoreHome()
    restoreDsh()
    restoreProfile()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dsh, { recursive: true, force: true })
    fs.rmSync(profileDir, { recursive: true, force: true })
    fs.rmSync(bin.dir, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('rewriteEntry replaces the pinned version without duplicating the block', async () => {
  const home = tempDir('meetclip-feishu-home-')
  const dsh = tempDir('meetclip-feishu-dsh-')
  const bin = fakeBinaries()
  const stateDir = tempDir('meetclip-feishu-state-')
  const restoreHome = withEnv('HOME', home)
  const restoreDsh = withEnv('DSH_HOME', dsh)
  try {
    const manager = new FeishuManager({
      feishuPackage: TEST_PACKAGE,
      feishuRegistry: TEST_REGISTRY,
      stateDir,
      feishuStatePath: path.join(stateDir, 'feishu.json'),
      feishuLogPath: path.join(stateDir, 'feishu.log'),
      feishuNode: bin.node,
      feishuNpx: bin.npx
    })
    manager.writeEntry('0.27.4')
    const rewritten = manager.rewriteEntry('0.28.0')
    assert.equal(rewritten.changed, true)
    const text = fs.readFileSync(path.join(dsh, 'cordis.patch.yml'), 'utf8')
    assert.equal(text.split(FEISHU_ENTRY_ID).length - 1, 1)
    assert.match(text, /feishu-mcp-pro@0\.28\.0/)
    assert.ok(!text.includes('0.27.4'))
    assert.ok(rewritten.backup && fs.existsSync(rewritten.backup))
  } finally {
    restoreHome()
    restoreDsh()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dsh, { recursive: true, force: true })
    fs.rmSync(bin.dir, { recursive: true, force: true })
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('飞书包名与源有内置默认值，config 与环境变量可覆盖', async () => {
  const stateDir = tempDir('meetclip-feishu-defaults-')
  const mk = (overrides = {}) => new FeishuManager({
    stateDir,
    feishuStatePath: path.join(stateDir, 'feishu.json'),
    feishuLogPath: path.join(stateDir, 'feishu.log'),
    ...overrides
  })

  // 不配置任何东西：默认值直接可用，首次引导点一下就能装。
  const builtin = mk()
  assert.match(builtin.packageName(), /^@mi\/feishu-mcp-pro$/)
  assert.match(builtin.registryUrl(), /^https:\/\/pkgs\.d\.xiaomi\.net\//)

  // meetclip config 优先。
  const configured = mk({ feishuPackage: TEST_PACKAGE, feishuRegistry: TEST_REGISTRY })
  assert.equal(configured.packageName(), TEST_PACKAGE)
  assert.equal(configured.registryUrl(), TEST_REGISTRY)

  // 显式清空 config 时仍然回到内置默认值，不会变成「未配置」。
  const blank = mk({ feishuPackage: '', feishuRegistry: '' })
  assert.match(blank.packageName(), /@mi\/feishu-mcp-pro/)
  assert.match(blank.registryUrl(), /pkgs\.d\.xiaomi\.net/)

  fs.rmSync(stateDir, { recursive: true, force: true })
})
