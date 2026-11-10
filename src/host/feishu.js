import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

/**
 * Feishu MCP Pro onboarding.
 *
 * The desktop MCP client (`@deepseek-ai/dsh-mcp-client`) is configured by an
 * `insert` row in DSH's *user* patch layer, so this module only ever appends one
 * well-formed block to `$DSH_HOME/cordis.patch.yml`. HMR watches that file, so a
 * freshly inserted row is loaded without restarting the app.
 *
 * Nothing here exposes Feishu tokens: `readAuthState` reads `auth.json` for its
 * metadata only and the status payload never contains access/refresh tokens.
 */

// 飞书 MCP 的包名与 npm 源内置一份默认值，首次引导点一下就能装；部署方可
// 用 meetclip config 的 `feishuPackage` / `feishuRegistry`（或同名环境变量）
// 覆盖，指向自己的镜像。两者都显式清空时，界面会提示「未配置 MCP 源」。
export const FEISHU_PACKAGE = process.env.MEETCLIP_FEISHU_PACKAGE || '@mi/feishu-mcp-pro'
export const FEISHU_REGISTRY = process.env.MEETCLIP_FEISHU_REGISTRY
  || 'https://pkgs.d.xiaomi.net/artifactory/api/npm/mi-npm/'
export const FEISHU_DOC_URL = 'https://open.feishu.cn/document/home/index'
export const FEISHU_SERVER_NAME = 'feishu'
export const FEISHU_ENTRY_ID = 'mcp-feishu-pro'
export const FEISHU_MARKER = '# 会摘 · 飞书 MCP Pro（自动写入；删除这段即可移除）'
export const FEISHU_MIN_NODE_MAJOR = 20

const LOG_LIMIT = 32 * 1024
const STATUS_CACHE_MS = 20_000
const LATEST_CACHE_MS = 10 * 60_000
const DEFAULT_TIMEOUT_MS = 300_000

// Suffix-matched allowlist for links opened in the user's browser. `feishu.cn`
// covers every tenant subdomain (xxx.feishu.cn, accounts…), so the
// plug-in works for any organization instead of pinning one tenant.
const OPEN_HOSTS = [
  'feishu.cn',
  'larksuite.com',
  'github.com'
]

export function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() ? path.resolve(env.trim()) : path.join(os.homedir(), '.dsh')
}

/** The user patch layer applied after the profile patch; HMR watches it. */
export function patchPathFor(home = dshHome()) {
  return path.join(home, 'cordis.patch.yml')
}

export function authPathFor(home = os.homedir()) {
  return path.join(home, '.feishu-mcp-pro', 'auth.json')
}

/** The active profile's own patch, when the host exposes it via the environment. */
export function profilePatchPath(home = dshHome()) {
  const dir = process.env.DSH_PROFILE_DIR
  if (dir && dir.trim()) return path.join(path.resolve(dir.trim()), 'cordis.patch.yml')
  const profile = process.env.DSH_PROFILE
  if (profile && profile.trim()) return path.join(home, 'profiles', profile.trim(), 'cordis.patch.yml')
  return null
}

export function patchLayers(home = dshHome()) {
  const layers = [{ scope: 'home', path: patchPathFor(home) }]
  const profilePath = profilePatchPath(home)
  if (profilePath && path.resolve(profilePath) !== path.resolve(layers[0].path)) {
    layers.push({ scope: 'profile', path: profilePath })
  }
  return layers
}

function exists(file) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

