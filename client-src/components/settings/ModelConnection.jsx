import {
  modelCatalog, probeModels, probeUsableModels, saveAIConfig, saveAsrEngine, testAIModel, testAsrEngine
} from '../../lib/api.js'
import {
  PREFERRED_SPEECH_MODEL, PREFERRED_TEXT_MODEL, modelOptions, preferModel,
  splitEntries, splitModels, withoutHidden
} from '../../lib/models.js'

const BASE_PLACEHOLDER = 'https://your-gateway.example/v1'

function cleanBase(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

/**
 * 「连接模型服务」的唯一入口。
 *
 * 先填地址与 Key，再点「连接并获取模型」；拉清单走 Host，不要求先保存，
 * 因此不会再出现「保存地址要先有模型、选模型要先有地址」的死锁。
 * 选好语音/文字模型后一次性保存，设置页、首页配置卡和首次引导共用同一套顺序。
 */
export function ModelConnection({
  t,
  initialBaseUrl = '',
  initialApiKey = '',
  initialAsr = '',
  initialText = '',
  hasSavedKey = false,
  compact = false,
  showSave = true,
  saveLabel = '保存并测试',
  onSaved
}) {
  const [baseUrl, setBaseUrl] = React.useState(cleanBase(initialBaseUrl))
  const [apiKey, setApiKey] = React.useState(initialApiKey)
  const [catalog, setCatalog] = React.useState(null)
  const [hidden, setHidden] = React.useState([])
  const [showHidden, setShowHidden] = React.useState(false)
  const [asrModel, setAsrModel] = React.useState(initialAsr || '')
  const [textModel, setTextModel] = React.useState(initialText || '')
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [asrProbe, setAsrProbe] = React.useState(null)
  const [textProbe, setTextProbe] = React.useState(null)

  const asrModels = catalog?.asr || []
  const textModels = showHidden ? (catalog?.text || []) : withoutHidden(catalog?.text || [], hidden)
  const asrOptions = modelOptions(asrModels, asrModel)
  const textOptions = modelOptions(textModels, textModel)
  const canConnect = Boolean(cleanBase(baseUrl)) && (Boolean(apiKey.trim()) || hasSavedKey)

  async function connect() {
    const base = cleanBase(baseUrl)
    if (!base) { setError('请先填写服务地址（Base URL）'); return }
    if (!apiKey.trim() && !hasSavedKey) { setError('请先粘贴 API Key'); return }
    setBusy('connect')
    setError('')
    setNotice('')
    try {
      // 有已保存 Key 且这次没重粘时，走后端读取已保存的 Key；否则用 Host 探针，
      // 这样首次引导/全新环境在后端启动前也能先拿到模型清单。
      const result = !apiKey.trim() && hasSavedKey
        ? await modelCatalog()
        : await probeModels({ apiKey: apiKey.trim(), baseUrl: base })
      const ids = Array.isArray(result?.models) ? result.models : []
      const entries = Array.isArray(result?.entries) ? result.entries : []
      if (!ids.length && !entries.length) throw new Error('网关没有返回可用模型，请检查地址与 Key')
      const split = entries.length ? splitEntries(entries) : splitModels(ids)
      const nextAsr = preferModel(split.asr, PREFERRED_SPEECH_MODEL) || split.asr[0] || asrModel
      const nextText = preferModel(split.text, PREFERRED_TEXT_MODEL)
        || split.text.find((id) => id.split('/')[0] === String(nextAsr).split('/')[0])
        || split.text[0] || textModel
      setCatalog({ count: Number(result?.count) || ids.length, asr: split.asr, text: split.text })
      setAsrModel(nextAsr)
      setTextModel(nextText)
      setNotice(`已获取 ${Number(result?.count) || ids.length} 个模型，请确认语音与文字模型`)
      probeUsableModels({ apiKey: apiKey.trim(), baseUrl: base, models: split.text })
        .then((value) => { if (value?.ok) setHidden(Array.isArray(value.hidden) ? value.hidden : []) })
        .catch(() => {})
    } catch (failure) {
      setCatalog(null)
      setError(failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

  async function probeAsr() {
    if (!asrModel) { setAsrProbe({ ok: false, text: '请先选择语音模型' }); return }
    setAsrProbe({ busy: true, text: '正在用 1 秒静音测试…' })
    try {
      const result = await testAsrEngine({
        provider: 'mimo', base_url: cleanBase(baseUrl), model: asrModel,
        api_key: apiKey.trim() || undefined
      })
      setAsrProbe({ ok: true, text: `语音模型可用：${result?.model || asrModel}` })
    } catch (failure) {
      setAsrProbe({ ok: false, text: `语音测试未通过：${failure?.message || '连接失败'}` })
    }
  }

  async function probeText() {
    if (!textModel) { setTextProbe({ ok: false, text: '请先选择文字模型' }); return }
    setTextProbe({ busy: true, text: '正在请求文字模型…' })
    try {
      const result = await testAIModel({
        provider: 'mimo', base_url: cleanBase(baseUrl), model: textModel,
        api_key: apiKey.trim() || undefined
      })
      if (result?.ok) setTextProbe({ ok: true, text: `文字模型可用：${result.model || textModel}${result.seconds ? `（${result.seconds}s）` : ''}` })
      else setTextProbe({ ok: false, text: `文字测试未通过：${result?.message || 'Key 或模型不可用'}` })
    } catch (failure) {
      setTextProbe({ ok: false, text: `文字测试未通过：${failure?.message || '连接失败'}` })
    }
  }

  async function save() {
    const base = cleanBase(baseUrl)
    if (!base) { setError('请先填写服务地址（Base URL）'); return }
    if (!asrModel) { setError('请先选择语音转文字模型'); return }
    if (!textModel) { setError('请先选择文字总结模型'); return }
    if (!apiKey.trim() && !hasSavedKey) { setError('请先粘贴 API Key'); return }
    setBusy('save')
    setError('')
    setNotice('')
    try {
      await saveAsrEngine({
        mode: 'default', provider: 'mimo', base_url: base, model: asrModel,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {})
      })
      await saveAIConfig({ provider: 'mimo', base_url: base, model: textModel })
      await probeAsr()
      await probeText()
      setNotice('已保存，并完成一次连接测试')
      await onSaved?.({ baseUrl: base, asrModel, textModel })
      setApiKey('')
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className={`mc-model-connection${compact ? ' is-compact' : ''}`}>
      <label className="mc-form-row">
        <span>服务地址</span>
        <input className="mc-input" value={baseUrl} spellCheck={false} placeholder={BASE_PLACEHOLDER}
          onChange={(event) => { setBaseUrl(event.target.value); setError('') }} />
      </label>
      <label className="mc-form-row">
        <span>API Key</span>
        <input className="mc-input" type="password" value={apiKey} autoComplete="off" spellCheck={false}
          placeholder={hasSavedKey ? '已配置；留空则不修改' : '粘贴 API Key'}
          onChange={(event) => { setApiKey(event.target.value); setError('') }} />
      </label>
      <div className="mc-actions">
        <button type="button" className="mc-button" data-variant={catalog ? undefined : 'primary'}
          disabled={busy === 'connect' || !canConnect} onClick={connect}>
          {busy === 'connect' ? '连接中…' : catalog ? '重新获取模型' : '连接并获取模型'}
        </button>
        {catalog ? <span className="mc-foot-meta">已获取 {catalog.count} 个模型</span> : null}
      </div>

      {catalog ? (
        <>
          <label className="mc-form-row">
            <span>语音转文字</span>
            <select className="mc-input mc-select" value={asrModel} onChange={(event) => setAsrModel(event.target.value)}>
              {asrOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="mc-form-row">
            <span>文字总结</span>
            <select className="mc-input mc-select" value={textModel} onChange={(event) => setTextModel(event.target.value)}>
              {textOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          {hidden.length ? (
            <p className="mc-foot-meta">
              已隐藏 {hidden.length} 个这个 Key 调不通的模型
              <button type="button" className="mc-link-button" onClick={() => setShowHidden((value) => !value)}>
                {showHidden ? '只看可用' : '显示全部'}
              </button>
            </p>
          ) : null}
          {showSave ? (
            <div className="mc-actions">
              <button type="button" className="mc-button" disabled={Boolean(busy)} onClick={probeAsr}>测试语音</button>
              <button type="button" className="mc-button" disabled={Boolean(busy)} onClick={probeText}>测试文字</button>
              <button type="button" className="mc-button" data-variant="primary" disabled={Boolean(busy)} onClick={save}>
                {busy === 'save' ? '保存中…' : saveLabel}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {asrProbe ? <p className="mc-form-note" data-tone={asrProbe.ok ? undefined : 'error'}>{asrProbe.text}</p> : null}
      {textProbe ? <p className="mc-form-note" data-tone={textProbe.ok ? undefined : 'error'}>{textProbe.text}</p> : null}
      {notice ? <p className="mc-form-note" role="status">{notice}</p> : null}
      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
      <p className="mc-foot-meta">
        Key 只保存在本机钥匙串。网关地址可以是公司网关、代理或你自己的 OpenAI 兼容服务。
      </p>
    </div>
  )
}
