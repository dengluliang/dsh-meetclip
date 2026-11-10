// 会议采集面板预览：复现首页采集框 + 会议导入卡片的实际宽度（520px）。
// 用法：node build/build-meeting-preview.mjs && node build/meeting-preview-shot.mjs
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { CaptureInline } from '../client-src/components/capture/CaptureInline.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React

const style = document.createElement('style')
style.textContent = css
document.head.append(style)

const options = {
  languages: [
    { id: '', name: '自动' }, { id: 'Chinese', name: '中文' }, { id: 'English', name: '英文' },
    { id: 'Cantonese', name: '粤语' }, { id: 'Japanese', name: '日语' }
  ],
  asr_ready: true,
  asr_provider: 'mimo',
  hotwords_supported: false
}

window.fetch = async (url) => {
  const target = String(url)
  let body = {}
  if (target.includes('/meeting/options')) body = options
  else if (target.includes('/api/deps')) body = { ready: true, yt_dlp: true, ffmpeg: true }
  else if (target.includes('/api/sessions')) body = []
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

const t = translator('zh-CN')
const query = new URLSearchParams(location.search)
const filled = query.get('empty') !== '1'
// 默认展示多选批量态：一条视频 + 一条音频，导入后自动收进一个卡包。
const single = query.get('single') === '1'
const files = filled ? (single ? [
  { path: '/Users/me/Movies/与软件部沟通后续如何协作.m4a', name: '与软件部沟通后续如何协作.m4a', bytes: 12.4 * 1024 * 1024 }
] : [
  { path: '/Users/me/Movies/产品评审 第 1 场.mp4', name: '产品评审 第 1 场.mp4', bytes: 486.2 * 1024 * 1024 },
  { path: '/Users/me/Movies/产品评审 第 2 场.m4a', name: '产品评审 第 2 场.m4a', bytes: 42.6 * 1024 * 1024 }
]) : null

createRoot(document.getElementById('root')).render(
  <div className="mc-root" style={{ height: 'auto', padding: '44px 56px 320px' }}>
    <h1 className="mc-home-headline">
      你留下了 <b className="mc-home-serif">10</b> 段现场，共 <b className="mc-home-serif">8.9</b> 小时。
      <br />
      本周新增 <b>2</b> 条
    </h1>
    <form className="mc-home-capture" data-capture="true" style={{ position: 'relative', maxWidth: 520, marginLeft: 0 }}>
      <button type="button" className="mc-home-plus" aria-label="新建采集" title="新建采集">＋</button>
      <input readOnly placeholder="已选择会议文件，在下方确认后导入" />
      <CaptureInline t={t} type="meeting" files={files} onClose={() => {}} onCreated={() => {}} />
    </form>
  </div>
)
