import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { ensureDir } from './config.js'

const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.flv', '.webm', '.m4v', '.ts',
  '.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus'
])
const MAX_UPLOAD = 8 * 1024 * 1024 * 1024

// 多选结果用 ASCII 单元分隔符拼接，文件名里的空格、逗号、中文和换行都不会拆错。
const PICKER_SEPARATOR = '\u001f'

/**
 * 只选择路径，不执行；便于单测多选脚本。
 * 媒体选择器故意不写 `of type {"public.movie","public.audio"}`：
 * mkv/flv/ts 等容器在 macOS 上不一定归入这两个 UTI，会被系统置灰。
 * 扩展名由 Host 上传与后端 IMPORT_RE 再校验。
 */
export function pickerScript(kind, multiple = false) {
  if (kind === 'directory') return 'POSIX path of (choose folder with prompt "选择会摘存储位置")'
  if (!multiple) return 'POSIX path of (choose file with prompt "选择音视频文件")'
  return [
    'set picked to choose file with prompt "选择音视频文件（可多选）" with multiple selections allowed',
    'if class of picked is not list then set picked to {picked}',
    'set sep to character id 31',
    'set out to ""',
    'repeat with i from 1 to count of picked',
    '  set p to item i of picked',
    '  if i is 1 then',
    '    set out to POSIX path of p',
    '  else',
    '    set out to out & sep & (POSIX path of p)',
    '  end if',
    'end repeat',
    'return out'
  ].join('\n')
}

export function parsePickedPaths(stdout) {
  return String(stdout || '')
    .split(PICKER_SEPARATOR)
    .map((value) => value.replace(/^[\r\n]+|[\r\n]+$/g, ''))
    .filter((value) => value.trim().length > 0)
}

export function pickFile(kind, options = {}) {
  if (typeof options === 'number') options = { timeoutMs: options }
  const multiple = kind !== 'directory' && options.multiple === true
  const timeoutMs = Number(options.timeoutMs) || 300_000
  const script = pickerScript(kind, multiple)
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const text = String(stderr || error.message || '')
        if (/User canceled|用户已取消|-128/i.test(text)) {
          resolve({ ok: false, cancelled: true })
          return
        }
        resolve({ ok: false, cancelled: false, error: text.trim().slice(0, 500) })
        return
      }
      const paths = parsePickedPaths(stdout)
      if (!paths.length) {
        resolve({ ok: false, cancelled: true })
        return
      }
      resolve({ ok: true, path: paths[0], paths })
    })
  })
}

export function cleanupUploads(settings, maxAgeDays = 7) {
  try {
    if (!fs.existsSync(settings.uploadDir)) return
    const cutoff = Date.now() - maxAgeDays * 86400 * 1000
    for (const entry of fs.readdirSync(settings.uploadDir)) {
      const target = path.join(settings.uploadDir, entry)
      try {
        const stat = fs.statSync(target)
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(target, { force: true })
      } catch {}
    }
  } catch {}
}

export async function receiveUpload(req, res, settings) {
  cleanupUploads(settings)
  const rawName = String(req.headers['x-filename'] || 'upload')
  let name = rawName
  try { name = decodeURIComponent(rawName) } catch {}
  name = path.basename(name).replace(/[^\w.\- ()（）]+/g, '_').slice(-120)
  const extension = path.extname(name).toLowerCase()
  if (!MEDIA_EXTENSIONS.has(extension)) {
    return respond(res, 400, { detail: '仅支持常见音视频文件（mp4/mov/mkv/flv/webm/m4v/ts/mp3/m4a/wav/aac/flac/ogg/opus）' })
  }
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > MAX_UPLOAD) {
    return respond(res, 413, { detail: '单个文件不能超过 8 GB' })
  }
  ensureDir(settings.uploadDir)
  const free = freeBytes(settings.uploadDir)
  if (free !== null && free < 1024 * 1024 * 1024) {
    return respond(res, 507, { detail: '磁盘可用空间不足 1 GB' })
  }
  const id = randomUUID()
  const target = path.join(settings.uploadDir, `${id}${extension}`)
  let bytes = 0
  let failed = null
  const stream = fs.createWriteStream(target, { mode: 0o600 })
  try {
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        if (failed) return
        failed = error
        try { stream.destroy() } catch {}
        try { req.destroy() } catch {}
        reject(error)
      }
      req.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_UPLOAD) fail(new Error('文件超过 8 GB'))
      })
      req.on('error', fail)
      stream.on('error', fail)
      stream.on('finish', resolve)
      req.pipe(stream)
    })
    if (failed) throw failed
    if (bytes === 0) throw new Error('上传内容为空')
    return respond(res, 200, {
      ok: true,
      uploadId: id,
      name,
      path: target,
      bytes
    })
  } catch (error) {
    try { fs.rmSync(target, { force: true }) } catch {}
    return respond(res, error?.message === '文件超过 8 GB' ? 413 : 400, {
      detail: error?.message || '上传失败'
    })
  }
}

export function revealSession(settings, sessionId) {
  const id = String(sessionId || '')
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    return Promise.resolve({ ok: false, error: '无效的记录 ID' })
  }
  const dir = path.join(settings.dataDir, id)
  if (!fs.existsSync(dir)) {
    return Promise.resolve({ ok: false, error: '记录目录不存在' })
  }
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-R', dir], (error) => {
      if (error) resolve({ ok: false, error: String(error.message || error) })
      else resolve({ ok: true })
    })
  })
}

export function openTarget(settings, target) {
  const map = {
    data: [settings.dataDir, false],
    state: [settings.stateDir, false],
    logs: [settings.logPath, true]
  }
  const entry = map[target]
  if (!entry) return Promise.resolve({ ok: false, error: '未知的打开目标' })
  const [file, reveal] = entry
  return new Promise((resolve) => {
    execFile('/usr/bin/open', reveal ? ['-R', file] : [file], (error) => {
      if (error) resolve({ ok: false, error: String(error.message || error) })
      else resolve({ ok: true })
    })
  })
}

/** Open an external https page in the user's browser (allowlist checked by the caller). */
export function openUrl(url) {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', [String(url)], (error) => {
      if (error) resolve({ ok: false, error: String(error.message || error) })
      else resolve({ ok: true })
    })
  })
}

function respond(res, status, value) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function freeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}
