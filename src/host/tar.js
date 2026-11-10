import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Minimal, defensive tar.gz reader for plugin update packages.
 *
 * The updater only ever accepts the tarball produced by `npm pack`, so the
 * supported surface is deliberately small: regular files and directories under
 * one top-level `package/` directory, plus the metadata entries npm may emit
 * (PAX extended headers and GNU long names). Links, devices and sparse files
 * are rejected instead of being interpreted.
 */

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024
export const MAX_FILE_BYTES = 32 * 1024 * 1024
export const MAX_ENTRIES = 5000
const BLOCK = 512
const MAX_PATH_LENGTH = 900
const MAX_SEGMENT_LENGTH = 255

export class TarError extends Error {
  constructor(message, code = 'archive-invalid') {
    super(message)
    this.name = 'TarError'
    this.code = code
  }
}

export function extractTarball(buffer, destDir, options = {}) {
  const limits = {
    maxArchiveBytes: options.maxArchiveBytes || MAX_ARCHIVE_BYTES,
    maxExtractedBytes: options.maxExtractedBytes || MAX_EXTRACTED_BYTES,
    maxFileBytes: options.maxFileBytes || MAX_FILE_BYTES,
    maxEntries: options.maxEntries || MAX_ENTRIES
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TarError('更新包为空', 'archive-empty')
  }
  if (buffer.length > limits.maxArchiveBytes) {
    throw new TarError('更新包超过大小上限', 'archive-too-large')
  }
  if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    throw new TarError('更新包不是 gzip 格式', 'archive-not-gzip')
  }

  let tar
  try {
    tar = zlib.gunzipSync(buffer, {
      maxOutputLength: Math.min(limits.maxExtractedBytes + 8 * 1024 * 1024, 512 * 1024 * 1024)
    })
  } catch (error) {
    throw new TarError(`更新包无法解压：${error?.message || error}`, 'archive-gunzip')
  }
  if (tar.length === 0) throw new TarError('更新包解压后为空', 'archive-empty')

  const root = path.resolve(destDir)
  fs.mkdirSync(root, { recursive: true })

  let offset = 0
  let entries = 0
  let extractedBytes = 0
  let sawFile = false
  let pendingPath = null
  let pendingLongName = null
  let pendingSize = null
  const written = []

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break

    verifyChecksum(header, offset)
    const size = parseNumber(header, 124, 12, 'size')
    const type = String.fromCharCode(header[156] || 0)

    if (size < 0 || offset + BLOCK + size > tar.length) {
      throw new TarError('更新包条目长度越界', 'archive-truncated')
    }
    const payload = tar.subarray(offset + BLOCK, offset + BLOCK + size)

    if (type === 'x' || type === 'g') {
      const pax = parsePax(payload)
      if (pax.path) pendingPath = pax.path
      if (pax.linkpath) throw new TarError('更新包包含链接条目，已拒绝', 'archive-link')
      if (pax.size !== undefined) pendingSize = pax.size
      offset = nextBlock(offset, size)
      entries += 1
      if (entries > limits.maxEntries) throw new TarError('更新包条目过多', 'archive-too-many-entries')
      continue
    }
    if (type === 'L') {
      pendingLongName = payload.toString('utf8').replace(/\0.*$/s, '')
      offset = nextBlock(offset, size)
      entries += 1
      if (entries > limits.maxEntries) throw new TarError('更新包条目过多', 'archive-too-many-entries')
      continue
    }
    if (type === 'K') {
      throw new TarError('更新包包含链接条目，已拒绝', 'archive-link')
    }
    if (type === '1' || type === '2' || type === '3' || type === '4' || type === '6') {
      throw new TarError('更新包包含链接或设备条目，已拒绝', 'archive-link')
    }
    if (type !== '0' && type !== '\0' && type !== '7' && type !== '5') {
      throw new TarError(`更新包包含不支持的类型：${JSON.stringify(type)}`, 'archive-type')
    }

    entries += 1
    if (entries > limits.maxEntries) throw new TarError('更新包条目过多', 'archive-too-many-entries')

    const headerName = readName(header)
    const rawName = pendingPath || pendingLongName || headerName
    const entrySize = pendingSize !== null && type !== '5' ? pendingSize : size
    pendingPath = null
    pendingLongName = null
    pendingSize = null

    if (entrySize < 0) throw new TarError('更新包条目长度为负', 'archive-invalid')
    if (type !== '5' && entrySize > limits.maxFileBytes) {
      throw new TarError('更新包内单个文件超过大小上限', 'archive-too-large')
    }

    const relative = normalizeMemberName(rawName)
    if (relative === null) {
      // The top-level `package/` directory itself, or a metadata-only entry.
      offset = nextBlock(offset, size)
      continue
    }

    const target = safeJoin(root, relative)
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 })
      offset = nextBlock(offset, size)
      continue
    }

    extractedBytes += entrySize
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new TarError('更新包解压后超过大小上限', 'archive-too-large')
    }

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
    const executable = modeIsExecutable(header)
    fs.writeFileSync(target, payload, { mode: executable ? 0o755 : 0o644 })
    written.push(relative)
    sawFile = true
    offset = nextBlock(offset, size)
  }

  if (!sawFile) throw new TarError('更新包里没有文件', 'archive-empty')

  return {
    ok: true,
    root,
    files: written,
    entries,
    bytes: extractedBytes
  }
}

