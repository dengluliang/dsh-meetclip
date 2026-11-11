// 静态预览：用真实 BatchCard / BatchOverlay 组件渲染「失败项重试」改动，供 Chrome 截图核对。
// 用法：node build/build-batch-retry-preview.mjs && node build/batch-retry-preview-shot.mjs
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { BatchCard } from '../client-src/components/home/BatchCard.jsx'
import { BatchOverlay } from '../client-src/components/home/BatchOverlay.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React

const style = document.createElement('style')
style.textContent = css
document.head.append(style)

const t = translator('zh-CN')
const created = Math.floor(new Date('2026-11-11T16:40:00+08:00').getTime() / 1000)
const members = [
  { id: 'v1', title: '小米 17 发布会全程回放', status: 'done', platform: 'bilibili', duration: 5420, error: '' },
  { id: 'v2', title: 'DeepSeek 开发者日 · 长上下文与 Agent 实践', status: 'done', platform: 'youtube', duration: 5210, error: '' },
  { id: 'v3', title: '从零搭一个本地知识库', status: 'done', platform: 'bilibili', duration: 1830, error: '' },
  { id: 'v4', title: '产品观察：AI 硬件的第二次尝试', status: 'done', platform: 'weibo', duration: 2400, error: '' },
  { id: 'v5', title: 'iPhone 17 Pro 上手体验', status: 'processing', platform: 'youtube', duration: 1280, error: '' },
  { id: 'v6', title: '本周科技新闻速览', status: 'queued', platform: 'bilibili', duration: 960, error: '' },
  { id: 'v7', title: '某场直播的完整回放', status: 'error', platform: 'bilibili', duration: 0, error: '下载失败：HTTP 403（需要登录或更换浏览器 Cookie）' },
  { id: 'v8', title: '三小时播客精选', status: 'error', platform: 'youtube', duration: 0, error: '视频超过 6 小时上限，已跳过下载' }
]
const batch = {
  id: 'preview-batch',
  title: '批量视频 · 11-11 16:40',
  created_at: created,
  updated_at: created + 180,
  total: members.length,
  counts: { queued: 1, processing: 1, done: 4, error: 2, cancelled: 0 },
  active: 2,
  members
}

const noop = () => {}
const query = new URLSearchParams(location.search)
const view = query.get('view') || 'card'

function Caption({ children }) {
  return <p className="preview-caption">{children}</p>
}

function CardView() {
  return (
    <div className="preview-card-stage">
      <Caption>首页批次卡 · 存在失败项时，卡片底部出现「重试 N 条失败」</Caption>
      <div className="preview-card-wrap">
        <BatchCard item={batch} t={t} onOpen={noop} onDelete={noop} onRetry={noop} />
      </div>
      <p className="preview-note">点击按钮只重试失败的 {batch.counts.error} 条；其余已完成、排队中的记录保持不动。</p>
    </div>
  )
}

function OverlayView() {
  return (
    <div className="preview-overlay-stage">
      <Caption>批次浮层 · 左下角可一键重试全部失败项</Caption>
      <div className="preview-overlay-wrap">
        <BatchOverlay batch={batch} t={t} onClose={noop} onOpenRecord={noop} onDeleteAll={noop}
          onRefresh={noop} onRetry={noop} />
      </div>
      <p className="preview-note">重试后逐条重新入队，列表中成功重试的记录会回到「排队中」，按钮在失败项清零后自动消失。</p>
    </div>
  )
}

function BothView() {
  return (
    <div className="preview-both">
      <div className="preview-col preview-col-card">
        <Caption>首页批次卡 · 失败项可一键重试</Caption>
        <div className="preview-card-wrap">
          <BatchCard item={batch} t={t} onOpen={noop} onDelete={noop} onRetry={noop} />
        </div>
        <p className="preview-note">卡片底部原来显示「部分失败」，现在直接显示「重试 2 条失败项」。</p>
      </div>
      <div className="preview-col preview-col-overlay">
        <Caption>批次浮层 · 左下角重试全部失败项</Caption>
        <div className="preview-overlay-wrap">
          <BatchOverlay batch={batch} t={t} onClose={noop} onOpenRecord={noop} onDeleteAll={noop}
            onRefresh={noop} onRetry={noop} />
        </div>
        <p className="preview-note">只重试失败项；成功后重新入队，失败清零后按钮自动消失。</p>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <div className="mc-root preview-page">
    {view === 'overlay' ? <OverlayView /> : view === 'card' ? <CardView /> : <BothView />}
  </div>
)
