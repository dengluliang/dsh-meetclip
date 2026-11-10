import {
  acceptSpeakerGuess, guessSpeakers, rejectSpeakerGuess, speakersPlan, undoSpeakers, updateSpeakers
} from '../lib/api.js'
import { clock } from '../lib/format.js'
import { ContextMenu, useContextMenu } from './ContextMenu.jsx'

const COLORS = ['#5b8def', '#d96c8a', '#4aa88b', '#c08a3e', '#8a6fd1', '#3f9fc4', '#c26a4a', '#6d8f3f']

export function SpeakersPanel({ detail, sessionId, onReload, t }) {
  const [editing, setEditing] = React.useState(null)
  const [draft, setDraft] = React.useState('')
  const [merging, setMerging] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [plan, setPlan] = React.useState(null)
  const { menu, open: openMenu, close: closeMenu } = useContextMenu()

  const speakers = React.useMemo(() => {
    const raw = new Map()
    let total = 0
    for (const row of detail?.transcripts || []) {
      if (!row.speaker) continue
      const seconds = Math.max(0, Number(row.end) - Number(row.start))
      raw.set(row.speaker, (raw.get(row.speaker) || 0) + seconds)
      total += seconds
    }
    return [...raw.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, seconds], index) => ({
        key,
        seconds,
        name: detail?.speakers?.[key] || key,
        percent: total > 0 ? seconds / total : 0,
        color: COLORS[index % COLORS.length]
      }))
  }, [detail])

  const planByRaw = React.useMemo(() => {
    const map = new Map()
    for (const item of plan?.speakers || []) map.set(item.raw, item)
    return map
  }, [plan])

  const loadPlan = React.useCallback(async () => {
    try { setPlan(await speakersPlan(sessionId)) } catch { setPlan(null) }
  }, [sessionId])

  React.useEffect(() => { loadPlan() }, [loadPlan, detail?.transcripts?.length])

  async function run(label, operation) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
      await loadPlan()
      await onReload?.()
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function rename(speaker) {
    const name = draft.trim()
    if (!name || name === speaker.name) { setEditing(null); return }
    const existing = speakers.find((item) => item.key !== speaker.key && item.name === name)
    if (existing && !window.confirm(`“${name}”已存在，是否把 ${speaker.name} 合并到该发言人？`)) {
      return
    }
    await run('rename', async () => {
      if (existing) await updateSpeakers(sessionId, {}, { [speaker.key]: existing.key })
      else await updateSpeakers(sessionId, { [speaker.key]: name }, {})
      setEditing(null)
    })
  }

  async function merge(speaker) {
    if (!merging || merging === speaker.key) return
    await run('merge', async () => {
      await updateSpeakers(sessionId, {}, { [speaker.key]: merging })
      setMerging(null)
    })
  }

  async function guess() {
    const result = await guessSpeakers(sessionId).catch((failure) => {
      setError(failure?.message || String(failure))
      return null
    })
    if (result) {
      setPlan(result)
      setNotice(result.skipped ? result.skipped : `找到 ${result.found || 0} 个名字，采纳前请核对依据`)
      if (result.found) await onReload?.()
    }
  }

  if (speakers.length === 0) {
    return <div className="mc-inline-empty"><strong>{t('detail.noSpeakers') || '暂无发言人'}</strong><span>开启说话人分离并重新转写后可在此编辑。</span></div>
  }

  return (
    <div className="mc-speakers">
      <div className="mc-speaker-bar">
        <button type="button" className="mc-button mc-button-small" disabled={busy}
          onClick={guess} title="从对话里读人名（需要 AI Key）">
          {t('speakers.guess') || '从对话里认人'}
        </button>
        {plan?.can_undo ? (
          <button type="button" className="mc-button mc-button-small" disabled={busy}
            onClick={() => run('undo', async () => { await undoSpeakers(sessionId) })}>
            {t('speakers.undo') || '撤销'}
          </button>
        ) : null}
      </div>
      {notice ? <p className="mc-card-text" role="status">{notice}</p> : null}

      {speakers.map((speaker) => {
        const item = planByRaw.get(speaker.key)
        const candidate = item?.guess
        return (
        <div key={speaker.key} className="mc-speaker" style={{ borderLeftColor: speaker.color }}
          onContextMenu={(event) => openMenu(event, [
            { id: 'rename', label: '重命名…', onSelect: () => { setEditing(speaker.key); setDraft(speaker.name) } },
            {
              id: 'merge',
              label: '合并到',
              submenu: speakers.filter((entry) => entry.key !== speaker.key).map((entry) => ({
                id: entry.key,
                label: entry.name,
                onSelect: () => mergeWith(speaker, entry.key)
              }))
            }
          ])}>
          <div className="mc-speaker-head">
            {editing === speaker.key ? (
              <input className="mc-input mc-speaker-input" autoFocus value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); rename(speaker) }
                  if (event.key === 'Escape') setEditing(null)
                }} />
            ) : (
              <button type="button" className="mc-speaker-name" style={{ color: speaker.color }}
                onDoubleClick={() => { setEditing(speaker.key); setDraft(speaker.name) }}
                title="双击重命名">
                {speaker.name}
              </button>
            )}
            <span className="mc-speaker-time mc-mono">{clock(speaker.seconds)} · {Math.round(speaker.percent * 100)}%</span>
          </div>
          <div className="mc-progress"><span style={{ width: `${Math.max(2, speaker.percent * 100)}%`, background: speaker.color }} /></div>
          {candidate && !candidate.refused ? (
            <div className="mc-speaker-guess">
              <div className="mc-speaker-guess-text">
                <strong>{candidate.name}</strong>
                {candidate.evidence ? <span className="mc-mono">{candidate.evidence}</span> : null}
              </div>
              <div className="mc-speaker-guess-actions">
                <button type="button" className="mc-button mc-button-small" disabled={busy}
                  onClick={() => run('accept', async () => { await acceptSpeakerGuess(sessionId, speaker.key, candidate.name) })}>
                  {t('speakers.accept') || '就是他'}
                </button>
                <button type="button" className="mc-button mc-button-small" disabled={busy}
                  onClick={() => run('reject', async () => { await rejectSpeakerGuess(sessionId, speaker.key) })}>
                  {t('speakers.reject') || '不是'}
                </button>
              </div>
            </div>
          ) : null}
          <div className="mc-speaker-actions">
            {editing === speaker.key ? (
              <>
                <button type="button" className="mc-button mc-button-small" disabled={busy} onClick={() => rename(speaker)}>保存</button>
                <button type="button" className="mc-button mc-button-small" onClick={() => setEditing(null)}>取消</button>
              </>
            ) : (
              <>
                <button type="button" className="mc-button mc-button-small" onClick={() => { setEditing(speaker.key); setDraft(speaker.name) }}>改名</button>
                <select className="mc-input mc-select mc-select-small" value={merging === speaker.key ? merging : ''}
                  onChange={(event) => {
                    const target = event.target.value
                    if (!target) { setMerging(null); return }
                    setMerging(target)
                    if (window.confirm(`把“${speaker.name}”的全部发言合并到另一位发言人？`)) mergeWith(speaker, target)
                    else setMerging(null)
                  }}>
                  <option value="">合并到…</option>
                  {speakers.filter((item2) => item2.key !== speaker.key).map((item2) => (
                    <option key={item2.key} value={item2.key}>{item2.name}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
        )
      })}
      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  )

  async function mergeWith(speaker, target) {
    await run('merge', async () => {
      await updateSpeakers(sessionId, {}, { [speaker.key]: target })
      setMerging(null)
    })
  }
}
