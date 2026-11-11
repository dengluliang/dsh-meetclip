import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { packageRoot, packageVersion } from './config.js'
import { extractTarball, MAX_ARCHIVE_BYTES, MAX_EXTRACTED_BYTES, MAX_FILE_BYTES, MAX_ENTRIES } from './tar.js'

export const DEFAULT_UPDATE_REPO = 'dengluliang/dsh-meetclip'
export const UPDATE_PACKAGE_NAME = '@meetclip/dsh-meetclip'
export const CHECK_TIMEOUT_MS = 8000
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000
const DOWNLOAD_TOTAL_TIMEOUT_MS = 15 * 60_000
const PROGRESS_INTERVAL_MS = 250
const MAX_NOTES_CHARS = 8000
const BACKUP_PREFIX = '.update-bak-'
const RUNNING = new Set(['checking', 'downloading', 'verifying', 'installing'])
const ALLOWED_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'codeload.github.com'
]
const REQUIRED_FILES = ['index.js', 'client.js', 'src/host/routes.js', 'backend/app/main.py', 'package.json']

export class UpdateError extends Error {
  constructor(message, code = 'update-failed', status = 500) {
    super(message)
    this.name = 'UpdateError'
    this.code = code
    this.status = status
  }
}

/** Strict semver subset: `1.2.3` with optional `-prerelease`, optional `+build`. */
export function parseVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.') : []
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}`,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new UpdateError(`无法比较版本号：${left} / ${right}`, 'version-invalid', 500)
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const one = a.prerelease[i]
    const two = b.prerelease[i]
    if (one === undefined) return -1
    if (two === undefined) return 1
    const oneNumeric = /^\d+$/.test(one)
    const twoNumeric = /^\d+$/.test(two)
    if (oneNumeric && twoNumeric) {
      const diff = Number(one) - Number(two)
      if (diff) return diff > 0 ? 1 : -1
    } else if (oneNumeric !== twoNumeric) {
      return oneNumeric ? -1 : 1
    } else if (one !== two) {
      return one > two ? 1 : -1
    }
  }
  return 0
}

function normalizeRepo(value, fallback = DEFAULT_UPDATE_REPO) {
  const text = String(value || '').trim()
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : fallback
}

function normalizeSha(value) {
  const text = String(value || '').trim().replace(/^sha256:/i, '').toLowerCase()
  return /^[a-f0-9]{64}$/.test(text) ? text : ''
}

function boundedNotes(value) {
  return String(value || '').slice(0, MAX_NOTES_CHARS)
}

/** Validate and normalize the small `latest.json` feed published with each release. */
export function parseLatestFeed(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpdateError('更新源返回的不是有效 JSON 对象', 'feed-invalid', 502)
  }
  const parsed = parseVersion(value.version || value.tag)
  if (!parsed) throw new UpdateError('更新源缺少有效版本号', 'feed-invalid', 502)
  const asset = value.asset && typeof value.asset === 'object' ? value.asset : {}
  const name = path.basename(String(asset.name || ''))
  const url = String(asset.url || '')
  const sha256 = normalizeSha(asset.sha256)
  if (!name || !/\.tgz$/i.test(name)) {
    throw new UpdateError('更新源没有提供 .tgz 安装包', 'feed-invalid', 502)
  }
  if (!url) throw new UpdateError('更新源缺少安装包地址', 'feed-invalid', 502)
  if (!sha256) throw new UpdateError('更新源缺少 SHA-256 校验值', 'feed-invalid', 502)
  const size = Number(asset.size)
  const repo = normalizeRepo(options.repo || DEFAULT_UPDATE_REPO)
  const tag = String(value.tag || `v${parsed.version}`).trim()
  return {
    version: parsed.version,
    tag,
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : '',
    url: typeof value.url === 'string' && value.url ? value.url : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    notes: boundedNotes(value.notes),
    asset: {
      name,
      url,
      size: Number.isFinite(size) && size > 0 ? size : 0,
      sha256
    }
  }
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

export function allowedUpdateUrl(value, { allowLocal = false } = {}) {
  try {
    const url = new URL(String(value || ''))
    if (url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    if (url.protocol === 'https:') {
      return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    }
    if (allowLocal && url.protocol === 'http:' && isLoopbackHost(host)) return true
    return false
  } catch {
    return false
  }
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function readJsonSync(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function exists(file) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

function writable(dir) {
  let target = path.resolve(String(dir || '.'))
  for (let depth = 0; depth < 64; depth += 1) {
    if (exists(target)) {
      try {
        fs.accessSync(target, fs.constants.W_OK)
        return true
      } catch {
        return false
      }
    }
    const parent = path.dirname(target)
    if (parent === target) return false
    target = parent
  }
  return false
}

function abortReason(name, message) {
  const error = new Error(message)
  error.name = name
  return error
}

function timeoutSignal(parentSignal, ms) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parentSignal?.reason || abortReason('UpdateAborted', '更新已取消'))
  if (parentSignal) {
    if (parentSignal.aborted) onAbort()
    else parentSignal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(abortReason('UpdateTimeout', '等待更新源超时')), ms)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort)
    }
  }
}

export class UpdateManager {
  constructor(settings = {}, options = {}) {
    this.settings = settings
    this.repo = normalizeRepo(options.repo || settings.updateRepo || process.env.MEETCLIP_UPDATE_REPO || DEFAULT_UPDATE_REPO)
    this.feedUrl = String(options.feedUrl || settings.updateFeed || process.env.MEETCLIP_UPDATE_FEED || '').trim()
    this.targetDir = path.resolve(options.targetDir || settings.packageRoot || packageRoot)
    this.currentVersion = options.currentVersion || packageVersion
    this.stateDir = path.resolve(options.stateDir || settings.stateDir || path.join(os.homedir(), '.dsh', 'meetclip'))
    this.statePath = path.join(this.stateDir, 'update-state.json')
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.now = options.now || Date.now
    this.allowSourceTarget = options.allowSourceTarget === true
    this.latest = null
    this.lastCheckAt = 0
    this.job = null
    this.promise = null
    this.abort = null
    this.recovery = null
    this.previousVersion = ''
    this.loadState()
    this.recoverInterrupted()
    this.cleanupStaleWork()
  }

  refresh(settings) {
    const previousStateDir = this.stateDir
    this.settings = settings
    this.repo = normalizeRepo(settings.updateRepo || this.repo)
    this.feedUrl = String(settings.updateFeed || this.feedUrl || '').trim()
    this.stateDir = path.resolve(settings.stateDir || this.stateDir)
    this.statePath = path.join(this.stateDir, 'update-state.json')
    if (this.stateDir !== previousStateDir) this.loadState()
  }

  // ---------------------------------------------------------------- state

  loadState() {
    const state = readJsonSync(this.statePath)
    if (!state) return
    const checkAt = Number(state.lastCheckAt)
    this.lastCheckAt = Number.isFinite(checkAt) && checkAt > 0 ? checkAt : 0
    if (state.latest) {
      try {
        this.latest = parseLatestFeed(state.latest, { repo: this.repo })
      } catch {
        this.latest = null
      }
    }
    if (typeof state.previousVersion === 'string') this.previousVersion = state.previousVersion
  }

  persistState() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true })
      const value = {
        schemaVersion: 1,
        lastCheckAt: this.lastCheckAt,
        latest: this.latest,
        installedVersion: this.readInstalledVersion(),
        previousVersion: this.previousVersion,
        lastResult: this.job
          ? { state: this.job.state, at: this.now(), error: this.job.error || '' }
          : null
      }
      const temp = `${this.statePath}.tmp`
      fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
      fs.renameSync(temp, this.statePath)
    } catch {}
  }

  /**
   * If a previous update crashed between moving the old package away and
   * putting the new one in place, restore the newest updater-made backup.
   */
  recoverInterrupted() {
    try {
      const parent = path.dirname(this.targetDir)
      const base = path.basename(this.targetDir)
      const backups = fs.readdirSync(parent)
        .filter((name) => name.startsWith(`${base}${BACKUP_PREFIX}`))
        .sort()
        .reverse()
      const targetVersion = this.readInstalledVersion()
      if (targetVersion && fs.existsSync(path.join(this.targetDir, 'index.js'))) return
      if (!backups.length) return
      const source = path.join(parent, backups[0])
      if (exists(this.targetDir)) {
        try { fs.renameSync(this.targetDir, `${this.targetDir}.corrupt-${timestamp()}`) } catch {}
      }
      fs.renameSync(source, this.targetDir)
      this.recovery = { restoredFrom: source, at: this.now() }
    } catch {}
  }

  cleanupStaleWork() {
    try {
      const root = path.join(this.stateDir, 'updates')
      if (!exists(root)) return
      for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry)
        try {
          if (!fs.statSync(dir).isDirectory()) continue
          if (exists(path.join(dir, 'stage'))) fs.rmSync(path.join(dir, 'stage'), { recursive: true, force: true })
          for (const file of fs.readdirSync(dir)) {
            if (file.endsWith('.part')) fs.rmSync(path.join(dir, file), { force: true })
          }
        } catch {}
      }
    } catch {}
  }

  readInstalledVersion() {
    const manifest = readJsonSync(path.join(this.targetDir, 'package.json'))
    return typeof manifest?.version === 'string' ? manifest.version : ''
  }

  /** The newer of the running and on-disk versions; updates compare against this. */
  referenceVersion() {
    const installed = this.readInstalledVersion()
    if (!installed) return this.currentVersion
    try {
      return compareVersions(installed, this.currentVersion) > 0 ? installed : this.currentVersion
    } catch {
      return this.currentVersion
    }
  }

  targetInfo() {
    const normalized = this.targetDir.split(path.sep).join('/')
    const marker = `/node_modules/${UPDATE_PACKAGE_NAME}`
    const kind = normalized.endsWith(marker) ? 'installed' : 'source'
    return {
      path: this.targetDir,
      kind,
      writable: writable(this.targetDir)
    }
  }

  /**
   * 更新器替换安装副本前会把旧目录改名成 `<包名>.update-bak-<版本>-<时间戳>-<序号>`
   * 放在旁边；这些目录就是可回退的版本。只认包名正确、必需文件齐全的完整备份，
   * 避免把一个残缺目录摆到界面上让人点。
   */
  listBackups() {
    const parent = path.dirname(this.targetDir)
    const base = path.basename(this.targetDir)
    const prefix = `${base}${BACKUP_PREFIX}`
    let names = []
    try {
      names = fs.readdirSync(parent)
    } catch {
      return []
    }
    const rows = []
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const match = /^(.+)-(\d{8}-\d{6})-(\d+)$/.exec(name.slice(prefix.length))
      if (!match) continue
      const dir = path.join(parent, name)
      try {
        if (!fs.statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const manifest = readJsonSync(path.join(dir, 'package.json'))
      if (!manifest || manifest.name !== UPDATE_PACKAGE_NAME) continue
      const parsed = parseVersion(manifest.version)
      if (!parsed) continue
      if (!REQUIRED_FILES.every((relative) => exists(path.join(dir, ...relative.split('/'))))) continue
      rows.push({
        id: name,
        version: parsed.version,
        path: dir,
        at: backupStampEpoch(match[2]),
        seq: Number(match[3]) || 0
      })
    }
    // 备份名里的时间戳是本地时间、按秒排序即可；同一秒内用序号兜底。
    rows.sort((left, right) => (right.at - left.at) || (right.seq - left.seq))
    return rows
  }

  /** 给「关于」页用的可回退版本；磁盘上已经是的版本不再重复列出。 */
  rollbackInfo(target = this.targetInfo(), installedVersion = this.readInstalledVersion()) {
    const available = this.listBackups()
      .filter((row) => row.version !== installedVersion)
      .map((row) => ({
        id: row.id,
        version: row.version,
        at: row.at,
        // 回退过之后，备份里也可能有比当前磁盘版本新的版本，按钮会改叫「切换回」。
        direction: versionDirection(installedVersion, row.version)
      }))
    return {
      available,
      canRollback: available.length > 0 && (target.kind === 'installed' || this.allowSourceTarget)
    }
  }

  status() {
    const installedVersion = this.readInstalledVersion()
    let updateAvailable = false
    if (this.latest) {
      try { updateAvailable = compareVersions(this.latest.version, this.referenceVersion()) > 0 } catch {}
    }
    const target = this.targetInfo()
    return {
      ok: true,
      currentVersion: this.currentVersion,
      installedVersion,
      restartRequired: Boolean(installedVersion && installedVersion !== this.currentVersion),
      // 磁盘上的版本比正在运行的旧，说明重启后是「回退」，界面换一句提示。
      restartDirection: restartDirection(installedVersion, this.currentVersion),
      repo: this.repo,
      target,
      latest: this.latest,
      updateAvailable,
      lastCheckAt: this.lastCheckAt,
      recovery: this.recovery,
      rollback: this.rollbackInfo(target, installedVersion),
      job: this.jobSnapshot()
    }
  }

  jobSnapshot() {
    if (!this.job) return null
    return {
      state: this.job.state,
      phase: this.job.phase,
      kind: this.job.kind || 'update',
      message: this.job.message,
      percent: this.job.percent,
      received: this.job.received,
      total: this.job.total,
      speed: this.job.speed,
      version: this.job.version,
      error: this.job.error,
      startedAt: this.job.startedAt,
      updatedAt: this.job.updatedAt,
      finishedAt: this.job.finishedAt
    }
  }

  running() {
    return Boolean(this.job && RUNNING.has(this.job.state))
  }

  resetJob(state, phase, kind = 'update') {
    this.job = {
      state,
      phase,
      kind,
      message: '',
      percent: null,
      received: 0,
      total: 0,
      speed: 0,
      version: '',
      error: '',
      startedAt: this.now(),
      updatedAt: this.now(),
      finishedAt: 0
    }
  }

  setJob(patch) {
    if (!this.job) return
    Object.assign(this.job, patch, { updatedAt: this.now() })
  }

  // ------------------------------------------------------------- lifecycle

  /** 默认只检查：安装要用户再点一次「点击升级」（POST install），或多传 autoInstall: true。 */
  startCheck({ autoInstall = false } = {}) {
    if (this.running()) throw new UpdateError('已有更新任务在进行中', 'update-busy', 409)
    this.resetJob('checking', '检查更新')
    this.abort = new AbortController()
    this.promise = this.runCheck(autoInstall)
      .catch((error) => this.fail(error))
      .finally(() => { this.abort = null })
    return this.jobSnapshot()
  }

  startInstall() {
    if (this.running()) throw new UpdateError('已有更新任务在进行中', 'update-busy', 409)
    if (!this.latest) throw new UpdateError('还没有检查到新版本，请先检查更新', 'no-latest', 409)
    if (compareVersions(this.latest.version, this.referenceVersion()) <= 0) {
      if (this.readInstalledVersion() !== this.currentVersion) {
        throw new UpdateError('新版本已经安装，重启 DeepSeek Harness 后生效', 'restart-required', 409)
      }
      throw new UpdateError('当前已经是最新版本', 'no-update', 409)
    }
    this.resetJob('downloading', '准备下载')
    this.abort = new AbortController()
    this.promise = this.performInstall(this.latest)
      .catch((error) => this.fail(error))
      .finally(() => { this.abort = null })
    return this.jobSnapshot()
  }

  /**
   * 把更新器留下的某个旧版本备份换回安装目录。回退前先把当前磁盘版本另存为
   * 一份新备份，所以回退本身也能再切回来，且整个过程不需要联网。
   * 不传版本时取最近的一份备份。
   */
  startRollback(requestedVersion = '') {
    if (this.running()) throw new UpdateError('已有更新任务在进行中', 'update-busy', 409)
    const installed = this.readInstalledVersion()
    // 磁盘上已经是的版本没有回退意义，直接从候选里去掉。
    const backups = this.listBackups().filter((row) => row.version !== installed)
    if (!backups.length) {
      throw new UpdateError('没有可回退的备份：应用内更新会保留上一版本，手工安装的副本没有备份', 'no-rollback', 409)
    }
    const wanted = String(requestedVersion || '').trim().replace(/^v/i, '')
    const backup = wanted ? backups.find((row) => row.version === wanted) : backups[0]
    if (!backup) {
      const listed = backups.map((row) => `v${row.version}`).join('、')
      throw new UpdateError(`没有 v${wanted} 的备份，可回退：${listed}`, 'no-rollback', 409)
    }
    const target = this.targetInfo()
    if (target.kind !== 'installed' && !this.allowSourceTarget) {
      throw new UpdateError('当前以源码方式运行，不能覆盖安装副本；请用 git checkout 切换版本', 'target-source', 409)
    }
    if (!target.writable) {
      throw new UpdateError(`没有权限写入插件目录：${target.path}`, 'target-unwritable', 403)
    }
    this.resetJob('installing', '回退中', 'rollback')
    this.setJob({
      version: backup.version,
      percent: null,
      message: `准备回退到 v${backup.version}…`
    })
    this.promise = this.performRollback(backup, installed)
      .catch((error) => this.fail(error))
      .finally(() => { this.abort = null })
    return this.jobSnapshot()
  }

  cancel() {
    if (!this.running()) return { status: 'not-running' }
    if (this.job.state === 'verifying' || this.job.state === 'installing') return { status: 'too-late' }
    try {
      this.abort?.abort(abortReason('UpdateCancelled', '更新已取消'))
    } catch {}
    return { status: 'cancelled' }
  }

  async whenIdle() {
    if (this.promise) await this.promise.catch(() => {})
    return this.jobSnapshot()
  }

  dispose() {
    try { this.abort?.abort(abortReason('UpdateDisposed', '会摘正在关闭')) } catch {}
  }

  // ---------------------------------------------------------------- check

  async runCheck(autoInstall) {
    const feed = await this.fetchLatestRelease()
    this.latest = feed
    this.lastCheckAt = this.now()
    this.persistState()
    if (compareVersions(feed.version, this.referenceVersion()) <= 0) {
      const installed = this.readInstalledVersion()
      const pendingRestart = Boolean(installed && compareVersions(installed, this.currentVersion) > 0)
      this.setJob({
        state: 'done',
        phase: pendingRestart ? '已安装新版本' : '已是最新版本',
        message: pendingRestart
          ? `已安装 v${installed}，重启 DeepSeek Harness 后生效`
          : `当前 v${this.currentVersion} 已经是最新版本`,
        version: feed.version,
        percent: null,
        finishedAt: this.now()
      })
      return this.jobSnapshot()
    }
    this.setJob({
      state: 'downloading',
      phase: '发现新版本',
      message: `发现 v${feed.version}，准备下载`,
      version: feed.version
    })
    if (!autoInstall) {
      this.setJob({
        state: 'done',
        phase: '发现新版本',
        message: `发现 v${feed.version}，等待安装`,
        version: feed.version,
        percent: null,
        finishedAt: this.now()
      })
      return this.jobSnapshot()
    }
    await this.performInstall(feed)
    return this.jobSnapshot()
  }

  async fetchLatestRelease() {
    if (typeof this.fetchImpl !== 'function') {
      throw new UpdateError('当前运行环境不支持网络请求', 'fetch-unavailable', 500)
    }
    const primary = this.feedUrl
      ? appendCacheBust(this.feedUrl)
      : `https://github.com/${this.repo}/releases/latest/download/latest.json?ts=${this.now()}`
    let primaryError = null
    try {
      const feed = await this.fetchFeedJson(primary)
      const parsed = parseLatestFeed(feed, { repo: this.repo })
      if (!allowedUpdateUrl(parsed.asset.url, { allowLocal: Boolean(this.feedUrl) && isLoopbackUrl(primary) })) {
        throw new UpdateError('更新源给出的安装包地址不被允许', 'feed-invalid', 502)
      }
      return parsed
    } catch (error) {
      primaryError = error
      if (this.feedUrl) throw this.describeNetworkError(error)
      if (error?.name === 'UpdateCancelled' || error?.name === 'UpdateDisposed'
        || error?.code === 'cancelled') throw error
    }
    try {
      return await this.fetchReleaseApi()
    } catch (error) {
      const described = this.describeNetworkError(error)
      if (!described.cause && primaryError) described.cause = primaryError
      throw described
    }
  }

  async fetchFeedJson(url) {
    const timeout = timeoutSignal(this.abort?.signal, CHECK_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(url, {
        signal: timeout.signal,
        redirect: 'follow',
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache',
          'user-agent': 'MeetClip-Updater'
        }
      })
      if (!response.ok) {
        throw new UpdateError(`更新源返回 HTTP ${response.status}`, response.status === 404 ? 'no-release' : 'feed-http', response.status)
      }
      if (!allowedUpdateUrl(response.url || url, { allowLocal: Boolean(this.feedUrl) && isLoopbackUrl(url) })) {
        throw new UpdateError('更新源重定向到了不允许的地址', 'feed-invalid', 502)
      }
      try {
        return await response.json()
      } catch {
        throw new UpdateError('更新源返回的 JSON 无法解析', 'feed-invalid', 502)
      }
    } catch (error) {
      const reason = timeout.signal.reason
      if (reason?.name === 'UpdateCancelled' || reason?.name === 'UpdateDisposed') throw reason
      if (reason?.name === 'UpdateTimeout' || error?.name === 'UpdateTimeout') {
        throw new UpdateError('连接 GitHub 超时，请检查网络或代理', 'network-timeout', 504)
      }
      if (error?.name === 'UpdateCancelled' || error?.name === 'UpdateDisposed') throw error
      if (error instanceof UpdateError) throw error
      throw this.describeNetworkError(error)
    } finally {
      timeout.dispose()
    }
  }

  async fetchReleaseApi() {
    const url = `https://api.github.com/repos/${this.repo}/releases/latest`
    const timeout = timeoutSignal(this.abort?.signal, CHECK_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(url, {
        signal: timeout.signal,
        redirect: 'follow',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'MeetClip-Updater'
        }
      })
      if (response.status === 404) throw new UpdateError('仓库还没有发布版本', 'no-release', 404)
      if (response.status === 403 || response.status === 429) {
        throw new UpdateError('GitHub 接口限流，请稍后再试', 'rate-limited', 429)
      }
      if (!response.ok) throw new UpdateError(`GitHub API 返回 HTTP ${response.status}`, 'api-http', response.status)
      const release = await response.json()
      return await this.releaseToFeed(release)
    } catch (error) {
      const reason = timeout.signal.reason
      if (reason?.name === 'UpdateCancelled' || reason?.name === 'UpdateDisposed') throw reason
      if (reason?.name === 'UpdateTimeout' || error?.name === 'UpdateTimeout') {
        throw new UpdateError('连接 GitHub 超时，请检查网络或代理', 'network-timeout', 504)
      }
      if (error instanceof UpdateError) throw error
      throw this.describeNetworkError(error)
    } finally {
      timeout.dispose()
    }
  }

  async releaseToFeed(release) {
    if (!release || typeof release !== 'object') throw new UpdateError('GitHub Release 数据无效', 'feed-invalid', 502)
    const version = parseVersion(release.tag_name)
    if (!version) throw new UpdateError('GitHub Release 的 tag 不是有效版本号', 'feed-invalid', 502)
    const assets = Array.isArray(release.assets) ? release.assets : []
    const asset = assets.find((item) => /\.tgz$/i.test(String(item?.name || '')))
    if (!asset?.browser_download_url) throw new UpdateError('Release 里没有 .tgz 安装包', 'feed-invalid', 502)
    let sha256 = normalizeSha(asset.digest)
    if (!sha256) sha256 = await this.readChecksumAsset(assets, asset.name)
    if (!sha256) throw new UpdateError('Release 没有提供 SHA-256 校验值', 'feed-invalid', 502)
    return parseLatestFeed({
      version: version.version,
      tag: release.tag_name,
      publishedAt: release.published_at,
      notes: release.body,
      url: release.html_url,
      asset: {
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        sha256
      }
    }, { repo: this.repo })
  }

  async readChecksumAsset(assets, targetName) {
    const sums = assets.find((item) => String(item?.name || '').toLowerCase() === 'sha256sums.txt')
    if (!sums?.browser_download_url) return ''
    const timeout = timeoutSignal(this.abort?.signal, CHECK_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(sums.browser_download_url, {
        signal: timeout.signal,
        redirect: 'follow',
        headers: { accept: 'text/plain', 'user-agent': 'MeetClip-Updater' }
      })
      if (!response.ok) return ''
      const text = await response.text()
      if (text.length > 64 * 1024) return ''
      for (const line of text.split(/\r?\n/)) {
        const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim())
        if (match && match[2].trim() === targetName) return normalizeSha(match[1])
      }
    } catch {}
    finally { timeout.dispose() }
    return ''
  }

  describeNetworkError(error) {
    if (error instanceof UpdateError) return error
    const code = String(error?.cause?.code || error?.code || '')
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new UpdateError('连不上 GitHub，请检查网络或代理', 'network-dns', 502)
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
      return new UpdateError('连接 GitHub 失败，请检查网络或代理', 'network-refused', 502)
    }
    if (String(error?.name || '').startsWith('Abort')) {
      const reason = error?.cause || error?.reason
      if (reason?.name === 'UpdateTimeout') {
        return new UpdateError('连接 GitHub 超时，请检查网络或代理', 'network-timeout', 504)
      }
      if (reason?.name === 'UpdateCancelled' || reason?.name === 'UpdateDisposed') {
        return new UpdateError('检查更新已取消', 'cancelled', 499)
      }
      return new UpdateError('检查更新已取消', 'cancelled', 499)
    }
    return new UpdateError(`检查更新失败：${error?.message || error}`, 'network-error', 502)
  }

  // --------------------------------------------------------------- install

  async performInstall(feed) {
    if (compareVersions(feed.version, this.referenceVersion()) <= 0) {
      throw new UpdateError('这个版本已经安装', 'no-update', 409)
    }
    const target = this.targetInfo()
    if (target.kind !== 'installed' && !this.allowSourceTarget) {
      throw new UpdateError('当前以源码方式运行，请用 git pull 更新；自动更新只替换 DSH 安装副本', 'target-source', 409)
    }
    if (!target.writable) {
      throw new UpdateError(`没有权限写入插件目录：${target.path}`, 'target-unwritable', 403)
    }
    const version = feed.version
    const workDir = path.join(this.stateDir, 'updates', safeVersion(version))
    const stage = path.join(workDir, 'stage')
    const tgz = path.join(workDir, feed.asset.name)
    await fsp.mkdir(workDir, { recursive: true })
    await fsp.rm(stage, { recursive: true, force: true })

    this.setJob({ state: 'downloading', phase: '下载中', version, percent: 0, received: 0, total: feed.asset.size || 0, speed: 0 })
    const download = await this.downloadAsset(feed.asset, tgz)
    const digest = download.digest
    this.setJob({ percent: 100, speed: 0, received: download.received, total: download.total })

    this.setJob({ state: 'verifying', phase: '校验并解包', percent: null, message: '校验 SHA-256…' })
    const expected = normalizeSha(feed.asset.sha256)
    if (!timingSafeHexEqual(digest, expected)) {
      await removeQuiet(tgz)
      throw new UpdateError('下载文件 SHA-256 校验失败，已丢弃', 'hash-mismatch', 502)
    }
    try {
      const buffer = await fsp.readFile(tgz)
      if (buffer.length > MAX_ARCHIVE_BYTES) throw new UpdateError('更新包超过大小上限', 'archive-too-large', 413)
      await fsp.mkdir(stage, { recursive: true })
      extractTarball(buffer, stage, {
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        maxExtractedBytes: MAX_EXTRACTED_BYTES,
        maxFileBytes: MAX_FILE_BYTES,
        maxEntries: MAX_ENTRIES
      })
      await this.validatePackage(stage, version)
    } catch (error) {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
      throw error
    }

    this.setJob({ state: 'installing', phase: '安装中', percent: null, message: '替换已安装的插件副本…' })
    this.previousVersion = this.readInstalledVersion()
    const applied = await this.applyStage(stage, version)
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
    this.persistState()
    this.setJob({
      state: 'done',
      phase: '更新完成',
      message: `已安装 v${version}，重启 DeepSeek Harness 后生效`,
      percent: 100,
      speed: 0,
      finishedAt: this.now()
    })
    return { ok: true, version, backup: applied.backup, target: applied.target }
  }

  /**
   * 备份目录和安装目录是同一层的两个目录，交换一次即可：当前版本先改名成备份，
   * 再把旧备份改回安装目录。任何一步失败都把原名改回去，不动资料与数据。
   */
  async performRollback(backup, installedVersion) {
    const version = backup.version
    // 先确认备份本身完整，免得把能用的版本换成一个残缺目录。
    try {
      await this.validatePackage(backup.path, version)
    } catch (error) {
      throw new UpdateError(`备份 v${version} 不完整：${error?.message || error}`, 'rollback-invalid', 500)
    }
    const target = this.targetDir
    const parent = path.dirname(target)
    const base = path.basename(target)
    const keepVersion = this.readInstalledVersion() || installedVersion || 'unknown'
    let sequence = this.now() % 100000
    let keep = path.join(parent, `${base}${BACKUP_PREFIX}${safeVersion(keepVersion)}-${timestamp()}-${sequence}`)
    while (exists(keep)) {
      sequence = (sequence + 1) % 1000000
      keep = path.join(parent, `${base}${BACKUP_PREFIX}${safeVersion(keepVersion)}-${timestamp()}-${sequence}`)
    }
    this.setJob({
      state: 'installing',
      phase: '回退中',
      message: `把 v${version} 的备份换回插件目录…`,
      percent: null
    })
    const hadTarget = exists(target)
    let moved = false
    let copied = false
    try {
      if (hadTarget) {
        await fsp.rename(target, keep)
        moved = true
      }
      if (moved) {
        try {
          await fsp.rename(backup.path, target)
        } catch (error) {
          if (error?.code !== 'EXDEV') throw error
          await copyTree(backup.path, target)
          copied = true
        }
      } else {
        await copyTree(backup.path, target)
        copied = true
      }
      await this.validatePackage(target, version)
      if (copied) await fsp.rm(backup.path, { recursive: true, force: true }).catch(() => {})
    } catch (error) {
      // 只有确实动过目录才清理并还原；改名本身失败时安装目录还是原样。
      if (moved) {
        // 备份是被改名（不是复制）过来的话，先把它改回备份名，别弄丢可回退的版本。
        if (!copied && !exists(backup.path) && exists(target)) {
          try {
            await fsp.rename(target, backup.path)
          } catch {
            await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
          }
        } else {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
        }
        try { await fsp.rename(keep, target) } catch {}
      } else if (!hadTarget) {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
      }
      throw new UpdateError(`回退失败：${error?.message || error}`, 'rollback-failed', 500)
    }
    await this.pruneBackups(parent)
    this.previousVersion = version
    this.persistState()
    this.setJob({
      state: 'done',
      phase: '回退完成',
      message: `已回退到 v${version}，重启 DeepSeek Harness 后生效`,
      percent: 100,
      speed: 0,
      finishedAt: this.now()
    })
    return { ok: true, version, backup: keep, target }
  }

  async downloadAsset(asset, destination) {
    if (!allowedUpdateUrl(asset.url, { allowLocal: Boolean(this.feedUrl) && isLoopbackUrl(this.feedUrl) })) {
      throw new UpdateError('安装包地址不被允许', 'download-url', 403)
    }
    const part = `${destination}.part`
    await fsp.rm(part, { force: true }).catch(() => {})
    const controller = new AbortController()
    const onAbort = () => controller.abort(this.abort?.signal?.reason || abortReason('UpdateCancelled', '更新已取消'))
    this.abort?.signal.addEventListener('abort', onAbort, { once: true })
    let lastActivity = this.now()
    let idleTimer = null
    const totalTimer = setTimeout(() => controller.abort(abortReason('UpdateTimeout', '下载超时')), DOWNLOAD_TOTAL_TIMEOUT_MS)
    idleTimer = setInterval(() => {
      if (this.now() - lastActivity > DOWNLOAD_IDLE_TIMEOUT_MS) {
        controller.abort(abortReason('UpdateTimeout', '下载长时间没有数据'))
      }
    }, 5000)
    let handle = null
    let received = 0
    let total = asset.size || 0
    let lastReport = 0
    const started = this.now()
    const hash = crypto.createHash('sha256')
    try {
      const response = await this.fetchImpl(asset.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          accept: 'application/octet-stream',
          'accept-encoding': 'identity',
          'user-agent': 'MeetClip-Updater'
        }
      })
      if (!response.ok) {
        throw new UpdateError(`下载安装包失败：HTTP ${response.status}`, 'download-http', response.status)
      }
      if (!allowedUpdateUrl(response.url || asset.url, { allowLocal: Boolean(this.feedUrl) && isLoopbackUrl(this.feedUrl) })) {
        throw new UpdateError('下载重定向到了不允许的地址', 'download-url', 403)
      }
      const length = Number(response.headers.get('content-length'))
      if (Number.isFinite(length) && length > 0) total = length
      if (total > MAX_ARCHIVE_BYTES) throw new UpdateError('安装包超过大小上限', 'archive-too-large', 413)
      if (!response.body) throw new UpdateError('下载响应没有内容', 'download-empty', 502)

      handle = await fsp.open(part, 'w')
      for await (const chunk of response.body) {
        lastActivity = this.now()
        received += chunk.length
        if (received > MAX_ARCHIVE_BYTES) throw new UpdateError('安装包超过大小上限', 'archive-too-large', 413)
        hash.update(chunk)
        await handle.write(chunk)
        const now = this.now()
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          const elapsed = Math.max((now - started) / 1000, 0.001)
          this.setJob({
            state: 'downloading',
            percent: total > 0 ? Math.min(99.9, Math.round((received / total) * 1000) / 10) : null,
            received,
            total,
            speed: Math.round(received / elapsed)
          })
        }
      }
      await handle.close()
      handle = null
      if (total > 0 && received !== total) {
        throw new UpdateError(`下载不完整：${received}/${total} 字节`, 'download-incomplete', 502)
      }
      await fsp.rename(part, destination)
      return { digest: hash.digest('hex'), received, total }
    } catch (error) {
      try { await handle?.close() } catch {}
      await removeQuiet(part)
      if (error?.name === 'UpdateCancelled' || error?.name === 'UpdateDisposed') throw error
      if (error?.name === 'UpdateTimeout') throw new UpdateError(error.message || '下载超时', 'download-timeout', 504)
      if (error?.name === 'AbortError') {
        const reason = controller.signal.reason
        if (reason?.name === 'UpdateCancelled' || reason?.name === 'UpdateDisposed') throw reason
        if (reason?.name === 'UpdateTimeout') throw new UpdateError(reason.message || '下载超时', 'download-timeout', 504)
        throw new UpdateError('下载已中断', 'download-aborted', 499)
      }
      if (error instanceof UpdateError) throw error
      throw new UpdateError(`下载安装包失败：${error?.message || error}`, 'download-failed', 502)
    } finally {
      clearInterval(idleTimer)
      clearTimeout(totalTimer)
      this.abort?.signal.removeEventListener('abort', onAbort)
    }
  }

  async validatePackage(dir, version) {
    const manifest = readJsonSync(path.join(dir, 'package.json'))
    if (!manifest) throw new UpdateError('更新包缺少 package.json', 'package-invalid', 502)
    if (manifest.name !== UPDATE_PACKAGE_NAME) {
      throw new UpdateError(`更新包名称不匹配：${manifest.name}`, 'package-invalid', 502)
    }
    if (version && manifest.version !== version) {
      throw new UpdateError(`更新包版本不匹配：期望 ${version}，实际 ${manifest.version}`, 'package-invalid', 502)
    }
    for (const relative of REQUIRED_FILES) {
      if (!exists(path.join(dir, ...relative.split('/')))) {
        throw new UpdateError(`更新包缺少 ${relative}`, 'package-incomplete', 502)
      }
    }
    return manifest
  }

  async applyStage(stage, version) {
    const target = this.targetDir
    const parent = path.dirname(target)
    const backupBase = this.previousVersion || this.readInstalledVersion() || 'unknown'
    const backup = path.join(parent, `${path.basename(target)}${BACKUP_PREFIX}${safeVersion(backupBase)}-${timestamp()}-${this.now() % 100000}`)
    await fsp.mkdir(parent, { recursive: true })
    if (!exists(target)) {
      try {
        await copyTree(stage, target)
        await this.validatePackage(target, version)
      } catch (error) {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      return { target, backup: '' }
    }
    let moved = false
    try {
      await fsp.rename(target, backup)
      moved = true
      try {
        await fsp.rename(stage, target)
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error
        await copyTree(stage, target)
        await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
      }
      await this.validatePackage(target, version)
    } catch (error) {
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
      if (moved) {
        try { await fsp.rename(backup, target) } catch {}
      }
      throw error
    }
    await this.pruneBackups(parent)
    return { target, backup }
  }

  async pruneBackups(parent) {
    try {
      const base = path.basename(this.targetDir)
      const rows = fs.readdirSync(parent)
        .filter((name) => name.startsWith(`${base}${BACKUP_PREFIX}`))
        .sort()
        .reverse()
      for (const name of rows.slice(2)) {
        await fsp.rm(path.join(parent, name), { recursive: true, force: true }).catch(() => {})
      }
    } catch {}
  }

  // -------------------------------------------------------------- failures

  fail(error) {
    const cancelled = error?.name === 'UpdateCancelled' || error?.name === 'UpdateDisposed'
      || error?.code === 'cancelled' || error?.code === 'download-aborted'
    const label = this.job?.kind === 'rollback' ? '回退' : '更新'
    const message = cancelled ? `${label}已取消` : this.describeFailure(error)
    this.cleanupJobFiles()
    this.setJob({
      state: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? '已取消' : `${label}失败`,
      message,
      error: cancelled ? '' : message,
      finishedAt: this.now()
    })
    this.persistState()
    return this.jobSnapshot()
  }

  cleanupJobFiles() {
    const version = this.job?.version
    if (!version) return
    try {
      const dir = path.join(this.stateDir, 'updates', safeVersion(version))
      fs.rmSync(path.join(dir, 'stage'), { recursive: true, force: true })
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.part')) fs.rmSync(path.join(dir, file), { force: true })
      }
    } catch {}
  }

  describeFailure(error) {
    const code = String(error?.code || '')
    if (code === 'no-release') return 'GitHub 仓库还没有发布版本'
    if (code === 'rate-limited') return 'GitHub 接口限流，请稍后再试'
    if (code === 'hash-mismatch') return '下载校验失败，已丢弃下载文件'
    if (code === 'target-source') return '当前以源码方式运行，请用 git pull 更新'
    if (code === 'target-unwritable') return '没有权限写入插件目录'
    if (code === 'ENOSPC') return '磁盘空间不足'
    if (code === 'EACCES' || code === 'EPERM') return '没有权限写入插件目录'
    if (code.startsWith('archive-')) return `更新包无效：${error.message}`
    if (code.startsWith('package-')) return `更新包无效：${error.message}`
    if (code.startsWith('network')) return error.message
    return error?.message || String(error)
  }
}

