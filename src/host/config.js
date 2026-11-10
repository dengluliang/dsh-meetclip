import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  activeLibraryOf, defaultLibraryName, libraryIdFor, readRegistry
} from './libraries.js'

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const packageVersion = readPackageVersion()

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
}

function exists(file) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    port: Number.isInteger(config.port) && config.port > 0 && config.port < 65536 ? config.port : 8321,
    dataDir: typeof config.dataDir === 'string' && config.dataDir.trim() ? path.resolve(config.dataDir.trim()) : null,
    stateDir: typeof config.stateDir === 'string' && config.stateDir.trim()
      ? path.resolve(config.stateDir.trim())
      : path.join(dshHome(), 'meetclip'),
    backendMode: ['auto', 'managed', 'external'].includes(config.backendMode) ? config.backendMode : 'auto',
    python: typeof config.python === 'string' && config.python.trim() ? path.resolve(config.python.trim()) : null,
    // Feishu MCP is spawned through npx; a Finder-launched Electron app often has a
    // shorter PATH than the login shell, so both binaries can be pinned explicitly.
    feishuNode: typeof config.feishuNode === 'string' && config.feishuNode.trim() ? path.resolve(config.feishuNode.trim()) : null,
    feishuNpx: typeof config.feishuNpx === 'string' && config.feishuNpx.trim() ? path.resolve(config.feishuNpx.trim()) : null,
    // Update feed is intentionally opt-in: the public default points at the
    // upstream GitHub Releases, and forks can override it without editing code.
    updateRepo: typeof config.updateRepo === 'string' && config.updateRepo.trim() ? config.updateRepo.trim() : '',
    updateFeed: typeof config.updateFeed === 'string' && config.updateFeed.trim() ? config.updateFeed.trim() : '',
    autoStart: config.autoStart === true,
    tools: config.tools !== false
  }
}

export function prefsPath(stateDir) {
  return path.join(stateDir, 'prefs.json')
}

export function readPrefs(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(prefsPath(stateDir), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export function writePrefs(stateDir, prefs) {
  fs.mkdirSync(stateDir, { recursive: true })
  const target = prefsPath(stateDir)
  const temp = `${target}.tmp`
  fs.writeFileSync(temp, JSON.stringify(prefs, null, 2), { mode: 0o600 })
  fs.renameSync(temp, target)
}

export function resolveSettings(rawConfig) {
  const config = normalizeConfig(rawConfig)
  const registry = readRegistry(config.stateDir)
  const active = activeLibraryOf(registry)
  const prefDir = active ? path.resolve(active.dataDir) : null
  // Where the effective directory came from: a user choice, the deployment config,
  // or the built-in default. First-use setup only proposes a friendlier directory
  // for the built-in default, so an existing choice is never moved silently.
  const dataDirSource = prefDir ? 'prefs' : config.dataDir ? 'config' : 'default'
  const dataDir = prefDir || config.dataDir || defaultDataDir(config.stateDir)
  const port = registry.port || config.port
  return {
    ...config,
    port,
    dataDir,
    dataDirSource,
    // 多资料空间：libraries 是全部空间，library 是当前激活的那个。
    // 没有注册表条目时（首次安装）用有效目录合成一个不落盘的虚拟空间，
    // 让界面在第一次写入之前也能如实显示「当前是哪个空间」。
    registry,
    libraries: registry.libraries,
    library: active || {
      id: libraryIdFor(dataDir),
      name: defaultLibraryName(dataDir),
      dataDir,
      createdAt: null,
      lastOpenedAt: null,
      virtual: true
    },
    sharedDir: registry.sharedDir,
    prefs: registry.raw,
    packageRoot,
    backendRoot: path.join(packageRoot, 'backend'),
    backendAppDir: path.join(packageRoot, 'backend', 'app'),
    requirementsPath: path.join(packageRoot, 'backend', 'requirements.txt'),
    tokenPath: path.join(dataDir, '.api-token'),
    logPath: path.join(config.stateDir, 'backend.log'),
    setupLogPath: path.join(config.stateDir, 'setup.log'),
    feishuLogPath: path.join(config.stateDir, 'feishu.log'),
    feishuStatePath: path.join(config.stateDir, 'feishu.json'),
    pidPath: path.join(config.stateDir, 'backend.pid'),
    uploadDir: path.join(config.stateDir, 'uploads'),
    venvDir: path.join(config.stateDir, 'venv'),
    venvPython: path.join(config.stateDir, 'venv', 'bin', 'python')
  }
}

function defaultDataDir(stateDir) {
  const legacy = path.resolve(packageRoot, '..', 'data')
  if (exists(path.join(legacy, 'zhibo.db'))) return legacy
  return path.join(stateDir, 'data')
}

export function readApiToken(tokenPath) {
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim()
    return token || null
  } catch {
    return null
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readLogTail(file, lines = 200) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const all = text.split('\n')
    return all.slice(Math.max(0, all.length - lines)).join('\n')
  } catch {
    return ''
  }
}

/**
 * Directory first-use setup proposes. An install that has never picked a
 * directory would otherwise land in the hidden state directory.
 */
export function suggestedDataDir(settings) {
  return settings.dataDirSource === 'default'
    ? path.join(os.homedir(), 'Documents', '会摘资料')
    : settings.dataDir
}

export function publicLocations(settings) {
  return {
    dataDir: settings.dataDir,
    // 工作区注册的是 realpath；会话 cwd 也走 realpath，客户端 @ 卡片用它比较。
    dataDirCanonical: canonicalPath(settings.dataDir),
    dataDirSource: settings.dataDirSource,
    suggestedDataDir: suggestedDataDir(settings),
    stateDir: settings.stateDir,
    port: settings.port,
    venv: settings.venvDir,
    tokenPresent: Boolean(readApiToken(settings.tokenPath)),
    dataDirExists: exists(settings.dataDir),
    // 多资料空间：当前激活空间 + 可切换的空间（精简，不含体积统计）。
    library: settings.library
      ? {
          id: settings.library.id,
          name: settings.library.name,
          dataDir: settings.library.dataDir,
          virtual: Boolean(settings.library.virtual)
        }
      : null,
    libraries: (settings.libraries || []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      dataDir: entry.dataDir,
      active: entry.id === settings.library?.id
    })),
    sharedDir: settings.sharedDir || null
  }
}

function canonicalPath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}
