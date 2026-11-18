/**
 * 运行环境自举：不假设这台机器上有 Python、Homebrew，也不假设能连上 GitHub。
 *
 * 两条国内可达的链路，按顺序试，任何一步失败都继续下一条：
 *   1. PyPI 镜像（清华 / 阿里 / 官方）→ uv 的 wheel（wheel 里带的 uv 二进制直接用，
 *      不需要先有 Python）、后端依赖的 wheel。
 *   2. npmmirror 的 python-build-standalone → 独立 CPython 3.12（连 uv 都装不上时的兜底，
 *      解压即用，不写系统目录、不需要管理员密码）。
 *
 * 所有下载地址都可以用环境变量覆盖，便于内网部署：
 *   MEETCLIP_PYPI_MIRROR     逗号分隔的 PyPI 镜像根（默认 清华/阿里/官方）
 *   MEETCLIP_PYTHON_MIRROR   逗号分隔的 python-build-standalone 镜像根（默认 npmmirror）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { ensureDir } from './config.js'

const USER_AGENT = 'meetclip-bootstrap/1.0'
const PYTHON_SERIES = '3.12'

export const DEFAULT_PYPI_INDEXES = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.org/simple'
]

export const DEFAULT_PYTHON_MIRRORS = [
  'https://registry.npmmirror.com/-/binary/python-build-standalone'
]

function listFromEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw || !raw.trim()) return fallback
  const list = raw.split(',').map((row) => row.trim()).filter(Boolean)
  return list.length ? list : fallback
}

export function pypiIndexes() {
  return listFromEnv('MEETCLIP_PYPI_MIRROR', DEFAULT_PYPI_INDEXES)
}

export function pythonMirrors() {
  return listFromEnv('MEETCLIP_PYTHON_MIRROR', DEFAULT_PYTHON_MIRRORS)
}

export function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url)
  }
}

// ---------- 纯函数：挑资产（单测覆盖） ----------

export function compareVersions(left, right) {
  const a = String(left).split('.').map((row) => Number(row) || 0)
  const b = String(right).split('.').map((row) => Number(row) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0)
    if (diff) return diff > 0 ? 1 : -1
  }
  return 0
}

function wheelArchOf(arch) {
  return arch === 'x64' ? 'x86_64' : 'arm64'
}

function standalonePlatformOf(arch) {
  return arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'
}

/**
 * 从 PyPI 项目页的 HTML 里挑最新一个 macOS 平台的 uv wheel。
 *
 * 用页面里的相对链接解析成绝对地址：镜像站的 href 常写成 ../../packages/xx/yy/……，
 * 直接拼会错；也不要相信"最新版本号"，各镜像同步进度不同，取它自己页面上最大的那个。
 */
export function parseUvWheel(page, pageUrl, arch = process.arch) {
  const suffix = wheelArchOf(arch)
  const pattern = new RegExp(
    `href="([^"]*?uv-(\\d+(?:\\.\\d+)+)-py3-none-macosx_\\d+_\\d+_${suffix}\\.whl)(?:#[^"]*)?"`,
    'g'
  )
  let best = null
  for (const match of String(page || '').matchAll(pattern)) {
    const version = match[2]
    if (!best || compareVersions(version, best.version) > 0) best = { version, href: match[1] }
  }
  if (!best) return null
  try {
    return { version: best.version, url: new URL(best.href, pageUrl).href }
  } catch {
    return null
  }
}

/** npmmirror 的目录列表里，release 目录（20250818 这类）按名字倒序就是由新到旧。 */
export function pickStandaloneReleases(entries, limit = 4) {
  const names = (Array.isArray(entries) ? entries : [])
    .filter((row) => row && row.name && /^\d{8}$/.test(String(row.name).replace(/\/$/, '')))
    .map((row) => String(row.name).replace(/\/$/, ''))
  return [...new Set(names)].sort().reverse().slice(0, limit)
}

/**
 * 在某个 release 目录里挑 cpython-3.12.x-<platform>-install_only.tar.gz。
 *
 * 只要 install_only（自带 pip，解压即用），不要 stripped / debug / pgo 那些变体。
 */
