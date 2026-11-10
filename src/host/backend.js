import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ensureDir, readApiToken, readLogTail } from './config.js'
import { jsonResponse } from './http.js'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
])

export class BackendError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export class BackendManager {
  constructor(settings) {
    this.settings = settings
    this.state = 'stopped'
    this.phase = 'stopped'
    this.attached = false
    this.managed = false
    this.child = null
    this.pid = null
    this.lastError = ''
    this.version = null
    this.starting = null
    this.stopping = false
    this.wasHealthy = false
    this.restarts = []
    this.logs = []
    this.disposed = false
  }

  refresh(settings) {
    this.settings = settings
  }

  status() {
    return {
      state: this.state,
      phase: this.phase,
      mode: this.attached ? 'attached' : this.managed ? 'managed' : 'stopped',
      port: this.settings.port,
      pid: this.pid,
      version: this.version,
      lastError: this.lastError,
      dataDir: this.settings.dataDir,
      tokenPresent: Boolean(readApiToken(this.settings.tokenPath)),
      restarts: this.restarts.length
    }
  }

  logTail(lines = 80) {
    if (this.logs.length > 0) return this.logs.slice(-lines).join('\n')
    return readLogTail(this.settings.logPath, lines)
  }

  async probe(timeoutMs = 2000) {
    const url = `http://127.0.0.1:${this.settings.port}/api/health`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      const text = await response.text()
      let data = null
      try { data = JSON.parse(text) } catch {}
      if (response.status === 200 && data && data.app === 'meetclip' && Number(data.protocol) >= 3) {
        return { kind: 'current', data }
      }
      return { kind: 'foreign', status: response.status, body: text.slice(0, 200) }
    } catch (error) {
      if (error?.name === 'AbortError') return { kind: 'unknown', error: 'timeout' }
      if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return { kind: 'none' }
      return { kind: 'unknown', error: error?.message || String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  async ensure() {
    if (this.disposed) throw new BackendError('disposed', '会摘后端管理器已停止')
    if (this.state === 'running' && !this.attached && this.child) return this.status()
    if (this.starting) return this.starting
    this.starting = this._ensure().finally(() => { this.starting = null })
    return this.starting
  }

  async _ensure() {
    if (this.state === 'running') return this.status()
    const probe = await this.probe()
    if (probe.kind === 'current') {
      await this.adopt(probe.data)
      return this.status()
    }
    if (probe.kind === 'foreign') {
      throw new BackendError('port_foreign', `端口 ${this.settings.port} 已被其他程序占用`, probe.body)
    }
    if (probe.kind === 'unknown') {
      throw new BackendError('port_unknown', `端口 ${this.settings.port} 无响应或正在启动`, probe.error)
    }
    if (this.settings.backendMode === 'external') {
      throw new BackendError('external_down', '后端由外部管理，但当前未运行', this.settings.port)
    }
    return this.spawn()
  }

  async adopt(health) {
    const reported = health?.data_dir ? path.resolve(String(health.data_dir)) : null
    const expected = path.resolve(this.settings.dataDir)
    if (reported && reported !== expected) {
      throw new BackendError(
        'data_dir_mismatch',
        `端口 ${this.settings.port} 上的后端使用数据目录 ${reported}，与插件配置 ${expected} 不一致`,
        { reported, expected }
      )
    }
    this.attached = true
    this.managed = false
    this.state = 'running'
    this.phase = 'attached'
    this.pid = Number.isInteger(health?.pid) ? health.pid : null
    this.version = Number.isInteger(health?.protocol) ? health.protocol : null
    this.lastError = ''
    this.wasHealthy = true
    if (!readApiToken(this.settings.tokenPath)) {
      throw new BackendError('token_missing', '已连接后端，但读取不到本地 API 凭证', this.settings.tokenPath)
    }
    return this.status()
  }

  async spawn() {
    if (this.settings.backendMode === 'external') {
      throw new BackendError('external_mode', '当前为外部后端模式，插件不会自行启动')
    }
    ensureDir(this.settings.stateDir)
    ensureDir(this.settings.dataDir)
    const python = this.settings.python || this.settings.venvPython
    if (!fs.existsSync(python)) {
      throw new BackendError('no_env', '尚未安装独立的 Python 运行环境', python)
    }
    if (!fs.existsSync(path.join(this.settings.backendAppDir, 'main.py'))) {
      throw new BackendError('no_backend', '插件包内缺少后端源码', this.settings.backendAppDir)
    }

    this.stopping = false
    this.state = 'starting'
    this.phase = 'spawning'
    this.lastError = ''
    this.attached = false
    this.managed = true

    const args = [
      '-m', 'uvicorn', 'main:app',
      '--app-dir', 'app',
      '--host', '127.0.0.1',
      '--port', String(this.settings.port),
      '--no-proxy-headers'
    ]
    const logStream = fs.createWriteStream(this.settings.logPath, { flags: 'a' })
    logStream.write(`\n=== ${new Date().toISOString()} start ${python} ${args.join(' ')} ===\n`)
    let child
    try {
      child = spawn(python, args, {
        cwd: this.settings.backendRoot,
        env: this.buildEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      this.state = 'error'
      this.phase = 'spawn_failed'
      this.lastError = error?.message || String(error)
      throw new BackendError('spawn_failed', this.lastError)
    }

    this.child = child
    this.pid = child.pid
    this.writePidFile()
    const capture = (chunk) => {
      const text = chunk.toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        this.logs.push(line)
        if (this.logs.length > 300) this.logs.shift()
      }
    }
    child.stdout.on('data', (chunk) => { capture(chunk); logStream.write(chunk) })
    child.stderr.on('data', (chunk) => { capture(chunk); logStream.write(chunk) })
    child.once('exit', (code, signal) => this.onExit(code, signal))
    child.once('error', (error) => {
      this.lastError = error?.message || String(error)
      this.logs.push(`spawn error: ${this.lastError}`)
    })

    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await delay(400)
      if (child.exitCode !== null) break
      const probe = await this.probe(1500)
      if (probe.kind === 'current') {
        const reported = probe.data?.data_dir ? path.resolve(String(probe.data.data_dir)) : null
        if (reported && reported !== path.resolve(this.settings.dataDir)) {
          this.lastError = `后端报告的数据目录 ${reported} 与配置 ${this.settings.dataDir} 不一致`
          this.state = 'error'
          this.phase = 'data_dir_mismatch'
          await this.stop()
          throw new BackendError('data_dir_mismatch', this.lastError)
        }
        this.state = 'running'
        this.phase = 'ready'
        this.version = Number(probe.data?.protocol) || null
        this.pid = Number.isInteger(probe.data?.pid) ? probe.data.pid : child.pid
        this.wasHealthy = true
        this.lastError = ''
        if (!readApiToken(this.settings.tokenPath)) {
          this.state = 'error'
          this.phase = 'token_missing'
          this.lastError = '后端已启动但未生成 API 凭证'
          throw new BackendError('token_missing', this.lastError, this.settings.tokenPath)
        }
        return this.status()
      }
    }

    this.state = 'error'
    this.phase = 'start_failed'
    this.lastError = this.lastError || '本地引擎启动超时'
    try { child.kill('SIGKILL') } catch {}
    throw new BackendError('start_failed', this.lastError, this.logTail(40))
  }

  onExit(code, signal) {
    const wasManaged = this.managed
    this.child = null
    this.pid = null
    this.removePidFile()
    if (this.stopping || this.disposed) {
      this.state = 'stopped'
      this.phase = 'stopped'
      this.managed = false
      this.wasHealthy = false
      return
    }
    this.state = 'error'
    this.phase = 'exited'
    this.lastError = `本地引擎退出（code=${code ?? '-'} signal=${signal ?? '-'}）`
    this.logs.push(this.lastError)
    if (wasManaged && this.wasHealthy && this.settings.backendMode !== 'external') {
      const now = Date.now()
      this.restarts = this.restarts.filter((time) => now - time < 10 * 60 * 1000)
      if (this.restarts.length < 3) {
        this.restarts.push(now)
        setTimeout(() => {
          if (this.disposed || this.stopping) return
          this.state = 'stopped'
          this.spawn().catch((error) => {
            this.state = 'error'
            this.phase = 'restart_failed'
            this.lastError = error?.message || String(error)
          })
        }, 1200)
      }
    }
    this.wasHealthy = false
  }

  async stop() {
    const child = this.child
    this.stopping = true
    if (!child) {
      this.attached = false
      this.managed = false
      this.state = 'stopped'
      this.phase = 'stopped'
      this.pid = null
      this.removePidFile()
      return this.status()
    }
    try { child.kill('SIGINT') } catch {}
    const exited = await waitForExit(child, 10_000)
    if (!exited) {
      try { child.kill('SIGKILL') } catch {}
      await waitForExit(child, 2_000)
    }
    this.child = null
    this.pid = null
    this.managed = false
    this.attached = false
    this.state = 'stopped'
    this.phase = 'stopped'
    this.removePidFile()
    return this.status()
  }

  async restart() {
    await this.stop()
    this.stopping = false
    this.restarts = []
    return this.ensure()
  }

  async request(pathname, init = {}) {
    await this.ensure()
    const token = readApiToken(this.settings.tokenPath)
    if (!token) throw new BackendError('token_missing', '本地 API 凭证不存在')
    const headers = new Headers(init.headers || {})
    headers.set('X-MeetClip-Token', token)
    const response = await fetch(`http://127.0.0.1:${this.settings.port}${pathname}`, {
      ...init,
      headers,
      cache: 'no-store'
    })
    return response
  }

  async json(pathname, init = {}) {
    const response = await this.request(pathname, init)
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!response.ok) {
      const message = (data && (data.detail || data.message)) || `HTTP ${response.status}`
      const error = new BackendError('backend_http', String(message), data)
      error.status = response.status
      throw error
    }
    return data
  }

  async forward(req, res) {
    try {
      await this.ensure()
    } catch (error) {
      jsonResponse(res, 503, {
        detail: error?.message || '本地引擎未运行',
        code: error?.code || 'backend_down',
        hint: error?.detail
      })
      return
    }
    const token = readApiToken(this.settings.tokenPath)
    if (!token) {
      jsonResponse(res, 503, { detail: '本地 API 凭证不存在', code: 'token_missing' })
      return
    }
    let incoming
    try {
      incoming = new URL(req.url, 'http://127.0.0.1')
    } catch {
      jsonResponse(res, 400, { detail: '无效请求路径' })
      return
    }
    const suffix = incoming.pathname.startsWith('/meetclip/api')
      ? incoming.pathname.slice('/meetclip/api'.length)
      : incoming.pathname
    if (!suffix.startsWith('/')) {
      jsonResponse(res, 404, { detail: 'not found' })
      return
    }
    const upstreamPath = `/api${suffix}${incoming.search}`
    const headers = { ...req.headers }
    for (const key of Object.keys(headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) delete headers[key]
    }
    headers.host = `127.0.0.1:${this.settings.port}`
    headers['x-meetclip-token'] = token

    const upstream = http.request({
      host: '127.0.0.1',
      port: this.settings.port,
      method: req.method,
      path: upstreamPath,
      headers
    }, (upstreamRes) => {
      if (res.headersSent) return
      const responseHeaders = {}
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
        responseHeaders[key] = value
      }
      const contentType = String(upstreamRes.headers['content-type'] || '')
      if (contentType.includes('text/event-stream')) {
        responseHeaders['cache-control'] = 'no-cache, no-transform'
        responseHeaders['x-accel-buffering'] = 'no'
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        jsonResponse(res, 502, { detail: `本地引擎连接失败：${error?.message || error}`, code: 'backend_unreachable' })
      } else {
        try { res.end() } catch {}
      }
    })
    res.on('close', () => {
      if (!res.writableEnded) {
        try { upstream.destroy() } catch {}
      }
    })
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      req.resume()
      upstream.end()
    } else {
      req.pipe(upstream)
    }
  }

  buildEnv() {
    const env = {
      PATH: [
        path.join(this.settings.stateDir, 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin'
      ].join(':'),
      HOME: process.env.HOME || '',
      LANG: process.env.LANG || 'zh_CN.UTF-8',
      TMPDIR: process.env.TMPDIR || '/tmp',
      ZHIBO_DATA_DIR: this.settings.dataDir,
      ZHIBO_BIN_DIR: path.join(this.settings.stateDir, 'bin'),
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1'
    }
    // 多资料空间：账号与通用设置只存一份，后端通过这个变量读共享目录。
    // 没启用共享时绝不注入，保证单库安装与外部引擎行为不变。
    if (this.settings.sharedDir) env.MEETCLIP_SHARED_DIR = this.settings.sharedDir
    if (fs.existsSync('/etc/ssl/cert.pem')) env.SSL_CERT_FILE = '/etc/ssl/cert.pem'
    return env
  }

  writePidFile() {
    try {
      ensureDir(this.settings.stateDir)
      fs.writeFileSync(this.settings.pidPath, JSON.stringify({
        pid: this.pid,
        port: this.settings.port,
        dataDir: this.settings.dataDir,
        startedAt: Date.now()
      }), { mode: 0o600 })
    } catch {}
  }

  removePidFile() {
    try { fs.rmSync(this.settings.pidPath, { force: true }) } catch {}
  }

  async dispose() {
    this.disposed = true
    if (this.managed && this.child) await this.stop()
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