function nextBlock(offset, size) {
  return offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) if (block[i] !== 0) return false
  return true
}

function readName(header) {
  const name = cString(header, 0, 100)
  const prefix = cString(header, 345, 155)
  return prefix ? `${prefix}/${name}` : name
}

function cString(header, offset, length) {
  const raw = header.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return (end === -1 ? raw : raw.subarray(0, end)).toString('utf8')
}

function parseNumber(header, offset, length, label) {
  const raw = header.subarray(offset, offset + length)
  if (raw[0] & 0x80) {
    throw new TarError(`更新包使用 base-256 ${label} 编码，已拒绝`, 'archive-invalid')
  }
  const text = cString(header, offset, length).trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new TarError(`更新包 ${label} 字段格式无效`, 'archive-invalid')
  }
  return Number.parseInt(text, 8)
}

function verifyChecksum(header, offset) {
  const expected = (() => {
    const text = cString(header, 148, 8).trim()
    if (!text) return 0
    if (!/^[0-7]+$/.test(text)) return -1
    return Number.parseInt(text, 8)
  })()
  if (expected < 0) throw new TarError('更新包头校验和格式无效', 'archive-invalid')
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i]
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  if (unsigned !== expected && signed !== expected) {
    throw new TarError(`更新包头校验失败（偏移 ${offset}）`, 'archive-checksum')
  }
}

function modeIsExecutable(header) {
  const text = cString(header, 100, 8).trim()
  if (!/^[0-7]+$/.test(text)) return false
  return (Number.parseInt(text, 8) & 0o111) !== 0
}

function parsePax(payload) {
  const result = {}
  let offset = 0
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset)
    if (space === -1) break
    const lengthText = payload.toString('ascii', offset, space)
    if (!/^\d+$/.test(lengthText)) break
    const length = Number.parseInt(lengthText, 10)
    if (length <= 0 || offset + length > payload.length) break
    const record = payload.toString('utf8', space + 1, offset + length).replace(/\n$/, '')
    const equals = record.indexOf('=')
    if (equals > 0) {
      const key = record.slice(0, equals)
      const value = record.slice(equals + 1)
      if (key === 'path') result.path = value
      else if (key === 'linkpath') result.linkpath = value
      else if (key === 'size' && /^\d+$/.test(value)) result.size = Number.parseInt(value, 10)
    }
    offset += length
  }
  return result
}

/**
 * Turn a tar member name into a path relative to the package root.
 * Returns null for the root `package/` directory and metadata entries.
 */
function normalizeMemberName(rawName) {
  let value = String(rawName || '')
  if (!value) throw new TarError('更新包条目缺少文件名', 'archive-invalid')
  if (value.includes('\\')) throw new TarError('更新包条目包含反斜杠路径', 'archive-unsafe-path')
  if (value.includes('\0')) throw new TarError('更新包条目包含 NUL 字符', 'archive-unsafe-path')
  if (value.startsWith('/')) throw new TarError('更新包条目使用绝对路径', 'archive-unsafe-path')
  if (/^[A-Za-z]:/.test(value)) throw new TarError('更新包条目使用盘符路径', 'archive-unsafe-path')
  if (value.length > MAX_PATH_LENGTH) throw new TarError('更新包条目路径过长', 'archive-unsafe-path')

  const segments = value.split('/').filter((segment) => segment !== '')
  if (!segments.length) return null
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new TarError('更新包条目包含相对路径跳转', 'archive-unsafe-path')
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new TarError('更新包条目路径段过长', 'archive-unsafe-path')
    }
  }
  if (segments[0] !== 'package') {
    throw new TarError('更新包顶层目录不是 package/', 'archive-layout')
  }
  const rest = segments.slice(1)
  return rest.length ? rest.join('/') : null
}

function safeJoin(root, relative) {
  const target = path.resolve(root, ...relative.split('/'))
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (target !== root && !target.startsWith(prefix)) {
    throw new TarError('更新包条目试图跳出目标目录', 'archive-unsafe-path')
  }
  return target
}
