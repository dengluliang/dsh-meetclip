// 散落画布布局：Hero 居中的世界坐标，所有卡片（记录/金句/便利签/图片）一起参与避让。
//
// 位置是卡片中心点，纵横向都可以为负；组件渲染时换算成 left/top。
// 布局是幂等的：同样的 entries + manual + pins + previous 一定得到同样结果，
// 这样轮询刷新和 React 重渲染都不会让墙面漂移。

export const SCATTER_GAP = 24
export const HERO_SIZE = { w: 540, h: 372 }
export const SPIRAL = {
  angle: 2.39996,
  radius: 220,
  radiusStep: 118,
  stretchX: 1.34,
  stretchY: 0.88
}

function textHash(value) {
  let hash = 2166136261
  for (const ch of String(value ?? '')) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seeded(seed) {
  let value = (seed || 1) >>> 0
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 4294967296
  }
}

export function entryKey(entry) {
  return `${entry?.type || 'entry'}-${entry?.item?.id ?? ''}`
}

function widthOf(entry) {
  const hash = textHash(entry?.item?.id)
  if (entry?.type === 'pack') return 272
  if (entry?.type === 'batch') return 268
  if (entry?.type === 'note') return 246
  if (entry?.type === 'image') return 232 + (hash % 3) * 18
  if (entry?.type === 'highlight') return 210 + (hash % 3) * 16
  if (entry?.type === 'doc') return 252
  return entry?.item?.cover?.value ? 242 + (hash % 4) * 16 : 220 + (hash % 4) * 16
}

function heightOf(entry, width = widthOf(entry)) {
  if (entry?.type === 'pack') return 208
  if (entry?.type === 'batch') return 196
  if (entry?.type === 'note') return entry?.item?.kind === 'todo' ? 224 : 190
  if (entry?.type === 'image') {
    const ratio = Number(entry?.item?.width) > 0 && Number(entry?.item?.height) > 0
      ? Number(entry.item.height) / Number(entry.item.width)
      : 0.75
    return Math.round(Math.min(330, Math.max(150, width * ratio)))
  }
  if (entry?.type === 'highlight') return 196
  if (entry?.type === 'doc') return 112
  return entry?.item?.cover?.value ? Math.round(width * 0.78) + 182 : 204 + (textHash(entry?.item?.id) % 3) * 16
}

/** 卡片估算尺寸：和 CSS 里的固定宽高保持一致，避免求解出的间距和眼睛看到的不一样。 */
export function entrySize(entry) {
  const w = widthOf(entry)
  return { w, h: heightOf(entry, w) }
}

/** 卡片轻微倾斜，按 id 稳定；范围约 ±2.5°。 */
export function entryTilt(entry) {
  return ((textHash(entry?.item?.id) % 17) - 8) * 0.32
}

function toPosition(value) {
  if (!value || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/** 便利签和图片卡在服务端存了创建时的世界坐标，只在没有手动位置时当种子。 */
function serverSeed(entry) {
  if (entry?.type !== 'note' && entry?.type !== 'image') return null
  const x = Number(entry?.item?.x)
  const y = Number(entry?.item?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x === 0 && y === 0) return null
  return { x, y }
}

function spiralPoint(index, rand) {
  const angle = index * SPIRAL.angle + rand() * 0.5
  const radius = SPIRAL.radius + SPIRAL.radiusStep * Math.sqrt(index + 1)
  return {
    x: Math.cos(angle) * radius * SPIRAL.stretchX,
    y: Math.sin(angle) * radius * SPIRAL.stretchY
  }
}

function heroRect(hero) {
  return {
    x: 0,
    y: 0,
    w: Math.max(120, Number(hero?.w) || HERO_SIZE.w),
    h: Math.max(120, Number(hero?.h) || HERO_SIZE.h)
  }
}

function overlapX(a, b, gap) {
  return (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x)
}

function overlapY(a, b, gap) {
  return (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y)
}

export function rectOverlap(a, b, gap = 0) {
  return overlapX(a, b, gap) > 0 && overlapY(a, b, gap) > 0
}

/** 把一张卡从一堆障碍里用最小位移顶出来；用于落点归一和固定卡落位。 */
export function nudgeOutOf(node, obstacles, gap = SCATTER_GAP, maxSteps = 48) {
  const next = { x: Number(node.x) || 0, y: Number(node.y) || 0, w: node.w, h: node.h }
  for (let step = 0; step < maxSteps; step += 1) {
    let moved = false
    for (const other of obstacles) {
      if (!other || other === node) continue
      const ox = overlapX(next, other, gap)
      const oy = overlapY(next, other, gap)
      if (ox <= 0 || oy <= 0) continue
      moved = true
      if (ox < oy) {
        next.x += (Math.sign(next.x - other.x) || 1) * ox
      } else {
        next.y += (Math.sign(next.y - other.y) || 1) * oy
      }
    }
    if (!moved) break
  }
  return next
}

function stillOverlapping(items, hero, gap) {
  for (const node of items) {
    if (node.fixed) continue
    if (rectOverlap(node, hero, gap)) return true
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]
      const b = items[j]
      if (a.fixed && b.fixed) continue
      if (rectOverlap(a, b, gap)) return true
    }
  }
  return false
}

