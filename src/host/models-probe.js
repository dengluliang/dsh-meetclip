// 不预置网关地址：模型清单必须由用户填写服务地址后自行获取。
const DEFAULT_BASE_URL = ''
const MAX_KEY = 4096
const TIMEOUT_MS = 20_000

function normalizeBase(value) {
  const base = String(value || DEFAULT_BASE_URL).trim()
  if (!base) throw new Error('请先填写服务地址（Base URL）')
  let url
  try { url = new URL(base) } catch { throw new Error('网关地址无效') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('网关地址必须是 HTTPS，且不能包含凭证、查询参数或片段')
  }
  return url.toString().replace(/\/$/, '')
}

/** 只读列出网关模型；Key 只在本进程内存中使用，不落盘、不写日志。 */
export async function probeModelCatalog({ apiKey, baseUrl = DEFAULT_BASE_URL } = {}) {
  const key = String(apiKey || '').trim()
  if (!key || key.length > MAX_KEY || /\s/.test(key)) {
    throw new Error('API Key 不能为空、不能包含空白字符，且最多 4096 字符')
  }
  const target = normalizeBase(baseUrl) + '/models'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(target, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal
    })
    if (response.status >= 300 && response.status < 400) throw new Error('网关发生重定向，已拒绝发送凭证')
    if (response.status === 401 || response.status === 403) throw new Error('API Key 无效或没有模型权限')
    if (!response.ok) throw new Error(`网关返回 HTTP ${response.status}`)
    let data
    try { data = JSON.parse(await response.text()) } catch { throw new Error('网关没有返回模型列表') }
    const seen = new Set()
    const models = []
    for (const item of Array.isArray(data?.data) ? data.data : []) {
      const id = String(item?.id || '').trim()
      if (!id || id.endsWith(':batch') || seen.has(id)) continue
      seen.add(id)
      models.push(id)
    }
    return { ok: true, models, count: models.length }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('连接网关超时，请稍后重试')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
