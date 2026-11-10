import { deps, listSessions, meetingOptions } from '../../lib/api.js'
import { LaunchForm, MeetingForm, VideoForm } from '../NewCaptureDialog.jsx'
import { DocCardForm } from './DocCardForm.jsx'

const TITLES = {
  launch: ['发布会直播', '粘贴直播间链接，预检通过后开始采集'],
  video: ['视频链接', 'B站、YouTube 等链接导入，或批量粘贴'],
  meeting: ['会议录音', '选择本地音频或视频，可多选；导入后自动收进卡包'],
  doc: ['飞书文档', '读取文档正文，生成可在会话里 @ 的会摘卡片']
}

export function CaptureInline({ t, type = 'launch', url = '', file = null, files = null, onClose, onCreated, onSubmitted }) {
  const [options, setOptions] = React.useState(null)
  const [optionsError, setOptionsError] = React.useState('')
  const [health, setHealth] = React.useState({ depsReady: null, asrReady: null, active: 0 })
  const panelRef = React.useRef(null)

  React.useEffect(() => {
    let cancelled = false
    let timer = null
    async function load() {
      try {
        const value = await meetingOptions()
        if (cancelled) return
        setOptions(value)
        setOptionsError('')
        if (!value?.asr_ready) timer = setTimeout(load, 3000)
      } catch (failure) {
        if (!cancelled) {
          setOptionsError(failure?.message || String(failure))
          timer = setTimeout(load, 4000)
        }
      }
    }
    load()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    async function loadHealth() {
      const next = { depsReady: null, asrReady: null, active: 0 }
      try {
        const value = await deps()
        next.depsReady = Boolean(value?.ready ?? (value?.yt_dlp && value?.ffmpeg))
      } catch {}
      try {
        const options = await meetingOptions()
        next.asrReady = Boolean(options?.asr_ready)
      } catch {}
      try {
        const rows = await listSessions()
        next.active = (Array.isArray(rows) ? rows : []).filter((row) => ['queued', 'recording', 'processing'].includes(row.status)).length
      } catch {}
      if (!cancelled) setHealth(next)
    }
    loadHealth()
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    function onKey(event) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const [title, subtitle] = TITLES[type] || TITLES.launch

  return (
    <section ref={panelRef} className="mc-capture-inline mc-omnibox-pop" role="dialog" aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.shiftKey) return
        const tag = event.target?.tagName
        if (tag === 'TEXTAREA' || tag === 'SELECT') return
        const submit = panelRef.current?.querySelector('[data-new-submit="true"]:not([disabled])')
        if (submit) { event.preventDefault(); submit.click() }
      }}>
      <header className="mc-capture-inline-head">
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <button type="button" className="mc-icon-button" onClick={onClose} aria-label="关闭采集面板">×</button>
      </header>
      <div className="mc-capture-inline-body">
        {health.depsReady === false && type !== 'meeting' && type !== 'doc' ? (
          <div className="mc-notice" data-tone="error">缺少采集组件（yt-dlp / ffmpeg），请在首页「配置进度」中安装。</div>
        ) : null}
        {health.asrReady === false && type !== 'video' && type !== 'doc' ? (
          <div className="mc-notice" data-tone="warn">云端语音未配置：仍可保存音视频与截图，配置后可重新转写。</div>
        ) : null}
        {health.active > 0 && type !== 'doc' ? (
          <div className="mc-notice" data-tone="info">已有 {health.active} 个任务在运行，新任务会排队；直播轮到后才开始采集。</div>
        ) : null}
        {type === 'launch' ? (
          <LaunchForm t={t} health={health} initialUrl={url} onClose={onClose} onCreated={onCreated} />
        ) : null}
        {type === 'video' ? (
          <VideoForm t={t} options={options} initialUrl={url} onClose={onClose}
            onCreated={onCreated} onSubmitted={onSubmitted} />
        ) : null}
        {type === 'meeting' ? (
          <MeetingForm t={t} options={options} optionsError={optionsError} initialFile={file}
            initialFiles={files} onClose={onClose} onCreated={onCreated} />
        ) : null}
        {type === 'doc' ? <DocCardForm t={t} onClose={onClose} onCreated={onCreated} /> : null}
      </div>
    </section>
  )
}
