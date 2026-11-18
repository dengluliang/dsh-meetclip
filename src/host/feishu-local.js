/**
 * 飞书 MCP 的「本地安装」模式：不依赖 npx，也不要求用户自己装 Node。
 *
 * 思路：
 *   1. node 运行时——优先系统 node（config 的 feishuNode 或 PATH），否则直接用
 *      DSH 自带的 Electron（`ELECTRON_RUN_AS_NODE=1` 时它就是 node 24，与
 *      `Resources/runtime/bin/node` 那个包装脚本做的是同一件事）。
 *   2. 包管理器——用 DSH 自带的 pnpm（`runtime/primary-runtime/dependencies/pnpm`），
 *      把 `feishuPackage@version` 连同依赖装进 `~/.dsh/meetclip/feishu-mcp/`；
 *      机器上有 pnpm/npm 也可以退回去用。
 *   3. 启动——生成一个 `run.sh` 当 MCP 的 `command`，里面固化 node 路径、入口
 *      JS 与 ELECTRON_RUN_AS_NODE，DSH 拉起它就跟平时一样走 stdio。
 *
 * 这样在全新 Mac 上（没有 node、没有 npx）「安装并连接」也能一次成功；原来的
 * npx 模式保留（config `feishuMode: npx`），装不上时也会自动退回去。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'

export const PNPM_RELATIVE = path.join('runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
export const DEFAULT_TIMEOUT_MS = 300_000

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

/** Electron 的 resources 目录；纯 node 进程下可能不存在，返回空串。 */
export function appResourcesDir(execPath = process.execPath) {
  const fromElectron = process.resourcesPath
  if (fromElectron && exists(fromElectron)) return fromElectron
  if (!execPath) return ''
  // <App>.app/Contents/MacOS/<binary> → <App>.app/Contents/Resources
  const resources = path.join(path.dirname(path.dirname(execPath)), 'Resources')
  return exists(resources) ? resources : ''
}

/**
 * 解析出「能跑 JS 的 node」：系统 node 优先，其次 DSH 自带的 Electron。
 *
 * Electron 跑 JS 需要 `ELECTRON_RUN_AS_NODE=1`；对真正的 node 这个变量没有副作用，
 * 所以统一带上，启动器里也照写，DSH 之后拉起 MCP 时不需要额外环境。
 */