function clearOf(node, obstacles, gap) {
  for (const other of obstacles) {
    if (rectOverlap(node, other, gap)) return false
  }
  return true
}

/** 卡在 Hero 和固定卡之间时，绕着找最近的空地；只在迭代求解失败后使用。 */
function findSpot(node, obstacles, gap, maxRadius = 2000, step = 48) {
  if (clearOf(node, obstacles, gap)) return { x: node.x, y: node.y }
  const startX = node.x
  const startY = node.y
  const offset = (textHash(node.key || '') % 12) / 12 * Math.PI * 2
  for (let radius = step; radius <= maxRadius; radius += step) {
    const count = radius <= 96 ? 8 : 12
    for (let index = 0; index < count; index += 1) {
      const angle = offset + (index / count) * Math.PI * 2
      const candidate = {
        x: Math.round(startX + Math.cos(angle) * radius),
        y: Math.round(startY + Math.sin(angle) * radius),
        w: node.w,
        h: node.h
      }
      if (clearOf(candidate, obstacles, gap)) return candidate
    }
  }
  return null
}

function firstBlockedAuto(items, hero, gap) {
  for (const node of items) {
    if (!node.fixed && rectOverlap(node, hero, gap)) return node
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]
      const b = items[j]
      if (a.fixed && b.fixed) continue
      if (rectOverlap(a, b, gap)) return a.fixed ? b : b.fixed ? a : b
    }
  }
  return null
}

function rescue(items, hero, gap) {
  const all = items
  for (let guard = 0; guard < all.length * 3; guard += 1) {
    const blocked = firstBlockedAuto(all, hero, gap)
    if (!blocked) return true
    const obstacles = [hero, ...all.filter((node) => node !== blocked).map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }))]
    const spot = findSpot(blocked, obstacles, gap)
    if (!spot) return false
    blocked.x = spot.x
    blocked.y = spot.y
  }
  return !stillOverlapping(all, hero, gap)
}

function relaxRounded(items, hero, gap, passes = 96) {
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false
    for (const node of items) {
      if (node.fixed) continue
      const ox = overlapX(node, hero, gap)
      const oy = overlapY(node, hero, gap)
      if (ox > 0 && oy > 0) {
        moved = true
        if (ox < oy) node.x += (Math.sign(node.x) || 1) * Math.ceil(ox)
        else node.y += (Math.sign(node.y) || 1) * Math.ceil(oy)
      }
    }
    for (let i = 0; i < items.length; i += 1) {
      const a = items[i]
      for (let j = i + 1; j < items.length; j += 1) {
        const b = items[j]
        if (a.fixed && b.fixed) continue
        const ox = overlapX(a, b, gap)
        const oy = overlapY(a, b, gap)
        if (ox <= 0 || oy <= 0) continue
        moved = true
        const mover = a.fixed ? b : b.fixed ? a : b
        const other = mover === a ? b : a
        if (ox < oy) mover.x += (Math.sign(mover.x - other.x) || 1) * Math.ceil(ox)
        else mover.y += (Math.sign(mover.y - other.y) || 1) * Math.ceil(oy)
      }
    }
    if (!moved) break
  }
  return !stillOverlapping(items, hero, gap)
}