export function pickPythonAsset(entries, { arch = process.arch, series = PYTHON_SERIES } = {}) {
  const platform = standalonePlatformOf(arch)
  const pattern = new RegExp(
    `^cpython-${series.replace(/\./g, '\\.')}\\.(\\d+)\\+[^/]*?-${platform}-install_only\\.tar\\.gz$`
  )
  let best = null
  for (const row of (Array.isArray(entries) ? entries : [])) {
    const name = String(row?.name || '')
    const match = pattern.exec(name)
    if (!match) continue
    const version = `${series}.${match[1]}`
    if (!best || compareVersions(version, best.version) > 0) {
      best = { name, version, url: row.url || '', size: Number(row.size) || 0 }
    }
  }
  return best
}

// ---------- HTTP ----------

function openUrl(url, { timeoutMs = 60_000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`地址不合法：${url}`))
      return
    }
    const client = parsed.protocol === 'http:' ? http : https
    const request = client.get(parsed, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
      const status = response.statusCode || 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        if (redirects <= 0) {
          reject(new Error(`重定向过多：${url}`))
          return
        }
        const next = new URL(response.headers.location, url).href
        openUrl(next, { timeoutMs, redirects: redirects - 1 }).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`HTTP ${status}：${url}`))
        return
      }
      resolve(response)
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`连接超时：${hostOf(url)}`)))
    request.on('error', (error) => reject(new Error(`${error?.message || error}：${url}`)))
  })
}

export async function fetchText(url, { timeoutMs = 60_000, limit = 4 * 1024 * 1024 } = {}) {
  const response = await openUrl(url, { timeoutMs })
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    response.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        response.destroy(new Error(`响应过大：${url}`))
        return
      }
      chunks.push(chunk)
    })
    response.on('error', (error) => reject(new Error(`${error?.message || error}：${url}`)))
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function megabytes(bytes) {
  const value = Number(bytes) || 0
  if (!value) return ''
  return `${(value / 1024 / 1024).toFixed(1)}MB`
}

export function progressReporter(log, label, minStep = 10) {
  let last = 0
  return (received, total) => {
    const percent = total ? Math.floor((received / total) * 100) : 0
    if (!total) return
    if (percent - last < minStep && percent < 100) return
    last = percent
    log?.(`  ${label} ${percent}%  ${megabytes(received)} / ${megabytes(total)}`)
  }
}

export async function downloadToFile(url, dest, { onProgress, cancel, timeoutMs = 15 * 60_000 } = {}) {
  if (cancel?.aborted) throw new Error('已取消')
  ensureDir(path.dirname(dest))
  const part = `${dest}.part`
  const response = await openUrl(url, { timeoutMs })
  const total = Number(response.headers['content-length'] || 0)
  const size = await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part)
    let received = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      try { out.destroy() } catch {}
      try { response.destroy() } catch {}
      try { fs.unlinkSync(part) } catch {}
      reject(error)
    }
    response.on('data', (chunk) => {
      received += chunk.length
      if (cancel?.aborted) {
        fail(new Error('已取消'))
        return
      }
      onProgress?.(received, total)
    })
    response.on('error', (error) => fail(new Error(`${error?.message || error}：${url}`)))
    out.on('error', (error) => fail(error))
    out.on('finish', () => {
      if (settled) return
      settled = true
      try {
        fs.renameSync(part, dest)
      } catch (error) {
        reject(error)
        return
      }
      resolve(received)
    })
    response.pipe(out)
  })
  return size
}

// ---------- 子进程 ----------

function runCapture(command, args, { env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { env: { ...process.env, ...(env || {}) } })
    } catch (error) {
      resolve({ code: -1, output: String(error?.message || error) })
      return
    }
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk })
    child.stderr?.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, output: String(error?.message || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

function runLogged(command, args, { env, log, onChild, cancel, cwd, timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    log?.(`$ ${path.basename(command)} ${args.join(' ')}`)
    let child
    try {
      child = spawn(command, args, { env: { ...process.env, ...(env || {}) }, cwd })
    } catch (error) {
      reject(new Error(`${path.basename(command)} 启动失败：${error?.message || error}`))
      return
    }
    onChild?.(child)
    const tail = []
    const onData = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        log?.(line)
        tail.push(line)
        if (tail.length > 40) tail.shift()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    let timedOut = false
    const watcher = setInterval(() => {
      if (cancel?.aborted) {
        try { child.kill('SIGTERM') } catch {}
      }
    }, 400)
    const deadline = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3000)
    }, timeoutMs)
    child.on('error', (error) => {
      clearInterval(watcher)
      clearTimeout(deadline)
      onChild?.(null)
      reject(new Error(`${path.basename(command)} 启动失败：${error?.message || error}`))
    })
    child.on('close', (code) => {
      clearInterval(watcher)
      clearTimeout(deadline)
      onChild?.(null)
      if (timedOut) {
        reject(new Error(`${path.basename(command)} 超时（${Math.round(timeoutMs / 60000)} 分钟）`))
        return
      }
      if (cancel?.aborted) {
        reject(new Error('已取消'))
        return
      }
      if (code === 0) {
        resolve(tail.join('\n'))
        return
      }
      reject(new Error(`${path.basename(command)} 退出码 ${code}：${tail.slice(-4).join(' ')}`))
    })
  })
}

