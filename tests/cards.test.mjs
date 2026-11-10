import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cardCandidate,
  cardMention,
  registerCardReferenceSource,
  sameDirectory
} from '../client-src/lib/cards.js'

const t = (key) => ({
  'cards.section': '会摘卡片',
  'list.active': '进行中',
  'kind.meeting': '会议',
  'kind.link_video': '视频',
  'kind.live': '直播',
  'kind.doc': '飞书文档',
  'cards.linkOnly': '仅链接'
}[key] || key)

test('cardMention 使用 DSH 的 @ 路径语法', () => {
  assert.equal(cardMention('会摘卡片/标题.md'), '@会摘卡片/标题.md')
  assert.equal(cardMention('会摘卡片/标题 有空格.md'), '@"会摘卡片/标题 有空格.md"')
  assert.equal(cardMention(''), null)
  assert.equal(cardMention('会摘卡片/带"引号.md'), null)
  assert.equal(cardMention('会摘卡片/换\n行.md'), null)
})

test('sameDirectory 忽略尾斜杠，Windows 盘符不区分大小写', () => {
  assert.equal(sameDirectory('/tmp/会摘/', '/tmp/会摘'), true)
  assert.equal(sameDirectory('/tmp/会摘', '/tmp/其他'), false)
  assert.equal(sameDirectory('C:\\Data\\MeetClip', 'c:/data/meetclip'), true)
  assert.equal(sameDirectory('', '/tmp/会摘'), false)
})

test('cardCandidate 生成菜单行与可解析的 value', () => {
  const item = cardCandidate({
    id: 'abc123',
    title: '  旗舰手机\n芯片横评  ',
    kind: 'link_video',
    status: 'done',
    created_at: 1793161835,
    started_at: 1793161835,
    duration: 3434,
    path: '会摘卡片/旗舰手机 芯片横评.md'
  }, t, undefined)
  assert.equal(item.name, '旗舰手机 芯片横评')
  assert.match(item.description, /视频/)
  assert.equal(item.icon, 'file')
  assert.equal(item.section, '会摘卡片')
  const value = JSON.parse(item.value)
  assert.deepEqual(value, {
    id: 'abc123',
    title: '  旗舰手机\n芯片横评  ',
    path: '会摘卡片/旗舰手机 芯片横评.md',
    kind: 'link_video',
    url: ''
  })

  const active = cardCandidate({
    id: 'x', title: '正在录', kind: 'meeting', status: 'recording',
    created_at: 1793161835, duration: 12, path: '会摘卡片/正在录.md'
  }, t, undefined)
  assert.match(active.description, /进行中/)
  assert.equal(cardCandidate({ id: 'x', title: '无路径' }, t, undefined), null)
})

test('飞书文档卡候选使用 updated_at 并标注仅链接', () => {
  const doc = cardCandidate({
    id: 'doc:abc',
    title: '会议纪要：物模型白皮书',
    kind: 'doc',
    status: 'done',
    has_content: false,
    created_at: 1793161835,
    updated_at: 1793661835,
    duration: 0,
    url: 'https://example.feishu.cn/docx/ExampleDocToken1',
    path: '会摘卡片/会议纪要-物模型白皮书.md'
  }, t, undefined)
  assert.match(doc.description, /飞书文档/)
  assert.match(doc.description, /仅链接/)
  const value = JSON.parse(doc.value)
  assert.equal(value.kind, 'doc')
  assert.equal(value.url, 'https://example.feishu.cn/docx/ExampleDocToken1')
})

test('@ 卡片 source 只在会摘工作区返回候选，支持多条选择', async () => {
  const original = globalThis.fetch
  const roots = []
  globalThis.fetch = async (url) => {
    roots.push(String(url))
    if (String(url).includes('/app/status')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ locations: { dataDirCanonical: '/tmp/会摘资料' } }) }
    }
    if (String(url).includes('/api/cards')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          cards: [{
            id: 'abc123', title: '预算评审', kind: 'meeting', status: 'done',
            created_at: 1793161835, duration: 120, path: '会摘卡片/预算评审.md'
          }]
        })
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }

  try {
    const registered = []
    const ctx = {
      get(name) {
        if (name === 'inputTriggers') {
          return { registerSource: (source) => { registered.push(source); return () => {} } }
        }
        if (name === 'sessions') {
          return {
            list: {
              getSnapshot: () => ({
                byId: {
                  inWorkspace: { cwd: '/tmp/会摘资料' },
                  elsewhere: { cwd: '/tmp/代码仓库' }
                }
              })
            }
          }
        }
        return undefined
      }
    }
    const dispose = registerCardReferenceSource(ctx, undefined)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'meetclip-cards')
    assert.equal(registered[0].order, -10)
    assert.equal(registered[0].showGroupTitle, false)

    const inWorkspace = await registered[0].candidates({ sessionId: 'inWorkspace' }, { query: '预算' })
    assert.equal(inWorkspace.length, 1)
    assert.equal(inWorkspace[0].name, '预算评审')
    assert.equal(inWorkspace[0].section, '会摘卡片')

    const elsewhere = await registered[0].candidates({ sessionId: 'elsewhere' }, { query: '' })
    assert.deepEqual(elsewhere, [])

    const picked = registered[0].onPick({ candidate: inWorkspace[0] })
    assert.equal(picked.insert.source, 'meetclip-cards')
    assert.equal(picked.insert.ref, '@会摘卡片/预算评审.md')
    assert.equal(picked.insert.clipboardText, picked.insert.ref)
    assert.equal(await registered[0].codec.serialize(picked.insert.ref), picked.insert.ref)
    dispose()
  } finally {
    globalThis.fetch = original
  }
})

test('内置 reference source 存在时，卡片 chip 交给它处理预览与序列化', () => {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'inputTriggers') {
        return {
          live: { sources: [{ trigger: '@', name: 'reference' }] },
          registerSource: (source) => { registered.push(source); return () => {} }
        }
      }
      if (name === 'sessions') {
        return { list: { getSnapshot: () => ({ byId: {} }) } }
      }
      return undefined
    }
  }
  const dispose = registerCardReferenceSource(ctx, undefined)
  const candidate = {
    value: JSON.stringify({ id: 'x', title: '卡片', path: '会摘卡片/带 空格.md' })
  }
  const picked = registered[0].onPick({ candidate })
  assert.equal(picked.insert.source, 'reference')
  assert.equal(picked.insert.ref, '@"会摘卡片/带 空格.md"')
  dispose()
})
