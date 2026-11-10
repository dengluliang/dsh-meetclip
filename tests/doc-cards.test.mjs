import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DocCardError,
  callFeishuTool,
  createFeishuDocCard,
  parseFeishuDocUrl,
  previewFeishuDoc,
  readFeishuDoc
} from '../src/host/doc-cards.js'

const DOC_URL = 'https://example.feishu.cn/docx/ExampleDocToken1'
const DOC_JSON = JSON.stringify({
  title: '会议纪要：2026-11-04 | 聊聊「物模型」白皮书',
  content: '🎉 总结\n传播策略。\n✅ 待办任务与跟进\n郑晓航确认口径。',
  revision_id: 2
})

function fakeTools(handlers) {
  return {
    executable: () => true,
    async execute({ calls }) {
      const [call] = calls
      const handler = handlers[call.name]
      if (!handler) throw new Error(`unknown tool: ${call.name}`)
      const text = await handler(JSON.parse(call.arguments), call)
      return {
        results: [{
          callId: call.id,
          result: { content: [{ type: 'text', text }], isError: false }
        }]
      }
    }
  }
}

function backendStub() {
  const calls = []
  return {
    calls,
    async json(path, init) {
      calls.push({ path, init })
      return { ok: true, created: true, card: { title: '卡片', path: '会摘卡片/卡片.md' } }
    }
  }
}

test('parseFeishuDocUrl 只接受飞书文档链接', () => {
  assert.deepEqual(parseFeishuDocUrl(DOC_URL + '?from=share'), {
    url: DOC_URL + '?from=share',
    type: 'docx',
    token: 'ExampleDocToken1'
  })
  assert.equal(parseFeishuDocUrl('https://example.feishu.cn/wiki/WikAbc123456').type, 'wiki')
  assert.equal(parseFeishuDocUrl('https://example.feishu.cn/sheets/ShtAbc123456').type, 'sheet')
  assert.equal(parseFeishuDocUrl('https://example.feishu.cn/base/BasAbc123456').type, 'base')
  for (const bad of [
    '',
    'http://example.feishu.cn/docx/AbCdEf123456',
    'https://evil.com/docx/AbCdEf123456',
    'https://example.feishu.cn/minutes/obcn1g2429f9e82rg5euo348',
    'https://example.feishu.cn/docx/'
  ]) {
    assert.equal(parseFeishuDocUrl(bad), null, bad)
  }
})

test('callFeishuTool 提取文本并归一化错误', async () => {
  const tools = fakeTools({ 'mcp__feishu__doc_read': async () => DOC_JSON })
  assert.equal(await callFeishuTool(tools, 'mcp__feishu__doc_read', { document_id: 'x' }), DOC_JSON)

  const missing = fakeTools({})
  await assert.rejects(
    () => callFeishuTool(missing, 'mcp__feishu__doc_read', {}),
    (error) => error instanceof DocCardError && error.code === 'feishu_unavailable'
  )

  const denied = fakeTools({ 'mcp__feishu__doc_read': async () => { throw new Error('permission denied') } })
  await assert.rejects(
    () => callFeishuTool(denied, 'mcp__feishu__doc_read', {}),
    (error) => error.code === 'feishu_forbidden'
  )

  await assert.rejects(
    () => callFeishuTool({ executable: () => false, execute: async () => {} }, 'mcp__feishu__doc_read', {}),
    (error) => error.code === 'feishu_unavailable'
  )
})

test('readFeishuDoc 走 MCP 并解析正文', async () => {
  const tools = fakeTools({ 'mcp__feishu__doc_read': async () => DOC_JSON })
  const result = await readFeishuDoc(parseFeishuDocUrl(DOC_URL), { tools })
  assert.equal(result.linkOnly, false)
  assert.equal(result.title, '会议纪要：2026-11-04 | 聊聊「物模型」白皮书')
  assert.match(result.content, /郑晓航确认口径/)
  assert.equal(result.documentId, 'ExampleDocToken1')
  assert.equal(result.revision, '2')
})

test('readFeishuDoc 解析 wiki 后读 docx，非 docx 只登记链接', async () => {
  const tools = fakeTools({
    'mcp__feishu__wiki_get_node': async () => JSON.stringify({ obj_token: 'DocXyz987654', obj_type: 'docx', title: '知识库文档' }),
    'mcp__feishu__doc_read': async () => JSON.stringify({ title: '知识库文档', content: '正文', revision_id: 7 })
  })
  const result = await readFeishuDoc(parseFeishuDocUrl('https://example.feishu.cn/wiki/WikAbc123456'), { tools })
  assert.equal(result.documentId, 'DocXyz987654')
  assert.equal(result.content, '正文')
  assert.equal(result.revision, '7')

  const sheetTools = fakeTools({
    'mcp__feishu__wiki_get_node': async () => JSON.stringify({ obj_token: 'ShtXyz987654', obj_type: 'sheet', title: '表格页' })
  })
  const sheet = await readFeishuDoc(parseFeishuDocUrl('https://example.feishu.cn/wiki/WikAbc123456'), { tools: sheetTools })
  assert.equal(sheet.linkOnly, true)
  assert.match(sheet.warning, /只登记链接/)
})