// ---------- 解释器探测 ----------

export function findExecutable(name) {
  const paths = [
    process.env.PATH || '',
    path.join(os.homedir(), 'bin'),
    path.join(os.homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ].join(':').split(':').filter(Boolean)
  for (const dir of paths) {
    const candidate = path.join(dir, name)
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

export function pythonVersion(python) {
  return new Promise((resolve) => {
    runCapture(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { timeoutMs: 10_000 })
      .then(({ code, output }) => resolve(code === 0 ? String(output).trim() : ''))
      .catch(() => resolve(''))
  })
}

function isUsablePython(version) {
  const [major, minor] = String(version || '').split('.').map(Number)
  return major > 3 || (major === 3 && minor >= 10)
}

export async function findBasePython(settings = {}) {
  const candidates = [
    settings.python,
    settings.venvPython,
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10',
    '/usr/local/bin/python3.13',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3.10',
    findExecutable('python3.13'),
    findExecutable('python3.12'),
    findExecutable('python3.11'),
    findExecutable('python3.10'),
    findExecutable('python3')
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const version = await pythonVersion(candidate)
    if (isUsablePython(version)) return candidate
  }
  return null
}

// ---------- 安装步骤 ----------

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function downloadsDir(stateDir) {
  const dir = path.join(stateDir, 'downloads')
  ensureDir(dir)
  return dir
}

/**
 * 保证有 uv 可用：先用系统里的，其次用上次自举留下的，最后从 PyPI 镜像取 wheel 解出二进制。
 *
 * wheel 里 uv-<ver>.data/scripts/uv 就是可执行文件本身，比走 GitHub Release 稳；
 * 内网/断网时这里失败不影响后面的独立 CPython 兜底。
 */
export async function ensureUv({ stateDir, binDir, log, onChild, cancel } = {}) {
  if (!stateDir || !binDir) return null
  const existing = findExecutable('uv')
  if (existing) {
    log?.(`使用已有 uv：${existing}`)
    return { path: existing, source: 'system' }
  }
  const bundled = path.join(binDir, 'uv')
  if (isExecutableFile(bundled)) {
    log?.(`使用上次下载的 uv：${bundled}`)
    return { path: bundled, source: 'bundled' }
  }
  const errors = []
  for (const index of pypiIndexes()) {
    const pageUrl = `${index.replace(/\/+$/, '')}/uv/`
    try {
      const page = await fetchText(pageUrl)
      const wheel = parseUvWheel(page, pageUrl)
      if (!wheel) {
        errors.push(`${hostOf(index)} 上没有 macOS wheel`)
        continue
      }
      log?.(`从 ${hostOf(wheel.url)} 下载 uv ${wheel.version}`)
      const archive = path.join(downloadsDir(stateDir), `uv-${wheel.version}.whl`)
      await downloadToFile(wheel.url, archive, {
        cancel,
        onProgress: progressReporter(log, 'uv', 25)
      })
      const staging = path.join(downloadsDir(stateDir), `uv-${wheel.version}`)
      removeDir(staging)
      ensureDir(staging)
      await runLogged('unzip', ['-o', '-q', archive, '-d', staging], {
        log, onChild, cancel, timeoutMs: 5 * 60_000
      })
      const script = findUvScript(staging)
      if (!script) throw new Error('wheel 里没有 uv 可执行文件')
      ensureDir(binDir)
      fs.copyFileSync(script, bundled)
      fs.chmodSync(bundled, 0o755)
      const probe = await runCapture(bundled, ['--version'], { timeoutMs: 30_000 })
      if (probe.code !== 0) throw new Error(`解出的 uv 无法运行：${probe.output.slice(0, 200)}`)
      log?.(`uv 已就绪：${probe.output.trim()}`)
      removeDir(staging)
      return { path: bundled, source: 'downloaded' }
    } catch (error) {
      errors.push(`${hostOf(index)}：${error?.message || error}`)
      log?.(`从 ${hostOf(index)} 获取 uv 失败：${error?.message || error}`)
    }
  }
  log?.(`uv 自动安装未成功（${errors.slice(-2).join('；')}），改用独立 Python`)
  return null
}

export function findUvScript(root) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (entry.name === 'uv' && /\.data[\\/]scripts$/.test(dir)) return full
    }
  }
  return null
}

