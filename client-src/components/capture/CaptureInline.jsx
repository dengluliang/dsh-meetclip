import { deps, listSessions, meetingOptions } from '../../lib/api.js'
import { LaunchForm, MeetingForm, VideoForm } from '../NewCaptureDialog.jsx'
import { DocCardForm } from './DocCardForm.jsx'
import { openSettings } from '../../lib/settings-bus.js'

const TITLES = {
  launch: ['发布会直播', '粘贴直播间链接，预检通过后开始采集'],
  video: ['视频链接', 'B站、YouTube 等链接导入，或批量粘贴'],
  meeting: ['会议录音', '选择本地音频或视频，可多选；导入后自动收进卡包'],
  doc: ['飞书文档', '读取文档正文，生成可在会话里 @ 的会摘卡片']
}

// 面板贴着输入框下沿展开：底部操作行必须留在首页可视区内，否则会掉到裁切区外面。
const PANEL_GAP = 10
const PANEL_MIN_HEIGHT = 200
const PANEL_MAX_HEIGHT = 660

export function CaptureInline({ t, type = 'launch', url = '', file = null, files = null, onClose, onCreated, onSubmitted }) {
  const [options, setOptions] = React.useState(null)
  const [optionsError, setOptionsError] = React.useState('')
  const [health, setHealth] = React.useState({ depsReady: null, asrReady: null, active: 0 })
  const [panelMaxHeight, setPanelMaxHeight] = React.useState(0)
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

  // 首页「散落」模式外面套着 transform + overflow:hidden：面板一长，底部操作行就被裁掉，
  // 「加入队列」看得见却点不到。这里按「面板顶端 → 首页底部（再避开底部工具条）」的可用高度
  // 夹住面板，表单再长也只是中间那块自己滚动，操作行始终留在可视区里。
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let settled = 0
    let frame = 0
    function measure() {
      const node = panelRef.current
      if (!node || typeof node.getBoundingClientRect !== 'function') return
      const rect = node.getBoundingClientRect()
      if (!rect.height) return
      // 窄屏时面板改成贴底弹出（position: fixed），本来就贴着窗口底部，再夹高度只会越量越矮。
      const boxStyle = window.getComputedStyle ? window.getComputedStyle(node) : null
      if (boxStyle && boxStyle.position === 'fixed') return
      const home = node.closest('.mc-home')
      const homeRect = home ? home.getBoundingClientRect() : null
      const dock = home ? home.querySelector('.mc-home-dock') : null
      const dockRect = dock ? dock.getBoundingClientRect() : null
      const limit = Math.min(
        homeRect && homeRect.bottom > 0 ? homeRect.bottom : window.innerHeight,
        dockRect && dockRect.height > 0 ? dockRect.top - PANEL_GAP : Number.POSITIVE_INFINITY
      )
      // 面板在 transform: scale(...) 里，视觉像素要换算回 CSS 像素，缩放过1时也不会溢出。
      const scale = node.offsetHeight ? rect.height / node.offsetHeight : 1
      const ratio = scale > 0 ? scale : 1
      const space = Math.round((limit - rect.top - PANEL_GAP) / ratio)
      const next = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, space))
      if (Math.abs(next - settled) <= 6) return
      settled = next
      setPanelMaxHeight(next)
    }
    function remeasure() {
      measure()
      // 面板自身高度变化会改变可复测的几何，下一帧再量一次就稳定了，不需要常驻轮询。
      if (typeof window.requestAnimationFrame !== 'function') return
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(measure) })
    }
    measure()
    window.addEventListener('resize', remeasure)
    let observer = null
    if (typeof window.ResizeObserver === 'function' && panelRef.current) {
      observer = new window.ResizeObserver(remeasure)
      observer.observe(panelRef.current)
    }
    return () => {
      window.removeEventListener('resize', remeasure)
      if (observer) observer.disconnect()
      if (frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
    }
  }, [type])

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
      style={panelMaxHeight ? { maxHeight: `${panelMaxHeight}px` } : undefined}
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
          <div className="mc-notice" data-tone="warn">
            云端语音未配置：仍可保存音视频与截图，配置后可重新转写。
            <button type="button" className="mc-link-button" onClick={() => openSettings({ tab: 'models' })}>去配置模型</button>
          </div>
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
