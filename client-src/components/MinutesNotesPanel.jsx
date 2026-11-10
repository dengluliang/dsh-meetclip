import {
  aiStatus as fetchAIStatus, checkAI, generateMinutes, getMinutes, getMinutesInteractions,
  minutesMarkdown, saveMinutesInteractions, syncMinutesNotes
} from '../lib/api.js'
import { Markdown } from '../lib/markdown.jsx'
import { MeetClipIcon } from './Icon.jsx'
import { ContextMenu, useContextMenu } from './ContextMenu.jsx'
import { MinutesView } from './MinutesView.jsx'
import { newHighlightId, selectionHighlight, todoKey } from '../lib/minutesInteractions.js'
import {
  hasMinutesBlock, mergeDraftWithBlock, scenarioKey, scenarioLabel, stripMinutesBlock
} from '../lib/minutes.js'
import { hasMinutesContent } from '../lib/minutesView.js'

const DRAFT_PREFIX = 'meetclip.draft.'
const VIEW_KEY = 'meetclip.minutes.view'

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => {})
  try {
    const area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
  } catch {}
  return Promise.resolve()
}

function visibleWords(text) {
  return Array.from(String(text || '').replace(/<!--[\s\S]*?-->/g, '')).length
}

function chipText({ pending, minutes, stateKey, hasBlock, aiHasKey, t }) {
  if (pending) return t('minutes.updating') || '正在整理纪要…'
  if (stateKey === 'verified') return t('minutes.stateVerified') || '模型可用'
  if (stateKey === 'failed') return t('minutes.stateFailed') || '上次整理失败'
  if (stateKey === 'invalid_key') return t('minutes.stateInvalidKey') || 'AI Key 无效'
  if (stateKey === 'no_key') return aiHasKey ? (t('minutes.stateRetry') || '可重新生成') : (t('minutes.stateNoKey') || '未配置文字模型')
  if (stateKey === 'rate_limited') return t('minutes.stateRateLimited') || '限流，稍后重试'
  if (minutes?.kind === 'live' && !minutes?.final) return t('minutes.live') || '随录制更新'
  if (stateKey === 'ready') {
    return hasBlock && !minutes?.version ? (t('minutes.stateFromNotes') || '来自笔记') : (t('minutes.stateReady') || 'AI 纪要')
  }
  return t('minutes.stateEmpty') || '尚未生成'
}