/** 连 uv 都拿不到时，直接下 python-build-standalone 的 install_only 包，解压即用。 */
export async function installPythonStandalone({ stateDir, log, onChild, cancel } = {}) {
  const dest = path.join(stateDir, 'python-standalone')
  const python = path.join(dest, 'python', 'bin', `python${PYTHON_SERIES}`)
  if (isExecutableFile(python)) {
    log?.(`使用上次下载的 Python：${python}`)
    return python
  }
  const errors = []
  for (const mirror of pythonMirrors()) {
    const root = mirror.replace(/\/+$/, '')
    try {
      log?.(`查询 ${hostOf(mirror)} 上的 Python 3.12`)
      const listing = JSON.parse(await fetchText(`${root}/`))
      const releases = pickStandaloneReleases(listing)
      if (!releases.length) throw new Error('镜像上没有可用版本目录')
      for (const release of releases) {
        const files = JSON.parse(await fetchText(`${root}/${release}/`))
        const asset = pickPythonAsset(files)
        if (!asset || !asset.url) continue
        log?.(`从 ${hostOf(asset.url)} 下载 CPython ${asset.version}（${megabytes(asset.size) || '未知大小'}）`)
        const archive = path.join(downloadsDir(stateDir), asset.name)
        await downloadToFile(asset.url, archive, {
          cancel,
          onProgress: progressReporter(log, 'CPython', 10)
        })
        const staging = path.join(downloadsDir(stateDir), `python-${release}`)
        removeDir(staging)
        ensureDir(staging)
        try {
          await runLogged('tar', ['-xzf', archive, '-C', staging], {
            log, onChild, cancel, timeoutMs: 10 * 60_000
          })
          removeDir(dest)
          fs.renameSync(staging, dest)
          try { fs.unlinkSync(archive) } catch {}
          if (isExecutableFile(python)) {
            log?.(`独立 Python 已就绪：${python}`)
            return python
          }
          throw new Error('解压后找不到 python 可执行文件')
        } finally {
          removeDir(staging)
        }
      }
    } catch (error) {
      errors.push(`${hostOf(mirror)}：${error?.message || error}`)
      log?.(`从 ${hostOf(mirror)} 获取 Python 失败：${error?.message || error}`)
    }
  }
  throw new Error(`无法自动下载 Python 3.12（${errors.slice(-2).join('；')}）`)
}

export async function createVenv({ uvPath, pythonPath, venvDir, stateDir, log, onChild, cancel } = {}) {
  const venvPython = path.join(venvDir, 'bin', 'python3')
  if (fs.existsSync(venvPython)) return 'existing'
  // 残留的半成品目录会让 uv 直接报"已存在"，清掉重来
  if (fs.existsSync(venvDir) && !fs.existsSync(venvPython)) removeDir(venvDir)
  ensureDir(path.dirname(venvDir))
  if (uvPath) {
    const attempts = [...pythonMirrors().map((mirror) => ({ mirror })), { mirror: '' }]
    const errors = []
    for (const attempt of attempts) {
      try {
        const env = {
          UV_CACHE_DIR: path.join(stateDir, 'uv-cache'),
          UV_PYTHON_INSTALL_DIR: path.join(stateDir, 'uv-python'),
          UV_HTTP_TIMEOUT: '180'
        }
        if (attempt.mirror) env.UV_PYTHON_INSTALL_MIRROR = attempt.mirror
        log?.(attempt.mirror
          ? `创建独立 venv（uv，Python 3.12，源 ${hostOf(attempt.mirror)}）`
          : '创建独立 venv（uv，Python 3.12，官方源）')
        await runLogged(uvPath, ['venv', venvDir, '--python', PYTHON_SERIES], {
          env, log, onChild, cancel, timeoutMs: 15 * 60_000
        })
        if (fs.existsSync(venvPython)) return 'uv'
        throw new Error('venv 目录里没有 python')
      } catch (error) {
        errors.push(`${hostOf(attempt.mirror || 'https://github.com')}：${error?.message || error}`)
      }
    }
    throw new Error(`uv 创建 venv 失败：${errors.slice(-2).join('；')}`)
  }
  if (pythonPath) {
    log?.(`创建独立 venv（${pythonPath}）`)
    await runLogged(pythonPath, ['-m', 'venv', venvDir], { log, onChild, cancel })
    return 'python'
  }
  throw new Error('没有可用的 Python 解释器')
}

