import {
  aiStatus, asrEngines, checkAI, removeAIKey, saveAIConfig, saveAIKey, saveAsrEngine,
  testAIModel, testAsrEngine
} from '../lib/api.js'
import { ModelConnection } from './settings/ModelConnection.jsx'

const BASE_PLACEHOLDER = 'https://your-gateway.example/v1'
const MODEL_PLACEHOLDER = 'your-asr-model'
const TEXT_MODEL_PLACEHOLDER = 'your-text-model'

function mask(hasKey, placeholder) {
  return hasKey ? '已配置；留空则不修改' : placeholder
}

export function SettingsModels({ t }) {
  const [asr, setAsr] = React.useState(null)
  const [ai, setAi] = React.useState(null)
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

  React.useEffect(() => {
    load().catch((failure) => setError(failure?.message || String(failure)))
  }, [load])

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

  async function probeAsrModel() {
    const model = String(asr?.model || asr?.default_model || '').trim()
    const base = String(asr?.base_url || asr?.default_base_url || '').trim()
    if (!model) { setAsrProbe({ ok: false, text: '还没有保存语音模型，请先在上方连接并保存' }); return }
    if (!base) { setAsrProbe({ ok: false, text: '还没有保存服务地址，请先在上方连接并保存' }); return }
    setAsrProbe({ state: 'busy', text: '正在用 1 秒静音测试…' })
    try {
      const result = await testAsrEngine({ provider: 'mimo', base_url: base, model })
      setAsrProbe({ ok: true, text: `模型可用：${result?.model || model}` })
    } catch (failure) {
      setAsrProbe({ ok: false, text: `测试未通过：${failure?.message || '连接失败'}` })
    }
  }

  async function probeTextModel() {
    const model = String(ai?.model || '').trim()
    const base = String(ai?.base_url || '').trim()
    if (!model) { setTextProbe({ ok: false, text: '还没有保存文字模型，请先在上方连接并保存' }); return }
    if (!base) { setTextProbe({ ok: false, text: '还没有保存服务地址，请先在上方连接并保存' }); return }
    setTextProbe({ state: 'busy', text: '正在请求模型…' })
    try {
      const result = await testAIModel({ provider: ai?.provider === 'custom' ? 'custom' : 'mimo', base_url: base, model })
      if (result?.ok) setTextProbe({ ok: true, text: `模型可用：${result.model || model}${result.seconds ? `（${result.seconds}s）` : ''}` })
      else setTextProbe({ ok: false, text: `测试未通过：${result?.message || 'Key 或模型不可用'}` })
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
      await saveAsrEngine({
        mode: 'default', provider: 'mimo',
        base_url: asr?.base_url || asr?.default_base_url || '',
        model: asr?.model || asr?.default_model
      })
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
      await saveAIConfig({ provider: 'mimo', base_url: asr?.base_url || '', model: ai?.model || '' })
      if (ai?.own_key) { try { await removeAIKey() } catch {} }
      setAiCustom({ base_url: '', model: '', api_key: '' })
      setNotice('已恢复默认网关')
      await load()
    })
  }

  const asrCustomOn = Boolean(asr?.custom?.enabled)
  const aiCustomOn = Boolean(ai?.provider && ai.provider !== 'mimo')
  const savedAsr = asr?.model || asr?.default_model || ''
  const savedText = ai?.model || ''

  return (
    <div className="mc-settings-panel">
      <section className="mc-section">
        <div className="mc-section-title">连接模型服务</div>
        <div className="mc-card">
          <ModelConnection
            t={t}
            initialBaseUrl={asr?.base_url || asr?.default_base_url || ''}
            initialAsr={savedAsr}
            initialText={savedText}
            hasSavedKey={Boolean(asr?.default_has_key ?? asr?.has_api_key)}
            onSaved={load}
          />
          {asrCustomOn || aiCustomOn ? (
            <p className="mc-form-note" data-tone="warn">
              当前有服务在使用「自定义 API」。上面的默认连接不会覆盖它；要回到默认网关，请在对应小节点「恢复默认」。
            </p>
          ) : null}
        </div>
      </section>

      <section className="mc-section">
        <div className="mc-section-title">语音转文字</div>
        <div className="mc-card">
          <div className="mc-rows">
            <div className="mc-row"><span className="mc-row-key">当前模型</span><span className="mc-row-value mc-mono">{savedAsr || '未配置'}</span></div>
            <div className="mc-row"><span className="mc-row-key">服务地址</span><span className="mc-row-value mc-mono" title={asr?.base_url || ''}>{asr?.base_url || '未配置'}</span></div>
          </div>
          <div className="mc-actions">
            <button type="button" className="mc-button" disabled={Boolean(busy)} onClick={probeAsrModel}>
              {asrProbe?.state === 'busy' ? '测试中…' : '测试连接'}
            </button>
          </div>
          {asrProbe && asrProbe.state !== 'busy' ? (
            <p className="mc-form-note" data-tone={asrProbe.ok ? undefined : 'error'} role="status">{asrProbe.text}</p>
          ) : null}
          {asrProbe?.state === 'busy' ? <p className="mc-form-note">{asrProbe.text}</p> : null}
          <details className="mc-settings-details" open={asrCustomOn}>
            <summary>自定义 API（高级）</summary>
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
          <div className="mc-rows">
            <div className="mc-row"><span className="mc-row-key">当前模型</span><span className="mc-row-value mc-mono">{savedText || '未配置'}</span></div>
            <div className="mc-row"><span className="mc-row-key">服务地址</span><span className="mc-row-value mc-mono" title={ai?.base_url || ''}>{ai?.base_url || '未配置'}</span></div>
          </div>
          <div className="mc-actions">
            <button type="button" className="mc-button" disabled={Boolean(busy)} onClick={probeTextModel}>
              {textProbe?.state === 'busy' ? '测试中…' : '测试连接'}
            </button>
          </div>
          {textProbe && textProbe.state !== 'busy' ? (
            <p className="mc-form-note" data-tone={textProbe.ok ? undefined : 'error'} role="status">{textProbe.text}</p>
          ) : null}
          {textProbe?.state === 'busy' ? <p className="mc-form-note">{textProbe.text}</p> : null}
          <details className="mc-settings-details" open={aiCustomOn}>
            <summary>自定义 API（高级）</summary>
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