export function MinutesNotesPanel({
  sessionId, detail, notes, version, minutes, minutesNotesVersion,
  t, resolveAsset, saveNotes, reloadServer, onVersion, onSeek, onToast, onRefreshDetail
}) {
  const storageKey = `${DRAFT_PREFIX}${sessionId}`
  const initial = React.useMemo(() => {
    const serverNotes = notes || ''
    try {
      const draft = JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (draft && typeof draft.text === 'string' && draft.text !== serverNotes) {
        return {
          text: mergeDraftWithBlock(serverNotes, draft.text),
          restored: true,
          baseVersion: Number(draft.baseVersion) || Number(version) || 0
        }
      }
    } catch {}
    return { text: serverNotes, restored: false, baseVersion: Number(version) || 0 }
  }, [storageKey])

  const [text, setText] = React.useState(initial.text)
  const [baseVersion, setBaseVersion] = React.useState(initial.baseVersion)
  const [status, setStatus] = React.useState(initial.restored ? 'dirty' : 'idle')
  const [preview, setPreview] = React.useState(true)
  const [findOpen, setFindOpen] = React.useState(false)
  const [findQuery, setFindQuery] = React.useState('')
  const [findMatches, setFindMatches] = React.useState([])
  const [findIndex, setFindIndex] = React.useState(0)
  const [conflict, setConflict] = React.useState(false)
  const [error, setError] = React.useState('')
  const [serverUpdate, setServerUpdate] = React.useState(null)
  const [actionBusy, setActionBusy] = React.useState('')
  const [actionError, setActionError] = React.useState('')
  const [aiInfo, setAIInfo] = React.useState(null)
  const [checking, setChecking] = React.useState(false)
  const [checkResult, setCheckResult] = React.useState(null)
  const [restored] = React.useState(initial.restored)
  const [native, setNative] = React.useState(null)
  const [nativeState, setNativeState] = React.useState('idle')
  const [viewPref, setViewPref] = React.useState(() => {
    try { return localStorage.getItem(VIEW_KEY) || '' } catch { return '' }
  })
  const [selectionText, setSelectionText] = React.useState('')
  // 用户互动（勾选待办 / 高亮）独立于 AI 纪要保存；native 只是渲染数据。
  const [interactions, setInteractions] = React.useState(() => ({ todos: {}, highlights: [] }))
  const { menu, open: openMenu, close: closeMenu } = useContextMenu()
  const docRef = React.useRef(null)
  const textareaRef = React.useRef(null)
  const timerRef = React.useRef(null)
  const textRef = React.useRef(text)
  const versionRef = React.useRef(baseVersion)
  const dirtyRef = React.useRef(initial.restored)
  const savingRef = React.useRef(false)
  const syncBusyRef = React.useRef(false)
  const refreshRef = React.useRef(onRefreshDetail)
  const interactionsRef = React.useRef(interactions)
  const interactionsTimer = React.useRef(null)
  const interactionsBusy = React.useRef(false)
  const interactionsDirty = React.useRef(false)
  const mountedRef = React.useRef(true)
  const lastServerRef = React.useRef({ notes: notes || '', version: Number(version) || 0 })

  refreshRef.current = onRefreshDetail
  textRef.current = text
  versionRef.current = baseVersion
  interactionsRef.current = interactions

  const pending = Boolean(minutes && (minutes.state === 'updating' || minutes.queued))
  const hasBlock = hasMinutesBlock(text)
  const scenario = minutes?.scenario || scenarioKey(detail?.kind)
  const templateLabel = scenarioLabel(scenario, t)
  const minutesVersion = Number(minutes?.version) || 0
  const appliedVersion = Number(minutesNotesVersion) || 0
  const stateKey = pending ? 'pending'
    : (['failed', 'no_key', 'invalid_key', 'rate_limited'].includes(minutes?.state) ? minutes.state
      : (hasBlock || minutesVersion > 0 ? 'ready' : 'empty'))
  const canGenerate = Array.isArray(detail?.transcripts) ? detail.transcripts.length > 0 : Number(detail?.transcripts) > 0
  const processing = Boolean(detail?.recording || detail?.processing || detail?.queued ||
    ['recording', 'processing', 'queued'].includes(detail?.status))
  const noModel = minutes?.state === 'no_key' || minutes?.state === 'invalid_key'
  const needAI = noModel
  const aiHasKey = aiInfo ? Boolean(aiInfo.has_key) : null
  const aiModel = aiInfo?.model || ''
  const minutesError = String(minutes?.error || '').trim()
  const verified = checkResult?.ok === true
  const inheritedKey = Boolean(aiInfo?.has_key) && aiInfo?.own_key === false
  const showWrite = !pending && !noModel && minutesVersion > 0 && !hasBlock
  const showRegenerate = !pending && (minutesVersion > 0 || hasBlock || canGenerate)
  const syncMissing = !pending && !noModel && minutesVersion > 0 && !hasBlock
  const retryHint = t('minutes.hintRetry') || '文字模型已配置，重新整理会再试一次。'
  const invalidConfiguredHint = aiHasKey === true
    ? (t('minutes.hintInvalidConfigured') || '')
      .replace('{model}', aiModel ? `（${aiModel}）` : '')
      .replace('{error}', minutesError ? `：${minutesError}` : '')
    : null
  const hint = verified ? (t('minutes.hintVerified') || '')
    : pending ? null
    : minutes?.state === 'no_key'
      ? (aiHasKey ? retryHint : (t('minutes.hintNoKey') || ''))
      : minutes?.state === 'invalid_key'
        ? (aiHasKey === null ? (t('minutes.hintInvalidKey') || '')
          : (aiHasKey ? invalidConfiguredHint : (t('minutes.hintNoKey') || '')))
        : minutes?.state === 'rate_limited' ? (t('minutes.hintRateLimited') || '')
          : minutes?.state === 'failed' ? (t('minutes.hintFailed') || '')
            : null
  const emptyHint = verified ? (t('minutes.hintVerified') || '')
    : pending
    ? (t('minutes.processingHint') || '')
    : noModel
      ? (aiHasKey ? retryHint : (t('minutes.hintNoKey') || ''))
      : processing
        ? (t('minutes.processingHint') || '')
        : !canGenerate ? (t('minutes.noTranscript') || '') : (t('minutes.autoHint') || '')
  const words = visibleWords(text)
  const userNotes = stripMinutesBlock(text)
  const mode = viewPref === 'source' || !native ? 'source' : 'structured'

  function persistDraft(value) {
    try {
      if (value === '' && !dirtyRef.current) return
      localStorage.setItem(storageKey, JSON.stringify({ text: value, baseVersion: versionRef.current, updatedAt: Date.now() }))
    } catch {}
  }

  function clearDraft() {
    try { localStorage.removeItem(storageKey) } catch {}
  }

  async function save(force = false) {
    if (savingRef.current) return
    if (!force && !dirtyRef.current) return
    savingRef.current = true
    setStatus('saving')
    setError('')
    try {
      const result = await saveNotes(textRef.current, versionRef.current)
      const nextVersion = result?.version ?? result?.notes_version ?? versionRef.current + 1
      setBaseVersion(nextVersion)
      versionRef.current = nextVersion
      onVersion?.(nextVersion)
      dirtyRef.current = false
      setStatus('saved')
      setConflict(false)
      clearDraft()
      refreshRef.current?.()
    } catch (failure) {
      if (failure?.status === 409) {
        setStatus('conflict')
        setConflict(true)
      } else {
        setStatus('error')
        setError(failure?.message || String(failure))
      }
    } finally {
      savingRef.current = false
    }
  }

  function change(value) {
    setText(value)
    dirtyRef.current = true
    setStatus('dirty')
    persistDraft(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => save(true), 600)
  }

  React.useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'hidden' && dirtyRef.current) save(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (timerRef.current) clearTimeout(timerRef.current)
      if (dirtyRef.current) persistDraft(textRef.current)
    }
  }, [sessionId])

  // 打开面板时静默拉一次详情：纪要可能刚好在转录完成后排上队。
  React.useEffect(() => {
    refreshRef.current?.()
  }, [sessionId])

  // 这次失败到底是"没配模型"还是"配了但被拒绝"：只在失败状态下查一次 AI 状态。
  React.useEffect(() => {
    setCheckResult(null)
    if (!needAI) {
      setAIInfo(null)
      return undefined
    }
    let cancelled = false
    fetchAIStatus()
      .then((data) => { if (!cancelled) setAIInfo(data || null) })
      .catch(() => { if (!cancelled) setAIInfo(null) })
    return () => { cancelled = true }
  }, [needAI, sessionId])

  // 服务端笔记变化（AI 纪要写入、另一处保存）：不脏就刷新，脏就只提示。
  React.useEffect(() => {
    const nextNotes = notes || ''
    const nextVersion = Number(version) || 0
    if (nextNotes === lastServerRef.current.notes && nextVersion === lastServerRef.current.version) return
    const contentChanged = nextNotes !== lastServerRef.current.notes
    lastServerRef.current = { notes: nextNotes, version: nextVersion }
    // 只是父层跟着保存结果更新了 version、notes 仍是旧内容时，不要把手里的新文本覆盖回去。
    if (!contentChanged) return
    if (dirtyRef.current) {
      setServerUpdate({ notes: nextNotes, version: nextVersion })
      return
    }
    setText(nextNotes)
    textRef.current = nextNotes
    setBaseVersion(nextVersion)
    versionRef.current = nextVersion
    if (status === 'saved' || status === 'idle') setStatus('idle')
  }, [notes, version])

  // 结构化视图的数据：详情只带状态与版本，正文按版本单独拉。
  React.useEffect(() => {
    const version = Number(minutes?.version) || 0
    if (!version) {
      setNative(null)
      setNativeState('idle')
      return undefined
    }
    let cancelled = false
    setNativeState((previous) => (previous === 'ready' ? 'ready' : 'loading'))
    getMinutes(sessionId)
      .then((data) => {
        if (cancelled) return
        const usable = hasMinutesContent(data)
        setNative(usable ? data : null)
        setNativeState(usable ? 'ready' : 'empty')
      })
      .catch(() => {
        if (cancelled) return
        setNative(null)
        setNativeState('error')
      })
    return () => { cancelled = true }
  }, [sessionId, minutes?.version])

  // 后端返回的互动是权威版本；本地刚点、还没落库时不要被刷新冲掉。
  React.useEffect(() => {
    const server = native?.interactions
    if (!server || typeof server !== 'object') return
    if (interactionsBusy.current || interactionsDirty.current || interactionsTimer.current) return
    const doc = { todos: server.todos || {}, highlights: server.highlights || [] }
    interactionsRef.current = doc
    setInteractions(doc)
  }, [native])

  React.useEffect(() => () => {
    mountedRef.current = false
    if (interactionsTimer.current) {
      clearTimeout(interactionsTimer.current)
      interactionsTimer.current = null
      const doc = interactionsRef.current
      saveMinutesInteractions(sessionId, { todos: doc.todos || {}, highlights: doc.highlights || [] }).catch(() => {})
    }
  }, [sessionId])

  function applyInteractions(doc) {
    if (!doc || typeof doc !== 'object') return
    const next = { todos: doc.todos || {}, highlights: doc.highlights || [] }
    interactionsRef.current = next
    setInteractions(next)
  }

  async function flushInteractions() {
    if (interactionsBusy.current) { interactionsDirty.current = true; return }
    interactionsBusy.current = true
    try {
      do {
        interactionsDirty.current = false
        const doc = interactionsRef.current
        const result = await saveMinutesInteractions(sessionId, {
          todos: doc.todos || {}, highlights: doc.highlights || []
        })
        if (!mountedRef.current) return
        if (result?.interactions) applyInteractions(result.interactions)
        // 笔记里的纪要段落会跟着写成 - [x] /「高亮」，让工具与导出看到同一份状态。
        if (result?.notes_sync?.synced) refreshRef.current?.()
      } while (interactionsDirty.current)
    } catch (failure) {
      if (!mountedRef.current) return
      setActionError(failure?.message || String(failure))
      try {
        const data = await getMinutesInteractions(sessionId)
        if (mountedRef.current && data?.interactions) applyInteractions(data.interactions)
      } catch {}
    } finally {
      interactionsBusy.current = false
    }
  }

  function commitInteractions(next) {
    interactionsRef.current = next
    setInteractions(next)
    setActionError('')
    interactionsDirty.current = true
    if (interactionsTimer.current) clearTimeout(interactionsTimer.current)
    interactionsTimer.current = setTimeout(() => {
      interactionsTimer.current = null
      flushInteractions()
    }, 220)
  }

  function toggleTodo(item) {
    const key = todoKey(item?.text)
    if (!key) return
    const todos = { ...(interactionsRef.current.todos || {}) }
    const done = Boolean(todos[key]?.done)
    if (done) delete todos[key]
    else todos[key] = { done: true, text: String(item?.text || ''), at: Date.now() / 1000 }
    commitInteractions({ ...interactionsRef.current, todos })
  }

  function addHighlight(picked) {
    if (!picked?.quote) return
    const list = interactionsRef.current.highlights || []
    if (list.some((item) => item.quote === picked.quote && (item.topic || '') === (picked.topic || ''))) {
      onToast?.(t('minutes.highlightExists') || '这段文字已经高亮过了')
      return
    }
    const highlight = {
      id: newHighlightId(),
      quote: picked.quote,
      fragments: picked.fragments,
      section: picked.section || '',
      topic: picked.topic || '',
      t: picked.t === null || picked.t === undefined ? null : picked.t,
      at: Date.now() / 1000
    }
    commitInteractions({ ...interactionsRef.current, highlights: [...list, highlight] })
    try { window.getSelection?.()?.removeAllRanges?.() } catch {}
    setSelectionText('')
  }

  function removeHighlight(id) {
    if (!id) return
    const list = (interactionsRef.current.highlights || []).filter((item) => item.id !== id)
    commitInteractions({ ...interactionsRef.current, highlights: list })
  }

  function highlightCurrentSelection() {
    const picked = selectionHighlight(docRef.current)
    if (!picked) {
      onToast?.(t('minutes.selectForHighlight') || '先选中要标亮的文字')
      return
    }
    addHighlight(picked)
  }

  function openMarkMenu(event, span) {
    if (!span?.id) return
    openMenu(event, [
      {
        id: 'copyHighlight', label: t('minutes.copyHighlight') || '复制高亮文字',
        onSelect: () => copyPlain(span.quote || '', t('minutes.highlight') || '高亮')
      },
      {
        id: 'removeHighlight', label: t('minutes.removeHighlight') || '取消高亮', danger: true,
        onSelect: () => removeHighlight(span.id)
      }
    ])
  }

  function openSelectionMenu(event) {
    const mark = event.target?.closest?.('mark.mc-hl')
    const picked = selectionHighlight(docRef.current)
    const items = []
    if (picked) {
      items.push({
        id: 'highlight', label: t('minutes.highlightSelection') || '高亮所选',
        onSelect: () => addHighlight(picked)
      })
    }
    if (mark) {
      const id = mark.getAttribute('data-highlight-id')
      items.push({
        id: 'copyHighlight', label: t('minutes.copyHighlight') || '复制高亮文字',
        onSelect: () => copyPlain(mark.textContent || '', t('minutes.highlight') || '高亮')
      })
      items.push({
        id: 'removeHighlight', label: t('minutes.removeHighlight') || '取消高亮', danger: true,
        onSelect: () => removeHighlight(id)
      })
    }
    if (picked) {
      if (items.length) items.push({ separator: true })
      items.push({
        id: 'copySelection', label: t('minutes.copySelection') || '复制选中',
        onSelect: copySelection
      })
    }
    if (!items.length) return
    openMenu(event, items)
  }

  // 老记录：有纪要版本但笔记还没有段落时，懒回填一次；用户自己删掉的不会反复加回。
  React.useEffect(() => {
    if (pending || noModel || syncBusyRef.current) return
    if (!minutesVersion || hasBlock) return
    if (appliedVersion >= minutesVersion) return
    syncBusyRef.current = true
    let cancelled = false
    syncMinutesNotes(sessionId, false)
      .then((result) => {
        if (!cancelled && result?.synced) refreshRef.current?.()
      })
      .catch(() => {})
      .finally(() => { syncBusyRef.current = false })
    return () => { cancelled = true }
  }, [sessionId, pending, noModel, minutesVersion, hasBlock, appliedVersion])

  React.useEffect(() => {
    if (preview) return undefined
    const area = textareaRef.current
    if (!area) return undefined
    const frame = requestAnimationFrame(() => {
      area.focus()
      const end = textRef.current.length
      try { area.setSelectionRange(end, end) } catch {}
    })
    return () => cancelAnimationFrame(frame)
  }, [preview])

  async function loadLatest() {
    try {
      const next = await reloadServer()
      const nextNotes = next?.notes || ''
      setText(nextNotes)
      textRef.current = nextNotes
      const nextVersion = next?.notes_version ?? next?.version ?? 0
      setBaseVersion(nextVersion)
      versionRef.current = nextVersion
      dirtyRef.current = false
      setStatus('idle')
      setConflict(false)
      setServerUpdate(null)
      clearDraft()
      onVersion?.(nextVersion)
      onRefreshDetail?.()
    } catch (failure) {
      setError(failure?.message || String(failure))
    }
  }

  function keepDraft() {
    setConflict(false)
    setStatus('conflict')
    persistDraft(textRef.current)
  }

  function loadServerUpdate() {
    if (!serverUpdate) return
    setText(serverUpdate.notes)
    textRef.current = serverUpdate.notes
    setBaseVersion(serverUpdate.version)
    versionRef.current = serverUpdate.version
    dirtyRef.current = false
    setStatus('idle')
    setServerUpdate(null)
    setConflict(false)
    clearDraft()
    onVersion?.(serverUpdate.version)
  }

  function keepServerDraft() {
    setServerUpdate(null)
    dirtyRef.current = true
    setStatus('dirty')
    persistDraft(textRef.current)
  }

  function enterEdit() {
    setPreview(false)
  }

  function exitEdit() {
    if (dirtyRef.current) save(true)
    setPreview(true)
  }

  function onPaperClick(event) {
    if (event.defaultPrevented) return
    const target = event.target
    if (target?.closest?.('a, button, input, textarea, label, summary, [data-no-edit]')) return
    try {
      if (String(window.getSelection?.()?.toString?.() || '').trim()) return
    } catch {}
    enterEdit()
  }

  async function verifyAI() {
    setChecking(true)
    setCheckResult(null)
    try {
      const result = await checkAI()
      setCheckResult(result?.ok
        ? { ok: true, text: `${t('minutes.checkOk') || 'Key 可用'}${result.seconds ? `（${result.seconds}s）` : ''} · ${t('minutes.checkOkHint') || ''}` }
        : { ok: false, text: result?.message || t('minutes.checkFailed') || '检查失败' })
    } catch (failure) {
      setCheckResult({ ok: false, text: failure?.message || String(failure) })
    } finally {
      setChecking(false)
    }
  }

  async function flushSave() {
    if (!dirtyRef.current) return true
    if (savingRef.current) return true
    await save(true)
    return !dirtyRef.current
  }

  async function regenerate() {
    setActionBusy('generate')
    setActionError('')
    if (!(await flushSave())) {
      setActionError(t('minutes.saveFirst') || '请先处理当前笔记的保存或冲突，再继续。')
      setActionBusy('')
      return
    }
    try {
      await generateMinutes(sessionId, 'final')
      if (onToast) onToast(t('minutes.updating') || '已开始整理纪要')
      await onRefreshDetail?.()
    } catch (failure) {
      setActionError(failure?.message || String(failure))
    } finally {
      setActionBusy('')
    }
  }

  async function writeToNotes() {
    setActionBusy('sync')
    setActionError('')
    if (!(await flushSave())) {
      setActionError(t('minutes.saveFirst') || '请先处理当前笔记的保存或冲突，再继续。')
      setActionBusy('')
      return
    }
    try {
      const result = await syncMinutesNotes(sessionId, true)
      if (result?.synced && onToast) onToast(t('minutes.synced') || 'AI 纪要已写入笔记')
      await onRefreshDetail?.()
    } catch (failure) {
      setActionError(failure?.message || String(failure))
    } finally {
      setActionBusy('')
    }
  }

  function wrap(before, after = before, placeholder = '') {
    const area = textareaRef.current
    if (!area) return
    const start = area.selectionStart
    const end = area.selectionEnd
    const selected = text.slice(start, end) || placeholder
    const next = `${text.slice(0, start)}${before}${selected}${after}${text.slice(end)}`
    change(next)
    requestAnimationFrame(() => {
      area.focus()
      area.setSelectionRange(start + before.length, start + before.length + selected.length)
    })
  }

  function insert(textToInsert) {
    const area = textareaRef.current
    if (!area) return
    const start = area.selectionStart
    const next = `${text.slice(0, start)}${textToInsert}${text.slice(area.selectionEnd)}`
    change(next)
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + textToInsert.length, start + textToInsert.length) })
  }

  function setParagraph(level) {
    const area = textareaRef.current
    if (!area) return
    const start = text.lastIndexOf('\n', Math.max(0, area.selectionStart - 1)) + 1
    const endIndex = text.indexOf('\n', area.selectionEnd)
    const end = endIndex === -1 ? text.length : endIndex
    const block = text.slice(start, end)
    const lines = block.split('\n').map((line) => {
      const stripped = line.replace(/^\s*(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '')
      return level > 0 ? `${'#'.repeat(level)} ${stripped}` : stripped
    })
    const next = `${text.slice(0, start)}${lines.join('\n')}${text.slice(end)}`
    change(next)
    requestAnimationFrame(() => {
      area.focus()
      area.setSelectionRange(start, start + lines.join('\n').length)
    })
  }

  function computeMatches(query) {
    const needle = query.trim()
    if (!needle) return []
    const list = []
    const lower = text.toLowerCase()
    const target = needle.toLowerCase()
    let from = 0
    let index = lower.indexOf(target)
    while (index >= 0 && list.length < 500) {
      list.push({ start: index, end: index + needle.length })
      from = index + Math.max(1, needle.length)
      index = lower.indexOf(target, from)
    }
    return list
  }

  function jumpTo(index, matches = findMatches) {
    if (!matches.length) return
    const next = (index + matches.length) % matches.length
    setFindIndex(next)
    const area = textareaRef.current
    const match = matches[next]
    if (area && match) {
      area.focus()
      area.setSelectionRange(match.start, match.end)
    }
  }

  React.useEffect(() => {
    const matches = computeMatches(findQuery)
    setFindMatches(matches)
    setFindIndex(0)
    if (matches.length) jumpTo(0, matches)
  }, [findQuery, text])

  const statusText = {
    idle: '',
    dirty: '未保存',
    saving: '保存中…',
    saved: '已保存',
    conflict: '版本冲突',
    error: '保存失败'
  }[status]

  const chipLabel = chipText({ pending, minutes, stateKey: verified ? 'verified' : stateKey, hasBlock, aiHasKey, t })

  const mdTools = (
    <div className="mc-md-tools">
      <select className="mc-input mc-select mc-select-small" title="段落样式" defaultValue=""
        onChange={(event) => { setParagraph(Number(event.target.value)); event.target.value = '' }}>
        <option value="" disabled>正文</option>
        <option value="0">正文</option>
        <option value="1">标题 1</option>
        <option value="2">标题 2</option>
        <option value="3">标题 3</option>
      </select>
      <button type="button" className="mc-md-tool" onClick={() => wrap('**', '**', '重点')} title="加粗（⌘B）"><strong>B</strong></button>
      <button type="button" className="mc-md-tool" onClick={() => wrap('*', '*', '斜体')} title="斜体（⌘I）"><em>I</em></button>
      <button type="button" className="mc-md-tool" onClick={() => wrap('~~', '~~', '删除')} title="删除线"><s>S</s></button>
      <button type="button" className="mc-md-tool" onClick={() => insert('- ')} title="项目列表">•</button>
      <button type="button" className="mc-md-tool" onClick={() => insert('1. ')} title="编号列表">1.</button>
      <button type="button" className="mc-md-tool" onClick={() => insert('- [ ] ')} title="待办列表">☐</button>
      <button type="button" className="mc-md-tool" onClick={() => insert('> ')} title="引用">❝</button>
      <button type="button" className="mc-md-tool" onClick={() => wrap('`')} title="行内代码">&lt;/&gt;</button>
      <button type="button" className="mc-md-tool" onClick={() => insert('\n```\n\n```\n')} title="代码块">▤</button>
      <button type="button" className="mc-md-tool" onClick={() => insert('[文本](https://)')} title="链接">🔗</button>
      <button type="button" className="mc-md-tool" onClick={() => insert('\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n')} title="表格">▦</button>
      <button type="button" className="mc-md-tool" onClick={() => insert('\n---\n')} title="分隔线">—</button>
      <button type="button" className="mc-md-tool" onClick={() => setFindOpen((value) => !value)} title="查找（⌘F）">⌕</button>
      <button type="button" className="mc-md-tool" onClick={() => copyText(text)} title="复制全部笔记">⧉</button>
    </div>
  )

  function chooseView(next) {
    setViewPref(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch {}
  }

  function editSource() {
    chooseView('source')
    setPreview(false)
  }

  function trackSelection() {
    try {
      const selection = window.getSelection?.()
      const value = String(selection?.toString?.() || '').trim()
      setSelectionText(value && docRef.current?.contains(selection?.anchorNode) ? value : '')
    } catch {
      setSelectionText('')
    }
  }

  function copyPlain(value, label) {
    const textValue = String(value || '').trim()
    if (!textValue) return
    copyText(textValue)
    onToast?.(label
      ? `${t('minutes.copiedSection') || '已复制'} · ${label}`
      : (t('minutes.copied') || '已复制到剪贴板'))
  }

  function copySelection() {
    let value = selectionText
    if (!value) {
      try { value = String(window.getSelection?.()?.toString?.() || '').trim() } catch {}
    }
    if (!value) {
      onToast?.(t('minutes.selectFirst') || '先选中要复制的文字')
      return
    }
    copyText(value)
    onToast?.(t('minutes.copiedSelection') || '已复制选中的文字')
  }

  async function copyAll() {
    setActionBusy('copy')
    setActionError('')
    try {
      const value = await minutesMarkdown(sessionId, false)
      await copyText(String(value || ''))
      onToast?.(t('minutes.copied') || '已复制到剪贴板')
    } catch (failure) {
      setActionError(failure?.message || String(failure))
    } finally {
      setActionBusy('')
    }
  }

  return (
    <section className="mc-notes mc-jottings">
      <header className="mc-jottings-head">
        <div className="mc-jottings-title-wrap">
          <div className="mc-jottings-title-row">
            <h3 className="mc-jottings-title">{t('detail.minutes') || '纪要'}</h3>
            <span className="mc-ai-chip" data-state={verified ? 'verified' : stateKey} role="status">
              <span className="mc-ai-dot" aria-hidden="true" />
              {chipLabel}
            </span>
            <span className="mc-jottings-template">{templateLabel}</span>
          </div>
          <p className="mc-jottings-sub">{t('minutes.mergedHint') || 'AI 生成，写入笔记；点击可编辑'}</p>
        </div>
        <div className="mc-jottings-actions">
          {native ? (
            <div className="mc-view-switch" role="group" aria-label={t('minutes.view') || '视图'}>
              <button type="button" data-active={mode === 'structured'}
                onClick={() => chooseView('structured')}>{t('minutes.structured') || '结构化'}</button>
              <button type="button" data-active={mode === 'source'}
                onClick={() => { chooseView('source'); setPreview(true) }}>{t('minutes.source') || '原文'}</button>
            </div>
          ) : null}
          {mode === 'structured' ? (
            <>
              {showWrite ? (
                <button type="button" className="mc-button mc-button-small" disabled={Boolean(actionBusy)} onClick={writeToNotes}>
                  {actionBusy === 'sync' ? (t('minutes.writing') || '写入中…') : (t('minutes.writeToNotes') || '写入笔记')}
                </button>
              ) : null}
              {showRegenerate ? (
                <button type="button" className="mc-button mc-button-small" disabled={Boolean(actionBusy)}
                  title={t('minutes.regenerateHint') || ''} onClick={regenerate}>
                  {actionBusy === 'generate' ? (t('minutes.updating') || '正在整理纪要…')
                    : (hasBlock ? (t('minutes.regenerate') || '重新生成') : (t('minutes.generate') || '生成纪要'))}
                </button>
              ) : null}
              <button type="button" className="mc-button mc-button-small" onClick={editSource}>
                {t('minutes.editSource') || '编辑原文'}
              </button>
            </>
          ) : !preview ? (
            <button type="button" className="mc-button mc-button-small" onClick={exitEdit}>{t('minutes.preview') || '预览'}</button>
          ) : (
            <>
              {showWrite ? (
                <button type="button" className="mc-button mc-button-small" disabled={Boolean(actionBusy)} onClick={writeToNotes}>
                  {actionBusy === 'sync' ? (t('minutes.writing') || '写入中…') : (t('minutes.writeToNotes') || '写入笔记')}
                </button>
              ) : null}
              {showRegenerate ? (
                <button type="button" className="mc-button mc-button-small" disabled={Boolean(actionBusy)}
                  title={t('minutes.regenerateHint') || ''} onClick={regenerate}>
                  {actionBusy === 'generate' ? (t('minutes.updating') || '正在整理纪要…')
                    : (hasBlock ? (t('minutes.regenerate') || '重新生成') : (t('minutes.generate') || '生成纪要'))}
                </button>
              ) : null}
              <button type="button" className="mc-button mc-button-small" data-variant={hasBlock ? undefined : 'primary'}
                onClick={enterEdit}>{t('minutes.edit') || '编辑'}</button>
            </>
          )}
        </div>
      </header>

      <div className="mc-jottings-body">
        {hint ? (
          <div className="mc-jottings-hint-row">
            <p className="mc-jottings-hint">{hint}</p>
            {needAI && aiHasKey ? (
              <button type="button" className="mc-button mc-button-small" disabled={checking} onClick={verifyAI}>
                {checking ? (t('minutes.checking') || '检查中…') : (t('minutes.checkModel') || '检查模型')}
              </button>
            ) : null}
          </div>
        ) : null}
        {checkResult ? (
          <p className="mc-jottings-check" data-ok={checkResult.ok ? 'true' : 'false'} role="status">{checkResult.text}</p>
        ) : null}
        {needAI && inheritedKey ? <p className="mc-jottings-hint">{t('minutes.hintInheritedKey') || ''}</p> : null}
        {actionError ? <p className="mc-error-text" role="alert">{actionError}</p> : null}
        {syncMissing && !actionError ? <p className="mc-jottings-hint">{t('minutes.hintSyncMissing') || ''}</p> : null}
        {restored ? <div className="mc-notes-banner">已恢复本机未同步的草稿。</div> : null}
        {error ? <div className="mc-notes-banner mc-notes-banner-error" role="alert">{error}</div> : null}
        {serverUpdate ? (
          <div className="mc-notes-banner mc-notes-banner-info" role="status">
            <strong>{t('minutes.backgroundUpdate') || '笔记已在后台更新'}</strong>
            <span>{t('minutes.backgroundUpdateBody') || ''}</span>
            <div className="mc-actions">
              <button type="button" className="mc-button mc-button-small" onClick={loadServerUpdate}>
                {t('minutes.loadLatest') || '载入最新'}
              </button>
              <button type="button" className="mc-button mc-button-small" onClick={keepServerDraft}>
                {t('minutes.keepDraft') || '保留草稿'}
              </button>
            </div>
          </div>
        ) : null}
        {conflict ? (
          <div className="mc-notes-banner mc-notes-banner-error" role="alert">
            <strong>笔记已在其他位置更新。</strong>
            <span>当前草稿已保留。可以载入最新版本，或保留草稿后自行合并。</span>
            <div className="mc-actions">
              <button type="button" className="mc-button mc-button-small" onClick={loadLatest}>载入最新版本</button>
              <button type="button" className="mc-button mc-button-small" onClick={keepDraft}>保留草稿</button>
            </div>
          </div>
        ) : null}

        {mode === 'structured' && native ? (
          <>
            <div className="mc-minutes-toolbar">
              <p className="mc-minutes-tool-hint">
                {t('minutes.selectHint') || '可自由选择文字复制，也可以整份复制。'}
              </p>
              <div className="mc-actions">
                <button type="button" className="mc-button mc-button-small"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={highlightCurrentSelection} disabled={!selectionText}
                  title={t('minutes.highlightHint') || '选中文字后加高亮'}>
                  {t('minutes.highlightSelection') || '高亮所选'}
                </button>
                <button type="button" className="mc-button mc-button-small"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={copySelection} disabled={!selectionText}>
                  {t('minutes.copySelection') || '复制选中'}
                </button>
                <button type="button" className="mc-button mc-button-small" disabled={actionBusy === 'copy'} onClick={copyAll}>
                  {actionBusy === 'copy' ? (t('minutes.copying') || '复制中…') : (t('minutes.copyAll') || '复制全部')}
                </button>
              </div>
            </div>
            <div className="mc-notes-paper mc-jottings-paper mc-minutes-paper" ref={docRef}
              onMouseUp={trackSelection} onKeyUp={trackSelection}
              onContextMenu={openSelectionMenu} data-view="structured">
              <MinutesView minutes={native} t={t} onSeek={onSeek} onCopy={copyPlain}
                interactions={interactions} onToggleTodo={toggleTodo} onMark={openMarkMenu} />
            </div>
            <div className="mc-jottings-foot">
              <span>{t('minutes.selectHintFoot') || '选中任意文字即可复制'}</span>
              <span className="mc-foot-meta">{templateLabel}</span>
            </div>
            {userNotes.trim() ? (
              <div className="mc-minutes-notes">
                <div className="mc-minutes-notes-head">
                  <h4>{t('minutes.myNotes') || '我的笔记'}</h4>
                  <button type="button" className="mc-button mc-button-small" onClick={editSource}>
                    {t('minutes.editNotes') || '编辑笔记'}
                  </button>
                </div>
                <div className="mc-notes-paper mc-jottings-paper is-readonly">
                  <Markdown text={userNotes} resolveAsset={resolveAsset} onSeek={onSeek} />
                </div>
              </div>
            ) : null}
          </>
        ) : preview ? (
          text.trim() ? (
            <>
              <div className="mc-notes-paper mc-jottings-paper" onClick={onPaperClick}
                title={t('minutes.clickEdit') || '点击编辑'}>
                <Markdown text={text} resolveAsset={resolveAsset} onSeek={onSeek} />
              </div>
              <div className="mc-jottings-foot">
                <span>{t('minutes.clickEdit') || '点击任意位置编辑'}</span>
                <span className="mc-foot-meta">{words} 字</span>
              </div>
            </>
          ) : (
            <div className="mc-notes-paper mc-jottings-paper is-empty" onClick={onPaperClick}>
              <div className="mc-jottings-empty">
                <MeetClipIcon size={30} />
                <h4>{pending ? (t('minutes.updating') || '正在整理纪要…') : (t('minutes.empty') || '还没有纪要')}</h4>
                <p>{emptyHint}</p>
                <div className="mc-actions">
                  {canGenerate && !pending ? (
                    <button type="button" className="mc-button mc-button-small" data-variant="primary"
                      disabled={Boolean(actionBusy)} onClick={(event) => { event.stopPropagation(); regenerate() }}>
                      {actionBusy === 'generate' ? (t('minutes.updating') || '正在整理纪要…') : (t('minutes.generate') || '生成纪要')}
                    </button>
                  ) : null}
                  <button type="button" className="mc-button mc-button-small"
                    onClick={(event) => { event.stopPropagation(); enterEdit() }}>
                    {t('minutes.startWrite') || '写点什么'}
                  </button>
                </div>
              </div>
            </div>
          )
        ) : (
          <>
            <div className="mc-notes-toolbar">
              {mdTools}
              <div className="mc-notes-status">
                <span className="mc-foot-meta">{words} 字</span>
                {statusText ? <span className="mc-save-state" data-state={status}>{statusText}</span> : null}
                <button type="button" className="mc-button mc-button-small" onClick={() => save(true)} disabled={status === 'saving'}>保存</button>
              </div>
            </div>
            {findOpen ? (
              <div className="mc-findbar">
                <input className="mc-input" autoFocus value={findQuery} placeholder="查找笔记"
                  onChange={(event) => setFindQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); jumpTo(findIndex + (event.shiftKey ? -1 : 1)) }
                    if (event.key === 'Escape') { event.preventDefault(); setFindOpen(false) }
                  }} />
                <span className="mc-find-count">{findMatches.length ? `${findIndex + 1}/${findMatches.length}` : '0'}</span>
                <button type="button" className="mc-button mc-button-small" onClick={() => jumpTo(findIndex - 1)} disabled={!findMatches.length}>↑</button>
                <button type="button" className="mc-button mc-button-small" onClick={() => jumpTo(findIndex + 1)} disabled={!findMatches.length}>↓</button>
                <button type="button" className="mc-icon-button" onClick={() => setFindOpen(false)} aria-label="关闭查找">×</button>
              </div>
            ) : null}
            <textarea ref={textareaRef} className="mc-notes-area" value={text}
              onChange={(event) => change(event.target.value)}
              onBlur={() => { if (dirtyRef.current) save(true) }}
              onKeyDown={(event) => {
                const modifier = event.metaKey || event.ctrlKey
                if (modifier && event.key.toLowerCase() === 'f') {
                  event.preventDefault(); setFindOpen(true)
                } else if (modifier && event.key.toLowerCase() === 's') {
                  event.preventDefault(); save(true)
                } else if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') {
                  event.preventDefault(); exitEdit()
                } else if (modifier && event.key.toLowerCase() === 'b') {
                  event.preventDefault(); wrap('**', '**', '重点')
                } else if (modifier && event.key.toLowerCase() === 'i') {
                  event.preventDefault(); wrap('*', '*', '斜体')
                } else if (event.key === 'Escape' && !findOpen) {
                  event.preventDefault(); exitEdit()
                }
              }}
              placeholder={t('detail.noNotes')} spellCheck={false} />
          </>
        )}
      </div>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </section>
  )
}
