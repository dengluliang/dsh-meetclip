

import css from './styles.css'
import libraryCss from './libraries.css'
import settingsSpacingCss from './settings-spacing.css'
import updateCss from './update.css'
import { MeetClipIcon } from './components/Icon.jsx'
import { Panel } from './components/Panel.jsx'
import { Settings } from './components/Settings.jsx'
import { createAgentBridge, installAgentBridge } from './lib/agent.js'
import { registerCardReferenceSource } from './lib/cards.js'
import { en, translator, zh } from './lib/i18n.js'
import { installStyles } from './lib/styles.js'

export const inject = ['slots']

function useLocaleTick(locale) {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!locale || typeof locale.subscribe !== 'function') return undefined
    return locale.subscribe(() => setTick((value) => value + 1))
  }, [locale])
}

export function apply(ctx) {
  const locale = ctx.get('locale')

  ctx.effect(() => {
    const disposers = []
    if (locale && typeof locale.register === 'function') {
      const entries = [['zh-CN', zh], ['en', en], ['zh', zh], ['en-US', en]]
      for (const [id, dictionary] of entries) {
        try {
          const dispose = locale.register('meetclip', id, dictionary)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch {
          // A deployment may expose a different locale id set; local dictionaries still translate.
        }
      }
    }
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch {}
      }
    }
  })

  // Module Loader halves run through factory(require); `styles` is only provided to
  // dynamic client halves, so inject the package stylesheet explicitly.
  // 资料空间相关的样式单独一份文件：样式主表被多处并发改动，这里不再往里加。
  // 资料空间与设置页节奏各一份独立文件：主样式表被多处并发改动，这里不再往里加。
  ctx.effect(() => installStyles(css + libraryCss + settingsSpacingCss + updateCss))

  function withLocale(Component) {
    return function MeetClipLocalizedView(props) {
      useLocaleTick(locale)
      return <Component {...props} t={translator(locale)} />
    }
  }

  const PanelView = withLocale(Panel)
  const SettingsView = withLocale(Settings)

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'meetclip'
  }, PanelView))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'meetclip',
    order: 20,
    label: () => translator(locale)('panel.title')
  }, MeetClipIcon))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'meetclip',
    order: 25,
    label: () => translator(locale)('settings.title')
  }, SettingsView))

  // Optional integration: wait for the Web input-trigger pipeline instead of
  // declaring it as a hard dependency, so terminals/older shells still load.
  if (typeof ctx.inject === 'function') {
    ctx.effect(() => {
      let pending
      try {
        pending = ctx.inject(['inputTriggers', 'sessions'], (scope) => {
          scope.effect(() => registerCardReferenceSource(scope, locale), 'meetclip: @ cards')
        })
      } catch {
        return () => {}
      }
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      return () => {
        try { pending?.dispose?.() } catch {}
      }
    }, 'meetclip: @ cards')

    // 首页 Hero 的「发给 Agent」：只依赖客户端会话与工作区导航；缺任何一项
    // 就保持不安装，Hero 会给出可操作的错误，采集与搜索不受影响。
    ctx.effect(() => {
      let pending
      try {
        pending = ctx.inject(['sessions', 'uiWorkspace'], (scope) => {
          const dispose = installAgentBridge(createAgentBridge({
            sessions: scope.get('sessions'),
            uiWorkspace: scope.get('uiWorkspace'),
            conversation: (() => { try { return scope.get('conversation') } catch { return null } })()
          }))
          scope.effect(() => dispose, 'meetclip: agent bridge')
        })
      } catch {
        return () => {}
      }
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      return () => {
        try { pending?.dispose?.() } catch {}
      }
    }, 'meetclip: agent bridge')

    // 增强桥：有 conversation 输入模型时，右键「提问」可以把结构化 @ 引用直接放进新会话草稿。
    // 单独 inject，避免让不支持 conversation 的老壳连 Hero 发送也一起失去。
    ctx.effect(() => {
      let pending
      try {
        pending = ctx.inject(['sessions', 'uiWorkspace', 'conversation'], (scope) => {
          const dispose = installAgentBridge(createAgentBridge({
            sessions: scope.get('sessions'),
            uiWorkspace: scope.get('uiWorkspace'),
            conversation: scope.get('conversation')
          }))
          scope.effect(() => dispose, 'meetclip: agent draft bridge')
        })
      } catch {
        return () => {}
      }
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      return () => {
        try { pending?.dispose?.() } catch {}
      }
    }, 'meetclip: agent draft bridge')
  }
}
