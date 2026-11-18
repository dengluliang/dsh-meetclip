import {
  asrEngines, deps, depsInstallStatus, installDeps, meetingOptions
} from '../../lib/api.js'
import { ModelConnection } from '../settings/ModelConnection.jsx'

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

export function SetupProgressCards({ revision = 0, variant = 'feed' }) {
  const [state, setState] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [keyOpen, setKeyOpen] = React.useState(false)
  const [failure, setFailure] = React.useState(null)

  const load = React.useCallback(async () => {
    try {
      const [engine, options, capture] = await Promise.all([
        asrEngines(), meetingOptions(), deps()
      ])
      setState({ engine, options, capture })
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
      detail: '一键下载 yt-dlp 与 ffmpeg（国内镜像，无需 Homebrew）后可采集直播和链接视频。',
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
                <ModelConnection
                  compact
                  initialBaseUrl={engine?.base_url || engine?.default_base_url || ''}
                  initialAsr={engine?.model || engine?.default_model || ''}
                  hasSavedKey={Boolean(engine?.default_has_key ?? engine?.has_api_key)}
                  onSaved={async () => { setKeyOpen(false); await load() }}
                />
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </aside>
  )
}