function executable(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function searchDirs(pathValue, homeDir) {
  const dirs = String(pathValue || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
  const extras = [
    path.join(homeDir, 'bin'),
    path.join(homeDir, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const nvm = path.join(homeDir, '.nvm', 'versions', 'node')
  try {
    const versions = fs.readdirSync(nvm).sort((left, right) => compareVersions(right, left))
    for (const version of versions) extras.unshift(path.join(nvm, version, 'bin'))
  } catch {}
  const seen = new Set()
  return [...dirs, ...extras].filter((dir) => {
    const key = path.resolve(dir)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Highest version first; unparsable ids sort last. */
export function compareVersions(left, right) {
  const a = String(left || '').replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = String(right || '').replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function resolveBinaries({
  pathValue = process.env.PATH,
  homeDir = os.homedir(),
  nodeOverride = null,
  npxOverride = null
} = {}) {
  const dirs = searchDirs(pathValue, homeDir)
  const find = (name, override) => {
    if (override && executable(override)) return path.resolve(override)
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      if (executable(candidate)) return candidate
    }
    return null
  }
  const node = find('node', nodeOverride)
  const npx = find('npx', npxOverride)
  const envPath = [...new Set([
    node ? path.dirname(node) : null,
    npx ? path.dirname(npx) : null,
    ...dirs
  ].filter(Boolean))].join(path.delimiter)
  return { node, npx, dirs, envPath }
}

export function parseVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : ''
}

export function versionMajor(version) {
  const match = String(version || '').match(/^v?(\d+)/)
  return match ? Number(match[1]) : 0
}

export function validOpenUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return OPEN_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

export function extractAuthUrl(text) {
  const matches = String(text || '').match(/https:\/\/[^\s"'`<>]+/g) || []
  let fallback = ''
  for (const raw of matches) {
    const candidate = raw.replace(/[),.;]+$/, '')
    if (!validOpenUrl(candidate)) continue
    if (/\/callback\b/i.test(candidate)) continue
    if (/accounts\.|verif|authorize|oauth/i.test(candidate)) return candidate
    if (!fallback) fallback = candidate
  }
  return fallback
}

/** Metadata only — access/refresh tokens stay in the file. */
export function readAuthState(homeDir = os.homedir()) {
  const file = authPathFor(homeDir)
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { present: false, loggedIn: false, expired: false, needsLogin: true, openId: '', accessExpiresAt: null, refreshExpiresAt: null, tokenSource: '', path: file }
  }
  let tokens = null
  try {
    tokens = JSON.parse(raw)
  } catch {
    return { present: true, loggedIn: false, expired: true, needsLogin: true, openId: '', accessExpiresAt: null, refreshExpiresAt: null, tokenSource: '', path: file, detail: '登录文件无法解析' }
  }
  const now = Date.now() / 1000
  const access = Number(tokens?.expires_at) || 0
  const refresh = Number(tokens?.refresh_expires_at) || 0
  const refreshExpired = !refresh || now >= refresh - 60
  const accessExpired = !access || now >= access - 60
  return {
    present: true,
    loggedIn: Boolean(tokens?.access_token) && !refreshExpired,
    expired: refreshExpired,
    needsLogin: refreshExpired,
    accessExpired,
    openId: maskOpenId(tokens?.open_id),
    accessExpiresAt: access || null,
    refreshExpiresAt: refresh || null,
    tokenSource: typeof tokens?.token_source === 'string' ? tokens.token_source : '',
    path: file
  }
}

export function maskOpenId(value) {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 6) return `${text.slice(0, 2)}****`
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

/**
 * 只给 Host 内部读文档用：返回未过期的 access token，过期/缺失返回空串。
 * 绝不通过路由返回、不写日志；调用方只在 HTTPS 请求头里使用。
 */
export function readAccessToken(homeDir = os.homedir()) {
  try {
    const tokens = JSON.parse(fs.readFileSync(authPathFor(homeDir), 'utf8'))
    const token = typeof tokens?.access_token === 'string' ? tokens.access_token : ''
    const expires = Number(tokens?.expires_at) || 0
    if (!token || !expires || Date.now() / 1000 >= expires - 60) return ''
    return token
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ patch */

export function entryPresent(text) {
  return /(^|\n)[ \t]*-[ \t]*id:[ \t]*mcp-feishu-pro[ \t]*(#.*)?(\n|$)/.test(String(text || ''))
}

export function foreignFeishuEntry(text) {
  const body = String(text || '')
  if (!/(^|\n)[ \t]*serverName:[ \t]*['"]?feishu['"]?[ \t]*(#.*)?(\n|$)/.test(body)) return ''
  if (entryPresent(body)) return ''
  const ids = [...body.matchAll(/(^|\n)[ \t]*-[ \t]*id:[ \t]*([A-Za-z0-9._-]+)/g)].map((match) => match[2])
  return ids.find((id) => id !== FEISHU_ENTRY_ID) || 'unknown'
}

/** True when the text is a YAML sequence (or only comments), safe to append to. */
export function patchAppendable(text) {
  const body = String(text || '')
  if (!body.trim()) return true
  for (const row of body.split('\n')) {
    const line = row.trim()
    if (!line || line.startsWith('#')) continue
    return line.startsWith('-') || line.startsWith('[')
  }
  return true
}

function yamlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function renderEntryBlock({ command, args = [], envPath = '', npmCache = '', version = '' }) {
  const lines = [
    FEISHU_MARKER,
    '- insert:',
    `    - id: ${FEISHU_ENTRY_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${FEISHU_SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${yamlString(command)}`
  ]
  if (args.length) {
    lines.push('        args:')
    for (const arg of args) lines.push(`          - ${yamlString(arg)}`)
  } else {
    lines.push('        args: []')
  }
  if (envPath || npmCache) {
    lines.push('        env:')
    if (envPath) lines.push(`          PATH: ${yamlString(envPath)}`)
    // npm's default cache can be owned by another user (sudo npm), which makes
    // every npx run fail with EPERM; a plugin-owned cache keeps this working.
    if (npmCache) lines.push(`          npm_config_cache: ${yamlString(npmCache)}`)
  }
  lines.push('        failOnStartupError: false')
  if (version) lines.push(`        # pinned ${version}`)
  return `${lines.join('\n')}\n`
}

export function insertEntry(text, block) {
  const body = String(text || '')
  if (entryPresent(body)) return { text: body, changed: false, reason: 'present' }
  if (!patchAppendable(body)) return { text: body, changed: false, reason: 'unreadable' }
  const trimmed = body.trim()
  if (!trimmed) return { text: block, changed: true }
  if (trimmed === '[]') return { text: block, changed: true }
  const head = body.replace(/\s*$/, '')
  return { text: `${head}\n\n${block}`, changed: true }
}

export function removeEntry(text) {
  const body = String(text || '')
  const rows = body.split('\n')
  const target = rows.findIndex((row) => /^[ \t]*-[ \t]*id:[ \t]*mcp-feishu-pro[ \t]*$/.test(row))
  if (target < 0) return { text: body, changed: false }
  // Start at the marker comment, else at the unindented `- insert:` row above the id.
  let start = -1
  for (let index = target; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.trim() === FEISHU_MARKER) { start = index; break }
    if (/^-[ \t]/.test(row)) { start = index; break }
  }
  if (start < 0) return { text: body, changed: false }
  // Pull in the marker comment (and any blank line) that precedes the block.
  for (let index = start - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.trim() === FEISHU_MARKER) { start = index; break }
    if (row.trim() && !row.trim().startsWith('#')) break
  }
  // Our nested rows are indented, so the next unindented `- ` row ends the block.
  let end = rows.length
  for (let index = target + 1; index < rows.length; index += 1) {
    if (/^-[ \t]/.test(rows[index])) { end = index; break }
  }
  rows.splice(start, end - start)
  return { text: finalizePatch(rows.join('\n')), changed: true }
}

export function finalizePatch(text) {
  const body = String(text || '')
  const meaningful = body.split('\n').some((row) => {
    const line = row.trim()
    return line && !line.startsWith('#')
  })
  if (!meaningful) return '[]\n'
  return `${body.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`
}

export function readPatchText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function writePatchText(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  let backup = null
  const previous = readPatchText(file)
  if (previous.trim()) {
    backup = `${file}.meetclip-bak-${Date.now()}`
    fs.writeFileSync(backup, previous, { mode: 0o600 })
  }
  const temp = `${file}.meetclip-tmp-${process.pid}`
  fs.writeFileSync(temp, text, { mode: 0o600 })
  fs.renameSync(temp, file)
  return { path: file, backup }
}

/* --------------------------------------------------------------- children */

function childEnv(bins, cacheDir, extra = process.env) {
  const env = {
    ...extra,
    PATH: bins.envPath || extra.PATH || '',
    HOME: os.homedir(),
    npm_config_loglevel: 'error',
    npm_config_update_notifier: 'false'
  }
  if (cacheDir) {
    try { fs.mkdirSync(cacheDir, { recursive: true }) } catch {}
    env.npm_config_cache = cacheDir
  }
  return env
}

export function runCommand(command, args, { env, timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, env, cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || error).trim().slice(-1200)
        const failure = new Error(detail || `命令失败（退出码 ${error.code ?? '?'}）`)
        failure.code = 'command_failed'
        failure.stderr = String(stderr || '')
        failure.stdout = String(stdout || '')
        reject(failure)
        return
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/**
 * Speak just enough MCP over stdio to prove the server answers: initialize,
 * then tools/list. Resolves `{ ok, toolCount, serverInfo }` or `{ ok:false, error }`.
 */
export function probeMcpServer({ command, args, env, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (failure) {
      resolve({ ok: false, error: String(failure?.message || failure) })
      return
    }
    let settled = false
    let buffer = ''
    let log = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch {}
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000).unref?.()
      resolve({ ...result, log: log.slice(-1200) })
    }
    const timer = setTimeout(() => finish({ ok: false, error: '连接超时（60s）' }), timeoutMs)
    const send = (payload) => {
      try { child.stdin.write(`${JSON.stringify(payload)}\n`) } catch {}
    }
    child.once('error', (failure) => finish({ ok: false, error: String(failure?.message || failure) }))
    child.once('exit', (code) => {
      if (!settled) finish({ ok: false, error: `服务进程退出（退出码 ${code}）` })
    })
    child.stderr.on('data', (chunk) => { log = (log + chunk.toString('utf8')).slice(-4000) })
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message = null
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && message.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 1 && message.error) {
          finish({ ok: false, error: message.error?.message || 'initialize 失败' })
        } else if (message.id === 2) {
          if (message.error) {
            finish({ ok: false, error: message.error?.message || 'tools/list 失败' })
          } else {
            const tools = message.result?.tools
            finish({ ok: true, toolCount: Array.isArray(tools) ? tools.length : 0, serverInfo: undefined })
          }
        }
      }
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'meetclip-setup', version: '1' }
      }
    })
  })
}

/* ---------------------------------------------------------------- manager */

export class FeishuManager {
  constructor(settings) {
    this.settings = settings
    this.ctx = null
    this.job = null
    this.child = null
    this.latest = { at: 0, version: '' }
    this.nodeCache = { at: 0, value: '' }
  }

  refresh(settings) {
    this.settings = settings
    this.nodeCache = { at: 0, value: '' }
  }

  // Package name / npm registry come from the plugin config first, then the env
  // vars, and never from a value baked into the published source.
  packageName() {
    const value = this.settings && this.settings.feishuPackage
    return String(value || FEISHU_PACKAGE || '').trim()
  }

  registryUrl() {
    const value = this.settings && this.settings.feishuRegistry
    return String(value || FEISHU_REGISTRY || '').trim()
  }

  packageTarget() {
    const name = this.packageName()
    const registry = this.registryUrl()
    if (!name) {
      throw new Error('尚未配置飞书 MCP 包：请在 cordis.patch.yml 的 meetclip config 里填写 feishuPackage（例如你组织镜像上的 feishu-mcp 包名）')
    }
    return { name, registry }
  }

  attach(ctx) {
    this.ctx = ctx
  }

  homeDir() {
    return dshHome()
  }

  patchPath() {
    return patchPathFor(this.homeDir())
  }

  statePath() {
    return this.settings.feishuStatePath || path.join(this.settings.stateDir, 'feishu.json')
  }

  logPath() {
    return this.settings.feishuLogPath || path.join(this.settings.stateDir, 'feishu.log')
  }

  /** Dedicated npm cache so npx never depends on a possibly root-owned ~/.npm. */
  npmCacheDir() {
    return path.join(this.settings.stateDir, 'npm-cache')
  }

  spawnEnv(bins) {
    return childEnv(bins, this.npmCacheDir())
  }

  /** Both user patch files, so a row written elsewhere still counts as present. */
  layerStates() {
    return patchLayers(this.homeDir()).map((layer) => {
      const text = readPatchText(layer.path)
      return {
        scope: layer.scope,
        path: layer.path,
        text,
        present: entryPresent(text),
        conflict: foreignFeishuEntry(text),
        appendable: patchAppendable(text)
      }
    })
  }

  readState() {
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'))
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  writeState(patch) {
    const next = { ...this.readState(), ...patch }
    try {
      fs.mkdirSync(path.dirname(this.statePath()), { recursive: true })
      fs.writeFileSync(this.statePath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    } catch {}
    return next
  }

  binaries() {
    return resolveBinaries({
      pathValue: process.env.PATH,
      homeDir: os.homedir(),
      nodeOverride: this.settings.feishuNode || null,
      npxOverride: this.settings.feishuNpx || null
    })
  }

  async nodeVersion(node) {
    if (!node) return ''
    if (this.nodeCache.value && Date.now() - this.nodeCache.at < STATUS_CACHE_MS) return this.nodeCache.value
    try {
      const result = await runCommand(node, ['-v'], { timeoutMs: 10_000, env: process.env })
      const version = parseVersion(result.stdout)
      this.nodeCache = { at: Date.now(), value: version }
      return version
    } catch {
      this.nodeCache = { at: Date.now(), value: '' }
      return ''
    }
  }

  liveEntry() {
    try {
      const loader = this.ctx?.get?.('loader')
      if (!loader || typeof loader.entries !== 'function') return null
      for (const entry of loader.entries()) {
        if (entry?.options?.id === FEISHU_ENTRY_ID) return true
      }
      return false
    } catch {
      return null
    }
  }

  async status() {
    const bins = this.binaries()
    const nodeVersion = await this.nodeVersion(bins.node)
    const major = versionMajor(nodeVersion)
    const layers = this.layerStates()
    const presentLayer = layers.find((layer) => layer.present)
    const conflictLayer = layers.find((layer) => layer.conflict)
    const state = this.readState()
    return {
      ok: true,
      package: {
        name: this.packageName(),
        registry: this.registryUrl(),
        configured: Boolean(this.packageName() && this.registryUrl()),
        docUrl: FEISHU_DOC_URL,
        serverName: FEISHU_SERVER_NAME,
        entryId: FEISHU_ENTRY_ID,
        minNodeMajor: FEISHU_MIN_NODE_MAJOR
      },
      runtime: {
        node: bins.node,
        nodeVersion,
        nodeMajor: major,
        nodeOk: Boolean(bins.node) && major >= FEISHU_MIN_NODE_MAJOR,
        npx: bins.npx,
        npxOk: Boolean(bins.npx),
        path: bins.envPath
      },
      dsh: {
        patchPath: presentLayer?.path || this.patchPath(),
        patchScope: presentLayer?.scope || 'home',
        entryId: FEISHU_ENTRY_ID,
        serverName: FEISHU_SERVER_NAME,
        entryPresent: Boolean(presentLayer),
        entryLive: this.liveEntry(),
        conflict: conflictLayer?.conflict || null,
        layers: layers.map((layer) => ({ scope: layer.scope, path: layer.path, entryPresent: layer.present }))
      },
      auth: readAuthState(os.homedir()),
      pinnedVersion: state.version || '',
      installedAt: state.installedAt || null,
      job: this.jobSnapshot()
    }
  }

  jobSnapshot() {
    if (!this.job) return null
    return {
      action: this.job.action,
      state: this.job.state,
      step: this.job.step,
      log: this.job.log.slice(-8000),
      url: this.job.url || '',
      error: this.job.error || '',
      done: Boolean(this.job.done),
      startedAt: this.job.startedAt,
      finishedAt: this.job.finishedAt || null
    }
  }

  step(text) {
    if (this.job) this.job.step = text
    this.appendLog(`→ ${text}`)
  }

  appendLog(line) {
    if (!this.job) return
    this.job.log += `${line}\n`
    if (this.job.log.length > LOG_LIMIT) this.job.log = this.job.log.slice(-LOG_LIMIT)
    try {
      fs.appendFileSync(this.logPath(), `${line}\n`)
    } catch {}
  }

  start(action, options = {}) {
    if (this.job && this.job.state === 'running') {
      const error = new Error('已有飞书任务在进行中，请等它结束或先取消')
      error.status = 409
      throw error
    }
    if (!['install', 'update', 'login', 'logout', 'setup', 'probe'].includes(action)) {
      const error = new Error(`不支持的飞书操作：${action}`)
      error.status = 400
      throw error
    }
    try { fs.mkdirSync(path.dirname(this.logPath()), { recursive: true }) } catch {}
    this.job = {
      action,
      mode: options.mode === 'device' ? 'device' : 'auto',
      state: 'running',
      step: '准备',
      log: '',
      url: '',
      error: '',
      done: false,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.appendLog(`\n=== ${new Date().toISOString()} ${action} ===`)
    this.run(action).catch((failure) => {
      if (!this.job) return
      this.job.state = failure?.code === 'cancelled' ? 'cancelled' : 'error'
      this.job.error = failure?.message || String(failure)
      this.job.done = true
      this.job.finishedAt = Date.now()
      this.appendLog(`❌ ${this.job.error}`)
    })
    return this.jobSnapshot()
  }

  cancel() {
    if (!this.job || this.job.state !== 'running') return false
    try { this.child?.kill('SIGTERM') } catch {}
    this.child = null
    this.job.state = 'cancelled'
    this.job.done = true
    this.job.finishedAt = Date.now()
    this.appendLog('⏹ 已取消')
    return true
  }

  dispose() {
    try { this.child?.kill('SIGTERM') } catch {}
    this.child = null
  }

  async run(action) {
    if (action === 'install') return this.runInstall({ update: false })
    if (action === 'update') return this.runInstall({ update: true })
    if (action === 'login') return this.runLogin()
    if (action === 'logout') return this.runLogout()
    if (action === 'setup') return this.runOfficialSetup()
    return this.runProbe()
  }

  requireBinaries() {
    const bins = this.binaries()
    if (!bins.npx) {
      const error = new Error('没有找到 npx：请先安装 Node.js 20+（或 nvm），装好后回到这里重试；也可以在 cordis.patch.yml 的 meetclip config 里指定 feishuNpx')
      error.code = 'npx_missing'
      throw error
    }
    if (!bins.node) {
      const error = new Error('没有找到 node：请先安装 Node.js 20+（或 nvm），装好后回到这里重试')
      error.code = 'node_missing'
      throw error
    }
    return bins
  }

  async resolveLatest({ fallback = '' } = {}) {
    if (this.latest.version && Date.now() - this.latest.at < LATEST_CACHE_MS) return this.latest.version
    const bins = this.requireBinaries()
    const major = versionMajor(await this.nodeVersion(bins.node))
    if (major && major < FEISHU_MIN_NODE_MAJOR) {
      const error = new Error(`Node 版本过低（${major}），飞书 MCP 需要 ${FEISHU_MIN_NODE_MAJOR} 以上`)
      error.code = 'node_too_old'
      throw error
    }
    this.step('解析飞书 MCP 最新版本')
    const { name, registry } = this.packageTarget()
    let result
    try {
      result = await runCommand(
        bins.npx,
        ['-y', `--registry=${registry}`, `${name}@latest`, '--version'],
        { timeoutMs: 180_000, env: this.spawnEnv(bins) }
      )
    } catch (failure) {
      const detail = String(failure?.message || failure)
      const hint = /EPERM|EACCES/i.test(detail)
        ? 'npm 缓存目录没有写权限（通常是以前用 sudo 装过包），可执行 npm cache clean --force，或换一个可写的 npm 缓存'
        : /EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network|registry/i.test(detail)
          ? '需要能访问 feishuRegistry 指定的 npm 源才能安装（见 INSTALL.md）'
          : '可能是 Node/npx 环境不完整'
      const error = new Error(`无法从配置的 npm 源解析 ${name}：${hint}。原始信息：${detail}`)
      error.code = 'resolve_failed'
      throw error
    }
    const version = parseVersion(result.stdout) || parseVersion(result.stderr)
    if (!version) {
      const error = new Error(`解析版本失败：${(result.stdout || result.stderr || '').trim().slice(-400)}`)
      error.code = 'resolve_failed'
      throw error
    }
    this.latest = { at: Date.now(), version }
    this.appendLog(`✔ 最新版本 ${version}`)
    return version
  }

  writeEntry(version) {
    const bins = this.binaries()
    const layers = this.layerStates()
    const presentLayer = layers.find((layer) => layer.present)
    if (presentLayer) return { changed: false, path: presentLayer.path, scope: presentLayer.scope }
    const conflictLayer = layers.find((layer) => layer.conflict)
    if (conflictLayer) {
      const error = new Error(`已有其他条目占用了 serverName「${FEISHU_SERVER_NAME}」（id: ${conflictLayer.conflict}），请先在 ${conflictLayer.path} 里改名或删除`)
      error.code = 'server_conflict'
      throw error
    }
    const home = layers.find((layer) => layer.scope === 'home')
    if (!home.appendable) {
      const error = new Error(`${home.path} 看起来不是 YAML 序列，已停止写入以免破坏你的配置；请手动编辑后重试`)
      error.code = 'patch_unreadable'
      throw error
    }
    const { name, registry } = this.packageTarget()
    const block = renderEntryBlock({
      command: bins.npx,
      args: ['-y', `--registry=${registry}`, `${name}@${version}`],
      envPath: bins.envPath,
      npmCache: this.npmCacheDir(),
      version
    })
    const next = insertEntry(home.text, block)
    if (!next.changed) return { changed: false, path: home.path }
    const written = writePatchText(home.path, next.text)
    return { changed: true, path: written.path, scope: 'home', backup: written.backup }
  }

  /** Replace our row in one atomic write (used by "检查更新"). */
  rewriteEntry(version) {
    const bins = this.binaries()
    const home = this.layerStates().find((layer) => layer.scope === 'home')
    if (!home.appendable) {
      const error = new Error(`${home.path} 看起来不是 YAML 序列，已停止写入以免破坏你的配置；请手动编辑后重试`)
      error.code = 'patch_unreadable'
      throw error
    }
    const stripped = removeEntry(home.text)
    const conflict = foreignFeishuEntry(stripped.text)
    if (conflict) {
      const error = new Error(`已有其他条目占用了 serverName「${FEISHU_SERVER_NAME}」（id: ${conflict}），请先在 ${home.path} 里改名或删除`)
      error.code = 'server_conflict'
      throw error
    }
    const { name, registry } = this.packageTarget()
    const block = renderEntryBlock({
      command: bins.npx,
      args: ['-y', `--registry=${registry}`, `${name}@${version}`],
      envPath: bins.envPath,
      npmCache: this.npmCacheDir(),
      version
    })
    const next = insertEntry(stripped.text, block)
    if (!next.changed) {
      const error = new Error('改写飞书 MCP 配置失败')
      error.code = 'patch_write_failed'
      throw error
    }
    const written = writePatchText(home.path, next.text)
    return { changed: true, path: written.path, scope: 'home', backup: written.backup }
  }

  removeEntry() {
    const layers = this.layerStates()
    const home = layers.find((layer) => layer.scope === 'home')
    const next = removeEntry(home.text)
    if (!next.changed) {
      const elsewhere = layers.find((layer) => layer.present)
      return { changed: false, path: elsewhere?.path || home.path, scope: elsewhere?.scope || 'home' }
    }
    const written = writePatchText(home.path, next.text)
    return { changed: true, path: written.path, scope: 'home', backup: written.backup }
  }

  async waitLive(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const live = this.liveEntry()
      if (live === null) return null
      if (live) return true
      await sleep(500)
    }
    return false
  }

  async probeVersion(version) {
    const bins = this.binaries()
    const { name, registry } = this.packageTarget()
    const result = await probeMcpServer({
      command: bins.npx,
      args: ['-y', `--registry=${registry}`, `${name}@${version}`],
      env: this.spawnEnv(bins)
    })
    return result
  }

  async runInstall({ update }) {
    const bins = this.requireBinaries()
    this.step('检查 Node 与 npx')
    const nodeVersion = await this.nodeVersion(bins.node)
    this.appendLog(`node: ${bins.node} ${nodeVersion || ''}`.trim())
    this.appendLog(`npx:  ${bins.npx}`)
    if (!nodeVersion) {
      const error = new Error('无法执行 node -v，请确认 Node 安装完整')
      error.code = 'node_broken'
      throw error
    }
    if (versionMajor(nodeVersion) < FEISHU_MIN_NODE_MAJOR) {
      const error = new Error(`Node 版本过低（${nodeVersion}），飞书 MCP 需要 ${FEISHU_MIN_NODE_MAJOR} 以上`)
      error.code = 'node_too_old'
      throw error
    }

    const pinned = this.readState().version || ''
    const version = update || !pinned ? await this.resolveLatest({ fallback: pinned }) : pinned
    if (!update && pinned && version !== pinned) this.appendLog(`✔ 已固定版本 ${version}`)

    this.step(update ? `更新 DSH 配置到 v${version}` : `写入 DSH 配置（v${version}）`)
    const write = update ? this.rewriteEntry(version) : this.writeEntry(version)
    if (write.changed) this.appendLog(`✔ 已写入 ${write.path}`)
    else if (write.scope === 'profile') this.appendLog(`… 配置已在 profile 补丁里（${write.path}），未改写；需要换版本请手动编辑`)
    else this.appendLog(`✔ 配置已存在，跳过写入（${write.path}）`)
    if (write.backup) this.appendLog(`  备份：${write.backup}`)
    this.writeState({ version, installedAt: Date.now(), patchPath: this.patchPath() })

    this.step('等待 DeepSeek Harness 载入配置')
    const live = await this.waitLive(update ? 25_000 : 20_000)
    if (live === true) this.appendLog('✔ 已被 DSH 载入')
    else if (live === false) this.appendLog('… 尚未载入，稍后会自动生效')
    else this.appendLog('… 当前部署无法查询加载状态，重启 DeepSeek Harness 后生效')

    this.step('验证 MCP 连接')
    const probe = await this.probeVersion(version)
    if (probe.ok) {
      this.appendLog(`✔ 已连接，公开 ${probe.toolCount} 个工具`)
      this.writeState({ lastProbe: { ok: true, toolCount: probe.toolCount, at: Date.now() } })
    } else {
      this.appendLog(`⚠ 连接测试未通过：${probe.error || '未知错误'}`)
      if (probe.log) this.appendLog(probe.log.split('\n').slice(-6).join('\n'))
      this.writeState({ lastProbe: { ok: false, error: probe.error || '', at: Date.now() } })
    }

    this.job.state = 'done'
    this.job.done = true
    this.job.finishedAt = Date.now()
    this.step(probe.ok ? '完成' : '配置已写入（连接待确认）')
    this.appendLog(probe.ok ? '✅ 飞书 MCP 已配置' : '⚠ 配置已写入，但连接测试未通过；可稍后在设置里重试')
  }

  async runLogin() {
    const auth = readAuthState(os.homedir())
    if (auth.loggedIn) {
      this.step('已登录')
      this.appendLog(`✔ 已登录${auth.openId ? `（${auth.openId}）` : ''}，无需重复授权`)
      this.finishJob()
      return
    }
    const bins = this.requireBinaries()
    const version = this.readState().version || await this.resolveLatest()
    const mode = this.job.mode === 'device' ? 'device' : 'auto'
    const { name, registry } = this.packageTarget()
    const args = ['-y', `--registry=${registry}`, `${name}@${version}`, 'login']
    if (mode === 'device') args.push('--device')
    this.step(mode === 'device' ? '等待设备码授权' : '等待浏览器授权')
    this.appendLog(`$ npx ${args.join(' ')}`)
    await this.execStream(bins, args, { timeoutMs: DEFAULT_TIMEOUT_MS, watchAuth: true })
    const after = readAuthState(os.homedir())
    if (!after.loggedIn) {
      const error = new Error('授权流程结束了，但没有读到有效登录状态；请重试，或改用设备码登录')
      error.code = 'login_incomplete'
      throw error
    }
    this.appendLog(`✔ 已登录${after.openId ? `（${after.openId}）` : ''}`)
    this.writeState({ loggedInAt: Date.now() })
    this.finishJob()
  }

  async runLogout() {
    const bins = this.requireBinaries()
    const version = this.readState().version || await this.resolveLatest()
    this.step('退出登录')
    const { name, registry } = this.packageTarget()
    this.appendLog(`$ npx ${name}@${version} logout`)
    try {
      await this.execStream(bins, ['-y', `--registry=${registry}`, `${name}@${version}`, 'logout'], { timeoutMs: 120_000 })
    } catch (failure) {
      if (failure?.code === 'cancelled') throw failure
      // The token file is the source of truth; a missing token makes the CLI exit non-zero.
      this.appendLog(`… CLI 返回：${failure?.message || failure}`)
    }
    const after = readAuthState(os.homedir())
    this.appendLog(after.loggedIn ? '⚠ 仍然检测到登录状态' : '✔ 已退出登录')
    this.finishJob()
  }

  async runOfficialSetup() {
    const bins = this.requireBinaries()
    const version = this.readState().version || await this.resolveLatest()
    this.step('运行官方 setup')
    this.appendLog('说明：会写入 ~/.npmrc 的包 scope registry，并改写本机其他编辑器的 MCP 配置。')
    const { name, registry } = this.packageTarget()
    await this.execStream(
      bins,
      ['-y', `--registry=${registry}`, `${name}@${version}`, 'setup'],
      { timeoutMs: DEFAULT_TIMEOUT_MS }
    )
    this.appendLog('✔ 官方 setup 已结束（DSH 部分不需要它，重复运行不会重复写入同一份配置）')
    this.finishJob()
  }

  async runProbe() {
    const bins = this.requireBinaries()
    const version = this.readState().version || await this.resolveLatest()
    this.step('验证 MCP 连接')
    const probe = await this.probeVersion(version)
    if (!probe.ok) {
      const error = new Error(probe.error || '连接测试未通过')
      error.code = 'probe_failed'
      if (probe.log) this.appendLog(probe.log.split('\n').slice(-6).join('\n'))
      throw error
    }
    this.appendLog(`✔ 已连接，公开 ${probe.toolCount} 个工具`)
    this.finishJob()
  }

  finishJob() {
    if (!this.job) return
    this.job.state = 'done'
    this.job.done = true
    this.job.finishedAt = Date.now()
    this.step('完成')
  }

  async execStream(bins, args, { timeoutMs = DEFAULT_TIMEOUT_MS, watchAuth = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(bins.npx, args, { env: this.spawnEnv(bins), stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      let settled = false
      let authWatcher = null
      const cleanup = () => {
        if (authWatcher) clearInterval(authWatcher)
        authWatcher = null
        this.child = null
      }
      const done = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        cleanup()
        if (this.job?.state === 'cancelled') {
          const cancelled = new Error('已取消')
          cancelled.code = 'cancelled'
          reject(cancelled)
          return
        }
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
        done(new Error(`执行超时（${Math.round(timeoutMs / 1000)}s）：${this.job?.step || ''}`))
      }, timeoutMs)
      const onData = (chunk) => {
        const text = chunk.toString('utf8')
        for (const line of text.split('\n')) {
          if (line.trim()) this.appendLog(line.trim())
        }
        const url = extractAuthUrl(text)
        if (url && this.job) this.job.url = url
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('error', (failure) => done(new Error(`无法启动命令：${failure?.message || failure}`)))
      child.once('exit', (code) => {
        if (code === 0) return done()
        done(new Error(`命令退出码 ${code}${this.job?.url ? `（授权链接：${this.job.url}）` : ''}`))
      })
      if (watchAuth) {
        authWatcher = setInterval(() => {
          const state = readAuthState(os.homedir())
          if (!state.loggedIn) return
          if (this.job) {
            this.job.url = ''
            this.step('已获取授权，正在校验')
          }
        }, 1000)
        authWatcher.unref?.()
      }
    })
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
