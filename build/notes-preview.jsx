// 「纪要 × 笔记」面板预览：真实样式 + 会议模板段落。
// 用法：node build/build-notes-preview.mjs && node build/notes-preview-shot.mjs [--light]
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { MinutesNotesPanel } from '../client-src/components/MinutesNotesPanel.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css
document.head.append(style)

const t = translator('zh-CN')
const invalid = new URLSearchParams(location.search).get('state') === 'invalid'
const notes = `<!-- meetclip:minutes:begin -->
# 会议纪要 · 小爱同学 Muse 版初步沟通
> 由 AI 根据转写自动生成，可直接编辑；「重新整理」会覆盖本节。

## 结论和待办
1. 目标 11 月中旬面向用户开始内测 [00:24](meetclip://seek/24)
2. Muse 与小爱没有本质技术差距，差距在产品化体验 [00:45](meetclip://seek/45)

- [ ] 市场同事给内测宣发形式的建议（陈玉皎）

## 总结
这是一次关于小爱同学 Muse 版方向的初步沟通：从对话式助手转向以“事情”为中心的 Agent 型伙伴，第一版先做独立内测 App，跑通云电脑方案后再回到主端。

## 主题
### [00:05](meetclip://seek/5) 背景与目标
确认 Muse 走红后，领导希望尽快把线上小爱往 Muse 方向改。
- [00:12](meetclip://seek/12) 小爱以对话和 session 为中心，Muse 以“事情”为中心
- [00:24](meetclip://seek/24) 目标 11 月中旬开始内测
**为什么先做独立 App？**
- 成本：每个用户要配云电脑，独立版本便于控制
- 现有版本：无法直接在线上主端改

### [01:20](meetclip://seek/80) 产品方案
首页从聊天界面改为任务/灵感主页，用户确认后把灵感转为任务。
- [01:36](meetclip://seek/96) 首次进入引导连接相册、通知、笔记、录音
- [02:02](meetclip://seek/122) 先小范围几百到上千人验证

## 人名和术语
- **Muse** 小爱同学的新方向
- **密克劳** 内测 App 的参照产品（听作：密克老）
- **陈玉皎** 市场侧同事

<!-- meetclip:minutes:end -->

# 我的笔记

## 待确认
- 邀请码发不发，等市场给建议
- 云电脑成本能不能压到每人每月 20 元以内
`

const detail = {
  id: 'preview', title: '小爱同学 Muse 版初步沟通', kind: 'meeting', status: 'done',
  duration: 4500, recording: false, processing: false, queued: false,
  notes: invalid ? '我的笔记：这条记录还没有生成纪要，先自己写了几句。' : notes,
  notes_version: 3,
  minutes_notes_version: invalid ? 0 : 3,
  transcripts: [{ id: 1, start: 0, end: 4, text: '大家好。' }],
  minutes: invalid ? {
    state: 'invalid_key', state_text: 'AI Key 无效，请到设置检查', version: 1, updated_at: Date.now(),
    covered: 0, kind: 'final', scenario: 'meeting', error: 'AI Key 无效或无模型权限', queued: false
  } : {
    state: 'idle', state_text: '', version: 3, updated_at: Date.now(), covered: 4500,
    kind: 'final', scenario: 'meeting', queued: false
  }
}

if (invalid) {
  const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
  window.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/ai/status')) {
      return json({ provider: 'mimo', provider_name: '默认网关（OpenAI 兼容）', base_url: 'https://gateway.example.test/v1',
        model: 'demo-flash', has_key: true, own_key: false, key_masked: 'sk-••••••••••••AJ2g', credential_error: '' })
    }
    if (target.includes('/ai/check')) {
      return json({ ok: false, kind: 'invalid_key', message: 'AI Key 无效或无模型权限',
        provider: 'mimo', model: 'demo-flash' })
    }
    return json({ detail: 'not mocked' })
  }
}

const root = createRoot(document.getElementById('root'))
root.render(
  <div className="mc-root" style={{ height: 'auto', padding: '34px 44px 60px' }}>
    <div className="mc-detail" style={{ maxWidth: 940, height: 800, margin: '0 auto' }}>
      <div className="mc-detail-tabs" role="tablist">
        <button type="button" role="tab" className="mc-tab" aria-selected={false}>内容</button>
        <button type="button" role="tab" className="mc-tab" aria-selected data-active>纪要</button>
        <span className="mc-tab-hint">点击预览进入编辑</span>
      </div>
      <MinutesNotesPanel
        sessionId="preview"
        detail={detail}
        notes={detail.notes}
        version={3}
        minutes={detail.minutes}
        minutesNotesVersion={detail.minutes_notes_version}
        t={t}
        resolveAsset={(path) => path}
        saveNotes={async () => ({ version: 4 })}
        reloadServer={async () => detail}
        onVersion={() => {}}
        onSeek={() => {}}
        onToast={() => {}}
        onRefreshDetail={() => {}}
      />
    </div>
  </div>
)