function separate(nodes, gap, passes) {
  const hero = nodes.hero
  const list = nodes.items
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false
    for (const node of list) {
      if (node.fixed) continue
      const ox = overlapX(node, hero, gap)
      const oy = overlapY(node, hero, gap)
      if (ox > 0 && oy > 0) {
        moved = true
        if (ox < oy) node.x += (Math.sign(node.x) || 1) * ox
        else node.y += (Math.sign(node.y) || 1) * oy
      }
    }
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j]
        if (a.fixed && b.fixed) continue
        const ox = overlapX(a, b, gap)
        const oy = overlapY(a, b, gap)
        if (ox <= 0 || oy <= 0) continue
        moved = true
        const horizontal = ox < oy
        const span = horizontal ? ox : oy
        const direction = horizontal
          ? (Math.sign(a.x - b.x) || 1)
          : (Math.sign(a.y - b.y) || 1)
        const shareA = a.fixed ? 0 : b.fixed ? 1 : 0.5
        const shareB = b.fixed ? 0 : a.fixed ? 1 : 0.5
        if (horizontal) {
          a.x += direction * span * shareA
          b.x -= direction * span * shareB
        } else {
          a.y += direction * span * shareA
          b.y -= direction * span * shareB
        }
      }
    }
    if (!moved) return true
  }
  return !stillOverlapping(list, hero, gap)
}

/**
 * 计算整面墙的位置。
 *
 * @param {Array} entries 全部可上墙的卡片，顺序决定螺旋撒点顺序
 * @param {object} options
 * @param {object} options.manual   手动位置 { [key]: { x, y } }
 * @param {object} options.pins     图钉 { [key]: true }
 * @param {object|null} options.previous 上一次布局结果，用来保持稳定
 * @returns {{ positions: object, hero: object }}
 */
export function buildLayout(entries, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.item?.id != null) : []
  const manual = options.manual && typeof options.manual === 'object' ? options.manual : {}
  const pins = options.pins && typeof options.pins === 'object' ? options.pins : {}
  const previous = options.previous?.positions && typeof options.previous.positions === 'object'
    ? options.previous.positions
    : null
  const gap = Number.isFinite(Number(options.gap)) ? Math.max(0, Number(options.gap)) : SCATTER_GAP
  const hero = heroRect(options.hero)
  const rand = seeded(7919)
  const nodes = []
  const seen = new Set()

  list.forEach((entry, index) => {
    const key = entryKey(entry)
    if (seen.has(key)) return
    seen.add(key)
    const size = entrySize(entry)
    const manualPos = toPosition(manual[key])
    const previousPos = toPosition(previous?.[key])
    const seed = manualPos || serverSeed(entry) || previousPos || spiralPoint(index, rand)
    const pinned = Boolean(pins[key])
    nodes.push({
      key,
      entry,
      x: seed.x,
      y: seed.y,
      w: size.w,
      h: size.h,
      tilt: entryTilt(entry),
      fixed: Boolean(manualPos) || pinned,
      pinned,
      manual: Boolean(manualPos)
    })
  })

  // 固定卡先落位：图钉和拖过的卡片只避 Hero 与更早的固定卡，之后不再移动。
  const accepted = []
  for (const node of nodes) {
    if (!node.fixed) continue
    const settled = nudgeOutOf(node, [hero, ...accepted], gap)
    node.x = settled.x
    node.y = settled.y
    accepted.push(node)
  }

  const passes = Number.isFinite(Number(options.maxPasses))
    ? Math.max(1, Number(options.maxPasses))
    : nodes.length > 120 ? 240 : 400
  let converged = separate({ items: nodes, hero }, gap, passes)
  if (!converged) {
    // 极端密集时再补一轮，只推自动卡，保证不会把重叠交给用户。
    converged = separate({ items: nodes, hero }, gap, Math.max(80, Math.round(passes / 2)))
  }
  if (!converged) converged = rescue(nodes, hero, gap)

  const settled = nodes.map((node) => ({
    key: node.key,
    x: Math.round(node.x),
    y: Math.round(node.y),
    w: node.w,
    h: node.h,
    fixed: node.fixed
  }))
  // 取整可能把刚刚等于 gap 的边又挤回 0.5px，做一轮只走整数的最小修正。
  const roundedClear = relaxRounded(settled, hero, gap)
  const positions = {}
  const origins = new Map(nodes.map((node) => [node.key, node]))
  for (const node of settled) {
    const origin = origins.get(node.key)
    positions[node.key] = {
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      tilt: origin.tilt
    }
  }
  return {
    positions,
    hero: { x: 0, y: 0, w: hero.w, h: hero.h },
    converged: roundedClear
  }
}
