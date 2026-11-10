import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { httpError } from './storage.js'

/**
 * 资料空间（library）注册表。
 *
 * 一份资料空间 = 一个数据目录，里面有自己的 zhibo.db、记录目录、会摘卡片、
 * .api-token 与 .trash。注册表按顺序放在 prefs.json 的 libraries / sharedDir 里，
 * 但同时也写回旧的 dataDir 字段，让旧版本宿主继续可用。
 *
 * 目录里的 .meetclip-library.json 是身份标记：目录被改名或拷到别的机器后，
 * 仍然认得出自己是同一个空间。
 */

export const MARKER_NAME = '.meetclip-library.json'
export const MARKER_VERSION = 1
// 全库共用、因此放进共享目录的文件。模型目录暂不共享：体积可能上 GB，
// 而且当前转写走云端，本地模型只在旧配置里用到。
export const SHARED_FILES = ['settings.json', 'bili_cookies.txt', 'douyin_cookies.txt']
const NAME_LIMIT = 40
const MAX_LIBRARIES = 24
const IGNORED_ENTRIES = new Set(['.DS_Store'])

/**
 * 真实路径。目录还没创建时，先 realpath 最近的已存在祖先，再把剩下的部分拼回去——
 * macOS 的 /var 是 /private/var 的软链，不这样处理会让「还没建的子目录」
 * 看起来不在自己的父目录里，嵌套/重复判断就会漏。
 */
export function canonicalPath(dir) {
  const resolved = path.resolve(String(dir || '.'))
  const pending = []
  let current = resolved
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = fs.realpathSync(current)
      return pending.length ? path.join(real, ...pending.reverse()) : real
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) return resolved
    pending.push(path.basename(current))
    current = parent
  }
  return resolved
}

/** 目录身份：sha1(realpath) 前 10 位，足够短且稳定。 */
export function libraryIdFor(dir) {
  return createHash('sha1').update(canonicalPath(dir)).digest('hex').slice(0, 10)
}

function cleanText(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
}

function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function sanitizeId(value) {
  const text = cleanText(value)
  return /^[A-Za-z0-9_-]{4,64}$/.test(text) ? text : null
}

/** 一个目录默认该叫什么；叫 data 的目录名对用户没有意义。 */
export function defaultLibraryName(dir) {
  const base = path.basename(canonicalPath(dir))
  if (!base || base === path.sep || base === 'data') return '默认资料空间'
  return base
}

export function hasLibraryDatabase(dir) {
  try {
    return fs.statSync(path.join(dir, 'zhibo.db')).isFile()
  } catch {
    return false
  }
}

export function readMarker(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, MARKER_NAME), 'utf8'))
    if (!value || typeof value !== 'object') return null
    return {
      id: sanitizeId(value.id),
      name: cleanText(value.name) || null,
      createdAt: numberOr(value.createdAt, null)
    }
  } catch {
    return null
  }
}

export function writeMarker(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, MARKER_NAME)
    const payload = {
      version: MARKER_VERSION,
      id: entry.id,
      name: entry.name,
      createdAt: entry.createdAt || Date.now()
    }
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function prefsFile(stateDir) {
  return path.join(stateDir, 'prefs.json')
}