export function findNodeRuntime({ settings = {}, binaries = {}, execPath = process.execPath } = {}) {
  const system = settings.feishuNode || binaries.node
  if (system && executable(system)) {
    return { exec: system, source: 'system', electron: false, env: {} }
  }
  if (execPath && exists(execPath)) {
    return { exec: execPath, source: 'dsh', electron: true, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return null
}

const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

function searchInstaller(name, envPath, extraDirs = EXTRA_BIN_DIRS) {
  const dirs = String(envPath || '').split(path.delimiter).filter(Boolean)
  for (const dir of [...dirs, ...extraDirs]) {
    const candidate = path.join(dir, name)
    if (executable(candidate)) return candidate
  }
  return null
}

/** 包管理器：config 指定 → DSH 自带 pnpm → PATH 上的 pnpm / npm。 */
export function findInstaller({ settings = {}, env = process.env, resources = null, extraDirs } = {}) {
  const override = settings.feishuPnpm
  if (override && exists(override)) return { kind: 'pnpm', path: override, source: 'config' }
  const root = resources === null ? appResourcesDir() : resources
  if (root) {
    const bundled = path.join(root, PNPM_RELATIVE)
    if (exists(bundled)) return { kind: 'pnpm', path: bundled, source: 'dsh' }
  }
  const pnpm = searchInstaller('pnpm', env.PATH, extraDirs)
  if (pnpm) return { kind: 'pnpm', path: pnpm, source: 'system' }
  const npm = searchInstaller('npm', env.PATH, extraDirs)
  if (npm) return { kind: 'npm', path: npm, source: 'system' }
  return null
}

/** 选本地模式还是 npx 模式。本地模式在全新机器上总能成立，因此默认它。 */
export function resolveStrategy({ settings = {}, binaries = {}, env = process.env, extraDirs } = {}) {
  const requested = settings.feishuMode === 'npx' ? 'npx' : 'local'
  if (requested === 'npx') return { mode: 'npx', reason: '配置指定使用 npx' }
  const node = findNodeRuntime({ settings, binaries })
  if (!node) return { mode: 'npx', reason: '没有可用的 node 运行时' }
  const installer = findInstaller({ settings, env, extraDirs })
  if (!installer) return { mode: 'npx', reason: '没有可用的包管理器（DSH 自带 pnpm 未找到）' }
  return { mode: 'local', node, installer }
}

export function encodePackageName(name) {
  const value = String(name || '').trim()
  if (!value) return ''
  return value.split('/').map((part, index) => (index === 0 && part.startsWith('@') ? part : encodeURIComponent(part))).join('%2F')
}

/** registry metadata → 最新版本号（dist-tags.latest 优先）。 */
export function pickLatestVersion(metadata) {
  if (!metadata || typeof metadata !== 'object') return ''
  const tags = metadata['dist-tags'] || metadata.distTags || {}
  const candidates = [tags.latest, tags.candidate, tags.next, metadata.version]
  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (/^\d+\.\d+\.\d+/.test(value)) return value
  }
  return ''
}

/**
 * package.json 的 bin 字段 → 入口相对路径。
 *
 * `bin` 可能是字符串（包名本身就是命令），也可能是对象；对象时优先取包名末段
 * （`@mi/feishu-mcp-pro` → `feishu-mcp-pro`），没有再退回第一个。
 */
export function pickBinEntry(packageJson, packageName) {
  if (!packageJson || typeof packageJson !== 'object') return ''
  const bin = packageJson.bin
  if (typeof bin === 'string') return bin
  if (bin && typeof bin === 'object') {
    const keys = Object.keys(bin).filter((key) => typeof bin[key] === 'string')
    if (!keys.length) return ''
    const leaf = String(packageName || '').split('/').pop()
    const chosen = keys.find((key) => key === leaf) || keys.find((key) => key === packageName) || keys[0]
    return bin[chosen]
  }
  if (typeof packageJson.main === 'string') return packageJson.main
  return ''
}

function shellQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`
}

/** 固定 node、入口与环境；DSH 拉起它、用户在终端跑它，行为一致。 */
export function launcherScript({ node, entry, version = '', generatedAt = '', home = os.homedir() }) {
  const now = generatedAt || new Date().toISOString()
  return [
    '#!/bin/sh',
    `# 会摘 · 飞书 MCP Pro 启动器（本地安装，不依赖 npx）`,
    `# 版本 ${version || '未知'} · 生成于 ${now}`,
    `# node：${node.exec}`,
    'export ELECTRON_RUN_AS_NODE=1',
    // 令牌在 ~/.feishu-mcp-pro/auth.json；DSH 拉起 MCP 时环境可能被裁剪，这里兜一个 HOME。
    `export HOME="\${HOME:-${home}}"`,
    `export PATH=${shellQuote([path.dirname(node.exec), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'))}`,
    `exec ${shellQuote(node.exec)} ${shellQuote(entry)} "$@"`,
    ''
  ].join('\n')
}

function fetchJson(url, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`地址不合法：${url}`))
      return
    }
    const client = parsed.protocol === 'http:' ? http : https
    const request = client.get(parsed, {
      headers: { accept: 'application/json', 'user-agent': 'meetclip-feishu-local/1.0' }
    }, (response) => {
      const status = response.statusCode || 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        fetchJson(new URL(response.headers.location, url).href, { timeoutMs }).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`registry 返回 HTTP ${status}`))
        return
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (failure) {
          reject(new Error(`registry 返回的不是 JSON：${failure?.message || failure}`))
        }
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('连接 registry 超时')))
    request.on('error', reject)
  })
}

