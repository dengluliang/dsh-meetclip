import {
  asrEngines, aiStatus, checkAI, modelCatalog, probeUsableCatalog, removeAIKey, saveAIConfig, saveAIKey, saveAsrEngine, testAIModel, testAsrEngine
} from '../lib/api.js'
import { modelOptions, splitEntries, splitModels, withoutHidden } from '../lib/models.js'

// 不预置任何网关地址与模型：用户填自己的 OpenAI 兼容服务，占位符只是格式示例。
const BASE_PLACEHOLDER = 'https://your-gateway.example/v1'
const MODEL_PLACEHOLDER = 'your-asr-model'
const TEXT_MODEL_PLACEHOLDER = 'your-text-model'

function mask(hasKey, placeholder) {
  return hasKey ? '已配置；留空则不修改' : placeholder
}

export function SettingsModels({ t }) {
  const [asr, setAsr] = React.useState(null)
  const [ai, setAi] = React.useState(null)
  const [models, setModels] = React.useState([])
  const [entries, setEntries] = React.useState([])
  // 拉完清单后在后台探测：只隐藏网关明确调不通的模型。
  const [hidden, setHidden] = React.useState([])
  const [showHidden, setShowHidden] = React.useState(false)
  const [filtering, setFiltering] = React.useState(false)
  const [catalogError, setCatalogError] = React.useState('')
  const [keyDraft, setKeyDraft] = React.useState('')
  const [defaultAsr, setDefaultAsr] = React.useState('')
  const [defaultText, setDefaultText] = React.useState('')
  const [asrBase, setAsrBase] = React.useState('')
  const [aiBase, setAiBase] = React.useState('')
  const [asrCustom, setAsrCustom] = React.useState({ base_url: '', model: '', api_key: '' })
  const [aiCustom, setAiCustom] = React.useState({ base_url: '', model: '', api_key: '' })
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [asrProbe, setAsrProbe] = React.useState(null)
  const [textProbe, setTextProbe] = React.useState(null)

  const load = React.useCallback(async () => {
    const [nextAsr, nextAi] = await Promise.all([asrEngines(), aiStatus()])
    setAsr(nextAsr)
    setAi(nextAi)
    setDefaultAsr(nextAsr?.custom?.enabled ? (nextAsr.default_model || '') : (nextAsr?.model || ''))
    setAsrBase(nextAsr?.custom?.enabled ? '' : (nextAsr?.default_base_url || nextAsr?.base_url || ''))
    setDefaultText(nextAi?.provider === 'mimo' ? (nextAi?.model || '') : '')
    setAiBase(nextAi?.provider === 'mimo' ? (nextAi?.base_url || '') : '')
    setAsrCustom({
      base_url: nextAsr?.custom?.base_url || '',
      model: nextAsr?.custom?.model || '',
      api_key: ''
    })
    setAiCustom({
      base_url: nextAi?.provider && nextAi.provider !== 'mimo' ? (nextAi.base_url || '') : '',
      model: nextAi?.provider && nextAi.provider !== 'mimo' ? (nextAi.model || '') : '',
      api_key: ''
    })
    return nextAsr
  }, [])

  const pullCatalog = React.useCallback(async () => {
    try {
      const result = await modelCatalog()
      setModels(Array.isArray(result?.models) ? result.models : [])
      setEntries(Array.isArray(result?.entries) ? result.entries : [])
      setCatalogError(result?.error || '')
      return result
    } catch (failure) {
      setModels([])
      setCatalogError(failure?.message || '拉取失败')
      return null
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    load()
      .then((nextAsr) => { if (!cancelled && (nextAsr?.default_has_key ?? nextAsr?.has_api_key)) return pullCatalog() })
      .catch((failure) => { if (!cancelled) setError(failure?.message || String(failure)) })
    return () => { cancelled = true }
  }, [load, pullCatalog])

  // 粘贴完整 Key 后自动保存并拉取，省掉“要再点一下按钮”的步骤。
  React.useEffect(() => {
    const key = keyDraft.trim()
    if (key.length < 24) return undefined
    const timer = setTimeout(() => { saveKeyAndPull() }, 800)
    return () => clearTimeout(timer)
  }, [keyDraft])

  async function run(label, operation) {
    setBusy(label)
    setError('')
    setNotice('')
    try {
      return await operation()
    } catch (failure) {
      setError(failure?.message || String(failure))
      return null
    } finally {
      setBusy('')
    }
  }

  async function saveKeyAndPull() {
    const key = keyDraft.trim()
    if (key && /\s/.test(key)) {
      setError('Key 不能包含空格或换行，请只粘贴 Key 本身')
      return
    }
    await run('key', async () => {
      setCatalogError('')
      if (key) {
        await saveAsrEngine({ mode: 'key', api_key: key })
        setNotice('Key 已保存，正在拉取模型清单…')
      }
      const result = await pullCatalog()
      if (result?.models?.length) filterUsable()
      if (result?.models?.length) {
        setKeyDraft('')
        setNotice(`已获取 ${result.models.length} 个模型`)
      } else if (result) {
        setNotice('没有获取到模型清单')
      }
      await load()
    })
  }

  /** 后台跑一轮可用性探测；失败就保持完整列表。 */
  async function filterUsable() {
    setFiltering(true)
    try {
      const result = await probeUsableCatalog()
      if (result?.ok) setHidden(Array.isArray(result.hidden) ? result.hidden : [])
    } catch {
      // 探测失败不影响选模型，列表保持原样。
    } finally {
      setFiltering(false)
    }
  }

  async function chooseAsrModel(model) {
    if (!model) return
    if (!asrBase.trim()) { setError('请先填写语音服务地址（Base URL）'); return }
    await run('asr-model', async () => {
      await saveAsrEngine({ mode: 'default', provider: 'mimo', base_url: asrBase.trim(), model })
      setDefaultAsr(model)
      await load()
      setNotice(`语音转文字已使用 ${model}`)
    })
  }

  async function saveAsrBase() {
    const base = asrBase.trim()
    if (!base) { setError('请先填写语音服务地址（Base URL）'); return }
    if (!defaultAsr) { setError('请先填写语音模型 ID'); return }
    await run('asr-base', async () => {
      await saveAsrEngine({ mode: 'default', provider: 'mimo', base_url: base, model: defaultAsr })
      await pullCatalog()
      await load()
      setNotice('语音服务地址已保存')
    })
  }

  async function saveAiBase() {
    const base = aiBase.trim()
    if (!base) { setError('请先填写文字服务地址（Base URL）'); return }
    if (!defaultText) { setError('请先填写文字模型 ID'); return }
    await run('ai-base', async () => {
      await saveAIConfig({ provider: 'mimo', base_url: base, model: defaultText })
      await load()
      setNotice('文字服务地址已保存')
    })
  }

  async function chooseTextModel(model) {
    const value = String(model || '').trim()
    if (!value || (ai?.provider === 'mimo' && value === ai?.model && !ai?.own_key)) return
    if (!aiBase.trim()) { setError('请先填写文字服务地址（Base URL）'); return }
    await run('text-model', async () => {
      await saveAIConfig({ provider: 'mimo', base_url: aiBase.trim(), model: value })
      if (ai?.own_key) { try { await removeAIKey() } catch {} }
      setDefaultText(value)
      await load()
    })
  }

  // 「测试连接」：直接测下拉里当前选中的模型（含还没保存的选择），不写设置。
  async function probeAsrModel() {
    const model = String(asrCustomOn ? asrCustom.model : defaultAsr || asr?.model || '').trim()
    const base = String(asrCustomOn ? asrCustom.base_url.trim() : asrBase.trim()).trim()
    if (!model) { setAsrProbe({ ok: false, text: '请先选择或填写模型' }); return }
    if (!base) { setAsrProbe({ ok: false, text: '请先填写 Base URL' }); return }
    setAsrProbe({ state: 'busy', text: '正在用 1 秒静音测试…' })
    try {
      const result = await testAsrEngine({
        provider: 'mimo',
        base_url: base,
        model,
        api_key: asrCustomOn ? asrCustom.api_key.trim() : ''
      })
      setAsrProbe({ ok: true, text: `模型可用：${result?.model || model}（${result?.message || '测试请求成功'}）` })
    } catch (failure) {
      setAsrProbe({ ok: false, text: `测试未通过：${failure?.message || '连接失败'}` })
    }
  }

  async function probeTextModel() {
    const custom = aiCustomOn
    const model = String(custom ? aiCustom.model : defaultText || ai?.model || '').trim()
    const base = String(custom ? aiCustom.base_url : aiBase).trim()
    if (!model) { setTextProbe({ ok: false, text: '请先选择或填写模型' }); return }
    if (!base) { setTextProbe({ ok: false, text: '请先填写 Base URL' }); return }
    setTextProbe({ state: 'busy', text: '正在请求模型…' })
    try {
      const result = await testAIModel({
        provider: custom ? 'custom' : 'mimo',
        base_url: base,
        model,
        api_key: custom ? aiCustom.api_key.trim() : ''
      })
      if (result?.ok) {
        setTextProbe({ ok: true, text: `模型可用：${result.model || model}${result.seconds ? `（${result.seconds}s）` : ''}` })
      } else {
        setTextProbe({ ok: false, text: `测试未通过：${result?.message || 'Key 或模型不可用'}` })
      }
    } catch (failure) {
      setTextProbe({ ok: false, text: `测试未通过：${failure?.message || '连接失败'}` })
    }
  }

  async function saveAsrCustom() {
    const base = asrCustom.base_url.trim()
    const model = asrCustom.model.trim()
    if (!base || !model) { setError('Base URL 与模型 ID 都不能为空'); return }
    if (!asrCustom.api_key.trim() && !asr?.custom?.has_key) { setError('请填写自定义 API Key'); return }
    await run('asr-custom', async () => {
      await saveAsrEngine({ mode: 'custom', base_url: base, model, api_key: asrCustom.api_key.trim() || undefined })
      setAsrCustom((value) => ({ ...value, api_key: '' }))
      await load()
      setNotice('已保存，正在测试连接…')
      await testAsrEngine()
      setNotice('自定义 API 已保存并通过测试')
    })
  }

  async function resetAsrCustom() {
    await run('asr-reset', async () => {
      await saveAsrEngine({ mode: 'default', provider: 'mimo', base_url: asrBase.trim() || asr?.default_base_url || '',
                            model: defaultAsr || asr?.default_model })
      setAsrCustom({ base_url: '', model: '', api_key: '' })
      setNotice('已恢复默认网关')
      await load()
    })
  }

  async function saveAiCustom() {
    const base = aiCustom.base_url.trim()
    const model = aiCustom.model.trim()
    if (!base || !model) { setError('Base URL 与模型 ID 都不能为空'); return }
    if (!aiCustom.api_key.trim() && !ai?.own_key) { setError('请填写自定义 API Key'); return }
    await run('ai-custom', async () => {
      if (aiCustom.api_key.trim()) await saveAIKey(aiCustom.api_key.trim())
      await saveAIConfig({ provider: 'custom', base_url: base, model })
      setAiCustom((value) => ({ ...value, api_key: '' }))
      const result = await checkAI()
      if (result?.ok) setNotice(`自定义 API 已保存，Key 可用（${result.seconds}s）`)
      else setNotice(`已保存；测试未通过：${result?.message || 'Key 不可用'}`)
      await load()
    })
  }

  async function resetAiCustom() {
    await run('ai-reset', async () => {
      await saveAIConfig({ provider: 'mimo', base_url: aiBase.trim(), model: defaultText || ai?.model || '' })
      if (ai?.own_key) { try { await removeAIKey() } catch {} }
      setAiCustom({ base_url: '', model: '', api_key: '' })
      setNotice('已恢复默认网关')
      await load()
    })
  }

  const asrCustomOn = Boolean(asr?.custom?.enabled)
  const aiCustomOn = Boolean(ai?.provider && ai.provider !== 'mimo')
  const { asr: asrModels, text: allTextModels } = entries.length ? splitEntries(entries) : splitModels(models)
  const textModels = showHidden ? allTextModels : withoutHidden(allTextModels, hidden)
  const asrOptions = modelOptions(asrModels, asrCustomOn ? asr?.default_model : defaultAsr)
  const textOptions = modelOptions(textModels, aiCustomOn ? '' : defaultText)

  return (
    <div className="mc-settings-panel">
      <section className="mc-section">
        <div className="mc-section-title">API Key</div>
        <div className="mc-card">
          <label className="mc-form-row">
            <span>API Key</span>
            <input className="mc-input" type="password" value={keyDraft} autoComplete="off" spellCheck={false}
              placeholder={/无效|401|403/.test(catalogError) ? 'Key 无效，请重新粘贴 API Key' : mask(asr?.default_has_key, '粘贴 API Key')}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') saveKeyAndPull() }} />
          </label>
          <p className="mc-form-note">更新 Key 后，点「拉取模型清单」。</p>
          <div className="mc-actions">
            <button type="button" className="mc-button" data-variant="primary" disabled={Boolean(busy)} onClick={saveKeyAndPull}>
              {busy === 'key' ? '拉取中…' : '拉取模型清单'}
            </button>
          </div>
          {catalogError ? <p className="mc-form-note" data-tone="error">{catalogError}</p> : null}
        </div>
      </section>

      <section className="mc-section">
        <div className="mc-section-title">语音转文字</div>
        <div className="mc-card">
          <div className="mc-form-row">
            <span>模型</span>
            <div className="mc-model-row">
              <select className="mc-input mc-select" value={asrCustomOn ? '' : defaultAsr}
                disabled={Boolean(busy) || asrCustomOn}
                onChange={(event) => { setAsrProbe(null); chooseAsrModel(event.target.value) }}>
                {asrCustomOn ? <option value="">使用自定义 API：{asr?.model}</option> : null}
                {asrOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)}
                onClick={probeAsrModel}>
                {asrProbe?.state === 'busy' ? '测试中…' : '测试连接'}
              </button>
            </div>
          </div>
          <div className="mc-form-row">
            <span>服务地址</span>
            <div className="mc-model-row">
              <input className="mc-input" value={asrCustomOn ? asrCustom.base_url : asrBase} spellCheck={false}
                disabled={Boolean(busy) || asrCustomOn} placeholder={BASE_PLACEHOLDER}
                onChange={(event) => setAsrBase(event.target.value)} />
              <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy) || asrCustomOn}
                onClick={saveAsrBase}>
                {busy === 'asr-base' ? '保存中…' : '保存地址'}
              </button>
            </div>
          </div>
          {asrProbe && asrProbe.state !== 'busy' ? (
            <p className="mc-form-note" data-tone={asrProbe.ok ? undefined : 'error'} role="status">{asrProbe.text}</p>
          ) : null}
          {asrProbe?.state === 'busy' ? <p className="mc-form-note">{asrProbe.text}</p> : null}
          <details className="mc-settings-details" open={asrCustomOn}>
            <summary>自定义 API</summary>
            <div className="mc-form">
              <label className="mc-form-row">
                <span>Base URL</span>
                <input className="mc-input" value={asrCustom.base_url} spellCheck={false}
                  placeholder={BASE_PLACEHOLDER}
                  onChange={(event) => setAsrCustom((value) => ({ ...value, base_url: event.target.value }))} />
              </label>
              <label className="mc-form-row">
                <span>模型 ID</span>
                <input className="mc-input" value={asrCustom.model} spellCheck={false}
                  placeholder={MODEL_PLACEHOLDER}
                  onChange={(event) => setAsrCustom((value) => ({ ...value, model: event.target.value }))} />
              </label>
              <label className="mc-form-row">
                <span>API Key</span>
                <input className="mc-input" type="password" value={asrCustom.api_key} autoComplete="off"
                  placeholder={mask(asr?.custom?.has_key, '粘贴自定义 API Key')}
                  onChange={(event) => setAsrCustom((value) => ({ ...value, api_key: event.target.value }))} />
              </label>
              <div className="mc-actions">
                <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={saveAsrCustom}>
                  {busy === 'asr-custom' ? '保存并测试中…' : '保存并测试连接'}
                </button>
                {asrCustomOn ? (
                  <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={resetAsrCustom}>
                    恢复默认
                  </button>
                ) : null}
              </div>
            </div>
          </details>
        </div>
      </section>

      <section className="mc-section">
        <div className="mc-section-title">文字总结</div>
        <div className="mc-card">
          <div className="mc-form-row">
            <span>模型</span>
            <div className="mc-model-row">
              <select className="mc-input mc-select" value={aiCustomOn ? '' : defaultText}
                disabled={Boolean(busy) || aiCustomOn}
                onChange={(event) => { setTextProbe(null); chooseTextModel(event.target.value) }}>
                {aiCustomOn ? <option value="">使用自定义 API：{ai?.model}</option> : null}
                {textOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)}
                onClick={probeTextModel}>
                {textProbe?.state === 'busy' ? '测试中…' : '测试连接'}
              </button>
            </div>
          </div>
          <div className="mc-form-row">
            <span>服务地址</span>
            <div className="mc-model-row">
              <input className="mc-input" value={aiCustomOn ? aiCustom.base_url : aiBase} spellCheck={false}
                disabled={Boolean(busy) || aiCustomOn} placeholder={BASE_PLACEHOLDER}
                onChange={(event) => setAiBase(event.target.value)} />
              <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy) || aiCustomOn}
                onClick={saveAiBase}>
                {busy === 'ai-base' ? '保存中…' : '保存地址'}
              </button>
            </div>
          </div>
          {textProbe && textProbe.state !== 'busy' ? (
            <p className="mc-form-note" data-tone={textProbe.ok ? undefined : 'error'} role="status">{textProbe.text}</p>
          ) : null}
          {textProbe?.state === 'busy' ? <p className="mc-form-note">{textProbe.text}</p> : null}
          <details className="mc-settings-details" open={aiCustomOn}>
            <summary>自定义 API</summary>
            <div className="mc-form">
              <label className="mc-form-row">
                <span>Base URL</span>
                <input className="mc-input" value={aiCustom.base_url} spellCheck={false}
                  placeholder={BASE_PLACEHOLDER}
                  onChange={(event) => setAiCustom((value) => ({ ...value, base_url: event.target.value }))} />
              </label>
              <label className="mc-form-row">
                <span>模型 ID</span>
                <input className="mc-input" value={aiCustom.model} spellCheck={false}
                  placeholder={TEXT_MODEL_PLACEHOLDER}
                  onChange={(event) => setAiCustom((value) => ({ ...value, model: event.target.value }))} />
              </label>
              <label className="mc-form-row">
                <span>API Key</span>
                <input className="mc-input" type="password" value={aiCustom.api_key} autoComplete="off"
                  placeholder={mask(ai?.own_key, '粘贴自定义 API Key')}
                  onChange={(event) => setAiCustom((value) => ({ ...value, api_key: event.target.value }))} />
              </label>
              <div className="mc-actions">
                <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={saveAiCustom}>
                  {busy === 'ai-custom' ? '保存并测试中…' : '保存并测试连接'}
                </button>
                {aiCustomOn ? (
                  <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={resetAiCustom}>
                    恢复默认
                  </button>
                ) : null}
              </div>
            </div>
          </details>
        </div>
      </section>

      {notice ? <p className="mc-card-text" role="status">{notice}</p> : null}
      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
    </div>
  )
}
