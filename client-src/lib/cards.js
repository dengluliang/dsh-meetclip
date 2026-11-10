import { listCards, listLibraries, status } from './api.js'
import { clock, dateTime } from './format.js'
import { localeId, translator } from './i18n.js'
import { matchLibraryByDir, sameDirectory } from './libraries.js'
import { publishLibraryHint } from './status-bus.js'

// 卡片根目录就是当前激活的资料空间；顺带缓存空间列表，用来判断
// 「这个会话的工作区其实属于另一个资料空间」。
const ROOT_TTL_MS = 15_000
let rootCache = { at: 0, value: { root: '', libraries: [] } }

export { sameDirectory }

/** 会摘工作区根目录 + 已知资料空间；失败时短时间缓存空值，避免每敲一个字都打接口。 */
export async function meetclipContext() {
  const now = Date.now()
  if (now - rootCache.at < ROOT_TTL_MS) return rootCache.value
  try {
    const [result, libraries] = await Promise.all([
      status(),
      listLibraries().catch(() => null)
    ])
    const value = {
      root: result?.locations?.dataDirCanonical || result?.locations?.dataDir || '',
      libraries: libraries?.libraries || []
    }
    rootCache = { at: now, value }
    return value
  } catch {
    rootCache = { at: now, value: { root: '', libraries: [] } }
    return rootCache.value
  }
}

export async function meetclipRoot() {
  return (await meetclipContext()).root
}

/** 生成 @ 菜单插入的 mention；路径含空白时用 DSH 的引号语法。 */
export function cardMention(path) {
  const value = String(path || '')
  if (!value || /[\u0000-\u001f\u007f-\u009f"]/u.test(value)) return null
  return /\s/u.test(value) ? `@"${value}"` : `@${value}`
}

/** 一张卡片 → inputTriggers 候选行。 */
const CARD_KINDS = ['meeting', 'link_video', 'live', 'doc', 'pack', 'note', 'highlight', 'image', 'batch']

export function cardCandidate(card, t, locale) {
  if (!card || !card.id || !card.title || !card.path) return null
  const kind = CARD_KINDS.includes(card.kind) ? card.kind : 'live'
  const active = ['pending', 'queued', 'recording', 'processing'].includes(card.status)
  const bits = []
  if (active) bits.push(t('list.active'))
  bits.push(t(`kind.${kind}`))
  if (kind === 'doc' && card.has_content === false) bits.push(t('cards.linkOnly'))
  if (kind === 'pack') bits.push(`${Number(card.count) || 0} ${t('cards.cardsUnit')}`)
  if (kind === 'batch' && Number(card.count) > 0) bits.push(`${Number(card.count)} ${t('cards.itemsUnit')}`)
  if (kind === 'highlight' && card.session_title) bits.push(String(card.session_title).slice(0, 40))
  const stamp = card.updated_at || card.started_at || card.created_at
  if (stamp) bits.push(dateTime(stamp, localeId(locale)))
  if (Number(card.duration) > 0) bits.push(clock(card.duration))
  return {
    name: String(card.title).replace(/\s+/g, ' ').trim(),
    description: bits.filter(Boolean).join(' · '),
    icon: 'file',
    section: t('cards.section'),
    value: JSON.stringify({ id: card.id, title: card.title, path: card.path, kind, url: card.url || '' })
  }
}

/**
 * 注册 @ 卡片 source。只在「当前会话 cwd 就是会摘工作区根目录」时返回候选，
 * 避免在代码仓库等工作区里出现无关记录。任何后端异常都静默返回空，
 * 让 DSH 原有的文件 @ 菜单继续工作。
 */
export function registerCardReferenceSource(ctx, locale) {
  const triggers = ctx?.get?.('inputTriggers')
  const sessions = ctx?.get?.('sessions')
  if (!triggers || typeof triggers.registerSource !== 'function') return () => {}
  if (!sessions?.list?.getSnapshot) return () => {}
  const t = () => translator(locale)
  // The built-in `reference` source owns file-chip preview and serialization.
  // Use it when present so clicking a card chip opens the generated Markdown;
  // fall back to our own codec on shells that only have the trigger registry.
  const insertSource = () => {
    const sources = triggers.live?.sources
    return Array.isArray(sources) && sources.some((item) => item.trigger === '@' && item.name === 'reference')
      ? 'reference'
      : 'meetclip-cards'
  }

  const source = {
    trigger: '@',
    name: 'meetclip-cards',
    order: -10,
    showGroupTitle: false,

    async candidates(session, { query, signal } = {}) {
      try {
        const { root, libraries } = await meetclipContext()
        if (!root) return []
        const cwd = sessions.list.getSnapshot()?.byId?.[session?.sessionId]?.cwd
        if (!sameDirectory(cwd, root)) {
          // 工作区属于另一个资料空间：让面板提示可以一键切过去，
          // 而不是给这个会话列出一堆对不上的卡片。
          const foreign = matchLibraryByDir(libraries, cwd)
          publishLibraryHint(foreign
            ? { id: foreign.id, name: foreign.name, dataDir: foreign.dataDir }
            : null)
          return []
        }
        publishLibraryHint(null)
        const result = await listCards(query || '', { signal })
        if (signal?.aborted) return []
        return (result?.cards || [])
          .map((card) => cardCandidate(card, t(), locale))
          .filter(Boolean)
      } catch {
        return []
      }
    },

    onPick({ candidate } = {}) {
      let card
      try {
        card = JSON.parse(candidate?.value || '{}')
      } catch {
        return undefined
      }
      const mention = cardMention(card?.path)
      if (!mention) return undefined
      return {
        insert: {
          source: insertSource(),
          ref: mention,
          label: card.title || card.id || mention,
          appearance: 'file',
          clipboardText: mention
        }
      }
    },

    codec: {
      clipboardText: (ref) => ref,
      serialize: (ref) => Promise.resolve(ref)
    }
  }

  try {
    return triggers.registerSource(source)
  } catch {
    return () => {}
  }
}