export async function installRequirements({
  uvPath, venvPython, requirementsPath, stateDir, log, onChild, cancel
} = {}) {
  if (!fs.existsSync(requirementsPath)) throw new Error(`缺少依赖清单：${requirementsPath}`)
  const indexes = pypiIndexes()
  const errors = []
  if (uvPath) {
    for (const index of indexes) {
      try {
        log?.(`安装后端依赖（uv，源 ${hostOf(index)}）`)
        await runLogged(uvPath, ['pip', 'install', '--python', venvPython, '-r', requirementsPath], {
          env: {
            UV_CACHE_DIR: path.join(stateDir, 'uv-cache'),
            UV_DEFAULT_INDEX: index,
            UV_HTTP_TIMEOUT: '180'
          },
          log,
          onChild,
          cancel
        })
        return index
      } catch (error) {
        errors.push(`${hostOf(index)}：${error?.message || error}`)
        log?.(`该源安装失败，换下一个：${error?.message || error}`)
      }
    }
  } else {
    for (const index of indexes) {
      try {
        log?.(`安装后端依赖（pip，源 ${hostOf(index)}）`)
        await runLogged(venvPython, [
          '-m', 'pip', 'install', '--disable-pip-version-check',
          '-r', requirementsPath, '-i', index, '--timeout', '60', '--retries', '2'
        ], { log, onChild, cancel })
        return index
      } catch (error) {
        errors.push(`${hostOf(index)}：${error?.message || error}`)
        log?.(`该源安装失败，换下一个：${error?.message || error}`)
      }
    }
  }
  throw new Error(`依赖安装失败：${errors.slice(-2).join('；')}`)
}

/**
 * 一步到位：uv（必要时现下）→ venv（必要时现下 CPython）→ 返回可用的解释器。
 * 依赖安装单独调用，方便 UI 分步展示。
 */
export async function prepareEnvironment({ settings, step, log, onChild, cancel } = {}) {
  ensureDir(settings.stateDir)
  const binDir = path.join(settings.stateDir, 'bin')
  ensureDir(binDir)

  step?.('准备 uv 运行时')
  const uv = await ensureUv({
    stateDir: settings.stateDir, binDir, log, onChild, cancel
  }).catch((error) => {
    log?.(`uv 自动安装失败：${error?.message || error}`)
    return null
  })

  if (fs.existsSync(settings.venvPython)) {
    log?.(`复用现有独立环境：${settings.venvDir}`)
    return { uv: uv?.path || null, uvSource: uv?.source || '', created: 'existing' }
  }

  let created = ''
  if (uv) {
    step?.('创建独立 venv（uv）')
    try {
      created = await createVenv({
        uvPath: uv.path, venvDir: settings.venvDir, stateDir: settings.stateDir,
        log, onChild, cancel
      })
    } catch (error) {
      log?.(`用 uv 创建 venv 失败：${error?.message || error}`)
    }
  }

  if (!created) {
    step?.('准备 Python 解释器')
    let base = await findBasePython(settings)
    if (base) log?.(`使用系统 Python：${base}`)
    if (!base) {
      step?.('下载独立 Python 3.12')
      base = await installPythonStandalone({
        stateDir: settings.stateDir, log, onChild, cancel
      })
    }
    step?.('创建独立 venv')
    created = await createVenv({
      pythonPath: base, venvDir: settings.venvDir, stateDir: settings.stateDir,
      log, onChild, cancel
    })
  }

  if (!fs.existsSync(settings.venvPython)) {
    throw new Error('运行环境创建后仍找不到 venv 里的 python，请查看日志')
  }
  log?.(`独立环境已就绪：${settings.venvPython}（${created}）`)
  return { uv: uv?.path || null, uvSource: uv?.source || '', created }
}
