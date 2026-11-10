import {
  asrEngines, deps, depsInstallStatus, installDeps,
  meetingOptions, saveAsrEngine, testAsrEngine, testMimoKey
} from '../../lib/api.js'

// 不预置网关地址与模型：用户填自己的 OpenAI 兼容服务。
const BASE_PLACEHOLDER = 'https://your-gateway.example/v1'
const MODEL_PLACEHOLDER = 'your-asr-model'

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

export function SetupProgressCards({ revision = 0, variant = 'feed' }) {
  const [state, setState] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [keyOpen, setKeyOpen] = React.useState(false)
  const [baseUrl, setBaseUrl] = React.useState('')
  const [model, setModel] = React.useState('')
  const [key, setKey] = React.useState('')
  const [keyError, setKeyError] = React.useState('')
  const [failure, setFailure] = React.useState(null)

  const load = React.useCallback(async () => {
    try {
      const [engine, options, capture] = await Promise.all([
        asrEngines(), meetingOptions(), deps()
      ])
      setState({ engine, options, capture })
      // 部署在 meetclip config 里统一了网关地址时，这里直接带出来，只需粘贴 Key。
      setBaseUrl((current) => current || engine?.default_base_url || engine?.base_url || '')
    } catch {
      setState(null)
    }
  }, [])

  React.useEffect(() => { load() }, [load, revision])

  React.useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, 15000)
    return () => clearInterval(timer)
  }, [load])

  async function installCapture() {
    setBusy('capture')
    setFailure(null)
    try {
      await installDeps()
      for (let index = 0; index < 2400; index += 1) {
        await wait(1500)
        const job = await depsInstallStatus()
        if (job?.error) throw new Error(job.error)
        if (job?.done && !job?.running) break
      }
      await load()
    } catch (input) {
      setFailure({ id: 'capture', message: input?.message || '采集组件安装失败' })
    } finally {
      setBusy('')
    }
  }

  async function saveKey() {
    if (!baseUrl.trim()) { setKeyError('请填写服务地址（Base URL）'); return }
    if (!model.trim()) { setKeyError('请填写模型 ID'); return }
    if (!key.trim()) { setKeyError('请输入 API Key'); return }
    setBusy('key')
    setKeyError('')
    setFailure(null)
    try {
      await testMimoKey(key.trim(), { baseUrl: baseUrl.trim(), model: model.trim() })
      await saveAsrEngine({ provider: 'mimo', base_url: baseUrl.trim(), model: model.trim(), api_key: key.trim() })
      await testAsrEngine()
      setKey('')
      setKeyOpen(false)
      await load()
    } catch (input) {
      setKeyError(input?.message || '云端语音配置失败')
    } finally {
      setBusy('')
    }
  }

  if (!state) return null
  const { engine, options, capture } = state
  const cards = []
  if (!(engine?.default_provider === 'mimo' && engine?.has_api_key && options?.asr_ready)) {
    cards.push({
      id: 'asr',
      title: '云端语音未配置',
      detail: '配置云端语音服务地址与 API Key 后即可转写直播、视频和会议。',
      action: <button type="button" className="mc-button mc-button-small" onClick={() => setKeyOpen((v) => !v)}>{keyOpen ? '收起' : '配置'}</button>
    })
  }
  if (!capture?.yt_dlp || !capture?.ffmpeg) {
    cards.push({
      id: 'capture',
      title: '采集组件缺失',
      detail: '安装 yt-dlp 与 ffmpeg 后可采集直播和链接视频。',
      action: <button type="button" className="mc-button mc-button-small" disabled={busy === 'capture'} onClick={installCapture}>{busy === 'capture' ? '安装中…' : '安装'}</button>
    })
  }
  if (!cards.length && !keyOpen) return null

  return (
    <aside className={`mc-progress-cards is-${variant}`} aria-label="配置进度">
      <div className="mc-progress-cards-head"><span>配置进度</span><span>{cards.length} 项待完成</span></div>
      <div className="mc-progress-list">
        {cards.map((card) => (
          <section key={card.id} className="mc-progress-card">
            <div>
              <strong>{card.title}</strong>
              <p>{card.detail}</p>
            </div>
            {card.action}
            {failure?.id === card.id ? <p className="mc-progress-error">{failure.message}</p> : null}
            {card.id === 'asr' && keyOpen ? (
              <div className="mc-progress-key">
                <input className="mc-input" value={baseUrl} spellCheck={false} placeholder={BASE_PLACEHOLDER}
                  onChange={(event) => { setBaseUrl(event.target.value); setKeyError('') }} />
                <input className="mc-input" value={model} spellCheck={false} placeholder={MODEL_PLACEHOLDER}
                  onChange={(event) => { setModel(event.target.value); setKeyError('') }} />
                <input className="mc-input" type="password" value={key} placeholder="API Key" autoComplete="off"
                  onChange={(event) => { setKey(event.target.value); setKeyError('') }} />
                <button type="button" className="mc-button mc-button-small" data-variant="primary" disabled={busy === 'key'} onClick={saveKey}>{busy === 'key' ? '验证中…' : '保存并测试'}</button>
                {keyError ? <p className="mc-progress-error">{keyError}</p> : null}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </aside>
  )
}

