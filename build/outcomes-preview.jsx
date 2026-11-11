// 「纪要 · 结论和待办」预览：真实组件 + 真实样式，样本取自 2026-11-11 机器人业务沟通记录。
// 用法：node build/build-outcomes-preview.mjs && node build/outcomes-preview-shot.mjs
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { MinutesView } from '../client-src/components/MinutesView.jsx'
import { todoKey } from '../client-src/lib/minutesInteractions.js'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css
document.head.append(style)

const t = translator('zh-CN')
const metrics = new URLSearchParams(location.search).get('metrics')

const minutes = {
  scenario: 'meeting',
  final: true,
  covered: 2844.7,
  section_order: ['outcomes', 'summary'],
  topics: [
    { start: 0, title: 'U1与X2模型发布节奏' },
    { start: 58.1, title: '武汉门店开业亮相' },
    { start: 86.7, title: 'X2 demo与传播性评估' },
    { start: 200.3, title: '模型能力与成本对比' },
    { start: 540, title: '孔老师沟通与规划' },
    { start: 900, title: '小爱新老板与公关护航' },
    { start: 1140, title: '明年传播资源回收' },
    { start: 1464, title: '料箱项目与人机协作' },
    { start: 2243, title: '武汉门店传播与年终收官' },
    { start: 2610, title: '机器人预算结转与明年申请' }
  ],
  conclusions: [
    { text: 'U1压档到12月中或底，与武汉门店开业打包宣发', owner: null, t: 58.1, support: 2 },
    { text: 'X2实际是否使用U1模型需向对方确认', owner: null, t: 151.5, support: 2 },
    { text: '料箱项目由研发直接对接，只谈技术点不谈传播', owner: null, t: 1283.4, support: 2 },
    { text: '明年传播拍摄和卖点逐步收回自有，不再依赖供应商', owner: null, t: 86.7, support: 2 },
    { text: 'MWC暂不参加，因无新花活且外语需小爱付费支持', owner: null, t: 605.4, support: 2 }
  ],
  todos: [
    { text: '找用户确认X2 demo的传播性和趣味性', owner: null, t: 112.2, support: 1, done: false },
    { text: '确认X2是否真实使用U1模型', owner: null, t: 151.5, support: 1, done: false },
    { text: '下周约孔老师从美国回来后聊12月及2027年规划', owner: null, t: 356.9, support: 2, done: false },
    { text: '跟Jason聊前沿大模型进入智能体领域的应对', owner: null, t: 205.5, support: 1, done: false },
    { text: '12月15日左右去拍料箱人机协作测试', owner: null, t: 20.7, support: 1, done: false },
    { text: '提前跟郑伟申请公关护航资源', owner: null, t: 1143.8, support: 1, done: false },
    { text: '让志颖直接对接料箱技术点', owner: null, t: 1296, support: 1, done: false },
    { text: '把今年没花完的机器人预算计提到明年', owner: null, t: 2610.8, support: 2, done: false },
    { text: '20号发X2+U1+料箱三连，隔十天后推武汉门店开业', owner: null, t: 2247, support: 2, done: false },
    { text: '剪年度回顾demo，配合武汉门店开业发布', owner: null, t: 2345.8, support: 2, done: false }
  ],
  summary: '会议围绕12月机器人业务的两个模型发布、武汉门店开业亮相、料箱项目及传播资源展开讨论，明确了U1与X2的压档策略、各项目对接人分工及下周沟通计划。',
  terms: []
}

// ?stress=1：补几条两位序号和一条会折行的待办，用来看标记列在最坏情况下是否还对得上。
if (new URLSearchParams(location.search).get('stress') === '1') {
  for (let i = 6; i <= 10; i += 1) {
    minutes.conclusions.push({ text: `第${i}条结论用于检查两位序号`, owner: null, t: 60 * i, support: 2 })
  }
  minutes.todos.push({
    text: '这条待办故意写得很长，用来确认正文折行后仍然从文字列开始，不会绕到勾选框下面，也不会把勾选框挤到第二行去',
    owner: null, t: 300, support: 2, done: false
  })
}

// ?done=1：把第一条待办标成已完成，用来核对待勾选框的 ✓ 与划线。
const won = new URLSearchParams(location.search).get('done') === '1'
const interactions = won ? { todos: { [todoKey(minutes.todos[0].text)]: { done: true } }, highlights: [] } : null

createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'mc-root' },
    React.createElement(MinutesView, {
      minutes,
      t,
      interactions,
      onSeek: () => {},
      onCopy: () => {},
      onToggleTodo: () => {}
    }))
)

// 量列用：把序号、勾选框、正文的左右边缘量出来，写进 DOM 供 --dump-dom 抓。
if (metrics) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const box = (node) => {
      const rect = node.getBoundingClientRect()
      return [Math.round(rect.left * 10) / 10, Math.round(rect.top * 10) / 10]
    }
    const index = [...document.querySelectorAll('.mc-minutes-conclusions .mc-minutes-index')].map(box)
    const marks = [...document.querySelectorAll('.mc-minutes-box')].map(box)
    const texts = [...document.querySelectorAll('.mc-minutes-list .mc-minutes-text')].map(box)
    const pre = document.createElement('pre')
    pre.id = 'metrics'
    pre.textContent = JSON.stringify({ index, marks, texts })
    document.body.append(pre)
  }))
}
