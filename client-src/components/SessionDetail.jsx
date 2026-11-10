import Hls from 'hls.js'
import {
  addMark, cancelLink, cancelSession, deleteMark,
  appSettings, deleteSession, duplicateSession, exportFormatUrl, exportMarkdown, exportZipUrl, fileUrl,
  getSession, keepGoing,
  saveAppSettings,
  renameSession, retranscribeSession, retryLink,
  revealRecord, saveRecordNotes, searchRecord, startSession, stopSession, updateMark
} from '../lib/api.js'
import { motionOf, shouldReloadForEvent } from '../lib/liveEvents.js'
import { createReloadGate } from '../lib/reload-gate.js'
import { ScreenCaptureDialog } from './ScreenCaptureDialog.jsx'
import { RetranscribeDialog } from './RetranscribeDialog.jsx'
import { MinutesNotesPanel } from './MinutesNotesPanel.jsx'
import { SpeakersPanel } from './SpeakersPanel.jsx'
import { ContextMenu, useContextMenu } from './ContextMenu.jsx'
import {
  clock, dateTime, duration, kindInfo, mergeTranscripts, speakerName, statusTone,
  transcriptLine, transcriptText
} from '../lib/format.js'

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
    return Promise.resolve()
  } catch (failure) {
    return Promise.reject(failure)
  }
}

