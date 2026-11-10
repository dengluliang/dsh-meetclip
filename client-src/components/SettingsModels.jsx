import {
  asrEngines, aiStatus, checkAI, modelCatalog, removeAIKey, saveAIConfig, saveAIKey, saveAsrEngine, testAIModel, testAsrEngine
} from '../lib/api.js'
import { modelOptions, splitModels } from '../lib/models.js'

const MIMO_BASE = 'https://api.llm.mioffice.cn/v1'
const DEFAULT_TEXT = 'xiaomi/mimo-v2.5'

function mask(hasKey, placeholder) {
  return hasKey ? '已配置；留空则不修改' : placeholder
}

export function SettingsModels({ t }) {
  const [asr, setAsr] = React.useState(null)
  const [ai, setAi] = React.useState(null)
  const [models, setModels] = React.useState([])
  const [catalogError, setCatalogError] = React.useState('')
  const [keyDraft, setKeyDraft] = React.useState('')
  const [mifyAsr, setMifyAsr] = React.useState('')
  const [mifyText, setMifyText] = React.useState(DEFAULT_TEXT)
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
    setMifyAsr(nextAsr?.custom?.enabled ? (nextAsr.mify_model || '') : (nextAsr?.model || ''))
    setMifyText(nextAi?.provider === 'mimo' ? (nextAi?.model || DEFAULT_TEXT) : DEFAULT_TEXT)
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
      .then((nextAsr) => { if (!cancelled && (nextAsr?.mify_has_key ?? nextAsr?.has_api_key)) return pullCatalog() })
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
      if (result?.models?.length) {
        setKeyDraft('')
        setNotice(`已获取 ${result.models.length} 个模型`)
      } else if (result) {
        setNotice('没有获取到模型清单')
      }
      await load()
    })
  }

  async function chooseAsrModel(model) {
    if (!model) return
    await run('asr-model', async () => {
      await saveAsrEngine({ mode: 'mify', provider: 'mimo', base_url: MIMO_BASE, model })
      setMifyAsr(model)
      await load()
    })
  }

  async function chooseTextModel(model) {
    const value = String(model || '').trim()
    if (!value || (ai?.provider === 'mimo' && value === ai?.model && !ai?.own_key)) return
    await run('text-model', async () => {
      await saveAIConfig({ provider: 'mimo', base_url: '', model: value })
      if (ai?.own_key) { try { await removeAIKey() } catch {} }
      setMifyText(value)
      await load()
    })
  }

  // 「测试连接」：直接测下拉里当前选中的模型（含还没保存的选择），不写设置。
  async function probeAsrModel() {
    const model = String(asrCustomOn ? asrCustom.model : mifyAsr || asr?.model || '').trim()
    if (!model) { setAsrProbe({ ok: false, text: '请先选择或填写模型' }); return }
    setAsrProbe({ state: 'busy', text: '正在用 1 秒静音测试…' })
    try {
      const result = await testAsrEngine({
        provider: 'mimo',
        base_url: asrCustomOn ? asrCustom.base_url.trim() : MIMO_BASE,
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
    const model = String(custom ? aiCustom.model : mifyText || ai?.model || '').trim()
    if (!model) { setTextProbe({ ok: false, text: '请先选择或填写模型' }); return }
    if (custom && !aiCustom.base_url.trim()) { setTextProbe({ ok: false, text: '请先填写 Base URL' }); return }
    setTextProbe({ state: 'busy', text: '正在请求模型…' })
    try {
      const result = await testAIModel({
        provider: custom ? 'custom' : 'mimo',
        base_url: custom ? aiCustom.base_url.trim() : '',
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
      await saveAsrEngine({ mode: 'mify', provider: 'mimo', base_url: MIMO_BASE, model: mifyAsr || asr?.mify_model })
      setAsrCustom({ base_url: '', model: '', api_key: '' })
      setNotice('已恢复 Mify')
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
      await saveAIConfig({ provider: 'mimo', base_url: '', model: mifyText || DEFAULT_TEXT })
      if (ai?.own_key) { try { await removeAIKey() } catch {} }
      setAiCustom({ base_url: '', model: '', api_key: '' })
      setNotice('已恢复 Mify')
      await load()
    })
  }

  const asrCustomOn = Boolean(asr?.custom?.enabled)
  const aiCustomOn = Boolean(ai?.provider && ai.provider !== 'mimo')
  const { asr: asrModels, text: textModels } = splitModels(models)
  const asrOptions = modelOptions(asrModels, asrCustomOn ? asr?.mify_model : mifyAsr)
  const textOptions = modelOptions(textModels, aiCustomOn ? DEFAULT_TEXT : mifyText)

  return (
    <div className="mc-settings-panel">
      <section className="mc-section">
        <div className="mc-section-title">Mify API Key</div>
        <div className="mc-card">
          <label className="mc-form-row">
            <span>API Key</span>
            <input className="mc-input" type="password" value={keyDraft} autoComplete="off" spellCheck={false}
              placeholder={/无效|401|403/.test(catalogError) ? 'Key 无效，请重新粘贴 Mify API Key' : mask(asr?.mify_has_key, '粘贴 Mify API Key')}
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
              <select className="mc-input mc-select" value={asrCustomOn ? '' : mifyAsr}
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
                  placeholder={MIMO_BASE}
                  onChange={(event) => setAsrCustom((value) => ({ ...value, base_url: event.target.value }))} />
              </label>
              <label className="mc-form-row">
                <span>模型 ID</span>
                <input className="mc-input" value={asrCustom.model} spellCheck={false}
                  placeholder="mimo-v2.5-asr"
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
                    恢复 Mify
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
              <select className="mc-input mc-select" value={aiCustomOn ? '' : mifyText}
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
                  placeholder={MIMO_BASE}
                  onChange={(event) => setAiCustom((value) => ({ ...value, base_url: event.target.value }))} />
              </label>
              <label className="mc-form-row">
                <span>模型 ID</span>
                <input className="mc-input" value={aiCustom.model} spellCheck={false}
                  placeholder="xiaomi/mimo-v2.5"
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
                    恢复 Mify
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
