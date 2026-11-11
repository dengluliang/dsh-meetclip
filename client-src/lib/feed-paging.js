/** 信息流翻页：一页的条数与「是否到底」的判定。

后端 `/api/home` 用 limit/offset 取页，短页（返回条数少于 limit）就是最后一页。
翻到底以后前端必须停下来：否则观察器每重新挂载一次就会再请求一次空页，
页脚文字在「正在加载…」和「继续下滑」之间来回闪。
 */

export const FEED_PAGE_SIZE = 60

/** 追加一页卡片，按 id 去重。 */
export function mergeFeedPage(current, rows) {
  const base = Array.isArray(current) ? current : []
  const seen = new Set(base.map((item) => item && item.id))
  const fresh = (Array.isArray(rows) ? rows : []).filter((item) => item && item.id && !seen.has(item.id))
  return fresh.length ? [...base, ...fresh] : base
}

/** 这一页是否已经是最后一页：空页或短页都算到底。 */
export function feedPageExhausted(rows, limit = FEED_PAGE_SIZE) {
  return !Array.isArray(rows) || rows.length < limit
}
