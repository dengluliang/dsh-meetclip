import fs from 'node:fs'
import path from 'node:path'

// A Finder visit leaves .DS_Store behind; it must never make an otherwise empty
// folder look occupied, and a move removes it before the rename.
const IGNORED_ENTRIES = new Set(['.DS_Store'])
const SIZE_FILE_LIMIT = 20_000
const SIZE_BYTE_LIMIT = 64 * 1024 * 1024 * 1024

/** An error the route layer turns into `status` plus `code` and `detail`. */
export function httpError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export function isInside(candidate, base) {
  const relative = path.relative(base, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function resolveTargetPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw httpError(400, 'storage_path_required', '请选择存储位置')
  }
  const value = raw.trim()
  if (!path.isAbsolute(value)) {
    throw httpError(400, 'storage_path_relative', '存储位置必须是绝对路径')
  }
  return path.resolve(value)
}

/** Inspect a candidate (or the current) storage directory without changing anything. */
export function inspectDir(settings, raw, { measure = true } = {}) {
  const target = resolveTargetPath(raw)
  const current = path.resolve(settings.dataDir)
  const stat = statOrNull(target)
  const exists = Boolean(stat)
  const isDirectory = Boolean(stat?.isDirectory())
  const names = exists && isDirectory ? safeNames(target) : []
  const meaningful = names.filter((name) => !IGNORED_ENTRIES.has(name))
  const size = measure && exists && isDirectory
    ? measureTree(target)
    : { bytes: 0, files: 0, capped: false }
  const targetDevice = deviceOf(target)
  const currentDevice = deviceOf(current)
  const nearest = ancestorOf(target)
  return {
    path: target,
    exists,
    isDirectory,
    writable: exists
      ? isDirectory && isWritable(target)
      : Boolean(nearest && nearest.stat.isDirectory() && isWritable(nearest.path)),
    hasLibrary: Boolean(exists && isDirectory && fs.existsSync(path.join(target, 'zhibo.db'))),
    empty: meaningful.length === 0,
    entryCount: meaningful.length,
    sizeBytes: size.bytes,
    fileCount: size.files,
    sizeCapped: size.capped,
    sameDeviceKnown: targetDevice !== null && currentDevice !== null,
    sameDevice: targetDevice !== null && targetDevice === currentDevice,
    isCurrent: target === current,
    insideCurrent: isInside(target, current),
    containsCurrent: isInside(current, target)
  }
}

/** Validate a storage switch and return the resolved target path. */
export function validateDataDirSwitch(settings, raw, { move = false } = {}) {
  const target = resolveTargetPath(raw)
  const current = path.resolve(settings.dataDir)
  if (target === current) {
    throw httpError(400, 'storage_unchanged', '这就是当前存储位置')
  }
  if (isInside(target, current)) {
    throw httpError(400, 'storage_nested', '新位置不能位于当前存储位置之内')
  }
  if (isInside(current, target)) {
    throw httpError(400, 'storage_parent', '新位置不能是当前存储位置的上级目录')
  }
  if (target === path.parse(target).root) {
    throw httpError(400, 'storage_root', '请选择更具体的文件夹')
  }
  const info = inspectDir(settings, target, { measure: false })
  if (info.exists && !info.isDirectory) {
    throw httpError(400, 'storage_not_directory', '新位置不是一个文件夹')
  }
  if (!info.writable) {
    throw httpError(400, 'storage_unwritable', '新位置不可写，请换一个文件夹或先授予磁盘访问权限')
  }
  if (move) {
    if (!fs.existsSync(current)) {
      throw httpError(400, 'storage_current_missing', '当前存储位置不存在，无法移动；请改用「只切换」')
    }
    if (!info.sameDeviceKnown || !info.sameDevice) {
      throw httpError(400, 'storage_cross_device', '新位置在不同磁盘，不能直接移动；请先在 Finder 里拷贝到新位置，再用「只切换」指向它')
    }
    if (info.exists && !info.empty) {
      throw httpError(400, 'storage_not_empty', '新位置不是空文件夹，不能自动移动；请先清空它，或只切换')
    }
  }
  return target
}

/**
 * Move the whole library to an empty same-volume directory. `rename` is atomic,
 * so a 4 GB library relocates instantly and a failure leaves the original intact.
 */
export function moveLibrary(from, to) {
  const source = statOrNull(from)
  if (!source || !source.isDirectory()) {
    throw httpError(400, 'storage_current_invalid', '当前存储位置不是一个文件夹，无法移动')
  }
  removeEmptyTarget(to)
  fs.renameSync(from, to)
}

function removeEmptyTarget(target) {
  const stat = statOrNull(target)
  if (!stat) return
  if (!stat.isDirectory()) {
    throw httpError(400, 'storage_not_directory', '新位置不是一个文件夹')
  }
  const names = fs.readdirSync(target)
  if (names.some((name) => !IGNORED_ENTRIES.has(name))) {
    throw httpError(400, 'storage_not_empty', '新位置不是空文件夹，不能自动移动')
  }
  for (const name of names) {
    fs.rmSync(path.join(target, name), { recursive: true, force: true })
  }
  fs.rmdirSync(target)
}

function statOrNull(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function safeNames(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
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

function deviceOf(target) {
  const found = ancestorOf(target)
  return found ? found.stat.dev : null
}

function measureTree(target) {
  let bytes = 0
  let files = 0
  let capped = false
  const stack = [target]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (IGNORED_ENTRIES.has(entry.name)) continue
      const full = path.join(current, entry.name)
      let stat
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!stat.isFile()) continue
      files += 1
      bytes += stat.size
      if (files >= SIZE_FILE_LIMIT || bytes >= SIZE_BYTE_LIMIT) {
        capped = true
        return { bytes, files, capped }
      }
    }
  }
  return { bytes, files, capped }
}
