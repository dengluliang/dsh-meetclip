// 真浏览器复现：转写 / 纪要里的时间戳点击是否把媒体跳到对应秒。
// 由 build/seek-e2e.mjs 打包并用本地 Chrome 打开；结果 POST 回 /__result。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SessionDetail } from '../client-src/components/SessionDetail.jsx'
import { translator } from '../client-src/lib/i18n.js'
import { installStyles } from '../client-src/lib/styles.js'
import css from '../client-src/styles.css'

installStyles(css)

const params = new URLSearchParams(location.search)
const sessionId = params.get('sid') || ''
const t = translator('zh-CN')

function report(payload) {
  try {
    return fetch('/__result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function findButtonByText(text) {
  return Array.from(document.querySelectorAll('button, [role="tab"]'))
    .find((node) => (node.textContent || '').trim() === text)
}

async function waitFor(predicate, timeout = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = predicate()
    if (value) return value
    await sleep(100)
  }
  return null
}

function mediaElement() {
  return document.querySelector('.mc-media video, .mc-media audio')
}

function parseClock(label) {
  const parts = String(label || '').trim().split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function nearestTranscriptRow(seconds) {
  let best = null
  let bestDistance = Infinity
  for (const row of document.querySelectorAll('.mc-tr')) {
    const value = parseClock(row.querySelector('.mc-tr-time')?.textContent)
    if (value === null) continue
    const distance = Math.abs(value - seconds)
    if (distance < bestDistance) { best = { row, seconds: value }; bestDistance = distance }
  }
  return best
}

async function clickAndRead(seconds) {
  const match = nearestTranscriptRow(seconds)
  if (!match) return { ok: false, error: 'no transcript row with a time label' }
  match.row.click()
  await sleep(900)
  const media = mediaElement()
  if (!media) return { ok: false, error: 'no media element after transcript click' }
  const value = Number(media.currentTime)
  return {
    ok: Math.abs(value - match.seconds) <= 2.5,
    expected: match.seconds,
    actual: Math.round(value * 100) / 100,
    rowLabel: match.row.querySelector('.mc-tr-time')?.textContent?.trim(),
    readyState: media.readyState,
    paused: media.paused,
    duration: Number.isFinite(media.duration) ? Math.round(media.duration * 100) / 100 : String(media.duration)
  }
}

async function main() {
  const detailResponse = await fetch(`/meetclip/api/sessions/${encodeURIComponent(sessionId)}`)
  const detail = await detailResponse.json()
  const results = { sessionId, title: detail.title, kind: detail.kind }

  const root = createRoot(document.getElementById('root'))
  root.render(
    React.createElement('div', { className: 'mc-root', style: { height: '100vh' } },
      React.createElement('div', { className: 'mc-workspace' },
        React.createElement('section', { className: 'mc-content' },
          React.createElement(SessionDetail, {
            sessionId,
            summary: { id: sessionId, title: detail.title, duration: detail.duration, status: detail.status, kind: detail.kind },
            t,
            backendStopped: false,
            onBackendRefresh: () => {},
            focus: null,
            onChanged: () => {},
            onDeleted: () => {},
            onCreated: () => {}
          })
        )
      )
    )
  )

  const rows = await waitFor(() => document.querySelectorAll('.mc-tr').length ? document.querySelectorAll('.mc-tr') : null, 20000)
  results.transcriptRows = rows ? rows.length : 0
  const media = await waitFor(() => {
    const node = mediaElement()
    return node && node.readyState >= 1 ? node : null
  }, 20000)
  results.media = media ? { tag: media.tagName.toLowerCase(), src: String(media.currentSrc || '').slice(0, 120), readyState: media.readyState } : null
  if (!media) {
    await report({ ...results, fatal: 'media never became ready' })
    return
  }

  const duration = Number(detail.duration) || 0
  const target = Math.min(300, Math.max(10, Math.round(duration * 0.1)))
  results.transcriptSeek = await clickAndRead(target)

  // 纪要页：结构化纪要里的时间戳锚点（播放器应保持挂载，只收成迷你条）
  const mediaBeforeTab = mediaElement()
  const minutesTab = findButtonByText('纪要')
  if (minutesTab) {
    minutesTab.click()
    // 用最后一个锚点，确保真的跨过一段距离，而不是本来就在目标位置。
    const anchor = await waitFor(() => {
      let best = null
      let bestSeconds = -1
      for (const node of document.querySelectorAll('.mc-minutes-time')) {
        const seconds = parseClock(node.textContent)
        if (seconds !== null && seconds > bestSeconds) { best = node; bestSeconds = seconds }
      }
      return best
    }, 15000)
    results.minutesTab = { found: true }
    results.minutesMediaMounted = Boolean(mediaElement())
    results.highlightMarks = document.querySelectorAll('mark.mc-hl').length
    results.minutesCompactBar = Boolean(document.querySelector('.mc-media.is-compact'))
    results.sameMediaElement = Boolean(mediaBeforeTab && mediaElement() === mediaBeforeTab)
    if (anchor) {
      const before = mediaElement() ? Number(mediaElement().currentTime) : null
      const expected = parseClock(anchor.textContent.trim())
      results.minutesAnchorCount = document.querySelectorAll('.mc-minutes-time').length
    results.minutesTopics = Array.from(document.querySelectorAll('.mc-minutes-topic-title'))
      .map((node) => (node.textContent || '').trim().slice(0, 40))
    results.minutesAnchor = {
        label: anchor.textContent.trim(),
        title: anchor.getAttribute('title') || '',
        expected
      }
      anchor.click()
      await sleep(900)
      const after = mediaElement() ? Number(mediaElement().currentTime) : null
      results.minutesSeek = {
        mediaMountedAfterClick: Boolean(mediaElement()),
        before,
        after,
        ok: after !== null && expected !== null ? Math.abs(after - expected) <= 2.5 : false
      }
    }
  }

  // 假直播会话上验证待办勾选与右键高亮：真 DOM 选区 + 右键菜单，不碰真实记录。
  if (sessionId === 'live-demo') {
    const box = document.querySelector('button[role="checkbox"]')
    if (box) {
      box.click()
      await sleep(500)
      results.todo = {
        checked: box.getAttribute('aria-checked') === 'true'
          || Boolean(document.querySelector('.mc-minutes-todos li[data-done="true"]')),
        stored: await fetch(`/meetclip/api/sessions/${sessionId}/minutes`).then((r) => r.json())
          .then((data) => Object.values(data.interactions?.todos || {}).some((item) => item && item.done))
          .catch(() => false)
      }
    }
    results.noAgentTrace = !document.body.innerText.includes('会摘助手可见')
      && !document.querySelector('.mc-minutes-trace')
    const summary = document.querySelector('.mc-minutes-topic-summary')
    const paper = document.querySelector('.mc-minutes-paper')
    if (summary && paper) {
      const range = document.createRange()
      range.selectNodeContents(summary)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      paper.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 320, clientY: 260
      }))
      await sleep(200)
      const buttons = Array.from(document.querySelectorAll('.mc-context button'))
      const highlightButton = buttons.find((node) => (node.textContent || '').trim() === '高亮所选')
      results.highlightMenu = buttons.map((node) => (node.textContent || '').trim())
      if (highlightButton) {
        highlightButton.click()
        await sleep(600)
        results.highlight = {
          rendered: Boolean(document.querySelector('mark.mc-hl')),
          stored: await fetch(`/meetclip/api/sessions/${sessionId}/minutes`).then((r) => r.json())
            .then((data) => (data.interactions?.highlights || []).length > 0)
            .catch(() => false)
        }
      }
    }
  }

  await report(results)
}

main().catch((error) => report({ sessionId, fatal: String(error?.stack || error) }))
