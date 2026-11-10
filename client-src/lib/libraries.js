/**
 * 资料空间（工作 / 生活 …）的纯逻辑：客户端与测试共用，不碰 React。
 *
 * 一份资料空间 = 一个数据目录；同一时刻只有一个处于激活状态，
 * 首页、资料库、搜索与 @ 卡片都跟着它走。
 */

/** 比较两个目录是否相同；忽略尾斜杠，Windows 盘符不区分大小写。 */
export function sameDirectory(left, right) {
  const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  if (!a || !b) return false
  if (a === b) return true
  if (/^[a-z]:\//i.test(a) || /^[a-z]:\//i.test(b)) return a.toLowerCase() === b.toLowerCase()
  return false
}

/** 名称校验；返回给用户看的错误文案，通过时返回空串。 */
export function libraryNameError(name) {
  const value = String(name || '').replace(/\s+/g, ' ').trim()
  if (!value) return '请先给资料空间起个名字'
  if ([...value].length > 40) return '名称不能超过 40 个字'
  if (/[/\\:*?"<>|]/.test(value)) return '名称里不能出现 / \\ : * ? " < > |'
  return ''
}

/** 当前激活的那一行。 */
export function activeOf(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.find((row) => row?.active) || null
}

/** 菜单顺序：当前的在最前，其余按最近使用时间倒序。 */
export function sortLibraries(rows) {
  const list = Array.isArray(rows) ? rows.slice() : []
  return list.sort((a, b) => {
    const active = Number(Boolean(b?.active)) - Number(Boolean(a?.active))
    if (active) return active
    const used = (Number(b?.lastOpenedAt) || 0) - (Number(a?.lastOpenedAt) || 0)
    if (used) return used
    return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-Hans-CN')
  })
}

/** 一行菜单下面的说明：条数 + 位置问题。 */
export function libraryMeta(row) {
  if (!row) return ''
  const bits = []
  bits.push(`${Number(row.records) || 0} 条记录`)
  if (row.exists === false) bits.push('位置不可用')
  else if (row.hasLibrary === false && !row.active) bits.push('还没有资料')
  return bits.join(' · ')
}

/** cwd 落在哪个资料空间里（用于 @ 卡片判断与提示）。 */
export function matchLibraryByDir(rows, dir) {
  const list = Array.isArray(rows) ? rows : []
  if (!dir) return null
  return list.find((row) => sameDirectory(row?.dataDir, dir)) || null
}

/**
 * 当前会话工作区属于另一个资料空间时给出提示。
 * 返回那个「另一个空间」，否则 null。
 */
export function foreignLibraryFor({ rows, cwd }) {
  const list = Array.isArray(rows) ? rows : []
  if (!cwd || !list.length) return null
  const active = activeOf(list)
  const here = matchLibraryByDir(list, cwd)
  if (!here) return null
  if (active && here.id === active.id) return null
  return here
}

/** 切换确认框里的任务说明：直播 2 条、会议 1 条。 */
export function busyWorkText(work) {
  const list = Array.isArray(work) ? work : []
  if (!list.length) return ''
  const labels = { live: '直播', link_video: '视频', meeting: '会议' }
  const counts = new Map()
  for (const item of list) {
    const key = labels[item?.kind] || '任务'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count} 条`).join('、')
}

/**
 * 新建资料空间的默认位置：<用户主目录>/Documents/会摘/<名称>。
 * Paths on the host use forward slashes in this codebase, so join by hand.
 */
export function defaultLibraryDir(home, name, sharedRoot = '会摘') {
  const base = String(home || '').replace(/\/+$/, '')
  const folder = String(name || '').replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || '新资料空间'
  return base ? `${base}/Documents/${sharedRoot}/${folder}` : ''
}

/**
 * 新建资料空间的建议位置：
 * 已经在 ~/Documents/… 下时放 ~/Documents/会摘/<名称>，否则放在当前库的同级目录。
 * 这里不做刻意聪明的事——用户可以随时「选择…」换位置。
 */
export function suggestedLibraryDir({ dataDir, name, sharedRoot = '会摘' } = {}) {
  const current = String(dataDir || '').replace(/\/+$/, '')
  const folder = String(name || '').replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || '新资料空间'
  const match = current.match(/^(\/[^/]+\/[^/]+)\/Documents(\/|$)/)
  if (match) return `${match[1]}/Documents/${sharedRoot}/${folder}`
  if (!current) return ''
  const parent = current.slice(0, current.lastIndexOf('/'))
  return parent ? `${parent}/${folder}` : ''
}

/** 目录路径末尾的一段，用作默认名称提示。 */
export function dirLeaf(dir) {
  const value = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!value) return ''
  const leaf = value.slice(value.lastIndexOf('/') + 1)
  return leaf === 'data' ? '' : leaf
}

/**
 * 读不到资料空间时给一句能动手的话。
 * 最常见的原因是「客户端已是新版、宿主还是旧版」（旧宿主没有 /app/libraries 路由），
 * 直接把 HTTP 404 摊给用户没有意义。
 */
export function libraryLoadErrorText(failure) {
  const status = Number(failure?.status) || 0
  // 405 是宿主 HTTP 层对「没有匹配 POST 路由」的回应：旧宿主里这个接口根本不存在，
  // 和 404 是同一件事，只是方法不同。
  if (status === 404 || status === 405 || status === 501) {
    return '宿主还没加载多资料空间：请重启 DeepSeek Harness，或用最新的 dsh-meetclip 插件包重新安装「会摘」'
  }
  if (status === 503) return '本地引擎没起来，稍后再试；持续失败请到 设置 → 采集 重启引擎'
  if (status === 409) return failure?.message || '操作被拒绝'
  return failure?.message || String(failure || '未知错误')
}
