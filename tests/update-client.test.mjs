import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  formatBytes,
  formatSpeed,
  isUpdateRunning,
  progressDetail,
  progressPercent,
  rollbackCandidates,
  updatePrimary,
  updateSummary
} from '../client-src/lib/update.js'

test('formatBytes stays readable from bytes to gigabytes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(20 * 1024 * 1024), '20 MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB')
  assert.equal(formatBytes(-1), '0 B')
  assert.equal(formatBytes('nope'), '0 B')
})

test('formatSpeed omits a zero rate', () => {
  assert.equal(formatSpeed(0), '')
  assert.equal(formatSpeed(2048), '2.0 KB/s')
})

test('progress helpers clamp and describe a download', () => {
  assert.equal(progressPercent({ percent: 42.34 }), 42.34)
  assert.equal(progressPercent({ percent: 140 }), 100)
  assert.equal(progressPercent({ percent: null }), null)
  assert.equal(progressPercent(null), null)

  assert.match(
    progressDetail({ state: 'downloading', received: 1024, total: 2048, speed: 512 }),
    /1\.0 KB \/ 2\.0 KB · 512 B\/s/
  )
  assert.equal(progressDetail({ state: 'downloading', received: 1024, total: 0 }), '1.0 KB')
  assert.equal(progressDetail({ state: 'verifying', message: '校验 SHA-256…' }), '校验 SHA-256…')
})

test('updateSummary covers the lifecycle states', () => {
  assert.equal(updateSummary(null).tone, 'pending')
  assert.equal(updateSummary({ job: null, latest: null }).text, '还没有检查过更新')
  assert.equal(
    updateSummary({ job: null, latest: { version: '0.9.0' }, currentVersion: '0.9.0' }).text,
    '已是最新版本 v0.9.0'
  )
  assert.equal(
    updateSummary({ job: null, latest: { version: '0.9.1' }, currentVersion: '0.9.0', updateAvailable: true }).tone,
    'warn'
  )
  assert.equal(
    updateSummary({ job: null, latest: { version: '0.9.1' }, currentVersion: '0.9.0', installedVersion: '0.9.1', restartRequired: true }).text,
    '已安装 v0.9.1'
  )
  const running = updateSummary({
    job: { state: 'downloading', phase: '下载中', percent: 42.34, received: 1024, total: 2048, speed: 512 }
  })
  assert.equal(running.text, '下载中 42.3%')
  assert.equal(running.tone, 'pending')
  assert.equal(updateSummary({ job: { state: 'error', error: '连不上 GitHub' } }).tone, 'error')
  assert.equal(updateSummary({ job: { state: 'cancelled' } }).tone, 'warn')
})

test('isUpdateRunning only matches active host states', () => {
  assert.equal(isUpdateRunning({ job: { state: 'checking' } }), true)
  assert.equal(isUpdateRunning({ job: { state: 'installing' } }), true)
  assert.equal(isUpdateRunning({ job: { state: 'done' } }), false)
  assert.equal(isUpdateRunning({ job: null }), false)
  assert.equal(isUpdateRunning(null), false)
})

test('rollbackCandidates lists distinct local backups without the installed version', () => {
  const status = {
    installedVersion: '0.9.1',
    rollback: {
      available: [
        { version: '0.9.1', at: 100 },
        { version: '0.9.0', at: 200, direction: 'older' },
        { version: '0.9.0', at: 50, direction: 'older' },
        { version: '0.8.11', at: 300, direction: 'older' }
      ]
    }
  }
  assert.deepEqual(rollbackCandidates(status), [
    { version: '0.9.0', at: 200, direction: 'older' },
    { version: '0.8.11', at: 300, direction: 'older' }
  ])
  assert.deepEqual(rollbackCandidates({ rollback: { available: [{ version: '0.9.1' }] }, installedVersion: '0.9.1' }), [])
  assert.deepEqual(rollbackCandidates({}), [])
  assert.deepEqual(rollbackCandidates(null), [])
  assert.deepEqual(rollbackCandidates({ rollback: { available: [{ version: '  ' }, { nope: 1 }] } }), [])
})

