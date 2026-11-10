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