test('readFeishuDoc 在 MCP 不可用时走 Open API 兜底', async () => {
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(String(url))
    if (String(url).endsWith('/raw_content')) {
      return { ok: true, json: async () => ({ code: 0, data: { content: 'Open API 正文' } }) }
    }
    return { ok: true, json: async () => ({ code: 0, data: { document: { title: 'Open 标题', revision_id: 3 } } }) }
  }
  const result = await readFeishuDoc(parseFeishuDocUrl(DOC_URL), {
    tools: null,
    fetchImpl,
    readToken: () => 'user-token'
  })
  assert.equal(result.title, 'Open 标题')
  assert.equal(result.content, 'Open API 正文')
  assert.equal(result.revision, '3')
  assert.equal(requests.length, 2)
})

test('previewFeishuDoc 只返回标题/长度/摘要，不落卡片', async () => {
  const tools = fakeTools({ 'mcp__feishu__doc_read': async () => DOC_JSON })
  const preview = await previewFeishuDoc({ tools, url: DOC_URL })
  assert.equal(preview.ok, true)
  assert.equal(preview.title, '会议纪要：2026-11-04 | 聊聊「物模型」白皮书')
  assert.equal(preview.doc_type, 'docx')
  assert.equal(preview.has_content, true)
  assert.ok(preview.content_chars > 0)
  assert.match(preview.excerpt, /郑晓航|传播策略/)
  assert.equal(preview.content, undefined)

  const sheet = await previewFeishuDoc({ tools: fakeTools({}), url: 'https://example.feishu.cn/sheets/ShtAbc123456' })
  assert.equal(sheet.link_only, true)
  assert.match(sheet.warning, /只登记链接/)

  await assert.rejects(
    () => previewFeishuDoc({ tools, url: 'https://example.feishu.cn/minutes/obcn1g24' }),
    (error) => error.code === 'invalid_url'
  )
})

test('createFeishuDocCard 成功写入并带回调 payload', async () => {
  const tools = fakeTools({ 'mcp__feishu__doc_read': async () => DOC_JSON })
  const backend = backendStub()
  const result = await createFeishuDocCard({ tools, backend, url: DOC_URL })
  assert.equal(result.ok, true)
  assert.equal(result.link_only, false)
  assert.equal(backend.calls.length, 1)
  assert.equal(backend.calls[0].path, '/api/cards/doc')
  assert.equal(backend.calls[0].init.headers['content-type'], 'application/json')
  const payload = JSON.parse(backend.calls[0].init.body)
  assert.equal(payload.url, DOC_URL)
  assert.equal(payload.title, '会议纪要：2026-11-04 | 聊聊「物模型」白皮书')
  assert.match(payload.content, /郑晓航/)
  assert.equal(payload.document_id, 'ExampleDocToken1')
  assert.equal(payload.revision, '2')
})

test('createFeishuDocCard 环境性失败降级为链接卡', async () => {
  const backend = backendStub()
  const result = await createFeishuDocCard({
    tools: fakeTools({ 'mcp__feishu__doc_read': async () => { throw new Error('socket hang up') } }),
    backend,
    url: DOC_URL,
    fetchImpl: async () => { throw new Error('offline') },
    readToken: () => ''
  })
  assert.equal(result.link_only, true)
  assert.match(result.warning, /已先登记链接卡片/)
  const payload = JSON.parse(backend.calls[0].init.body)
  assert.equal(payload.content, '')
  assert.equal(payload.document_id, 'ExampleDocToken1')
})

test('createFeishuDocCard 内容性失败不落卡片', async () => {
  const backend = backendStub()
  await assert.rejects(
    () => createFeishuDocCard({
      tools: fakeTools({ 'mcp__feishu__doc_read': async () => { throw new Error('document not found') } }),
      backend,
      url: DOC_URL,
      readToken: () => ''
    }),
    (error) => error.code === 'feishu_not_found'
  )
  assert.equal(backend.calls.length, 0)
})

test('createFeishuDocCard 表格/非法链接', async () => {
  const backend = backendStub()
  const sheet = await createFeishuDocCard({
    tools: fakeTools({}),
    backend,
    url: 'https://example.feishu.cn/sheets/ShtAbc123456'
  })
  assert.equal(sheet.link_only, true)
  assert.match(sheet.warning, /只登记链接/)

  await assert.rejects(
    () => createFeishuDocCard({ backend, url: 'https://example.feishu.cn/minutes/obcn1g24' }),
    (error) => error.code === 'invalid_url' && error.status === 400
  )
})