/** 不走 npx 也能问版本：直接读 registry 的 packument。 */
export async function fetchLatestVersion({ registry, name, timeoutMs = 20_000 } = {}) {
  const base = String(registry || '').replace(/\/+$/, '')
  if (!base || !name) throw new Error('未配置飞书 MCP 的包名或 npm 源')
  const metadata = await fetchJson(`${base}/${encodePackageName(name)}`, { timeoutMs })
  const version = pickLatestVersion(metadata)
  if (!version) throw new Error('registry 上找不到可用版本（dist-tags 为空）')
  return version
}

export function localPaths(settings = {}, name = '') {
  const root = path.join(settings.stateDir || path.join(os.homedir(), '.dsh', 'meetclip'), 'feishu-mcp')
  return {
    root,
    launcher: path.join(root, 'run.sh'),
    store: path.join(root, 'store'),
    packageDir: name ? path.join(root, 'node_modules', ...String(name).split('/')) : root
  }
}

/** 已装好的本地副本（安装/更新之外的只读探测）。 */
export function localStatus({ settings = {}, name = '' } = {}) {
  const paths = localPaths(settings, name)
  let version = ''
  let entry = ''
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(paths.packageDir, 'package.json'), 'utf8'))
    version = String(packageJson.version || '')
    const relative = pickBinEntry(packageJson, name)
    if (relative) entry = path.join(paths.packageDir, relative)
  } catch {}
  const installed = Boolean(version && entry && exists(entry) && executable(paths.launcher))
  return { installed, version, entry, launcher: paths.launcher, root: paths.root }
}

function installerInvocation(installer, node) {
  if (installer.kind === 'pnpm') return { command: node.exec, args: [installer.path] }
  return { command: installer.path, args: [] }
}

function installArgs(installer, { dir, name, version, registry, store }) {
  const spec = `${name}@${version}`
  if (installer.kind === 'pnpm') {
    return [
      'add', '--dir', dir, spec,
      `--registry=${registry}`,
      `--store-dir=${store}`,
      '--ignore-scripts',
      '--reporter=append-only'
    ]
  }
  return [
    'install', '--prefix', dir, spec,
    `--registry=${registry}`,
    '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'
  ]
}

/**
 * 把包（含依赖）装进 `settings.stateDir/feishu-mcp/`，并生成启动器。
 * 返回 `{ install, command }`：`command` 是之后跑 login/logout 等子命令的形式。
 */
export async function installLocalPackage({
  settings = {}, name, version, registry, node, installer, log, runCommand
} = {}) {
  if (!node || !installer) throw new Error('本地安装缺少 node 或包管理器')
  const paths = localPaths(settings, name)
  fs.mkdirSync(paths.root, { recursive: true })
  const { command, args: baseArgs } = installerInvocation(installer, node)
  const args = [...baseArgs, ...installArgs(installer, {
    dir: paths.root, name, version, registry, store: paths.store
  })]
  log?.(`$ ${path.basename(command)} ${args.join(' ')}`)
  await runCommand(command, args, {
    env: {
      ...process.env,
      ...node.env,
      PATH: [path.dirname(node.exec), process.env.PATH || '', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter),
      npm_config_loglevel: 'error',
      npm_config_update_notifier: 'false'
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cwd: paths.root
  })

  const packageJson = JSON.parse(fs.readFileSync(path.join(paths.packageDir, 'package.json'), 'utf8'))
  const relative = pickBinEntry(packageJson, name)
  if (!relative) throw new Error('包装好了，但 package.json 里没有可执行入口（bin/main）')
  const entry = path.join(paths.packageDir, relative)
  if (!exists(entry)) throw new Error(`入口文件不存在：${entry}`)

  fs.writeFileSync(paths.launcher, launcherScript({ node, entry, version: packageJson.version }), { mode: 0o755 })
  fs.chmodSync(paths.launcher, 0o755)
  return {
    install: { launcher: paths.launcher, entry, version: String(packageJson.version || version), root: paths.root },
    command: { exec: node.exec, entry, env: node.env }
  }
}
