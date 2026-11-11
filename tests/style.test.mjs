import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { installStyles } from '../client-src/lib/styles.js'

test('installs a tagged stylesheet and removes it on dispose', () => {
  const appended = []
  const tag = {
    dataset: {},
    textContent: '',
    removed: false,
    remove() { this.removed = true }
  }
  const doc = {
    createElement(name) {
      assert.equal(name, 'style')
      return tag
    },
    head: {
      appendChild(node) { appended.push(node) }
    }
  }
  const dispose = installStyles('.mc-root { display: flex; }', doc)
  assert.equal(appended.length, 1)
  assert.equal(tag.dataset.meetclip, 'styles')
  assert.match(tag.textContent, /\.mc-root/)
  dispose()
  assert.equal(tag.removed, true)
})

test('built client contains the stylesheet and direct injection code', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /\.mc-root\s*\{/)
  assert.match(client, /dataset\.meetclip = "styles"/)
  assert.doesNotMatch(client, /typeof styles === "undefined"/)
})

// 设置插槽渲染在 .mc-root 之外，会继承 DSH 设置弹层的字号；
// 该容器必须自己钉住基准字号，辅助文字也必须显式给 size，否则会变大字。
test('settings slot pins its own typography', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /\.mc-settings-shell\s*\{[^}]*font-size:\s*\d/)
  assert.match(client, /\.mc-settings-panel \.mc-foot-meta\s*\{[^}]*font-size:\s*12px/)
})

// 便利签 / 待办 / 图片卡的「删除」与记录卡共用同一套右上角胶囊：同样内缩、悬停才出现。
test('note and image cards share the record card delete pill', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  const actionRule = (css.match(/\.mc-card-actions \{[^}]*\}/g) || []).find((rule) => rule.includes('position: absolute')) || ''
  const homeRule = (css.match(/\.mc-home-card-actions \{[^}]*\}/g) || []).find((rule) => rule.includes('position: absolute')) || ''
  for (const declaration of ['right: 10px', 'top: 10px', 'opacity: 0']) {
    assert.ok(actionRule.includes(declaration), `卡片动作缺少 ${declaration}`)
    assert.ok(homeRule.includes(declaration), `记录卡动作缺少 ${declaration}`)
  }
  assert.match(css, /\.mc-sticky-card:hover \.mc-card-actions/)
  assert.match(css, /\.mc-sticky-card:focus-within \.mc-card-actions/)
  assert.match(css, /\.mc-image-card:hover \.mc-card-actions/)
  assert.match(css, /\.mc-card-actions button\[data-action='delete'\] \{ color: #c1443d; \}/)
  assert.match(css, /\.mc-scatter-card\.is-pinned \.mc-card-actions \{ opacity: 0 !important; pointer-events: none; \}/)
  assert.doesNotMatch(css, /\.mc-sticky-delete|\.mc-image-delete/)
})

// 拖动态的 box-shadow 画在散落卡外壳上；外壳必须和卡片同圆角，否则四角露出直角白边。
test('scatter card shell follows the card radius', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  const shell = (css.match(/\.mc-scatter-card \{[^}]*\}/g) || []).find((rule) => rule.includes('position: absolute')) || ''
  assert.ok(shell.includes('border-radius: 20px'), '散落卡外壳缺少圆角')
  assert.match(shell, /transform: rotate\(var\(--tilt, 0deg\)\)/)
})

// 便利签正文跟随卡片内容字体：系统字体、12.5px，不再用放大的宋体。
test('sticky note body uses the card content typography', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  assert.ok(css.includes('--sticky-font: 12.5px; --sticky-leading: 1.62;'))
  const body = (css.match(/\.mc-sticky-text, \.mc-sticky-todo \{[^}]*\}/g) || []).pop() || ''
  assert.ok(body.includes('font-family: inherit'))
  assert.ok(body.includes('font-size: var(--sticky-font)'))
  assert.ok(body.includes('line-height: var(--sticky-leading)'))
  assert.doesNotMatch(css, /sticky-serif/)
})

// 图钉动效只给刚钉上的那张卡：基础 .is-pinned / .mc-scatter-pin 不再常驻 animation，
// 否则卡片重排（React 移动 DOM）会让所有已固定的卡片重播一次。
test('pin animation is scoped to the card that was just pinned', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  const pinnedBase = (css.match(/\.mc-scatter-card\.is-pinned\s*\{[^}]*\}/g) || [])[0] || ''
  assert.ok(pinnedBase.includes('translateY(5px)'))
  assert.doesNotMatch(pinnedBase, /animation:/)
  const pinBase = (css.match(/^\.mc-scatter-pin \{[^}]*\}/m) || [])[0] || ''
  assert.ok(pinBase.includes('position: absolute'))
  assert.doesNotMatch(pinBase, /animation:/)
  assert.match(css, /\.mc-scatter-card\.is-pinned\.is-pinning \{ animation: mc-pin-sink/)
  assert.match(css, /\.mc-scatter-card\.is-pinning \.mc-scatter-pin,/)
  assert.match(css, /\.mc-home-cell\.is-pinning \.mc-scatter-pin \{ animation: mc-pin-set/)
})

