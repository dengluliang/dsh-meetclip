import { meetingOptions, retranscribeSession, updateOptions as patchOptions } from '../lib/api.js'

export function RetranscribeDialog({ t, sessionId, detail, onClose, onDone }) {
  const meta = detail?.meta || {}
  const [options, setOptions] = React.useState(null)
  const initialProvider = meta.asr_engine?.provider === 'mimo' ? 'mimo' : 'default'
  const [provider, setProvider] = React.useState(initialProvider)
  const [language, setLanguage] = React.useState(meta.language_hint || '')
  const [hotwords, setHotwords] = React.useState(meta.hotwords || '')
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const missing = Array.isArray(detail?.asr_failures) ? detail.asr_failures.length : 0
  const legacySpeakers = Boolean(detail?.speakers && Object.keys(detail.speakers).length)
  const restartRequired = provider !== initialProvider || (language || '') !== (meta.language_hint || '')

  React.useEffect(() => {
    meetingOptions().then(setOptions).catch((failure) => setError(failure?.message || String(failure)))
  }, [])

  const hotwordSupported = options?.hotwords_supported !== false
  const languages = options?.languages || []

  async function save(startAfter) {
    setBusy(startAfter ? 'retranscribe' : 'save')
    setError('')
    try {
      const body = {
        language,
        hotwords: hotwordSupported ? hotwords : ''
      }
      if (provider !== 'default') body.asr_provider = provider
      await patchOptions(sessionId, body)
      if (startAfter) {
        await retranscribeSession(sessionId, restartRequired ? { resume: false } : {})
      }
      onDone?.()
      onClose()
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="mc-modal-layer" role="dialog" aria-modal="true">
      <div className="mc-modal mc-event-editor">
        <div className="mc-modal-head"><h3>转写选项</h3><button type="button" className="mc-icon-button" onClick={onClose}>×</button></div>
        <p className="mc-card-text">
          修改后可沿用到下次转录；已完成的片段不会重复识别，旧文字会保留到新结果成功。
          {missing > 0 ? ` 当前有 ${missing} 个片段没完成，不改引擎/语种时只补这些片段。` : ''}
          {restartRequired ? ' 引擎或语种已改变，保存后会从头转录。' : ''}
        </p>
        {legacySpeakers ? (
          <p className="mc-card-text">这条记录已有发言人标签；重新转写会清除它们，且不会再生成新的发言人。</p>
        ) : null}

        <label className="mc-form-row">
          <span>引擎</span>
          <select className="mc-input mc-select" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="default">跟随默认设置</option>
            <option value="mimo">MiMo 云端</option>
          </select>
        </label>
        <label className="mc-form-row">
          <span>语种</span>
          <select className="mc-input mc-select" value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="">自动</option>
            {languages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="mc-form-row">
          <span>热词</span>
          <input className="mc-input" value={hotwords} disabled={!hotwordSupported}
            onChange={(event) => setHotwords(event.target.value)} placeholder={hotwordSupported ? '人名、产品名或术语，用逗号分隔' : '当前引擎不支持热词'} />
        </label>
        {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
        <div className="mc-modal-actions">
          <button type="button" className="mc-button" onClick={onClose}>取消</button>
          <button type="button" className="mc-button" disabled={Boolean(busy)} onClick={() => save(false)}>仅保存</button>
          <button type="button" className="mc-button" data-variant="primary" disabled={Boolean(busy) || options?.asr_ready === false} onClick={() => save(true)}>
            {busy === 'retranscribe' ? '提交中…'
              : restartRequired ? '保存并从头转录'
                : missing > 0 ? '保存并补转录'
                  : '保存并开始转录'}
          </button>
        </div>
      </div>
    </div>
  )
}
