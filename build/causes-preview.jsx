// 「纪要 · 原因卡片」预览：真实组件 + 真实样式，样本取自 Mimo showcase 那段讨论。
// 用法：node build/build-causes-preview.mjs && node build/causes-preview-shot.mjs [--light]
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { MinutesView } from '../client-src/components/MinutesView.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css
document.head.append(style)

const t = translator('zh-CN')

const minutes = {
  scenario: 'live',
  final: true,
  covered: 5000,
  section_order: ['topics'],
  topics: [
    {
      start: 4439,
      title: '游戏厂商普遍不愿与生成式 AI 挂钩',
      summary: '做游戏场景 showcase 的难点集中在外部环境与自身能力两侧，都不是短期能补的。',
      points: [],
      fishbone: {
        question: 'Mimo 做游戏场景 showcase 为何困难',
        branches: [
          { label: '竞争格局', detail: 'Kimi 已发力游戏场景，先发优势明显', t: 4238, support: 2 },
          { label: '厂商意愿', detail: '游戏厂商担心 AI 导致画面粗糙，不愿合作', t: 4439, support: 2 },
          { label: '时间窗口', detail: '距发布仅一个月，大品牌合作流程来不及', t: 4878, support: 2 },
          { label: '技术能力', detail: 'Mimo 非生图模型，3D 游戏资产精细度不足', t: 4279, support: 2 },
          { label: '复现风险', detail: 'showcase 易被复刻，一旦翻车影响口碑', t: 4339, support: 0 }
        ]
      }
    }
  ]
}

createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'mc-root' },
    React.createElement(MinutesView, { minutes, t, onSeek: () => {}, onCopy: () => {} }))
)
