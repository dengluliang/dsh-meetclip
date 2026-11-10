const DEFAULT_BASE_URL = 'https://api.llm.mioffice.cn/v1'
const DEFAULT_MODEL = 'xiaomi/mimo-v2.5-asr'
const MAX_KEY = 4096

function silenceWav(seconds = 0.5) {
  const sampleRate = 16000
  const samples = Math.max(1, Math.round(sampleRate * seconds))
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

/** 无需本地 Python 环境的最小云端 ASR 连通性测试；Key 只在本进程内存中使用。 */
export async function probeMimo({ apiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL } = {}) {
  const key = String(apiKey || '').trim()
  if (!key || key.length > MAX_KEY || /\s/.test(key)) throw new Error('API Key 不能为空、不能包含空白字符，且最多 4096 字符')
  let url
  try { url = new URL(String(baseUrl || DEFAULT_BASE_URL)) } catch { throw new Error('网关地址无效') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('网关地址必须是 HTTPS，且不能包含凭证、查询参数或片段')
  }
  const target = url.toString().replace(/\/$/, '') + '/chat/completions'
  const payload = {
    model: String(model || DEFAULT_MODEL),
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {
      data: 'data:audio/wav;base64,' + silenceWav(1).toString('base64')
    } }] }],
    asr_options: { language: 'auto' },
    stream: true
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  const started = Date.now()
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: controller.signal
    })
    if (response.status >= 300 && response.status < 400) throw new Error('网关发生重定向，已拒绝发送凭证')
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error('API Key 无效或没有该模型权限')
      throw new Error(`云端语音请求失败（HTTP ${response.status}）`)
    }
    let text = ''
    if (String(response.headers.get('content-type') || '').includes('text/event-stream') && response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (text.includes('[DONE]')) { try { await reader.cancel() } catch {} break }
        if (/"error"\s*:/.test(text)) break
      }
    } else {
      text = await response.text()
    }
    if (/"error"\s*:/.test(text)) throw new Error('云端语音返回错误，请检查 API Key 与模型权限')
    return { ok: true, message: 'API Key 验证通过', latency: Date.now() - started, model: String(model || DEFAULT_MODEL) }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('云端语音测试超时，请检查网络或 VPN')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