function isLoopbackUrl(value) {
  try {
    return isLoopbackHost(new URL(String(value)).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** 重启后是升级还是回退：磁盘版本比运行版本旧就是回退。 */
function restartDirection(installed, current) {
  if (!installed || !current || installed === current) return ''
  try {
    const order = compareVersions(installed, current)
    return order < 0 ? 'rollback' : order > 0 ? 'update' : ''
  } catch {
    return ''
  }
}

/** 某个备份相对磁盘上已安装版本是更旧还是更新。 */
function versionDirection(installed, candidate) {
  if (!installed || !candidate || installed === candidate) return ''
  try {
    return compareVersions(candidate, installed) < 0 ? 'older' : 'newer'
  } catch {
    return ''
  }
}

/** `YYYYMMDD-HHMMSS` 是更新器写备份名时的本地时间，换回毫秒用于排序和展示。 */
function backupStampEpoch(value) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(value || ''))
  if (!match) return 0
  const time = new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6])
  ).getTime()
  return Number.isFinite(time) ? time : 0
}

function appendCacheBust(value) {
  const url = String(value)
  return `${url}${url.includes('?') ? '&' : '?'}ts=${Date.now()}`
}

function safeVersion(value) {
  const text = String(value || '')
  return /^[0-9A-Za-z.+_-]+$/.test(text) ? text : 'unknown'
}

function timingSafeHexEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'hex')
  const b = Buffer.from(String(right || ''), 'hex')
  if (a.length !== b.length || a.length === 0) return false
  try { return crypto.timingSafeEqual(a, b) } catch { return false }
}

async function removeQuiet(file) {
  try { await fsp.rm(file, { force: true }) } catch {}
}

async function copyTree(source, destination) {
  await fsp.rm(destination, { recursive: true, force: true }).catch(() => {})
  await fsp.cp(source, destination, { recursive: true, force: true })
}
