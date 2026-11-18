// 「设置 → 备份」预览：真实 SettingsBackup + mock 后端数据。
// 用法：node build/build-backup-preview.mjs && node build/backup-preview-shot.mjs [--light]
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import backupCss from '../client-src/backup.css'
import { SettingsBackup } from '../client-src/components/SettingsBackup.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css + backupCss
document.head.append(style)

const params = new URLSearchParams(location.search)
const light = params.get('theme') === 'light'
const scenario = params.get('scenario') || 'export'
const t = translator('zh-CN')

if (light) {
  const tokens = {
    '--dsw-alias-bg-base': '#f7f6f3',
    '--dsw-alias-bg-layer-1': '#ffffff',
    '--dsw-alias-bg-layer-2': '#ffffff',
    '--dsw-alias-bg-overlay': '#ffffff',
    '--dsw-alias-label-primary': '#1d1d1f',
    '--dsw-alias-label-secondary': '#6b6b70',
    '--dsw-alias-label-tertiary': '#929298',
    '--dsw-alias-label-caption': '#b0b0b5',
    '--dsw-alias-border-l1': 'rgba(0,0,0,.08)',
    '--dsw-alias-border-l2': 'rgba(0,0,0,.12)',
    '--dsw-alias-border-l4': 'rgba(0,0,0,.18)',
    '--dsw-alias-brand-primary': '#1d1d1f',
    '--dsw-alias-button-primary-fill': '#1d1d1f',
    '--dsw-alias-button-primary-hover': '#333333',
    '--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,.045)',
    '--dsw-alias-interactive-bg-active': 'rgba(0,0,0,.075)',
    '--dsw-alias-state-success-primary': '#2f9d62',
    '--dsw-alias-state-error-primary': '#d24b45',
    '--mc-line': 'rgba(0,0,0,.12)'
  }
  for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value)
  document.body.style.background = tokens['--dsw-alias-bg-base']
  document.body.style.color = tokens['--dsw-alias-label-primary']
}

const catalog = {
  ok: true,
  library: { name: '工作' },
  default_dest: '/Users/me/Library/Application Support/MeetClip/备份',
  format_version: 1,
  app_version: '0.9.18',
  items: {
    packs: [{
      id: '81a26c275e57', title: 'miloco 3.0 相关讨论', count: 6, created_at: 1794294686,
      updated_at: 1794299460,
      members: [
        { type: 'session', id: 'aaaaaaaaaaa1', title: '产品评审第 1 场', kind: 'meeting' },
        { type: 'session', id: 'aaaaaaaaaaa2', title: '产品评审第 2 场', kind: 'meeting' },
        { type: 'session', id: 'aaaaaaaaaaa3', title: '产品评审第 3 场', kind: 'meeting' },
        { type: 'note', id: 'bbbbbbbbbbb1', title: '待办：补上录屏权限说明' },
        { type: 'doc', id: 'doc:ccccccccccc1', title: 'miloco 3.0 需求文档' },
        { type: 'highlight', id: '21', title: '这句是结论' }
      ]
    }],
    records: [
      { id: 'aaaaaaaaaaa1', title: '产品评审第 1 场', kind: 'meeting', status: 'done', created_at: 1794294686, duration: 3200, transcripts: 420, marks: 12, screenshots: 4, has_notes: true, has_minutes: true, has_media: true, media_bytes: 268435456, base_bytes: 482000 },
      { id: 'aaaaaaaaaaa2', title: '产品评审第 2 场', kind: 'meeting', status: 'done', created_at: 1794200000, duration: 2800, transcripts: 380, marks: 8, screenshots: 2, has_notes: true, has_minutes: true, has_media: true, media_bytes: 134217728, base_bytes: 360000 },
      { id: 'aaaaaaaaaaa3', title: '产品评审第 3 场', kind: 'meeting', status: 'done', created_at: 1794100000, duration: 2400, transcripts: 300, marks: 3, screenshots: 0, has_notes: false, has_minutes: true, has_media: true, media_bytes: 67108864, base_bytes: 300000 },
      { id: 'aaaaaaaaaaa4', title: '发布会直播 · 秋季新品', kind: 'live', status: 'recording', created_at: 1794300000, duration: 1800, transcripts: 260, marks: 5, screenshots: 18, has_notes: false, has_minutes: true, active: true, has_media: true, media_bytes: 536870912, base_bytes: 120000 },
      { id: 'aaaaaaaaaaa5', title: 'B站视频：iPhone 17 上手', kind: 'link_video', status: 'done', created_at: 1794000000, duration: 900, transcripts: 120, marks: 1, screenshots: 0, has_notes: false, has_minutes: false, has_media: true, media_bytes: 734003200, base_bytes: 48000 },
      { id: 'aaaaaaaaaaa6', title: '周会纪要（无媒体）', kind: 'meeting', status: 'done', created_at: 1793900000, duration: 600, transcripts: 80, marks: 0, screenshots: 0, has_notes: true, has_minutes: true, has_media: false, media_bytes: 0, base_bytes: 26000 }
    ],
    notes: [
      { id: 'bbbbbbbbbbb1', title: '待办：补上录屏权限说明', kind: 'todo', created_at: 1794295000, base_bytes: 320 },
      { id: 'bbbbbbbbbbb2', title: '下次记得问一下发布会时间', kind: 'note', created_at: 1794201000, base_bytes: 90 }
    ],
    highlights: [
      { id: 21, session_id: 'aaaaaaaaaaa1', session_title: '产品评审第 1 场', note: '这句是结论：先上线灰度', ts: 512, created_at: 1794294900 },
      { id: 22, session_id: 'aaaaaaaaaaa2', session_title: '产品评审第 2 场', note: '成本要再算一遍', ts: 128, created_at: 1794202000 }
    ],
    images: [{ id: 'ddddddddddd1', title: '图片卡', width: 1440, height: 900, created_at: 1794203000, base_bytes: 402000 }],
    docs: [{ key: 'ccccccccccc1', title: 'miloco 3.0 需求文档', doc_type: 'docx', has_content: true, created_at: 1794204000, base_bytes: 8200 }],
    batches: [{ id: 'eeeeeeeeeee1', title: '批量视频 · 11-06 18:20', count: 3, created_at: 1794000000, member_ids: ['aaaaaaaaaaa5'] }]
  },
  totals: { records: 6, packs: 1, notes: 2, images: 1, docs: 1, batches: 1, highlights: 2, media_bytes: 1325000000, base_bytes: 1200000 }
}