function readPrefsFile(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(prefsFile(stateDir), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const declared = cleanText(raw.dataDir)
  if (!declared || !path.isAbsolute(declared)) return null
  const dataDir = path.resolve(declared)
  const marker = readMarker(dataDir)
  const id = sanitizeId(raw.id) || marker?.id || libraryIdFor(dataDir)
  const name = cleanText(raw.name) || marker?.name || defaultLibraryName(dataDir)
  return {
    id,
    name,
    dataDir,
    createdAt: numberOr(raw.createdAt, marker?.createdAt ?? null),
    lastOpenedAt: numberOr(raw.lastOpenedAt, null)
  }
}

/**
 * 读注册表。缺失或损坏时按旧 prefs 迁移出一条空间，只读、不落盘。
 * `legacy` 表示这份 prefs 还是旧格式（或没有 prefs），需要在下一次写入时升级。
 */
export function readRegistry(stateDir) {
  const prefs = readPrefsFile(stateDir)
  const declared = Array.isArray(prefs.libraries) ? prefs.libraries : null
  let libraries = []
  if (declared && declared.length) {
    const seenPaths = new Set()
    const seenIds = new Set()
    for (const item of declared) {
      const entry = normalizeEntry(item)
      if (!entry) continue
      const key = canonicalPath(entry.dataDir)
      if (seenPaths.has(key)) continue
      if (seenIds.has(entry.id)) entry.id = libraryIdFor(entry.dataDir)
      seenPaths.add(key)
      seenIds.add(entry.id)
      libraries.push(entry)
    }
  } else if (cleanText(prefs.dataDir)) {
    const entry = normalizeEntry({ dataDir: prefs.dataDir })
    if (entry) libraries.push(entry)
  }
  libraries = libraries.slice(0, MAX_LIBRARIES)
  const declaredActive = sanitizeId(prefs.activeLibraryId)
  const activeLibraryId = libraries.some((entry) => entry.id === declaredActive)
    ? declaredActive
    : (libraries[0]?.id || null)
  const port = Number.isInteger(prefs.port) && prefs.port > 0 && prefs.port < 65536 ? prefs.port : null
  const sharedDir = cleanText(prefs.sharedDir) && path.isAbsolute(cleanText(prefs.sharedDir))
    ? path.resolve(cleanText(prefs.sharedDir))
    : null
  return {
    schema: declared ? 2 : 1,
    legacy: !declared,
    libraries,
    activeLibraryId,
    port,
    sharedDir,
    dataDir: libraries.find((entry) => entry.id === activeLibraryId)?.dataDir || null,
    legacyDataDir: cleanText(prefs.dataDir) || null,
    raw: prefs
  }
}

function cleanEntry(entry) {
  const value = {
    id: entry.id,
    name: entry.name,
    dataDir: entry.dataDir
  }
  if (entry.createdAt) value.createdAt = entry.createdAt
  if (entry.lastOpenedAt) value.lastOpenedAt = entry.lastOpenedAt
  return value
}

/**
 * 原子写注册表。首次升级旧格式前，把原 prefs.json 备份成 prefs.json.bak-v1；
 * 未知字段原样保留，避免覆盖其它版本写进来的配置。
 */
export function writeRegistry(stateDir, registry) {
  fs.mkdirSync(stateDir, { recursive: true })
  const target = prefsFile(stateDir)
  const backup = `${target}.bak-v1`
  try {
    if (fs.existsSync(target) && !fs.existsSync(backup)) fs.copyFileSync(target, backup)
  } catch {}
  const active = registry.libraries.find((entry) => entry.id === registry.activeLibraryId)
    || registry.libraries[0]
    || null
  const base = readPrefsFile(stateDir)
  const payload = {
    ...base,
    schema: 2,
    activeLibraryId: active?.id || null,
    libraries: registry.libraries.slice(0, MAX_LIBRARIES).map(cleanEntry),
    // 旧版本宿主只认 dataDir：始终镜像当前激活空间。
    dataDir: active?.dataDir || base.dataDir || null
  }
  if (Number.isInteger(registry.port) && registry.port > 0 && registry.port < 65536) {
    payload.port = registry.port
  }
  if (registry.sharedDir) payload.sharedDir = registry.sharedDir
  else if ('sharedDir' in base && !registry.sharedDir) delete payload.sharedDir
  const temp = `${target}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, target)
  return payload
}

export function emptyRegistry({ port = null } = {}) {
  return { schema: 2, legacy: false, libraries: [], activeLibraryId: null, port, sharedDir: null, dataDir: null }
}

export function activeLibraryOf(registry) {
  if (!registry) return null
  return registry.libraries.find((entry) => entry.id === registry.activeLibraryId) || null
}

export function validateLibraryName(raw) {
  const name = cleanText(raw)
  if (!name) throw httpError(400, 'library_name_required', '请先给资料空间起个名字')
  if ([...name].length > NAME_LIMIT) {
    throw httpError(400, 'library_name_too_long', `名称不能超过 ${NAME_LIMIT} 个字`)
  }
  if (/[/\\:*?"<>|]/.test(name)) {
    throw httpError(400, 'library_name_invalid', '名称里不能出现 / \\ : * ? " < > |')
  }
  return name
}

/** 重名时自动加序号，避免列表里两行一模一样。 */
export function uniqueName(registry, raw, exceptId = null) {
  const base = cleanText(raw) || '资料空间'
  const taken = new Set(
    (registry?.libraries || [])
      .filter((entry) => entry.id !== exceptId)
      .map((entry) => entry.name)
  )
  if (!taken.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

function statOrNull(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function ancestorOf(target) {
  let dir = target
  for (let depth = 0; depth < 64; depth += 1) {
    const stat = statOrNull(dir)
    if (stat) return { path: dir, stat }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function entryNames(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => !IGNORED_ENTRIES.has(name))
  } catch {
    return []
  }
}

function insideOf(child, parent) {
  const relative = path.relative(parent, child)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** 预检一个候选目录：能不能新建/收养、是不是已有的库、会不会嵌套。 */
export function inspectLibraryDir(registry, raw, { measure = false } = {}) {
  const declared = cleanText(raw)
  if (!declared) throw httpError(400, 'library_path_required', '请选择资料空间的位置')
  if (!path.isAbsolute(declared)) throw httpError(400, 'library_path_relative', '位置必须是绝对路径')
  const target = path.resolve(declared)
  const canonical = canonicalPath(target)
  const stat = statOrNull(target)
  const exists = Boolean(stat)
  const isDirectory = Boolean(stat?.isDirectory())
  const names = exists && isDirectory ? entryNames(target) : []
  const hasLibrary = exists && isDirectory && hasLibraryDatabase(target)
  const nearest = ancestorOf(target)
  const writable = exists
    ? isDirectory && isWritable(target)
    : Boolean(nearest && nearest.stat.isDirectory() && isWritable(nearest.path))

  let duplicate = null
  let nested = false
  let contains = false
  for (const entry of registry?.libraries || []) {
    const other = canonicalPath(entry.dataDir)
    if (other === canonical) duplicate = { id: entry.id, name: entry.name }
    else if (insideOf(canonical, other)) nested = true
    else if (insideOf(other, canonical)) contains = true
  }

  return {
    path: target,
    canonical,
    exists,
    isDirectory,
    writable,
    hasLibrary,
    empty: names.length === 0,
    entryCount: names.length,
    duplicate,
    nested,
    contains,
    isRoot: target === path.parse(target).root,
    measure,
    suggestedName: hasLibrary
      ? (readMarker(target)?.name || defaultLibraryName(target))
      : defaultLibraryName(target)
  }
}

/**
 * 校验并归一化「新建/收养一个资料空间」的请求。
 * 空目录 = 新建；已有 zhibo.db = 收养；非空且没有库 = 拒绝（除非 force）。
 */
export function validateNewLibrary(registry, { name, dataDir, force = false } = {}) {
  const info = inspectLibraryDir(registry, dataDir)
  if (info.isRoot) throw httpError(400, 'library_path_root', '请选择更具体的文件夹')
  if (info.exists && !info.isDirectory) throw httpError(400, 'library_path_not_directory', '这个位置不是文件夹')
  if (!info.writable) {
    throw httpError(400, 'library_path_unwritable', '这个位置不可写，请换一个文件夹或先给 DeepSeek Harness 完全磁盘访问权限')
  }
  if (info.duplicate) {
    const error = httpError(409, 'library_exists', `这里已经是资料空间「${info.duplicate.name}」`)
    error.detail = info.duplicate
    throw error
  }
  if (info.nested) throw httpError(400, 'library_nested', '新位置不能放在另一个资料空间里面')
  if (info.contains) throw httpError(400, 'library_contains', '新位置不能包含另一个资料空间')
  if (info.exists && !info.empty && !info.hasLibrary && !force) {
    const error = httpError(409, 'library_not_empty', `这个文件夹里已有 ${info.entryCount} 项内容，没有找到会摘资料`)
    error.detail = { entryCount: info.entryCount }
    throw error
  }
  if ((registry?.libraries || []).length >= MAX_LIBRARIES) {
    throw httpError(409, 'library_limit', `最多只能有 ${MAX_LIBRARIES} 个资料空间`)
  }
  const marker = info.hasLibrary ? readMarker(info.path) : null
  const resolvedName = validateLibraryName(
    cleanText(name) || marker?.name || info.suggestedName
  )
  return {
    dataDir: info.path,
    canonical: info.canonical,
    name: resolvedName,
    adopt: info.hasLibrary,
    createdAt: marker?.createdAt || null,
    id: marker?.id || libraryIdFor(info.path),
    info
  }
}

/**
 * 共享目录：账号与通用设置只存这一份。
 * 只复制不移动，已存在的目标文件绝不覆盖；失败由调用方决定是否阻断。
 */
export function ensureSharedDir({ sharedDir, sourceDir = '', files = SHARED_FILES } = {}) {
  const declared = cleanText(sharedDir)
  if (!declared || !path.isAbsolute(declared)) {
    throw httpError(400, 'shared_dir_invalid', '共享目录必须是绝对路径')
  }
  const target = path.resolve(declared)
  fs.mkdirSync(target, { recursive: true })
  if (!isWritable(target)) throw httpError(400, 'shared_dir_unwritable', '共享目录不可写')
  const copied = []
  const kept = []
  const missing = []
  for (const name of files) {
    const to = path.join(target, name)
    const from = sourceDir ? path.join(sourceDir, name) : ''
    if (statOrNull(to)) {
      kept.push(name)
      continue
    }
    if (!from || !statOrNull(from)) {
      missing.push(name)
      continue
    }
    try {
      fs.copyFileSync(from, to)
      try { fs.chmodSync(to, 0o600) } catch {}
      copied.push(name)
    } catch (error) {
      const failure = httpError(500, 'shared_dir_copy_failed', `复制 ${name} 失败：${error?.message || error}`)
      throw failure
    }
  }
  return { sharedDir: target, copied, kept, missing }
}

/** 注册表里的一行 → 给界面的摘要（体积信息由调用方补）。 */
export function summarizeLibrary(registry, entry) {
  const stat = statOrNull(entry.dataDir)
  return {
    id: entry.id,
    name: entry.name,
    dataDir: entry.dataDir,
    active: entry.id === registry.activeLibraryId,
    exists: Boolean(stat?.isDirectory()),
    hasLibrary: Boolean(stat?.isDirectory()) && hasLibraryDatabase(entry.dataDir),
    createdAt: entry.createdAt || null,
    lastOpenedAt: entry.lastOpenedAt || null
  }
}

// 记录目录名就是 12 位十六进制 id（database.py: uuid4().hex[:12]）；
// 其它目录（会摘卡片、.trash、models、saved、board-images…）不算记录。
const RECORD_DIR = /^[0-9a-f]{12}$/i

/** 记录数：只数顶层记录目录，不递归（大库上必须便宜）。 */
export function recordDirectoryCount(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && RECORD_DIR.test(item.name))
      .length
  } catch {
    return 0
  }
}

export { insideOf, statOrNull, isWritable }