async function copyImage(url) {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('读取截图失败')
  const blob = await response.blob()
  if (!navigator.clipboard?.write || typeof window.ClipboardItem !== 'function') {
    throw new Error('当前浏览器不支持复制图片')
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
}

// 采集中的记录每 0.5 秒推一条 motion 分数（画面是否在动）。它只是侧栏那根指示条，
// 不该连带重拉整份详情：那曾是「点不动」的直接原因。详情刷新另外留一个最小间隔，
// 让 SSE、轮询和播放进度几个触发源不会叠成并发请求。
const DETAIL_MIN_GAP = 900

// 一次最多挂多少张截图缩略图。截图是 1920×1080 的原图，一条长直播能攒上千张，
// 全量挂上去会让渲染进程内存和主线程一起失控。
const SHOT_PAGE_SIZE = 120

function mergeMissingRanges(rows) {
  const ranges = []
  for (const row of rows) {
    const start = Number(row?.start)
    const end = Number(row?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end + 0.05) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }
  return ranges
}

export function SessionDetail({ sessionId, summary, t, backendStopped, onBackendRefresh, focus, onChanged, onDeleted, onCreated }) {
  const [detail, setDetail] = React.useState(null)
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [tab, setTab] = React.useState('content')
  const [inspector, setInspector] = React.useState('marks')
  const [revision, setRevision] = React.useState(0)
  const [exportData, setExportData] = React.useState(null)
  const [exporting, setExporting] = React.useState(false)
  const [actionBusy, setActionBusy] = React.useState('')
  const [toast, setToast] = React.useState(null)
  const [confirm, setConfirm] = React.useState(null)
  const [markOpen, setMarkOpen] = React.useState(false)
  const [markTime, setMarkTime] = React.useState(0)
  const [markText, setMarkText] = React.useState('')
  const [editingMark, setEditingMark] = React.useState(null)
  const [undoMark, setUndoMark] = React.useState(null)
  const [lightbox, setLightbox] = React.useState(null)
  const [pendingSeek, setPendingSeek] = React.useState(null)
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState('')
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [showGaps, setShowGaps] = React.useState(false)
  const [findOpen, setFindOpen] = React.useState(false)
  const [findQuery, setFindQuery] = React.useState('')
  const [findMatches, setFindMatches] = React.useState([])
  const [findIndex, setFindIndex] = React.useState(0)
  const [finding, setFinding] = React.useState(false)
  const [captureOpen, setCaptureOpen] = React.useState(false)
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  const [showInspector, setShowInspector] = React.useState(() => !(typeof window !== 'undefined' && window.innerWidth <= 1120))
  const [selectedMarkId, setSelectedMarkId] = React.useState(null)
  const [selectedShots, setSelectedShots] = React.useState(() => new Set())
  const [shotLimit, setShotLimit] = React.useState(SHOT_PAGE_SIZE)
  const [motion, setMotion] = React.useState(null)
  const { menu, open: openMenu, close: closeMenu } = useContextMenu()
  const mediaRef = React.useRef(null)
  const minutesPendingRef = React.useRef(false)
  const notesVersionRef = React.useRef(0)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [following, setFollowing] = React.useState(true)
  const [transcriptSelected, setTranscriptSelected] = React.useState(false)
  const transcriptRef = React.useRef(null)
  // 转写每行都包在 memo 里：播放进度（每秒数次）、motion 分数（每 0.5 秒）和后台轮询
  // 都会重渲染这个组件，逐行 diff 上千个节点会把主线程吃光。行内回调走 ref，
  // 这样行组件的 props 保持稳定，只有它自己「正在播」的状态变了才重绘。
  const seekRef = React.useRef(null)
  const transcriptMenuRef = React.useRef(null)
  const readSelectionRef = React.useRef(null)
  const rowActions = React.useMemo(() => ({
    seek: (seconds) => seekRef.current?.(seconds),
    menu: (event, row) => transcriptMenuRef.current?.(event, row)
  }), [])
  // 全屏分屏：左右/上下两种排法共用同一个比例；拖动分隔条即可改比例。
  const [stageLayout, setStageLayout] = React.useState(() => {
    try {
      const saved = localStorage.getItem('meetclip.stageLayout')
      if (saved === 'side' || saved === 'stack') return saved
    } catch {}
    if (typeof window !== 'undefined' && window.innerWidth / Math.max(1, window.innerHeight) < 1) return 'stack'
    return 'side'
  })
  const [stageRatio, setStageRatio] = React.useState(() => {
    try {
      const saved = Number(localStorage.getItem('meetclip.stageRatio'))
      if (Number.isFinite(saved) && saved >= 0.3 && saved <= 0.8) return saved
    } catch {}
    return 0.66
  })
  const [stageResizing, setStageResizing] = React.useState(false)
  const stageFullscreen = useStageFullscreen(mediaRef)

  React.useEffect(() => {
    try { localStorage.setItem('meetclip.stageLayout', stageLayout) } catch {}
  }, [stageLayout])

  React.useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem('meetclip.stageRatio', String(Math.round(stageRatio * 1000) / 1000)) } catch {}
    }, 300)
    return () => clearTimeout(timer)
  }, [stageRatio])

  React.useEffect(() => () => {
    document.body?.classList?.remove('mc-stage-resizing-side', 'mc-stage-resizing-stack')
  }, [])

  // 纪要页共用播放器但不显示视频；全屏分屏只属于内容页，切过去时退出全屏避免只剩一条黑边。
  React.useEffect(() => {
    if (tab === 'content' || !stageFullscreen) return
    try { document.exitFullscreen?.()?.catch?.(() => {}) } catch {}
  }, [tab, stageFullscreen])

  // 拖到一半被 Esc 退出全屏时，分隔条会卸载；清掉残留的拖拽光标状态。
  React.useEffect(() => {
    if (stageFullscreen) return
    document.body?.classList?.remove('mc-stage-resizing-side', 'mc-stage-resizing-stack')
    setStageResizing(false)
  }, [stageFullscreen])

  // 详情是一整份快照（转写、截图、标记、笔记…）。采集中的记录会被 SSE、定时轮询和
  // 播放进度各自触发重拉，放任并发的话主线程里会同时排着好几份几百 KB 的响应，
  // 整个 DSH 窗口都会点不动。闸门把刷新收成一路：单并发、最小间隔、漏掉的合并补拉。
  const loadGateRef = React.useRef({ gate: null, sessionId: '' })
  React.useEffect(() => () => { loadGateRef.current.gate?.stop() }, [])

  const load = React.useCallback((quiet = true) => {
    const holder = loadGateRef.current
    if (!holder.gate || holder.sessionId !== sessionId) {
      holder.gate?.stop()
      holder.sessionId = sessionId
      holder.gate = createReloadGate({
        gap: DETAIL_MIN_GAP,
        task: async (priority) => {
          if (!priority) setLoading(true)
          try {
            const next = await getSession(sessionId)
            setDetail(next)
            setError('')
          } catch (failure) {
            setError(failure?.message || String(failure))
          } finally {
            setLoading(false)
          }
        }
      })
    }
    holder.gate.request(!quiet)
    return Promise.resolve()
  }, [sessionId])

  React.useEffect(() => {
    setDetail(null)
    setError('')
    setTab('content')
    setMarkOpen(false)
    setUndoMark(null)
    setSelectedMarkId(null)
    setSelectedShots(new Set())
    setShotLimit(SHOT_PAGE_SIZE)
    setMotion(null)
    setFollowing(true)
    setShowGaps(false)
    setTranscriptSelected(false)
    minutesPendingRef.current = false
    notesVersionRef.current = 0
    load(false)
  }, [sessionId, load])

  const active = Boolean(detail?.recording || detail?.processing || detail?.queued ||
    ['recording', 'processing', 'queued'].includes(detail?.status))
  const minutesPending = Boolean(detail?.minutes && (detail.minutes.state === 'updating' || detail.minutes.queued))

  React.useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true)
    }, 3000)
    return () => clearInterval(timer)
  }, [active, load])

  // 纪要终稿可能在记录已经结束后才写完；等它时继续轮询详情，完成后再谈一次笔记更新。
  React.useEffect(() => {
    if (!minutesPending) return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true)
    }, 3000)
    return () => clearInterval(timer)
  }, [minutesPending, load])

  React.useEffect(() => {
    if (minutesPendingRef.current && !minutesPending &&
        (detail?.notes_version || 0) > notesVersionRef.current) {
      showToast(t('minutes.synced') || 'AI 纪要已写入笔记', {
        label: t('minutes.view') || '查看',
        run: () => setTab('minutes')
      })
    }
    minutesPendingRef.current = minutesPending
    notesVersionRef.current = detail?.notes_version || 0
  }, [minutesPending, detail?.notes_version])

  React.useEffect(() => {
    if (!active) return undefined
    let pending = null
    let closed = false
    const source = new EventSource(`/meetclip/api/sessions/${encodeURIComponent(sessionId)}/events?after=0`)
    const schedule = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        if (!closed) load(true)
      }, 350)
    }
    source.onmessage = (event) => {
      let payload = null
      try { payload = JSON.parse(event.data) } catch { return }
      if (payload?.kind === 'noop' || payload?.kind === 'closed') return
      if (payload?.kind === 'motion') {
        // 只喂那根指示条。这里以前会顺带 schedule() 重拉详情，采集时相当于每 0.5 秒
        // 解析并重绘一次整份记录，主线程被占满后整个 DSH 窗口都收不到点击。
        const score = motionOf(payload)
        if (score) setMotion({ ...score, at: Date.now() })
        return
      }
      if (payload?.kind === 'end_prompt') {
        showToast(payload.text || '一段时间没人说话，是否结束采集？', {
          label: '继续记录',
          run: () => { keepGoing(sessionId).then(() => load(true)).catch(() => {}) }
        })
      }
      if (shouldReloadForEvent(payload)) schedule()
      if (['done', 'error', 'cancelled'].includes(payload?.kind)) {
        closed = true
        source.close()
      }
    }
    source.onerror = () => { schedule() }
    return () => {
      closed = true
      if (pending) clearTimeout(pending)
      source.close()
    }
  }, [active, sessionId, load])

  React.useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1)
    }, 5000)
    return () => clearInterval(timer)
  }, [active])

  React.useEffect(() => {
    if (revision === 0) return
    if (detail?.recording) load(true)
  }, [revision, detail?.recording, load])

  React.useEffect(() => {
    if (!focus?.nonce) return
    setTab('content')
    if (typeof focus.time === 'number') setPendingSeek(focus.time)
  }, [focus?.nonce])

  React.useEffect(() => {
    if (pendingSeek === null) return undefined
    let done = false
    let timer = null
    const attempt = () => {
      if (done) return true
      const media = mediaRef.current
      if (!media) return false
      // HLS 直播的 duration 可能是 Infinity：只看元数据是否就绪，不能要求有限时长。
      if (media.readyState < 1) return false
      done = true
      applyMediaSeek(media, pendingSeek)
      setPendingSeek(null)
      return true
    }
    if (attempt()) return undefined
    // 播放器可能在下一次详情刷新、首个 HLS 分片就绪或回放文件生成后才挂上：短轮询补跳。
    timer = setInterval(() => {
      if (!attempt()) return
      clearInterval(timer)
      timer = null
    }, 300)
    // 最多等 20 秒就停下，避免播放器一直不出现时空转；下次详情刷新还会重试。
    const stop = setTimeout(() => {
      if (timer) { clearInterval(timer); timer = null }
    }, 20000)
    return () => {
      if (timer) clearInterval(timer)
      clearTimeout(stop)
    }
  }, [pendingSeek, detail])

  React.useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  // 跟读只滚转写列表自己，不能动外层列：以前用 scrollIntoView 会把整列连同播放器一起
  // 滚走，播放器一离开视口，时间轴就点不到了。
  React.useEffect(() => {
    if (!following || tab !== 'content') return
    const list = transcriptRef.current
    const row = list?.querySelector?.('.mc-tr[data-playing="true"]')
    if (!list || !row) return
    const listBox = list.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    const pad = 12
    if (rowBox.top < listBox.top + pad) list.scrollTop += rowBox.top - listBox.top - pad
    else if (rowBox.bottom > listBox.bottom - pad) list.scrollTop += rowBox.bottom - listBox.bottom + pad
  }, [currentTime, following, tab])

  // Keep the copy action in sync with what the reader has selected, so the
  // toolbar can offer「复制所选」instead of copying everything.
  React.useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const sync = () => {
      const next = Boolean(readTranscriptSelection())
      setTranscriptSelected((current) => (current === next ? current : next))
    }
    document.addEventListener('selectionchange', sync)
    return () => document.removeEventListener('selectionchange', sync)
  }, [])

  React.useEffect(() => {
    if (tab !== 'content') setTranscriptSelected(false)
  }, [tab])

  React.useEffect(() => {
    if (!findOpen) return undefined
    const query = findQuery.trim()
    if (!query) { setFindMatches([]); setFindIndex(0); return undefined }
    let cancelled = false
    const timer = setTimeout(async () => {
      setFinding(true)
      try {
        const rows = await searchRecord(sessionId, query)
        if (!cancelled) {
          setFindMatches(Array.isArray(rows) ? rows : [])
          setFindIndex(0)
        }
      } catch (failure) {
        if (!cancelled) showToast(failure?.message || String(failure))
      } finally {
        if (!cancelled) setFinding(false)
      }
    }, 260)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [findOpen, findQuery, sessionId])

  React.useEffect(() => {
    const match = findMatches[findIndex]
    if (match && typeof match.ts === 'number') seek(match.ts)
  }, [findMatches, findIndex])

  React.useEffect(() => {
    function onKey(event) {
      const target = event.target
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' || target.isContentEditable)
      const root = document.querySelector('.mc-root')
      const inside = root && target && root.contains(target)
      if (event.key === 'Enter' && markOpen && typing) {
        event.preventDefault()
        saveMark()
        return
      }
      if (event.key === 'Escape') {
        if (markOpen) {
          event.preventDefault()
          setMarkOpen(false)
          return
        }
        if (lightbox || menuOpen || findOpen) {
          event.preventDefault()
          setLightbox(null)
          setMenuOpen(false)
          setFindOpen(false)
          return
        }
      }
      if (!inside || typing) return
      if (lightbox?.list?.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        const delta = event.key === 'ArrowRight' ? 1 : -1
        setLightbox((current) => current ? {
          ...current,
          index: (current.index + delta + current.list.length) % current.list.length
        } : current)
        return
      }
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.altKey && event.key.toLowerCase() === 'i') {
        event.preventDefault()
        setShowInspector((value) => !value)
      } else if (event.key === ' ' && target.closest('.mc-shots') && selectedShots.size > 0) {
        const first = shots.find((shot) => selectedShots.has(shot.id))
        if (first) {
          event.preventDefault()
          setLightbox({ list: shots.filter((item) => selectedShots.has(item.id)), index: 0 })
        }
      } else if (event.key === ' ' && !target.closest('button,select,a')) {
        if (!mediaRef.current) return
        event.preventDefault()
        if (mediaRef.current.paused) mediaRef.current.play?.().catch(() => {})
        else mediaRef.current.pause?.()
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault()
        openMark()
      } else if (modifier && event.key.toLowerCase() === 'z' && undoMark) {
        event.preventDefault()
        restoreMark()
      } else if (modifier && event.key.toLowerCase() === 'f') {
        if (tab !== 'content') return
        event.preventDefault()
        openFind()
      } else if (modifier && event.key.toLowerCase() === 'g') {
        if (tab !== 'content') return
        event.preventDefault()
        stepFind(event.shiftKey ? -1 : 1)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (inspector !== 'marks' || !selectedMarkId) return
        const mark = marks.find((item) => item.id === selectedMarkId)
        if (!mark) return
        event.preventDefault()
        removeMark(mark)
      } else if (event.key === 'Enter') {
        if (inspector !== 'marks' || !selectedMarkId) return
        const mark = marks.find((item) => item.id === selectedMarkId)
        if (!mark) return
        event.preventDefault()
        openMark(mark)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const view = detail || summary || {}
  const kind = view.kind || 'live'
  const speakerTab = (kind === 'meeting' || kind === 'link_video') && Object.keys(detail?.speakers || {}).length > 0
  const info = kindInfo(kind)
  const transcripts = React.useMemo(() => mergeTranscripts(detail), [detail])
  const marks = Array.isArray(detail?.marks) ? detail.marks : []
  const shots = Array.isArray(detail?.screenshots) ? detail.screenshots : []
  // 截图缩略图只挂最近的一批：原图是 1920×1080 的 JPEG，一条长直播能攒上千张。
  const visibleShots = shots.length > shotLimit ? shots.slice(shots.length - shotLimit) : shots
  const hiddenShots = shots.length - visibleShots.length
  const linkJob = detail?.link_job || view.link_job
  const running = detail?.recording || detail?.status === 'recording'
  const queued = detail?.queued || detail?.status === 'queued'
  const canStart = kind === 'live' && !running && !queued && Boolean(detail?.source_url) && !detail?.media_path
  const canRetryLink = kind === 'link_video' && linkJob?.job_state === 'error'
  const canCancelLink = kind === 'link_video' && Boolean(linkJob) && linkJob?.job_state !== 'error' && linkJob?.job_state !== 'done'

  const failures = Array.isArray(detail?.asr_failures) ? detail.asr_failures : []
  const missingCount = failures.length
  const doneCount = Array.isArray(detail?.transcripts) ? detail.transcripts.length : 0
  const missingSeconds = React.useMemo(
    () => failures.reduce((total, row) => {
      const start = Number(row?.start)
      const end = Number(row?.end)
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? total + (end - start) : total
    }, 0),
    [failures]
  )
  const missingRanges = React.useMemo(() => mergeMissingRanges(failures), [failures])
  const failureReason = missingCount === 0 ? ''
    : failures.every((row) => /429/.test(String(row?.error || ''))) ? t('detail.partialReason429')
      : failures.some((row) => /网络|连接|VPN|network/i.test(String(row?.error || ''))) ? t('detail.partialReasonNetwork')
        : t('detail.partialReasonGeneric')
  // A record with failed chunks is usable but incomplete: keep the entry at hand
  // instead of hiding it behind the inspector or a generic "error" notice.
  const partial = Boolean(!active && detail?.media_path && missingCount > 0)
  const untranscribed = Boolean(!active && detail?.media_path && missingCount === 0 && doneCount === 0
    && ['pending', 'error', 'cancelled'].includes(detail?.status))

  const notices = []
  if (queued) {
    notices.push({ tone: 'warn', text: `排队第 ${detail?.queue_position || view.queue_position || 1} 位 · 轮到后自动处理` })
  }
  if (linkJob && !['done'].includes(linkJob.job_state)) {
    const stateLabels = {
      queued: '等待处理', waiting_for_slot: '等待处理', preparing: '正在准备下载',
      downloading: '正在下载视频', transcribing: '正在转写', finalizing: '正在整理',
      fallback_recording: '正在内录', cancelled: '已取消', error: '处理失败'
    }
    const label = stateLabels[linkJob.job_state] || linkJob.job_state
    const detailText = linkJob.job_state === 'downloading' && linkJob.downloaded_bytes
      ? ` · ${Math.round((linkJob.download_progress || 0) * 100)}%`
      : ''
    notices.push({ tone: linkJob.job_state === 'error' ? 'error' : 'info', text: `${label}${detailText}` })
  }
  if (detail?.diarize_error && detail?.status === 'done' && !active) {
    notices.push({ tone: 'warn', text: `未区分说话人：${detail.diarize_error}` })
  }
  if (detail?.error && detail?.status === 'error' && !partial) {
    notices.push({ tone: 'error', text: detail.error })
  }
  if (detail?.status === 'cancelled' && !partial) {
    notices.push({ tone: 'muted', text: '处理已取消，已保留已有内容' })
  }
  if (untranscribed) {
    notices.push({
      tone: 'info',
      text: t('detail.noTranscriptText'),
      action: { label: t('detail.startTranscribe'), run: confirmStart }
    })
  }

  function applyMediaSeek(media, seconds, { quiet = false } = {}) {
    if (!media) return false
    let target = Math.max(0, Number(seconds) || 0)
    let clamped = ''
    const durationKnown = Number.isFinite(media.duration) && media.duration > 0
    // 点播（本地 MP4/音频）的 seekable 会随缓冲进度变化，不能拿它当整段时长：
    // 否则刚打开视频、只缓冲了几秒时，点时间轴中后段会被当成“超出可播放范围”
    // 钳回开头，看起来就像重头播放。点播只按时长钳；直播回放才按 seekable 窗口钳。
    const liveWindow = Boolean(detail?.recording) || !durationKnown
    try {
      if (liveWindow) {
        const ranges = media.seekable
        if (ranges && ranges.length) {
          const start = Number(ranges.start(0))
          const end = Number(ranges.end(ranges.length - 1))
          if (Number.isFinite(start) && target < start - 0.3) {
            target = start
            clamped = '直播回放只保留了最近一段，已跳到最早可回放的位置'
          } else if (Number.isFinite(end) && target > end - 0.2) {
            target = Math.max(start, end - 0.3)
            clamped = '这个时间点还没有可播放的内容，已跳到可播放的末尾'
          }
        }
      } else if (target > media.duration - 0.2) {
        target = Math.max(0, media.duration - 0.3)
        clamped = '这个时间点超出媒体长度，已跳到末尾'
      }
      media.currentTime = target
    } catch {
      if (!quiet) showToast('当前播放器无法跳到这个时间点，可以先暂停再试，或导出媒体后本地播放')
      return false
    }
    media.play?.().catch(() => {})
    if (clamped && !quiet) showToast(clamped)
    return true
  }

  function seek(seconds) {
    const target = Math.max(0, Number(seconds) || 0)
    const media = mediaRef.current
    if (!media) {
      // 直播刚开始时播放器还没挂上（首个分片要等关键帧），采集中的记录仍会补跳。
      const waitingForPlayer = Boolean(detail?.recording || detail?.processing || detail?.queued
        || ['recording', 'processing', 'queued'].includes(detail?.status))
      const hasMedia = Boolean(detail?.media_path || detail?.live_hls_path)
      if (!hasMedia && !waitingForPlayer) {
        showToast('这条记录没有可播放的媒体文件，无法跳到对应时间点')
        return
      }
      // 详情还没加载完或播放器正在准备：先记住目标，播放器一就绪就补跳。
      setPendingSeek(target)
      showToast(hasMedia ? '播放器正在准备，稍后会自动跳到这个时间点'
        : '直播流还没连上，连上后会自动跳到这个时间点')
      return
    }
    if (media.readyState < 1) {
      setPendingSeek(target)
      showToast('播放器正在准备，稍后会自动跳到这个时间点')
      return
    }
    applyMediaSeek(media, target)
  }

  function clampStageRatio(value) {
    if (!Number.isFinite(value)) return 0.66
    return Math.min(0.8, Math.max(0.3, value))
  }

  function startStageResize(event) {
    if (!stageFullscreen) return
    const splitter = event.currentTarget
    const stage = splitter?.closest?.('.mc-main-col')
    if (!stage) return
    event.preventDefault()
    try { splitter.focus?.({ preventScroll: true }) } catch {}
    const side = stageLayout === 'side'
    const rect = stage.getBoundingClientRect()
    const total = side ? rect.width : rect.height
    if (!total) return
    const apply = (pointerEvent) => {
      const offset = side
        ? pointerEvent.clientX - rect.left
        : pointerEvent.clientY - rect.top
      setStageRatio(clampStageRatio(offset / total))
    }
    apply(event)
    setStageResizing(true)
    try { splitter.setPointerCapture(event.pointerId) } catch {}
    document.body?.classList?.add(side ? 'mc-stage-resizing-side' : 'mc-stage-resizing-stack')
    const stop = () => {
      splitter.removeEventListener('pointermove', apply)
      splitter.removeEventListener('pointerup', stop)
      splitter.removeEventListener('pointercancel', stop)
      document.body?.classList?.remove('mc-stage-resizing-side', 'mc-stage-resizing-stack')
      setStageResizing(false)
      try { splitter.releasePointerCapture(event.pointerId) } catch {}
    }
    splitter.addEventListener('pointermove', apply)
    splitter.addEventListener('pointerup', stop)
    splitter.addEventListener('pointercancel', stop)
  }

  function nudgeStageRatio(delta) {
    setStageRatio((value) => clampStageRatio(value + delta))
  }

  function toggleStageFullscreen() {
    const media = mediaRef.current
    // 全屏分屏：把播放器所在的整列（含视频、时间轴和转写）一起放进全屏，
    // 由 CSS 排成左侧视频、右侧转写；只放大视频会让整屏只剩下黑边。
    const target = media?.closest?.('.mc-main-col') || media?.closest?.('.mc-media') || media
    if (!target) return
    if (document.fullscreenElement === target) {
      document.exitFullscreen?.().catch?.(() => {})
      return
    }
    target.requestFullscreen?.().catch?.(() => {})
  }

  function showToast(text, action = null) {
    setToast({ text, action })
  }

  // The transcript is a reading surface first: dragging across rows must select
  // real text, so selection helpers run against the list element and never
  // depend on the surrounding app.
  function readTranscriptSelection() {
    const list = transcriptRef.current
    if (!list || typeof window === 'undefined' || typeof window.getSelection !== 'function') return ''
    let selection = null
    try { selection = window.getSelection() } catch { return '' }
    if (!selection || selection.isCollapsed || !selection.rangeCount) return ''
    let container = null
    try { container = selection.getRangeAt(0).commonAncestorContainer } catch { return '' }
    if (!container || !list.contains(container)) return ''
    return String(selection.toString() || '').replace(/\u00a0/g, ' ').trim()
  }

  function selectTranscriptAll() {
    const list = transcriptRef.current
    if (!list || typeof window === 'undefined' || typeof window.getSelection !== 'function'
      || typeof document === 'undefined' || typeof document.createRange !== 'function') return
    try {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(list)
      selection.removeAllRanges()
      selection.addRange(range)
      setFollowing(false)
      setTranscriptSelected(true)
    } catch {}
  }

  async function copyTranscriptText(text, message) {
    if (!text) return
    try {
      await copyText(text)
      showToast(message)
    } catch (failure) {
      showToast(failure?.message || '复制失败')
    }
  }

  async function copyTranscript(scope = 'auto') {
    const selected = scope === 'all' ? '' : readTranscriptSelection()
    const text = selected || transcriptText(transcripts, detail)
    const message = selected ? '已复制所选转写' : `已复制全部转写（${transcripts.length} 条）`
    return copyTranscriptText(text, message)
  }

  function copyTranscriptRow(row) {
    return copyTranscriptText(transcriptLine(row, detail), '已复制这段转写')
  }

  function copyTranscriptTime(row) {
    return copyTranscriptText(`[${clock(row.start)}]`, '已复制时间码')
  }

  function transcriptMenu(row) {
    // Read the selection while the menu opens: clicking a menu item collapses
    // the document selection before its click handler runs.
    const selected = readTranscriptSelection()
    return [
      ...(selected
        ? [{ id: 'copy-selection', label: '复制所选', hint: '⌘C', onSelect: () => copyTranscriptText(selected, '已复制所选转写') }]
        : []),
      { id: 'copy-row', label: '复制这段', onSelect: () => copyTranscriptRow(row) },
      { id: 'copy-time', label: '复制时间码', onSelect: () => copyTranscriptTime(row) },
      { separator: true },
      { id: 'copy-all', label: '复制全部转写', onSelect: () => copyTranscript('all') },
      { id: 'select-all', label: '全选转写', hint: '⌘A', onSelect: selectTranscriptAll },
      { separator: true },
      { id: 'jump', label: `跳转到 ${clock(row.start)}`, onSelect: () => seek(row.start) }
    ]
  }

  // 转写行是 memo 组件，拿到的回调必须恒定；这里每次渲染把最新的实现塞进 ref。
  seekRef.current = seek
  transcriptMenuRef.current = (event, row) => openMenu(event, transcriptMenu(row))
  readSelectionRef.current = readTranscriptSelection

  async function saveTitle() {
    const title = titleDraft.trim()
    if (!title || title === view.title) { setEditingTitle(false); return }
    try {
      await renameSession(sessionId, title)
      setEditingTitle(false)
      await load(true)
      onChanged?.()
    } catch (failure) {
      showToast(failure?.message || String(failure))
    }
  }

  async function makeDuplicate() {
    setMenuOpen(false)
    try {
      const created = await duplicateSession(sessionId)
      onCreated?.(created.id)
      showToast(`已创建副本：${created.title}`)
    } catch (failure) {
      showToast(failure?.message || String(failure))
    }
  }

  function removeRecord() {
    setMenuOpen(false)
    askConfirm({
      title: t('detail.delete'),
      body: t('detail.deleteBody'),
      label: t('detail.delete'),
      run: async () => {
        try {
          await deleteSession(sessionId)
          showToast(t('detail.deleted'))
          onDeleted?.()
        } catch (failure) {
          showToast(failure?.message || String(failure))
        }
      }
    })
  }

  function stepFind(step) {
    if (findMatches.length === 0) return
    const next = (findIndex + step + findMatches.length) % findMatches.length
    setFindIndex(next)
  }

  function openFind() {
    setTab('content')
    setFindOpen(true)
    setMenuOpen(false)
  }

  function openMark(mark = null) {
    if (mark) {
      setEditingMark(mark)
      setMarkTime(mark.ts)
      setMarkText(mark.note || '')
    } else {
      const time = mediaRef.current?.currentTime || currentTime || (transcripts.length ? transcripts[transcripts.length - 1].end : 0)
      setEditingMark(null)
      setMarkTime(Number(time) || 0)
      setMarkText('')
    }
    setMarkOpen(true)
  }

  async function saveMark() {
    if (actionBusy) return
    setActionBusy('mark')
    try {
      if (editingMark) {
        await updateMark(editingMark.id, editingMark.ts, markText.trim())
      } else {
        await addMark(sessionId, Number(markTime) || 0, markText.trim())
      }
      setMarkOpen(false)
      setEditingMark(null)
      await load(true)
      showToast(t('mark.added'))
    } catch (failure) {
      showToast(failure?.message || t('mark.error'))
    } finally {
      setActionBusy('')
    }
  }

  async function removeMark(mark) {
    if (actionBusy) return
    setActionBusy('mark')
    try {
      await deleteMark(mark.id)
      await load(true)
      setUndoMark(mark)
      showToast(t('mark.deleted'), { label: t('mark.undo'), run: () => restoreMark(mark) })
    } catch (failure) {
      showToast(failure?.message || t('mark.error'))
    } finally {
      setActionBusy('')
    }
  }

  async function restoreMark(mark = undoMark) {
    if (!mark) return
    try {
      await addMark(sessionId, mark.ts, mark.note || '')
      setUndoMark(null)
      setToast(null)
      await load(true)
    } catch (failure) {
      showToast(failure?.message || t('mark.error'))
    }
  }

  async function act(label, operation, message) {
    setActionBusy(label)
    try {
      await operation()
      await load(true)
      if (message) showToast(message)
    } catch (failure) {
      showToast(failure?.message || String(failure))
    } finally {
      setActionBusy('')
    }
  }

  function askConfirm(options) {
    setConfirm(options)
  }

  function confirmStart() {
    askConfirm({
      title: t('detail.startTranscribeTitle'),
      body: t('detail.startTranscribeBody').replace('{time}', view.duration ? duration(view.duration) : '整条'),
      label: t('detail.startTranscribe'),
      run: () => act('start-transcribe', () => retranscribeSession(sessionId, { resume: false }),
        t('detail.startTranscribeStarted'))
    })
  }

  function confirmResume() {
    if (!missingCount) return
    const body = doneCount > 0
      ? t('detail.fillMissingBody')
        .replace('{count}', String(missingCount))
        .replace('{time}', duration(missingSeconds))
        .replace('{done}', String(doneCount))
      : t('detail.fillMissingBodyAll')
        .replace('{count}', String(missingCount))
        .replace('{time}', duration(missingSeconds))
    askConfirm({
      title: t('detail.fillMissingTitle'),
      body,
      label: t('detail.fillMissingStart'),
      run: () => act('retranscribe', () => retranscribeSession(sessionId), t('detail.fillMissingStarted'))
    })
  }

  function confirmRestart() {
    askConfirm({
      title: t('detail.restart'),
      body: t('detail.restartBody').replace('{time}', view.duration ? duration(view.duration) : '整条'),
      label: t('detail.restart'),
      run: () => act('restart-transcribe', () => retranscribeSession(sessionId, { resume: false }),
        t('detail.restartStarted'))
    })
  }

  async function openExport() {
    setExporting(true)
    try {
      const result = await exportMarkdown(sessionId)
      setExportData(result)
    } catch (failure) {
      showToast(failure?.message || String(failure))
    } finally {
      setExporting(false)
    }
  }

  function downloadMarkdown() {
    const text = exportData?.markdown || ''
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${(view.title || 'meetclip').replace(/[\\/:*?"<>|]/g, '_')}.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function copyLiveLink() {
    if (!view.source_url) return
    try {
      await copyText(view.source_url)
      showToast('已复制直播链接')
    } catch (failure) {
      showToast(failure?.message || '复制失败')
    }
  }

  async function revealRecordDir() {
    try {
      await revealRecord(sessionId)
      showToast('已在 Finder 中显示记录目录')
    } catch (failure) {
      showToast(failure?.message || '无法在 Finder 中显示')
    }
  }

  function selectShot(shot, event) {
    const next = new Set(selectedShots)
    if (event.metaKey || event.ctrlKey) {
      if (next.has(shot.id)) next.delete(shot.id)
      else next.add(shot.id)
    } else {
      next.clear()
      next.add(shot.id)
    }
    setSelectedShots(next)
  }

  function shotList(shot) {
    return selectedShots.has(shot.id) && selectedShots.size > 0
      ? shots.filter((item) => selectedShots.has(item.id))
      : [shot]
  }

  async function copyShots(list) {
    if (!list.length) return
    try {
      if (list.length === 1) {
        await copyImage(fileUrl(sessionId, list[0].path))
        showToast('已复制截图')
      } else {
        await copyText(list.map((shot) => fileUrl(sessionId, shot.path)).join('\n'))
        showToast(`已复制 ${list.length} 张截图的链接`)
      }
    } catch (failure) {
      showToast(failure?.message || '复制截图失败')
    }
  }

  async function copyShotTimes(list) {
    try {
      await copyText(list.map((shot) => `[${clock(shot.ts)}]`).join('\n'))
      showToast('已复制时间码')
    } catch (failure) {
      showToast(failure?.message || '复制失败')
    }
  }

  function downloadShots(list) {
    list.forEach((shot, index) => {
      setTimeout(() => {
        const link = document.createElement('a')
        link.href = fileUrl(sessionId, shot.path)
        link.download = `shot-${shot.ts}.jpg`
        document.body.appendChild(link)
        link.click()
        link.remove()
      }, index * 120)
    })
  }

  function shotMenu(shot) {
    const list = shotList(shot)
    return [
      {
        id: 'preview',
        label: list.length > 1 ? `预览 ${list.length} 张（空格）` : '预览（空格）',
        onSelect: () => setLightbox({ list, index: 0 })
      },
      { separator: true },
      {
        id: 'copy',
        label: list.length > 1 ? `复制 ${list.length} 张图片` : '复制图片',
        onSelect: () => copyShots(list)
      },
      { id: 'copyTime', label: '复制时间码', onSelect: () => copyShotTimes(list) },
      { id: 'jump', label: `跳转到 ${clock(list[0].ts)}`, onSelect: () => seek(list[0].ts) },
      { id: 'download', label: list.length > 1 ? `下载 ${list.length} 张` : '下载图片', onSelect: () => downloadShots(list) },
      { separator: true },
      { id: 'reveal', label: '在 Finder 中显示记录目录', onSelect: revealRecordDir }
    ]
  }

  function markMenu(mark) {
    return [
      { id: 'jump', label: '跳转', onSelect: () => { setSelectedMarkId(mark.id); seek(mark.ts) } },
      { id: 'edit', label: '编辑批注', hint: '↵', onSelect: () => openMark(mark) },
      {
        id: 'copy',
        label: '复制',
        onSelect: () => copyText(`[${clock(mark.ts)}] ${mark.note || ''}`)
          .then(() => showToast('已复制标记'))
          .catch((failure) => showToast(failure?.message || '复制失败'))
      },
      { separator: true },
      { id: 'delete', label: '删除', danger: true, onSelect: () => removeMark(mark) }
    ]
  }

  function speakerMenu(speaker, speakers, actions) {
    return [
      { id: 'rename', label: '重命名…', onSelect: actions.rename },
      {
        id: 'merge',
        label: '合并到',
        submenu: speakers.filter((item) => item.key !== speaker.key).map((item) => ({
          id: item.key,
          label: item.name,
          onSelect: () => actions.merge(item.key)
        }))
      }
    ]
  }

  return (
    <div className="mc-detail" tabIndex={0}>
      <header className="mc-detail-head">
        <div className="mc-detail-title-wrap">
          <div className="mc-detail-title-row">
            <span className={`mc-kind-badge mc-kind-${info.tone}`}>{t(`kind.${kind}`)}</span>
            {editingTitle ? (
              <input className="mc-input mc-title-input" autoFocus value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); saveTitle() }
                  if (event.key === 'Escape') setEditingTitle(false)
                }}
                onBlur={saveTitle} />
            ) : (
              <h2 className="mc-detail-title" title={view.title}
                onDoubleClick={() => { setTitleDraft(view.title || ''); setEditingTitle(true) }}>
                {view.title || view.id}
              </h2>
            )}
          </div>
          <div className="mc-detail-meta">
            <span data-partial={partial ? 'true' : undefined}>
              {partial ? t('status.partial') : t(`status.${view.status || 'pending'}`)}
            </span>
            {view.duration ? <span>{duration(view.duration)}</span> : null}
            <span>{dateTime(view.started_at || view.created_at)}</span>
            {view.queue_position ? <span>{t('list.queue').replace('{n}', String(view.queue_position))}</span> : null}
            {view.source_url ? <a href={view.source_url} target="_blank" rel="noreferrer noopener">{t('detail.source')}</a> : null}
            {running ? (
              <span className="mc-live-capsule" title="正在采集">
                <span className="mc-live-dot" /> {clock(currentTime || detail?.live?.live_media_time || 0)}
                {shots.length ? ` · ${shots.length} 张截图` : ''}
                {detail?.stream_quality ? ` · ${detail.stream_quality}` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <div className="mc-detail-actions">
          {running ? (
            <button type="button" className="mc-button mc-button-small" data-variant="stop" disabled={Boolean(actionBusy)}
              onClick={() => askConfirm({
                title: t('detail.stop'),
                body: t('detail.stopConfirm'),
                label: t('detail.stop'),
                danger: true,
                run: () => act('stop', () => stopSession(sessionId))
              })}>{t('detail.stop')}</button>
          ) : null}
          {queued ? (
            <button type="button" className="mc-button mc-button-small" data-variant="primary" disabled={Boolean(actionBusy)}
              onClick={() => askConfirm({
                title: t('detail.cancelQueue'),
                body: t('detail.cancelConfirm'),
                label: t('detail.cancelQueue'),
                run: () => act('cancel', () => cancelSession(sessionId))
              })}>{t('detail.cancelQueue')}</button>
          ) : null}
          {canStart ? (
            <button type="button" className="mc-button mc-button-small" data-variant="primary" disabled={Boolean(actionBusy)}
              onClick={() => act('start', () => startSession(sessionId), t('status.recording'))}>{t('detail.start')}</button>
          ) : null}
          {canRetryLink ? (
            <>
              <button type="button" className="mc-button mc-button-small" data-variant="primary" disabled={Boolean(actionBusy)}
                onClick={() => act('retry', () => retryLink(sessionId))}>{t('detail.retry')}</button>
              <button type="button" className="mc-button mc-button-small" onClick={() => setCaptureOpen(true)}>内录</button>
            </>
          ) : null}
          {canCancelLink ? (
            <button type="button" className="mc-button mc-button-small" disabled={Boolean(actionBusy)}
              onClick={() => act('cancel', () => cancelLink(sessionId))}>{t('new.cancel')}</button>
          ) : null}
          {partial ? (
            <button type="button" className="mc-button mc-button-small" data-variant="primary" disabled={Boolean(actionBusy)}
              title={t('detail.fillMissingHint').replace('{count}', String(missingCount))}
              onClick={confirmResume}>
              {actionBusy === 'retranscribe' ? t('status.processing') : t('detail.fillMissing')}
            </button>
          ) : null}
          {untranscribed ? (
            <button type="button" className="mc-button mc-button-small" data-variant="primary" disabled={Boolean(actionBusy)}
              onClick={confirmStart}>
              {actionBusy === 'start-transcribe' ? t('status.processing') : t('detail.startTranscribe')}
            </button>
          ) : null}
          <button type="button" className="mc-button mc-button-small" onClick={() => openMark()} disabled={Boolean(actionBusy)}>
            {t('mark.add')}
          </button>
          <div className="mc-more">
            <button type="button" className="mc-button mc-button-small" onClick={() => setMenuOpen((value) => !value)}>
              {t('detail.more')}
            </button>
            {menuOpen ? (
              <div className="mc-menu" role="menu">
                {!active && partial ? (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); confirmResume() }}>
                      {t('detail.fillMissingMenu').replace('{count}', String(missingCount))}
                    </button>
                    <div className="mc-menu-sep" />
                  </>
                ) : null}
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openExport() }} disabled={exporting}>{exporting ? t('status.loading') : '导出 Markdown / 字幕 / Word…'}</button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openFind() }}>{t('detail.find')}</button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); load(false) }}>{t('common.refresh')}</button>
                <div className="mc-menu-sep" />
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setTitleDraft(view.title || ''); setEditingTitle(true) }}>{t('detail.rename')}</button>
                <button type="button" role="menuitem" disabled={kind === 'link_video' || active}
                  onClick={makeDuplicate}>{t('detail.duplicate')}</button>
                {view.source_url ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); copyLiveLink() }}>复制直播链接</button> : null}
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); revealRecordDir() }}>在 Finder 中显示</button>
                {!active && detail?.media_path ? (
                  <>
                    <div className="mc-menu-sep" />
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); confirmRestart() }}>
                      {t('detail.restart')}…
                    </button>
                  </>
                ) : null}
                <div className="mc-menu-sep" />
                <button type="button" role="menuitem" className="mc-menu-danger" onClick={removeRecord}>{t('detail.delete')}</button>
              </div>
            ) : null}
          </div>
          <button type="button" className="mc-icon-button" onClick={() => setShowInspector((value) => !value)}
            aria-label={showInspector ? '隐藏检查器' : '显示检查器'} title={showInspector ? '隐藏检查器（⌥⌘I）' : '显示检查器（⌥⌘I）'}>▤</button>
        </div>
      </header>

      {error ? (
        <div className="mc-detail-error" role="alert">
          <strong>{t('detail.error')}</strong>
          <span>{error}</span>
          {backendStopped ? <button type="button" className="mc-button mc-button-small" onClick={onBackendRefresh}>{t('list.startEngine')}</button> : null}
        </div>
      ) : null}

      {partial ? (
        <section className="mc-partial" aria-label={t('detail.partialTitle').replace('{count}', String(missingCount))}>
          <div className="mc-partial-copy">
            <strong>{t('detail.partialTitle').replace('{count}', String(missingCount))}</strong>
            <span>
              {t('detail.partialBody')
                .replace('{time}', duration(missingSeconds))
                .replace('{done}', String(doneCount))
                .replace('{reason}', failureReason)}
            </span>
          </div>
          <div className="mc-partial-actions">
            <button type="button" className="mc-button mc-button-small" data-variant="primary"
              disabled={Boolean(actionBusy)} onClick={confirmResume}>
              {actionBusy === 'retranscribe' ? t('status.processing') : t('detail.fillMissing')}
            </button>
            <button type="button" className="mc-button mc-button-small"
              aria-expanded={showGaps} onClick={() => setShowGaps((value) => !value)}>
              {showGaps
                ? t('detail.gapsHide')
                : t('detail.gapsShow').replace('{count}', String(missingRanges.length))}
            </button>
          </div>
          {showGaps ? (
            <div className="mc-gap-list">
              {missingRanges.map((gap, index) => (
                <button key={`${gap.start}-${index}`} type="button" className="mc-gap"
                  title={t('detail.gapJump').replace('{start}', clock(gap.start)).replace('{end}', clock(gap.end))}
                  onClick={() => seek(gap.start)}>
                  <span className="mc-mono">{clock(gap.start)}–{clock(gap.end)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {notices.length ? (
        <div className="mc-notices">
          {notices.map((notice, index) => (
            <div key={index} className="mc-notice" data-tone={notice.tone}>
              <span>{notice.text}</span>
              {notice.action ? (
                <button type="button" className="mc-button mc-button-small" disabled={Boolean(actionBusy)}
                  onClick={notice.action.run}>{notice.action.label}</button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {detail?.live?.phase_text ? (
        <div className="mc-phase">
          <span>{detail.live.phase_text}</span>
          {typeof detail.live.phase_progress === 'number' ? (
            <span className="mc-progress"><span style={{ width: `${Math.max(0, Math.min(100, detail.live.phase_progress * 100))}%` }} /></span>
          ) : null}
          <span className="mc-phase-steps">
            {(kind === 'live'
              ? [['stopping', '结束直播流'], ['remux', '生成回放文件'], ['transcribe', '完成转写'], ['done', '已保存']]
              : [['extract', '提取音频'], ['transcribe', '转写'], ['segments', '整理段落'], ['done', '完成']]
            ).map(([id, label]) => (
              <span key={id} className="mc-phase-step" data-active={detail.live.phase === id}>{label}</span>
            ))}
          </span>
        </div>
      ) : null}

      {markOpen ? (
        <div className="mc-mark-editor">
          <span className="mc-mono">{clock(markTime)}</span>
          <input className="mc-input" autoFocus value={markText} onChange={(event) => setMarkText(event.target.value)}
            placeholder={t('mark.placeholder')} aria-label={t('mark.add')} />
          <button type="button" className="mc-button mc-button-small" data-variant="primary" onClick={saveMark} disabled={Boolean(actionBusy)}>{t('mark.save')}</button>
          <button type="button" className="mc-button mc-button-small" onClick={() => { setMarkOpen(false); setEditingMark(null) }}>{t('mark.cancel')}</button>
        </div>
      ) : null}

      <div className="mc-detail-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'content'} data-active={tab === 'content'}
          className="mc-tab" onClick={() => setTab('content')}>{t('detail.content')}</button>
        <button type="button" role="tab" aria-selected={tab === 'minutes'} data-active={tab === 'minutes'}
          className="mc-tab" onClick={() => setTab('minutes')}>{t('detail.minutes') || '纪要'}</button>
        <span className="mc-tab-hint">{tab === 'minutes' ? '点击预览进入编辑' : t('mark.shortcut')}</span>
      </div>

      {findOpen ? (
        <div className="mc-findbar">
          <input className="mc-input" autoFocus value={findQuery} placeholder={t('detail.findPlaceholder')}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); stepFind(event.shiftKey ? -1 : 1) }
              if (event.key === 'Escape') { event.preventDefault(); setFindOpen(false) }
            }} />
          <span className="mc-find-count">{finding ? '…' : findMatches.length ? `${findIndex + 1}/${findMatches.length}` : '0'}</span>
          <button type="button" className="mc-button mc-button-small" onClick={() => stepFind(-1)} disabled={!findMatches.length}>↑</button>
          <button type="button" className="mc-button mc-button-small" onClick={() => stepFind(1)} disabled={!findMatches.length}>↓</button>
          <button type="button" className="mc-icon-button" onClick={() => setFindOpen(false)} aria-label="关闭">×</button>
        </div>
      ) : null}

      {loading && !detail ? (
        <div className="mc-detail-loading">
          <div className="mc-skeleton" style={{ width: '52%' }} />
          <div className="mc-skeleton" style={{ width: '76%' }} />
          <div className="mc-skeleton" style={{ width: '64%' }} />
        </div>
      ) : null}

      <div className="mc-detail-body" data-inspector={tab === 'content' && showInspector ? 'true' : 'false'}
        data-tab={tab}>
        <div className="mc-main-col" data-stage-layout={stageLayout} data-tab={tab}
          style={tab === 'content' && stageFullscreen ? (stageLayout === 'side'
              ? { gridTemplateColumns: `${(stageRatio * 100).toFixed(3)}% 8px minmax(0, 1fr)`, gridTemplateRows: 'minmax(0, 1fr)' }
              : { gridTemplateRows: `${(stageRatio * 100).toFixed(3)}% 8px minmax(0, 1fr)`, gridTemplateColumns: 'minmax(0, 1fr)' }) : undefined}>
            <div className="mc-stage-visual" data-compact={tab === 'minutes' ? 'true' : 'false'}>
              <MediaPane detail={detail} summary={summary} sessionId={sessionId} t={t} mediaRef={mediaRef}
                marks={marks} shots={shots} hits={findMatches.map((row) => ({ ts: row.ts }))}
                onSeek={(value) => seek(value)}
                stageFullscreen={stageFullscreen} stageLayout={stageLayout}
                onStageLayout={setStageLayout} onToggleFullscreen={toggleStageFullscreen}
                compact={tab === 'minutes'} onExpand={() => setTab('content')}
                onTime={(value) => setCurrentTime(value)} />
            </div>
            {tab === 'content' && stageFullscreen ? (
              <div className="mc-stage-splitter" role="separator" tabIndex={0}
                title="拖动调整比例，双击恢复 66%"
                aria-label={stageLayout === 'side' ? '调整视频与转写的左右宽度' : '调整视频与转写的上下高度'}
                aria-orientation={stageLayout === 'side' ? 'vertical' : 'horizontal'}
                aria-valuemin={30} aria-valuemax={80} aria-valuenow={Math.round(stageRatio * 100)}
                data-dragging={stageResizing ? 'true' : 'false'}
                onPointerDown={startStageResize}
                onDoubleClick={() => setStageRatio(0.66)}
                onKeyDown={(event) => {
                  const horizontal = stageLayout === 'side'
                  const back = horizontal ? 'ArrowLeft' : 'ArrowUp'
                  const forward = horizontal ? 'ArrowRight' : 'ArrowDown'
                  if (event.key === back) { event.preventDefault(); nudgeStageRatio(-0.02) }
                  else if (event.key === forward) { event.preventDefault(); nudgeStageRatio(0.02) }
                  else if (event.key === 'Home') { event.preventDefault(); setStageRatio(0.3) }
                  else if (event.key === 'End') { event.preventDefault(); setStageRatio(0.8) }
                }} />
            ) : null}
            {tab === 'content' ? (
              <section className="mc-transcript">
              <div className="mc-section-head mc-transcript-head">
                <h3>{t('detail.transcript')}</h3>
                <span className="mc-section-tools">
                  {!following ? (
                    <button type="button" className="mc-button mc-button-small" onClick={() => setFollowing(true)}>回到当前位置</button>
                  ) : null}
                  {transcripts.length ? (
                    <>
                      <button type="button" className="mc-button mc-button-small"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={selectTranscriptAll}
                        title="选中全部转写文字，再按 ⌘C 复制">全选</button>
                      <button type="button" className="mc-button mc-button-small"
                        data-variant={transcriptSelected ? 'primary' : undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => copyTranscript('auto')}
                        title={transcriptSelected ? '复制当前选中的文字' : '复制全部转写，含时间码与发言人'}>
                        {transcriptSelected ? '复制所选' : '复制转写'}
                      </button>
                    </>
                  ) : null}
                  <span className="mc-section-count">{transcripts.length}</span>
                </span>
              </div>
              {transcripts.length === 0 ? (
                <div className="mc-inline-empty">
                  <strong>{t('detail.noTranscript')}</strong>
                  <span>{t('detail.noTranscriptHint')}</span>
                </div>
              ) : (
                <div className="mc-transcript-list" ref={transcriptRef}
                  onWheel={() => setFollowing(false)}
                  onMouseUp={() => { if (readTranscriptSelection()) setFollowing(false) }}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && !event.altKey
                      && String(event.key).toLowerCase() === 'a') {
                      event.preventDefault()
                      selectTranscriptAll()
                    }
                  }}>
                  {transcripts.map((row, index) => {
                    const previous = transcripts[index - 1]
                    const speaker = speakerName(detail, row.speaker)
                    return (
                      <TranscriptRow key={row.id}
                        row={row}
                        playing={currentTime >= row.start && currentTime < row.end}
                        speaker={speaker}
                        heading={Boolean(speaker && (!previous || previous.speaker !== row.speaker || row.start - previous.end >= 8))}
                        query={findOpen && findQuery.trim() ? findQuery : ''}
                        actions={rowActions} />
                    )
                  })}
                </div>
              )}
            </section>
          ) : (
            <div className="mc-minutes-pane">
              <MinutesNotesPanel
                key={sessionId}
                sessionId={sessionId}
                detail={detail}
                notes={detail?.notes || ''}
                version={detail?.notes_version || 0}
                minutes={detail?.minutes || null}
                minutesNotesVersion={detail?.minutes_notes_version || 0}
                t={t}
                resolveAsset={(path) => fileUrl(sessionId, path)}
                saveNotes={(value, expected) => saveRecordNotes(sessionId, value, expected)}
                reloadServer={async () => getSession(sessionId)}
                onVersion={(next) => setDetail((current) => current ? { ...current, notes_version: next } : current)}
                onSeek={(value) => seek(value)}
                onToast={(text, action) => showToast(text, action)}
                onRefreshDetail={() => load(true)}
              />
            </div>
          )}
        </div>

        {tab === 'content' && showInspector ? <aside className="mc-inspector" aria-label={t('detail.info')}>
            <div className="mc-inspector-tabs" role="tablist">
              {[...(speakerTab ? [['speakers', t('detail.speakers') || '发言人', 0]] : []),
                ['marks', t('detail.marks'), marks.length],
                ...(kind === 'live' ? [['shots', t('detail.shots'), shots.length]] : []),
                ['info', t('detail.info'), 0]].map(([id, label, count]) => (
                <button key={id} type="button" role="tab" className="mc-inspector-tab"
                  aria-selected={inspector === id} data-active={inspector === id} onClick={() => setInspector(id)}>
                  {label}{count ? ` ${count}` : ''}
                </button>
              ))}
            </div>

            {kind === 'live' && active && detail?.has_video !== false ? (
              <div className="mc-inspector-live">
                <ShotTriggerBar count={shots.length} max={detail?.max_shots}
                  motion={motion?.score ?? detail?.live?.motion}
                  threshold={motion?.threshold ?? detail?.live?.motion_threshold}
                  lastShot={shots.length ? shots[shots.length - 1].ts : null} onToast={showToast} />
              </div>
            ) : null}

            {inspector === 'speakers' ? (
              <div className="mc-inspector-body">
                <SpeakersPanel detail={detail} sessionId={sessionId} onReload={() => load(false)} t={t} />
              </div>
            ) : null}

            {inspector === 'marks' ? (
              <div className="mc-inspector-body">
                {marks.length === 0 ? <div className="mc-inline-empty"><strong>{t('detail.noMarks')}</strong></div> : (
                  marks.map((mark) => (
                    <div key={mark.id} className="mc-mark-item" data-selected={selectedMarkId === mark.id}
                      onContextMenu={(event) => openMenu(event, markMenu(mark))}>
                      <button type="button" className="mc-mark"
                        onClick={() => { setSelectedMarkId(mark.id); seek(mark.ts) }}
                        onDoubleClick={() => { setSelectedMarkId(mark.id); openMark(mark) }}>
                        <span className="mc-mono">{clock(mark.ts)}</span>
                        <span>{mark.note || '—'}</span>
                      </button>
                      <span className="mc-mark-actions">
                        <button type="button" className="mc-icon-button mc-icon-button-xs" onClick={() => openMark(mark)} aria-label={t('mark.edit')}>✎</button>
                        <button type="button" className="mc-icon-button mc-icon-button-xs" onClick={() => removeMark(mark)} aria-label={t('mark.delete')}>×</button>
                      </span>
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {inspector === 'shots' && kind === 'live' ? (
              <div className="mc-inspector-body">
                <LivePreview sessionId={sessionId} path={detail?.live_preview_path} count={shots.length}
                  max={detail?.max_shots} latest={shots.length ? shots[shots.length - 1].ts : null} />
                <div className="mc-shots-head">
                  <span>{shots.length} 张</span>
                  <button type="button" className="mc-button mc-button-small" disabled={selectedShots.size === 0}
                    onClick={() => downloadShots(shots.filter((shot) => selectedShots.has(shot.id)))}>下载所选</button>
                </div>
                <div className="mc-shots">
                  {hiddenShots > 0 ? (
                    <button type="button" className="mc-button mc-button-small mc-shots-more"
                      onClick={() => setShotLimit((value) => value + SHOT_PAGE_SIZE)}>
                      再显示更早的 {Math.min(SHOT_PAGE_SIZE, hiddenShots)} 张（还有 {hiddenShots} 张）
                    </button>
                  ) : null}
                  {shots.length === 0 ? <div className="mc-inline-empty"><strong>{t('detail.noShots')}</strong></div> : (
                    visibleShots.map((shot) => (
                      <button key={shot.id} type="button" className="mc-shot"
                        data-selected={selectedShots.has(shot.id)}
                        draggable
                        onDragStart={(event) => {
                          const url = new URL(fileUrl(sessionId, shot.path), window.location.origin).href
                          event.dataTransfer.setData('text/uri-list', url)
                          event.dataTransfer.setData('text/plain', url)
                          try { event.dataTransfer.setData('DownloadURL', `image/jpeg:shot-${shot.ts}.jpg:${url}`) } catch {}
                          event.dataTransfer.effectAllowed = 'copy'
                        }}
                        onClick={(event) => selectShot(shot, event)}
                        onDoubleClick={() => setLightbox({ list: [shot], index: 0 })}
                        onContextMenu={(event) => openMenu(event, shotMenu(shot))}
                        title={`${clock(shot.ts)} · 单击选中，双击预览`}>
                        <img src={fileUrl(sessionId, shot.path)} alt={clock(shot.ts)} loading="lazy"
                          decoding="async" draggable={false} />
                        <span className="mc-shot-time mc-mono">{clock(shot.ts)}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {inspector === 'info' ? (
              <div className="mc-inspector-body">
                <InfoRow label={t('detail.kind')} value={t(`kind.${kind}`)} />
                <InfoRow label={t('detail.status')} value={partial ? t('status.partial') : t(`status.${view.status || 'pending'}`)} />
                <InfoRow label={t('detail.duration')} value={view.duration ? duration(view.duration) : '-'} />
                <InfoRow label={t('detail.transcriptCount')} value={String(transcripts.length)} />
                {partial ? (
                  <InfoRow label={t('detail.missingChunks')}
                    value={t('detail.missingValue').replace('{count}', String(missingCount)).replace('{time}', duration(missingSeconds))} />
                ) : null}
                <InfoRow label={t('detail.shotCount')} value={String(shots.length)} />
                <InfoRow label={t('detail.markCount')} value={String(marks.length)} />
                <InfoRow label={t('detail.source')} value={view.source_url || '-'} mono />
                {detail?.stream_quality ? <InfoRow label="画质" value={detail.stream_quality} /> : null}
                {detail?.language ? <InfoRow label="语种" value={detail.language} /> : null}
                {detail?.transcription_source ? <InfoRow label="转写来源" value={detail.transcription_source === 'subtitle' ? '平台字幕' : detail.asr_engine?.provider === 'mimo' ? '云端 ASR' : '本地 ASR'} /> : null}
                <InfoRow label="时间戳" value={detail?.aligned ? '精确到词' : detail?.timing_precision === 'chunk' ? '片段级' : '按句'} />
                {detail?.hotwords ? <InfoRow label="热词" value={detail.hotwords} /> : null}
                <InfoRow label="创建" value={dateTime(view.created_at)} />
                {view.error && !partial ? <InfoRow label="错误" value={view.error} /> : null}
                {(kind === 'meeting' || kind === 'link_video') ? (
                  <div className="mc-actions">
                    <button type="button" className="mc-button mc-button-small" onClick={() => setOptionsOpen(true)}>
                      {t('detail.transcribeOptions')}
                    </button>
                  </div>
                ) : null}
                {detail?.media_path ? (
                  <div className="mc-actions mc-actions-column">
                    {partial ? (
                      <button type="button" className="mc-button mc-button-small" data-variant="primary"
                        disabled={Boolean(actionBusy)} onClick={confirmResume}>
                        {actionBusy === 'retranscribe' ? t('status.processing')
                          : t('detail.fillMissingMenu').replace('{count}', String(missingCount))}
                      </button>
                    ) : null}
                    <button type="button" className="mc-button mc-button-small" disabled={Boolean(actionBusy)}
                      onClick={confirmRestart}>
                      {t('detail.restart')}…
                    </button>
                    <span className="mc-action-hint">
                      {partial ? t('detail.resumeHint') : t('detail.fullRestartHint')}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </aside> : null}
        </div>

      {optionsOpen ? (
        <RetranscribeDialog
          t={t}
          sessionId={sessionId}
          detail={detail}
          onClose={() => setOptionsOpen(false)}
          onDone={() => load(true)}
        />
      ) : null}

      {captureOpen ? (
        <ScreenCaptureDialog
          t={t}
          sessionId={sessionId}
          onClose={() => setCaptureOpen(false)}
          onDone={() => load(true)}
        />
      ) : null}

      {exportData ? (
        <div className="mc-modal-layer" role="dialog" aria-modal="true" aria-label="导出">
          <div className="mc-modal">
            <div className="mc-modal-head">
              <h3>导出</h3>
              <button type="button" className="mc-icon-button" onClick={() => setExportData(null)} aria-label="关闭">×</button>
            </div>
            <pre className="mc-export-text">{exportData.markdown || ''}</pre>
            <div className="mc-modal-actions">
              <button type="button" className="mc-button" onClick={() => navigator.clipboard?.writeText(exportData.markdown || '').catch(() => {})}>复制全文</button>
              <button type="button" className="mc-button" onClick={downloadMarkdown}>下载 Markdown</button>
              <a className="mc-button" href={exportZipUrl(sessionId)}>下载 ZIP</a>
              <a className="mc-button" href={exportFormatUrl(sessionId, 'srt')}>下载 SRT</a>
              <a className="mc-button" href={exportFormatUrl(sessionId, 'vtt')}>下载 VTT</a>
              <a className="mc-button" href={exportFormatUrl(sessionId, 'docx')}>下载 Word</a>
              <button type="button" className="mc-button" onClick={() => setExportData(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}

      {lightbox?.list?.length ? (() => {
        const shot = lightbox.list[lightbox.index] || lightbox.list[0]
        return (
          <div className="mc-modal-layer" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
            <div className="mc-lightbox" onClick={(event) => event.stopPropagation()}>
              <img src={fileUrl(sessionId, shot.path)} alt={clock(shot.ts)} />
              <div className="mc-lightbox-foot">
                {lightbox.list.length > 1 ? (
                  <button type="button" className="mc-button mc-button-small" onClick={() => setLightbox((current) => ({ ...current, index: (current.index - 1 + current.list.length) % current.list.length }))}>←</button>
                ) : null}
                <span className="mc-mono">{clock(shot.ts)}</span>
                <span className="mc-foot-meta">{lightbox.index + 1} / {lightbox.list.length}</span>
                {lightbox.list.length > 1 ? (
                  <button type="button" className="mc-button mc-button-small" onClick={() => setLightbox((current) => ({ ...current, index: (current.index + 1) % current.list.length }))}>→</button>
                ) : null}
                <button type="button" className="mc-button mc-button-small" onClick={() => copyShots([shot])}>复制图片</button>
                <a className="mc-button mc-button-small" href={fileUrl(sessionId, shot.path)} download={`shot-${shot.ts}.jpg`}>下载</a>
                <button type="button" className="mc-button mc-button-small" onClick={() => { seek(shot.ts); setLightbox(null) }}>跳转到此处</button>
                <button type="button" className="mc-button mc-button-small" onClick={() => setLightbox(null)}>关闭</button>
              </div>
            </div>
          </div>
        )
      })() : null}

      {confirm ? (
        <div className="mc-modal-layer" role="dialog" aria-modal="true">
          <div className="mc-modal mc-confirm">
            <div className="mc-modal-head"><h3>{confirm.title}</h3></div>
            <p className="mc-card-text">{confirm.body}</p>
            <div className="mc-modal-actions">
              <button type="button" className="mc-button" onClick={() => setConfirm(null)}>{t('new.cancel')}</button>
              <button type="button" className="mc-button" data-variant={confirm.danger ? 'stop' : 'primary'} onClick={() => {
                const run = confirm.run
                setConfirm(null)
                run?.()
              }}>{confirm.label}</button>
            </div>
          </div>
        </div>
      ) : null}

      <ContextMenu menu={menu} onClose={closeMenu} />

      {toast ? (
        <div className="mc-toast" role="status">
          <span>{toast.text}</span>
          {toast.action ? <button type="button" className="mc-toast-action" onClick={toast.action.run}>{toast.action.label}</button> : null}
          <button type="button" onClick={() => setToast(null)} aria-label="关闭">×</button>
        </div>
      ) : null}
    </div>
  )
}

// 一行转写。播放进度每秒更新数次、motion 分数每 0.5 秒一条、后台轮询还一直在换 detail
// 对象：不把行单独 memo 住，一次重渲染就要逐行 diff 整个列表，长记录会直接把渲染进程拖死。
const TranscriptRow = React.memo(function TranscriptRow({ row, playing, speaker, heading, query, actions }) {
  const pressRef = React.useRef(null)
  return (
    <>
      {heading ? <div className="mc-tr-speaker-head">{speaker}</div> : null}
      <div className="mc-tr" role="button" tabIndex={0} data-playing={playing}
        data-preview={row.preview ? 'true' : 'false'}
        title="单击跳转到这一句；拖选文字即可复制"
        onPointerDown={(event) => { pressRef.current = { x: event.clientX, y: event.clientY } }}
        onClick={(event) => {
          // 只把“这一下拖选出来的选区”当成复制操作；页面里残留的旧选区不能挡住跳转。
          const press = pressRef.current
          const moved = press && (Math.abs(event.clientX - press.x) > 4 || Math.abs(event.clientY - press.y) > 4)
          if (event.detail > 1 || moved) return
          try { window.getSelection?.()?.removeAllRanges?.() } catch {}
          actions.seek(row.start)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            actions.seek(row.start)
          }
        }}
        onContextMenu={(event) => actions.menu(event, row)}>
        <span className="mc-tr-time mc-mono">{clock(row.start)}</span>
        <span className="mc-tr-text">
          {!heading && speaker ? <span className="mc-tr-speaker">{speaker}</span> : null}
          {query ? highlightText(row.text, query) : row.text}
        </span>
      </div>
    </>
  )
}, (prev, next) => (
  prev.row === next.row && prev.playing === next.playing && prev.heading === next.heading
  && prev.speaker === next.speaker && prev.query === next.query && prev.actions === next.actions
))

function LivePreview({ sessionId, path, count, max, latest }) {
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!path) return undefined
    // 预览图每 3 秒换一次就够看；窗口在后台时不刷新，省掉一次图片解码。
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1)
    }, 3000)
    return () => clearInterval(timer)
  }, [path])
  if (!path) return null
  return (
    <div className="mc-live-detect">
      <img src={`${fileUrl(sessionId, path)}?v=${tick}`} alt="实时画面" decoding="async" draggable={false} />
      <div className="mc-live-detect-meta">
        <strong>实时画面检测</strong>
        <span>{count} / {max || 5000} 张截图{latest ? ` · 上次 ${clock(latest)}` : ' · 尚未截图'}</span>
      </div>
    </div>
  )
}

function ShotTriggerBar({ motion = null, threshold = null, lastShot = null, count = 0, max = 5000, onToast }) {
  const [x, setX] = React.useState(0.4)
  const [dragging, setDragging] = React.useState(false)
  const [flash, setFlash] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const saveTimer = React.useRef(null)
  const lastShotRef = React.useRef(lastShot)
  const xRef = React.useRef(x)

  React.useEffect(() => { xRef.current = x }, [x])

  React.useEffect(() => {
    let cancelled = false
    appSettings().then((settings) => {
      if (cancelled || dragging) return
      const value = Number(settings?.shot_sensitivity)
      if (Number.isFinite(value)) setX(Math.min(1, Math.max(0, 1 - value)))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    if (!dragging && Number.isFinite(Number(threshold)) && Number(threshold) > 1) {
      setX(Math.min(1, Math.max(0, Math.log(Number(threshold)) / Math.log(30))))
    }
  }, [threshold, dragging])

  React.useEffect(() => {
    if (lastShot == null || lastShotRef.current === lastShot) return undefined
    lastShotRef.current = lastShot
    setFlash(true)
    const timer = setTimeout(() => setFlash(false), 700)
    return () => clearTimeout(timer)
  }, [lastShot])

  React.useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const score = Number(motion)
  const fill = Number.isFinite(score) && score > 1 ? Math.min(1, Math.log(score) / Math.log(30)) : 0
  const over = fill > 0 && fill >= x
  const near = fill > 0 && !over && fill >= x * 0.7
  const status = flash ? '已截图' : over ? '等待稳定' : near ? '接近阈值' : fill > 0 ? '画面平稳' : '等待画面'
  const tone = flash || over ? '#e88a2d' : near ? '#d8a72f' : 'var(--dsw-alias-label-tertiary)'

  function persist(value) {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    setSaving(true)
    saveAppSettings({ shot_sensitivity: Math.min(1, Math.max(0, 1 - value)) })
      .catch((failure) => onToast?.(failure?.message || '截图灵敏度保存失败'))
      .finally(() => setSaving(false))
  }

  function change(value) {
    setX(value)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => persist(value), 250)
  }

  return (
    <section className="mc-shot-trigger" aria-label="自动截图阈值" title="拖动滑块设置截图阈值：画面变化超过滑块位置且稳定后自动截图。越靠左越灵敏，越靠右只在整页切换时截。">
      <div className="mc-shot-trigger-head">
        <span className="mc-shot-trigger-title">自动截图</span>
        <span className="mc-shot-trigger-count">{count} / {max || 5000} 张</span>
      </div>
      <div className="mc-shot-trigger-row">
        <span className="mc-shot-trigger-end">细微</span>
        <div className="mc-shot-axis" data-over={over} data-flash={flash}>
          <div className="mc-shot-axis-track" />
          <div className="mc-shot-axis-trigger" style={{ left: `${x * 100}%` }} />
          <div className="mc-shot-axis-fill" style={{ width: `${fill * 100}%`, background: over ? '#e88a2d' : near ? '#d8a72f' : 'var(--dsw-alias-label-tertiary)' }} />
          <div className="mc-shot-axis-knob" style={{ left: `${x * 100}%` }} />
          <input className="mc-shot-axis-input" type="range" min="0" max="1" step="0.01" value={x}
            onChange={(event) => change(Number(event.target.value))}
            onPointerDown={() => setDragging(true)}
            onPointerUp={() => { setDragging(false); persist(xRef.current) }}
            onKeyUp={() => persist(xRef.current)}
            aria-label="截图阈值：越靠左越灵敏" />
        </div>
        <span className="mc-shot-trigger-end">整页</span>
        <span className="mc-shot-trigger-status" style={{ color: tone }}>{saving ? '保存中' : status}</span>
      </div>
    </section>
  )
}

function useStageFullscreen(mediaRef) {
  const [active, setActive] = React.useState(false)
  React.useEffect(() => {
    const sync = () => {
      const stage = mediaRef.current?.closest?.('.mc-main-col')
      setActive(Boolean(stage && document.fullscreenElement === stage))
    }
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [mediaRef])
  return active
}

function PlayGlyph({ paused }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      {paused ? (
        <path d="M5.2 3.1a.8.8 0 0 1 1.2-.7l6.3 4.9a.9.9 0 0 1 0 1.4l-6.3 4.9a.8.8 0 0 1-1.2-.7Z" fill="currentColor" />
      ) : (
        <>
          <rect x="4.4" y="3.2" width="2.7" height="9.6" rx="1" fill="currentColor" />
          <rect x="8.9" y="3.2" width="2.7" height="9.6" rx="1" fill="currentColor" />
        </>
      )}
    </svg>
  )
}

function VolumeGlyph({ muted = false }) {
  return (
    <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.2 7h2.5L9 4.1v9.8L5.7 11H3.2Z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="m12 7.2 3.8 3.8M15.8 7.2 12 11" />
      ) : (
        <>
          <path d="M11.4 6.4a3.7 3.7 0 0 1 0 5.2" />
          <path d="M13.5 4.3a6.6 6.6 0 0 1 0 9.4" />
        </>
      )}
    </svg>
  )
}

function FullscreenGlyph({ active = false }) {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {active ? (
        <>
          <path d="M7.5 3v2.7c0 1-.8 1.8-1.8 1.8H3" />
          <path d="M12.5 3v2.7c0 1 .8 1.8 1.8 1.8H17" />
          <path d="M7.5 17v-2.7c0-1-.8-1.8-1.8-1.8H3" />
          <path d="M12.5 17v-2.7c0-1 .8-1.8 1.8-1.8H17" />
        </>
      ) : (
        <>
          <path d="M3 7.5V4.8C3 3.8 3.8 3 4.8 3h2.7" />
          <path d="M17 7.5V4.8c0-1-.8-1.8-1.8-1.8h-2.7" />
          <path d="M3 12.5v2.7c0 1 .8 1.8 1.8 1.8h2.7" />
          <path d="M17 12.5v2.7c0 1-.8 1.8-1.8 1.8h-2.7" />
        </>
      )}
    </svg>
  )
}

function PlayerScrubber({
  time, start, span, live, marks = [], shots = [], hits = [], onSeek
}) {
  const railRef = React.useRef(null)
  const [hover, setHover] = React.useState(null)
  const [draft, setDraft] = React.useState(null)
  const [dragging, setDragging] = React.useState(false)
  const total = Math.max(0, Number(span) || 0)
  const startAt = Math.max(0, Number(start) || 0)
  const enabled = total > 0.5 && typeof onSeek === 'function'
  const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0))
  const ratioAt = (clientX) => {
    const rect = railRef.current?.getBoundingClientRect()
    if (!rect || !rect.width) return 0
    return clamp((clientX - rect.left) / rect.width)
  }
  const timeAt = (ratio) => startAt + clamp(ratio) * total
  const current = clamp(((Number(time) || 0) - startAt) / (total || 1))
  const position = draft === null ? current : draft
  const preview = draft === null ? hover : draft
  const previewTime = preview === null ? 0 : timeAt(preview)
  const markAt = (seconds) => {
    if (!(total > 0)) return 0
    return clamp(((Number(seconds) || 0) - startAt) / total)
  }
  const relative = Math.max(0, Math.min(total, (Number(time) || 0) - startAt))
  const inputValue = draft === null ? relative : draft * total
  function onRange(event) {
    const value = Number(event.target.value)
    if (!enabled || !Number.isFinite(value)) return
    const ratio = clamp(value / total)
    setDraft(ratio)
    // 交给原生 range 处理点击/拖动的坐标：浏览器自己知道点在了哪里，
    // 不再依赖 pointerdown / pointerup 的 clientX（Electron 里曾出现点位丢失）。
    onSeek(startAt + value)
  }
  function finishDrag() {
    setDragging(false)
    setDraft(null)
  }
  return (
    <div className="mc-player-scrub" ref={railRef}
      data-disabled={enabled ? 'false' : 'true'}
      data-dragging={dragging ? 'true' : 'false'}
      onPointerMove={(event) => {
        // 原生 range 负责单击/键盘；按住拖动时再按指针位置补一次，
        // 避免某些 Chromium/Electron 组合里原生滑杆拖动不跟手。
        if (enabled && dragging && (event.buttons & 1)) {
          const ratio = ratioAt(event.clientX)
          setDragging(true)
          setDraft(ratio)
          onSeek(timeAt(ratio))
          return
        }
        if (draft === null && event.pointerType !== 'touch') setHover(ratioAt(event.clientX))
      }}
      onPointerEnter={(event) => { if (enabled && event.pointerType !== 'touch') setHover(ratioAt(event.clientX)) }}
      onPointerLeave={() => { if (!dragging) setHover(null) }}>
      <div className="mc-player-scrub-track" aria-hidden="true">
        <span className="mc-player-scrub-played" style={{ width: `${position * 100}%` }} />
        {shots.map((shot) => (
          <span key={`shot-${shot.id}`} className="mc-player-scrub-shot" title={`截图 ${clock(shot.ts)}`}
            style={{ left: `${markAt(shot.ts) * 100}%` }} />
        ))}
        {hits.map((hit, index) => (
          <span key={`hit-${index}`} className="mc-player-scrub-hit" title={`命中 ${clock(hit.ts)}`}
            style={{ left: `${markAt(hit.ts) * 100}%` }} />
        ))}
        {marks.map((mark) => (
          <span key={`mark-${mark.id}`} className="mc-player-scrub-mark" title={`${clock(mark.ts)} ${mark.note || ''}`}
            style={{ left: `${markAt(mark.ts) * 100}%` }} />
        ))}
        <span className="mc-player-scrub-thumb" style={{ left: `${position * 100}%` }} />
      </div>
      <input className="mc-player-scrub-input" type="range"
        min={0} max={total} step={1}
        value={inputValue}
        disabled={!enabled}
        aria-label={live ? '直播进度' : '播放进度'}
        aria-valuetext={preview === null ? clock(time) : clock(previewTime)}
        onChange={onRange}
        onPointerDown={() => setDragging(true)}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onBlur={finishDrag} />
      {preview === null ? null : (
        <span className="mc-player-scrub-bubble" aria-hidden="true"
          style={{ left: `clamp(28px, ${preview * 100}%, calc(100% - 28px))` }}>
          {clock(previewTime)}
        </span>
      )}
    </div>
  )
}

function PlayerBar({
  mediaRef, live, isVideo = false, t, marks = [], shots = [], hits = [], onSeek = null,
  stageFullscreen = false, stageLayout = 'side', onStageLayout = () => {}, onToggleFullscreen = () => {},
  compact = false, onExpand = null, onToggle = null
}) {
  const [state, setState] = React.useState({
    time: 0, duration: 0, paused: true, volume: 1, rate: 1, seekStart: 0, seekEnd: 0
  })
  React.useEffect(() => {
    const media = mediaRef.current
    if (!media) return undefined
    const sync = () => {
      let seekStart = 0
      let seekEnd = 0
      try {
        const ranges = media.seekable
        if (ranges && ranges.length) {
          seekStart = Number(ranges.start(0)) || 0
          seekEnd = Number(ranges.end(ranges.length - 1)) || 0
        }
      } catch {}
      if (!(seekEnd > seekStart) && Number.isFinite(media.duration) && media.duration > 0) {
        seekStart = 0
        seekEnd = media.duration
      }
      setState({
        time: Number(media.currentTime) || 0,
        duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0,
        paused: Boolean(media.paused),
        volume: Number(media.volume ?? 1),
        rate: Number(media.playbackRate) || 1,
        seekStart,
        seekEnd
      })
    }
    sync()
    const events = ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'volumechange',
      'ratechange', 'seeking', 'seeked', 'progress']
    events.forEach((name) => media.addEventListener(name, sync))
    return () => events.forEach((name) => media.removeEventListener(name, sync))
  }, [mediaRef, mediaRef.current])
  // 直播 HLS 的 duration 是 Infinity：可拖动范围用 seekable（分片窗口），不是时长。
  // 点播则始终用完整时长，避免刚缓冲出一小段时时间轴缩水、点中后段却落回开头。
  const seekWindow = Math.max(0, state.seekEnd - state.seekStart)
  const span = live ? seekWindow : (state.duration > 0 ? state.duration : seekWindow)
  const spanStart = live ? state.seekStart : 0
  const timed = state.duration > 0
  const volume = Math.max(0, Math.min(1, Number(state.volume) || 0))
  function toggle() {
    const media = mediaRef.current
    if (!media) return
    if (typeof onToggle === 'function') { onToggle(); return }
    if (media.paused) media.play?.().catch(() => {})
    else media.pause?.()
  }
  function seekLive() {
    const media = mediaRef.current
    if (!media) return
    const seekable = media.seekable
    const edge = seekable && seekable.length ? seekable.end(seekable.length - 1) : NaN
    if (Number.isFinite(edge)) media.currentTime = Math.max(0, edge - 1.5)
    else if (Number.isFinite(media.duration)) media.currentTime = Math.max(0, media.duration - 4)
    media.play?.().catch(() => {})
  }
  function seekFromBar(seconds) {
    const target = Math.max(0, Number(seconds) || 0)
    if (typeof onSeek === 'function') {
      onSeek(target)
      return
    }
    const media = mediaRef.current
    if (!media) return
    const limit = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : target
    media.currentTime = Math.min(target, limit)
  }
  return (
    <div className={compact ? 'mc-player-bar is-compact' : 'mc-player-bar'}>
      <PlayerScrubber
        time={state.time}
        start={spanStart}
        span={span}
        live={live}
        marks={marks}
        shots={shots}
        hits={hits}
        onSeek={seekFromBar} />
      <div className="mc-player-row">
        <button type="button" className="mc-player-play" onClick={toggle}
          aria-label={state.paused ? '播放' : '暂停'} title={state.paused ? '播放' : '暂停'}>
          <PlayGlyph paused={state.paused} />
        </button>
        <span className="mc-player-time mc-mono">
          {live || !timed ? (
            <>{clock(state.time)} <span className="mc-player-live-tag">· LIVE</span></>
          ) : (
            <>
              <span className="mc-player-time-current">{clock(state.time)}</span>
              <span className="mc-player-time-sep"> / </span>
              <span className="mc-player-time-total">{clock(state.duration)}</span>
            </>
          )}
        </span>
        <span className="mc-player-row-space" />
        {live ? (
          <button type="button" className="mc-player-latest" onClick={seekLive} title="跳到直播最新画面">
            <span aria-hidden="true" />最新
          </button>
        ) : (
          <span className="mc-player-rate" title="播放速度">
            <select value={state.rate}
              onChange={(event) => { if (mediaRef.current) mediaRef.current.playbackRate = Number(event.target.value) }}
              aria-label="播放速度">
              {[0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}x</option>)}
            </select>
          </span>
        )}
        <label className="mc-player-volume" title={`音量 ${Math.round(volume * 100)}%`}>
          <VolumeGlyph muted={volume <= 0.001} />
          <input type="range" min="0" max="1" step="0.05" value={volume}
            style={{ '--mc-volume-fill': `${volume * 100}%` }}
            onChange={(event) => { if (mediaRef.current) mediaRef.current.volume = Number(event.target.value) }}
            aria-label="音量" />
        </label>
        {compact ? (
          <button type="button" className="mc-button mc-button-small mc-player-expand" onClick={onExpand}
            title="回到内容页查看视频和转写">内容页</button>
        ) : null}
        {!compact && stageFullscreen ? (
          <span className="mc-player-layout" role="group" aria-label="分屏方向">
            <button type="button" data-active={stageLayout === 'side' ? 'true' : 'false'}
              aria-pressed={stageLayout === 'side'} onClick={() => onStageLayout('side')}
              title="左右分屏：左侧视频，右侧转写">左右</button>
            <button type="button" data-active={stageLayout === 'stack' ? 'true' : 'false'}
              aria-pressed={stageLayout === 'stack'} onClick={() => onStageLayout('stack')}
              title="上下分屏：上方视频，下方转写">上下</button>
          </span>
        ) : null}
        {isVideo && !compact ? (
          <button type="button" className="mc-player-full" data-active={stageFullscreen ? 'true' : 'false'}
            onClick={onToggleFullscreen}
            aria-label={stageFullscreen ? '退出全屏' : '全屏'}
            title={stageFullscreen ? '退出全屏（Esc）' : `全屏：${stageLayout === 'side' ? '左侧视频，右侧转写' : '上方视频，下方转写'}`}>
            <FullscreenGlyph active={stageFullscreen} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function MediaPane({
  detail, summary, sessionId, t, mediaRef, onTime, marks = [], shots = [], hits = [], onSeek = null,
  stageFullscreen = false, stageLayout = 'side', onStageLayout = () => {}, onToggleFullscreen = () => {},
  compact = false, onExpand = () => {}
}) {
  const [nativeHls] = React.useState(() => {
    try { return Boolean(document.createElement('video').canPlayType('application/vnd.apple.mpegurl')) } catch { return false }
  })
  // Chromium 对 HLS MIME 也返回 "maybe"（实际只能放 MP4 分片），不能只凭 canPlayType
  // 就跳过 hls.js：有 MediaSource 时一律走 hls.js，只有没有 MSE 的 Safari/AVPlayer 才用原生 HLS。
  const mse = (() => { try { return Boolean(Hls.isSupported()) } catch { return false } })()
  const nativeMode = nativeHls && !mse
  const [hlsError, setHlsError] = React.useState('')
  const [hlsGeneration, setHlsGeneration] = React.useState(0)
  const [connecting, setConnecting] = React.useState(false)
  const [playback, setPlayback] = React.useState('idle')   // idle | playing | muted | blocked
  const [paused, setPaused] = React.useState(true)
  const [buffering, setBuffering] = React.useState(false)
  const userPausedRef = React.useRef(false)
  const view = detail || summary || {}
  const live = Boolean(detail?.recording)
  const hls = detail?.live_hls_path
  const mediaPath = detail?.media_path
  const previewPath = detail?.live_preview_path
  const isAudio = detail?.has_video === false
  const supported = mse || nativeMode
  // 出错时也保留 video 元素：时间戳跳转仍可用，重试时不用重新挂载。
  const videoLive = live && Boolean(hls) && supported && !hlsError

  // 直播边播边缓冲：分片/播放列表偶发失败很常见，不要一错就退回静态图；
  // 按次数重连，连不上才给错误提示与一次手动重试。
  React.useEffect(() => {
    if (!live || !hls || !mse) return undefined
    const video = mediaRef.current
    if (!video) return undefined
    let instance = null
    let destroyed = false
    let retryTimer = null
    let attempts = 0
    const start = () => {
      if (destroyed) return
      setConnecting(true)
      instance = new Hls({ enableWorker: true, lowLatencyMode: false })
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return
        attempts = 0
        setConnecting(false)
        setHlsError('')
      })
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (destroyed || !data?.fatal) return
        attempts += 1
        // 播放列表 404：这场直播还没有可播的分片（或者刚被清理），重连一百次也还是 404，
        // 只会把代理和后端刷成请求洪水。立刻停下，让静态预览图顶上。
        const status = Number(data?.response?.code || data?.networkDetails?.status || 0)
        if (status === 404) {
          setConnecting(false)
          setHlsError('offline')
          try { instance.destroy() } catch {}
          instance = null
          return
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && attempts <= 2) {
          try { instance.recoverMediaError() } catch {}
          return
        }
        // 只重连 5 次并指数退避（1s/2s/4s/8s/8s），连不上就让用户手动重试。
        if (attempts <= 5) {
          setConnecting(true)
          try { instance.destroy() } catch {}
          instance = null
          retryTimer = setTimeout(start, Math.min(8000, 1000 * 2 ** (attempts - 1)))
          return
        }
        setConnecting(false)
        setHlsError(data?.details === 'levelLoadError' ? 'offline' : 'failed')
      })
      instance.loadSource(fileUrl(sessionId, hls))
      instance.attachMedia(video)
    }
    start()
    return () => {
      destroyed = true
      if (retryTimer) clearTimeout(retryTimer)
      try { instance?.destroy() } catch {}
    }
  }, [live, hls, mse, sessionId, hlsGeneration, mediaRef])

  // 开始采集后自动播放：先按有声播；被浏览器拦下就静音先出画面，
  // 再把“开启声音”交给一次点击，避免整块画面停在黑屏。
  React.useEffect(() => {
    if (!videoLive || hlsError) return undefined
    const video = mediaRef.current
    if (!video) return undefined
    let cancelled = false
    let timer = null
    let tries = 0
    const fail = (error) => {
      if (cancelled) return
      if (error?.name === 'NotAllowedError' && !video.muted) {
        video.muted = true
        setPlayback('muted')
        start(true)
        return
      }
      if (error?.name === 'NotAllowedError') {
        setPlayback('blocked')
        return
      }
      if (tries < 8 && !userPausedRef.current) {
        tries += 1
        timer = setTimeout(attempt, Math.min(8000, 700 * tries))
      }
    }
    const start = (muted) => {
      try {
        const promise = video.play()
        if (promise && typeof promise.then === 'function') {
          promise.then(() => { if (!cancelled) setPlayback(muted ? 'muted' : 'playing') }).catch(fail)
        } else if (!cancelled) {
          setPlayback(muted ? 'muted' : 'playing')
        }
      } catch (error) {
        fail(error)
      }
    }
    const attempt = () => {
      if (cancelled || userPausedRef.current || !video.paused) return
      start(false)
    }
    attempt()
    const wake = () => {
      if (userPausedRef.current) return
      tries = 0
      attempt()
    }
    video.addEventListener('canplay', wake)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      video.removeEventListener('canplay', wake)
    }
  }, [videoLive, hlsError, hls, sessionId, mediaRef])

  const unmute = React.useCallback(() => {
    const video = mediaRef.current
    if (!video) return
    video.muted = false
    if (!(video.volume > 0)) video.volume = 1
    video.play?.().catch(() => {})
    setPlayback('playing')
  }, [mediaRef])

  // 静音兜底后，用户第一次在面板里点击时顺手把声音打开。
  React.useEffect(() => {
    if (playback !== 'muted') return undefined
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onPointer = (event) => {
      if (event.target?.closest?.('.mc-root')) unmute()
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [playback, unmute])

  function toggleSurface() {
    const video = mediaRef.current
    if (!video || hlsError) return
    if (video.paused) {
      userPausedRef.current = false
      video.play?.().catch(() => {})
    } else {
      userPausedRef.current = true
      video.pause?.()
    }
  }

  if (videoLive) {
    const busy = buffering || (connecting && !hlsError)
    return (
      <div className={compact ? 'mc-media is-compact' : 'mc-media'}>
        <div className="mc-media-stage" data-paused={paused ? 'true' : 'false'}
          onClick={(event) => {
            if (event.target.closest?.('.mc-media-overlay')) return
            if (event.target.closest?.('.mc-media-unmute')) return
            toggleSurface()
          }}>
          <video ref={mediaRef} className="mc-player" playsInline
            src={nativeMode ? fileUrl(sessionId, hls) : undefined}
            onTimeUpdate={(event) => onTime(Number(event.currentTarget.currentTime) || 0)}
            onPlay={(event) => {
              setPaused(false)
              setBuffering(false)
              // 以元素真实的静音状态为准：静音兜底播放时不能把“开启声音”入口藏掉。
              setPlayback(event.currentTarget.muted ? 'muted' : 'playing')
            }}
            onPause={() => setPaused(true)}
            onPlaying={() => { setPaused(false); setBuffering(false) }}
            onWaiting={() => setBuffering(true)}
            onStalled={() => setBuffering(true)}
            onSeeking={() => setBuffering(true)}
            onSeeked={() => setBuffering(false)}
            onCanPlay={() => setBuffering(false)}
            onError={() => { if (nativeMode) setHlsError('failed') }} />
          {paused && !hlsError && !busy ? (
            <span className="mc-media-play-hint" aria-hidden="true">▶</span>
          ) : null}
          {busy ? <span className="mc-media-spinner" aria-hidden="true" /> : null}
          {connecting && !hlsError ? <span className="mc-media-status">{t('detail.hlsReconnecting')}</span> : null}
          {playback === 'muted' && !hlsError ? (
            <button type="button" className="mc-media-unmute"
              onClick={(event) => { event.stopPropagation(); unmute() }}
              title={t('detail.unmute')}>🔇 {t('detail.mutedPlayback')} · {t('detail.unmute')}</button>
          ) : null}
          {hlsError ? (
            <div className="mc-media-overlay mc-media-fail" onClick={(event) => event.stopPropagation()}>
              <strong>{t('detail.hlsFailed')}</strong>
              <span>{hlsError === 'offline' ? t('detail.hlsOffline') : t('detail.hlsRetryHint')}</span>
              <button type="button" className="mc-button mc-button-small"
                onClick={() => {
                  setHlsError('')
                  setHlsGeneration((value) => value + 1)
                  // 原生 HLS（Safari）没有 hls.js 实例可重建：让 video 重新加载同一地址。
                  if (nativeMode) mediaRef.current?.load?.()
                }}>{t('detail.retry')}</button>
            </div>
          ) : null}
        </div>
        <PlayerBar mediaRef={mediaRef} live isVideo t={t} onToggle={toggleSurface}
          marks={marks} shots={shots} hits={hits} onSeek={onSeek}
          stageFullscreen={stageFullscreen} stageLayout={stageLayout}
          onStageLayout={onStageLayout} onToggleFullscreen={onToggleFullscreen}
          compact={compact} onExpand={onExpand} />
      </div>
    )
  }

  if (live) {
    // 直播首个分片要等一个关键帧周期（B 站常见几秒）：先出上一次的预览画面 + 进度提示，
    // 不要把整块区域留成黑屏。
    const poster = previewPath
      ? `${fileUrl(sessionId, previewPath)}?v=${Math.floor((detail?.live?.live_media_time || 0) * 10)}`
      : ''
    return (
      <div className={compact ? 'mc-media is-compact' : 'mc-media'}>
        <div className="mc-media-waiting">
          {poster ? <img className="mc-media-poster" src={poster} alt="" draggable={false} /> : null}
          <div className="mc-media-waiting-body">
            {supported ? <span className="mc-media-spinner" aria-hidden="true" /> : null}
            <strong>{supported ? t('detail.connecting') : t('detail.livePreview')}</strong>
            <span>{supported ? t('detail.connectingHint') : t('detail.hlsUnsupported')}</span>
          </div>
        </div>
      </div>
    )
  }

  if (mediaPath) {
    return (
      <div className={compact ? 'mc-media is-compact' : 'mc-media'}>
        {isAudio ? (
          <audio ref={mediaRef} className="mc-audio" preload="metadata"
            src={fileUrl(sessionId, mediaPath)}
            onTimeUpdate={(event) => onTime(Number(event.currentTarget.currentTime) || 0)} />
        ) : (
          <video ref={mediaRef} className="mc-player" playsInline preload="metadata"
            src={fileUrl(sessionId, mediaPath)}
            onTimeUpdate={(event) => onTime(Number(event.currentTarget.currentTime) || 0)} />
        )}
        <PlayerBar mediaRef={mediaRef} live={false} isVideo={!isAudio} t={t}
          marks={marks} shots={shots} hits={hits} onSeek={onSeek}
          stageFullscreen={stageFullscreen} stageLayout={stageLayout}
          onStageLayout={onStageLayout} onToggleFullscreen={onToggleFullscreen}
          compact={compact} onExpand={onExpand} />
      </div>
    )
  }

  if (compact) return null
  const preparing = Boolean(detail?.processing) || view.status === 'processing'
  return (
    <div className="mc-media-empty">
      <span>{preparing ? t('detail.preparingReplay') : t('detail.noTranscriptHint')}</span>
    </div>
  )
}

function highlightText(text, query) {
  const value = String(text || '')
  const needle = String(query || '').trim()
  if (!needle) return value
  const lower = value.toLowerCase()
  const target = needle.toLowerCase()
  const nodes = []
  let from = 0
  let index = lower.indexOf(target)
  while (index >= 0) {
    if (index > from) nodes.push(value.slice(from, index))
    nodes.push(<mark key={`m${index}`}>{value.slice(index, index + needle.length)}</mark>)
    from = index + needle.length
    index = lower.indexOf(target, from)
  }
  if (from < value.length) nodes.push(value.slice(from))
  return nodes
}

function InfoRow({ label, value, mono = false }) {
  return (
    <div className="mc-row">
      <span className="mc-row-key">{label}</span>
      <span className={`mc-row-value${mono ? ' mc-mono' : ''}`}>{value}</span>
    </div>
  )
}