// 卡包：真实成员卡叠放、无边框灰色呼吸热区、全卡片浮层和排序把手；
// 动效必须在 reduced-motion 下关闭，深色主题不能只剩浅色纸边。
test('pack card, glow and full-card overlay styles are present', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.mc-pack-card \{[^}]*position: relative/)
  assert.match(css, /\.mc-pack-back,\n\.mc-pack-front \{/)
  assert.match(css, /\.mc-pack-back\[data-slot='2'\] \{ transform: translate/)
  assert.match(css, /\.mc-pack-front \.mc-home-card \{/)
  assert.match(css, /\.mc-pack-glow \{[^}]*box-shadow:/)
  assert.doesNotMatch(css, /\.mc-pack-outline/)
  assert.doesNotMatch(css, /\.mc-pack-hotzone/)
  assert.match(css, /\.mc-pack-hint\.is-ready/)
  assert.match(css, /\.mc-pack-modal \{ width: min\(980px/)
  assert.match(css, /\.mc-pack-card-grid \{[^}]*columns: 3/)
  assert.match(css, /\.mc-pack-drag-ghost \{/)
  assert.match(css, /\.mc-pack-drop-marker \{/)
  assert.doesNotMatch(css, /\.mc-pack-sort-handle/)
  assert.match(css, /\.mc-pack-undo \{/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.mc-pack-glow/)
  // 深色标记由 DSH 打在 body 上（body[data-ds-dark-theme]），预览页仍用 :root[data-theme='dark']；
  // 两者都写进 :is()，只写其中一种时另一种就是死代码。
  assert.match(css, /:is\(body\[data-ds-dark-theme\], \[data-theme='dark'\]\) \.mc-pack-back/)
  assert.match(css, /:is\(body\[data-ds-dark-theme\], \[data-theme='dark'\]\) \.mc-pack-front/)
})

// 卡包胶囊浮在成员卡上：底色必须跟主题走，写死成白色会在深色模式变成白底白字
// （批次卡进卡包时整条「卡包 · 标题 · N 张」都看不见）。
test('pack tab pill follows the theme instead of a hard-coded white surface', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  const tab = (css.match(/\.mc-pack-tab \{[^}]*\}/g) || [])[0] || ''
  assert.match(tab, /background: color-mix\(in srgb, var\(--dsw-alias-bg-layer-1\)/, '卡包胶囊应使用主题抬升层做底色')
  assert.doesNotMatch(tab, /rgba\(255,\s*255,\s*255/, '卡包胶囊不能再写死浅色底')
})

// 深色覆盖必须同时认 DSH 的 body 属性与预览页的 data-theme，且数量配对，
// 否则新增规则时容易只写一种、在真实界面里静默失效。
test('dark overrides cover both host and preview theme hooks', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  const paired = (css.match(/:is\(body\[data-ds-dark-theme\], \[data-theme='dark'\]\)/g) || []).length
  assert.ok(paired >= 30, `深色覆盖太少：${paired}`)
  assert.equal((css.match(/body\[data-ds-dark-theme\]/g) || []).length, paired)
  assert.equal((css.match(/\[data-theme='dark'\]/g) || []).length, paired)
})

// 会议模板把结论和待办并进同一节：序号和勾选框必须共用一条标记列——
// 列宽一样（正文左边缘才对齐），两个标记也都在这一格里居中（往下扫才是同一根光轴）。
test('conclusion numbers and todo checkboxes share one marker column', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  const num = (rule, pattern) => Number((rule.match(pattern) || [])[1])
  const list = (css.match(/\.mc-minutes-list \{[^}]*\}/g) || []).find((rule) => rule.includes('--mc-marker')) || ''
  const li = (css.match(/\.mc-minutes-list li \{[^}]*\}/g) || [])[0] || ''
  const index = (css.match(/\.mc-minutes-conclusions \.mc-minutes-index \{[^}]*\}/g) || [])[0] || ''
  const box = (css.match(/\.mc-minutes-box \{[^}]*\}/g) || [])[0] || ''
  const marker = num(list, /--mc-marker:\s*([\d.]+)px/)
  const row = num(list, /--mc-row:\s*([\d.]+)px/)
  assert.ok(marker > 0, '「.mc-minutes-list」应声明 --mc-marker 作为两条列表共用的标记列宽')
  assert.ok(row > 0, '「.mc-minutes-list」应声明 --mc-row 作为标记列的高（等于条目行高）')
  const lineHeight = num(li, /font-size:\s*([\d.]+)px/) * num(li, /line-height:\s*([\d.]+)/)
  assert.ok(Math.abs(lineHeight - row) < 0.05, `标记列高应与条目行高一致：${lineHeight} ≠ ${row}`)
  assert.match(index, /flex: 0 0 var\(--mc-marker\)/, '结论序号应占满标记列')
  assert.match(index, /height: var\(--mc-row\)/, '结论序号应占满标记列的高')
  assert.match(index, /justify-content: center/, '序号在标记列里水平居中')
  assert.match(index, /align-items: center/, '序号在标记列里垂直居中')
  const basis = num(box, /flex: 0 0 ([\d.]+)px/)
  const inset = num(box, /margin:\s*calc\(\(var\(--mc-row\) - [\d.]+px\) \/ 2\) ([\d.]+)px 0/)
  assert.equal(basis + inset * 2, marker, `勾选框宽度加左右留白应等于标记列宽：${basis} + ${inset} × 2 ≠ ${marker}`)
})

// 合并节里结论块和待办块要能分开：待办跟在结论后面时补一档间距，
// 只挂在相邻选择器上，单独出现待办（视频/直播模板）时不会留下悬空的外边距。
test('the todo block is set off from the conclusions above it', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  const rule = (css.match(/\.mc-minutes-conclusions \+ \.mc-minutes-todos \{[^}]*\}/g) || [])[0] || ''
  const gap = Number((rule.match(/margin-top:\s*(\d+)px/) || [])[1])
  const itemGap = Number((css.match(/\.mc-minutes-list \{[^}]*gap: (\d+)px/) || [])[1])
  assert.ok(gap > 0, '待办跟在结论后面时应有额外的上间距')
  assert.ok(gap > itemGap, `结论与待办之间的间距应大于条目间距：${gap} vs ${itemGap}`)
})
