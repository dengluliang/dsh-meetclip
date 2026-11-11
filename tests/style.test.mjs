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

// 会议模板把结论和待办并进同一节：序号列和勾选框列必须等宽，
// 否则「1. 结论」和「☐ 待办」的正文左边缘差 4px，整段读起来是锯齿的。
test('conclusion numbers and todo checkboxes share one marker column', async () => {
  const css = await readFile(new URL('../client-src/styles.css', import.meta.url), 'utf8')
  const px = (rule, pattern) => Number((rule.match(pattern) || [])[1])
  const list = (css.match(/\.mc-minutes-list \{[^}]*\}/g) || []).find((rule) => rule.includes('--mc-marker')) || ''
  const index = (css.match(/\.mc-minutes-conclusions \.mc-minutes-index \{[^}]*\}/g) || [])[0] || ''
  const box = (css.match(/\.mc-minutes-box \{[^}]*\}/g) || [])[0] || ''
  const marker = px(list, /--mc-marker:\s*(\d+)px/)
  assert.ok(marker > 0, '「.mc-minutes-list」应声明 --mc-marker 作为两条列表共用的标记列宽')
  assert.match(index, /flex: 0 0 var\(--mc-marker\)/, '结论序号应占满标记列')
  const basis = px(box, /flex: 0 0 (\d+)px/)
  const right = px(box, /margin:\s*\d+px (\d+)px 0 0/)
  assert.equal(basis + right, marker, `勾选框宽度加右留白应等于标记列宽：${basis} + ${right} ≠ ${marker}`)
})