const inspect = {
  ok: true,
  path: '/Users/me/Downloads/MeetClip备份-20261116-1042.zip',
  archive_bytes: 18874368,
  created_at: 1794303000,
  app_version: '0.9.18',
  source: { library: '生活' },
  options: { include_media: false },
  format_version: 1,
  counts: { records: 4, transcripts: 860, screenshots: 9, marks: 19, minutes: 4, notes: 2, images: 1, docs: 1, packs: 1, batches: 1, highlights: 2 },
  media_bytes: 0,
  media_included: false,
  items: [],
  already_imported: { records: 0, packs: 0, notes: 0, images: 0, docs: 0 },
  warnings: ['有 1 条记录正在采集时导出，只包含当时已写入的内容'],
  compatible: true
}

const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
const exportJob = { id: 'backup-demo', action: 'export', state: 'running', phase: '写入备份', message: '正在打包记录与截图', percent: 46, done: 9, total: 21, bytes_done: 8800000, bytes_total: 18874368, started_at: Date.now() / 1000 }
const importJob = { id: 'backup-import', action: 'import', state: 'running', phase: '写入资料库', message: '正在写入卡片内容', percent: 62, done: 4, total: 7, bytes_done: 12000000, bytes_total: 18874368, started_at: Date.now() / 1000 }
const doneExportJob = { id: 'backup-done', action: 'export', state: 'done', phase: '完成', message: '', percent: 100, done: 21, total: 21, bytes_done: 18874368, bytes_total: 18874368, started_at: Date.now() / 1000, finished_at: Date.now() / 1000, result: { path: inspect.path, bytes: 18874368, sha256: '9f2c1a7b6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a', counts: { records: 4, packs: 1, batches: 1, notes: 2, images: 1, docs: 1, transcripts: 860 }, warnings: ['有 1 条记录正在采集时导出，只包含当时已写入的内容'], include_media: true, format_version: 1 } }
const doneImportJob = { id: 'backup-import-done', action: 'import', state: 'done', phase: '完成', message: '', percent: 100, done: 7, total: 7, bytes_done: 18874368, bytes_total: 18874368, started_at: Date.now() / 1000, finished_at: Date.now() / 1000, result: { archive: { path: inspect.path, archive_id: 'demo', source: { library: '生活' }, created_at: inspect.created_at, format_version: 1 }, counts: { records: 4, notes: 2, images: 1, docs: 1, packs: 1, transcripts: 860, marks: 19, screenshots: 9 }, skipped: { records: 0, notes: 0, images: 0, docs: 0, packs: 0 }, warnings: ['有 1 条记录正在采集时导出，只包含当时已写入的内容'], include_media: false } }
let currentJob = null
window.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/api/backup/catalog')) return json(catalog)
  if (target.includes('/api/backup/job')) return json({ ok: true, job: currentJob })
  if (target.includes('/api/backup/inspect')) return json(inspect)
  if (target.includes('/app/pick-file')) return json({ ok: true, path: inspect.path })
  if (target.includes('/api/backup/export')) {
    currentJob = scenario === 'done' ? doneExportJob : exportJob
    return json({ ok: true, job: currentJob })
  }
  if (target.includes('/api/backup/import')) {
    currentJob = scenario === 'importdone' ? doneImportJob : importJob
    return json({ ok: true, job: currentJob })
  }
  if (target.includes('/api/backup/cancel')) {
    currentJob = null
    return json({ ok: true, job: null })
  }
  return json({ ok: true })
}

function Frame() {
  return (
    <div className="mc-root" style={{ padding: '22px 24px', maxWidth: 980, margin: '0 auto' }}>
      <SettingsBackup t={t} onClose={() => {}} />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Frame />)

// 自动勾选卡包并读取一份备份，让截图里同时有「已选」和「导入摘要」。
// 目录是异步加载的，按钮出现前要重试；只执行一次。
let filled = false
function clickWhenReady(label, delay = 120) {
  setTimeout(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === label)
    if (!button) {
      clickWhenReady(label, delay)
      return
    }
    button.click()
  }, delay)
}
function autoFill() {
  if (filled) return
  const pick = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === '选择文件…')
  const packRow = Array.from(document.querySelectorAll('.mc-backup-row'))
    .find((row) => row.textContent.includes('miloco 3.0 相关讨论'))
  if (!pick || !packRow) {
    setTimeout(autoFill, 150)
    return
  }
  filled = true
  packRow.querySelector('input')?.click()
  const media = Array.from(document.querySelectorAll('.mc-backup-option')).find((row) => row.textContent.includes('包含视频/音频文件'))
  media?.querySelector('input')?.click()
  pick.click()
  if (scenario === 'import' || scenario === 'importdone') clickWhenReady('开始导入', 400)
  else clickWhenReady('导出备份', 1400)
}
setTimeout(autoFill, 200)
