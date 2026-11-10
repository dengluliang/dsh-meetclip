import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './config.js'

const MAX_UPLOAD = 8 * 1024 * 1024 * 1024
const ALLOWED = new Set(['.mp4', '.webm', '.mov', '.mkv', '.ts'])

export async function receiveFallbackUpload(req, res, runtime) {
  let url
  try {
    url = new URL(req.url, 'http://127.0.0.1')
  } catch {
    return json(res, 400, { detail: '无效请求' })
  }
  const sessionId = String(url.searchParams.get('session_id') || '')
  const token = String(url.searchParams.get('token') || '')
  const target = String(url.searchParams.get('target') || '')
  if (!sessionId || !token || !target) return json(res, 400, { detail: '缺少内录参数' })

  const sessionDir = path.resolve(runtime.settings.dataDir, sessionId)
  const targetPath = path.resolve(target)
  if (!targetPath.startsWith(sessionDir + path.sep)) {
    return json(res, 403, { detail: '内录文件必须位于当前记录目录' })
  }
  const extension = path.extname(targetPath).toLowerCase()
  if (!ALLOWED.has(extension)) return json(res, 400, { detail: '不支持的内录文件扩展名' })
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > MAX_UPLOAD) return json(res, 413, { detail: '内录文件不能超过 8 GB' })

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.accessSync(path.dirname(targetPath), fs.constants.W_OK)
  } catch (error) {
    return json(res, 500, { detail: `无法写入记录目录：${error?.message || error}` })
  }

  let bytes = 0
  let failed = null
  const stream = fs.createWriteStream(targetPath, { mode: 0o600 })
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
        if (bytes > MAX_UPLOAD) fail(new Error('内录文件超过 8 GB'))
      })
      req.on('error', fail)
      stream.on('error', fail)
      stream.on('finish', resolve)
      req.pipe(stream)
    })
    if (failed || bytes < 1024) throw failed || new Error('内录内容过短')
    const completed = await runtime.backend.json(
      `/api/link-videos/${encodeURIComponent(sessionId)}/fallback/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: targetPath, token })
      }
    )
    return json(res, 200, { ok: true, bytes, path: targetPath, result: completed })
  } catch (error) {
    try { fs.rmSync(targetPath, { force: true }) } catch {}
    return json(res, error?.message === '内录文件超过 8 GB' ? 413 : 400, {
      detail: error?.message || '内录失败'
    })
  }
}

function json(res, status, value) {
  if (res.headersSent) { res.end(); return }
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store'
  })
  res.end(body)
}
