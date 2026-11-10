export function requireBrowser(ctx, req) {
  const connection = ctx.get('connection')
  if (!connection) return 503
  try {
    const rejection = connection.requestRejection({ headers: req.headers })
    return rejection || null
  } catch {
    return 403
  }
}

export function jsonResponse(res, status, value, headers = {}) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...headers
  })
  res.end(body)
}

export async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('invalid JSON body')
    error.status = 400
    throw error
  }
}