test('updateSummary renders rollback states', () => {
  assert.equal(updateSummary({ job: { state: 'error', kind: 'rollback', error: '磁盘空间不足' } }).text, '回退失败')
  const done = updateSummary({
    job: { state: 'done', kind: 'rollback', version: '0.9.0' },
    installedVersion: '0.9.0',
    restartRequired: true,
    restartDirection: 'rollback'
  })
  assert.equal(done.tone, 'warn')
  assert.match(done.text, /已回退到 v0\.9\.0/)
  assert.match(done.detail, /重启/)
  const pending = updateSummary({
    job: null,
    installedVersion: '0.9.0',
    restartRequired: true,
    restartDirection: 'rollback'
  })
  assert.match(pending.detail, /重启后回到这个版本/)
})

test('the built client contains the About tab, progress styles and privacy copy', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /\.mc-update-bar/)
  assert.match(client, /mc-update-sweep/)
  assert.match(client, /settings\.tab\.about/)
  assert.match(client, /about\.privacy/)
  assert.match(client, /\\u5173\\u4E8E\\u4F1A\\u6458/)
  assert.match(client, /updateCheck/)
})

test('the built client exposes the local rollback controls', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /about\.rollbackRow/)
  assert.match(client, /about\.rollbackConfirmAction/)
  assert.match(client, /mc-about-rollback-select/)
  assert.match(client, /mc-rollback-confirm/)
  assert.match(client, /updateRollback/)
})

test('updatePrimary 在没有更新时是检查更新，查到更新后变成点击升级', () => {
  const base = { currentVersion: '0.9.5', target: { kind: 'installed' } }
  assert.deepEqual(updatePrimary(null), { action: 'check', label: '检查更新' })
  assert.deepEqual(updatePrimary({ ...base, latest: null }), { action: 'check', label: '检查更新' })
  assert.deepEqual(
    updatePrimary({ ...base, latest: { version: '0.9.5' }, updateAvailable: false }),
    { action: 'check', label: '检查更新' }
  )
  assert.deepEqual(
    updatePrimary({ ...base, latest: { version: '0.9.6' }, updateAvailable: true }),
    { action: 'install', label: '点击升级' }
  )
  // 源码运行不能覆盖安装，保持检查。
  assert.deepEqual(
    updatePrimary({ ...base, target: { kind: 'source' }, latest: { version: '0.9.6' }, updateAvailable: true }),
    { action: 'check', label: '检查更新' }
  )
  // 任务在跑时主按钮只显示阶段文案。
  assert.deepEqual(
    updatePrimary({ ...base, job: { state: 'downloading', phase: '下载中', percent: 12 } }),
    { action: 'busy', label: '下载中' }
  )
})

test('发现新版本时提示改为等待点击升级', () => {
  const summary = updateSummary({
    currentVersion: '0.9.5',
    latest: { version: '0.9.6' },
    updateAvailable: true,
    job: null
  })
  assert.equal(summary.tone, 'warn')
  assert.match(summary.text, /发现新版本 v0\.9\.6/)
  assert.match(summary.detail, /点击升级/)
  assert.doesNotMatch(summary.detail, /立即更新/)
})

test('关于页：更新内容按 Markdown 预览，且没有独立的刷新状态按钮', async () => {
  const about = await readFile(new URL('../client-src/components/SettingsAbout.jsx', import.meta.url), 'utf8')
  assert.match(about, /<Markdown text=\{latest\.notes\}/)
  assert.doesNotMatch(about, /<pre className="mc-update-notes"/)
  assert.doesNotMatch(about, /actions\.refresh/)
  // 主按钮改用 updatePrimary 决定「检查更新」还是「点击升级」。
  assert.match(about, /updatePrimary\(status\)/)
  assert.match(about, /primary\.action === 'install'/)
})

test('关于页：更新内容区域禁止选中与复制', async () => {
  const [about, css] = await Promise.all([
    readFile(new URL('../client-src/components/SettingsAbout.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client-src/update.css', import.meta.url), 'utf8')
  ])
  assert.match(about, /onCopy=\{\(event\) => event\.preventDefault\(\)\}/)
  assert.match(about, /onCut=\{\(event\) => event\.preventDefault\(\)\}/)
  const block = css.slice(css.indexOf('.mc-update-notes-card .mc-update-notes {'))
  assert.match(block.slice(0, 600), /user-select: none;/)
  assert.match(block.slice(0, 600), /-webkit-user-select: none;/)
})
