import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createLinkCard,
  decodeHtml,
  extractArticle,
  fallbackLinkTitle,
  fetchLinkPage,
  linkKind,
  parseLinkUrl,
  previewLinkCard
} from '../src/host/link-cards.js'

const WECHAT_URL = 'https://mp.weixin.qq.com/s/AbCdEf123456'
const WEB_URL = 'https://example.com/posts/hello'

const LONG_BODY = '这是正文第一段，讲了发布会的产品线和价格。'.repeat(12)
const WECHAT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta property="og:title" content="小米发布会：一口气看完">
<meta name="description" content="手机、汽车和价格。">
<title>小米发布会：一口气看完</title></head>
<body><div class="rich_media_area_primary">
<h1 id="activity-name"> 小米发布会：一口气看完 </h1>
<div id="meta_content"><span id="js_name">差评</span><em id="publish_time">2026-11-03 20:00</em></div>
<div id="js_content"><p>${LONG_BODY}</p><p>第二段：价格公布。</p></div>
</div></body></html>`

const WEB_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>一篇普通文章 - 示例站点</title><meta property="og:site_name" content="示例站点">
<meta name="description" content="这是摘要。"><meta name="author" content="张三">
<meta property="article:published_time" content="2026-11-02T09:30:00+08:00"></head>
<body><nav>首页 关于 登录</nav><header>站点头部</header>
<article><h1>一篇普通文章</h1><p>${LONG_BODY}</p><p>第二段正文。</p></article>
<footer>版权所有</footer><script>var x = 1</script></body></html>`

function responseFor(html, { url = WEB_URL, status = 200, contentType = 'text/html; charset=utf-8' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => Buffer.from(html, 'utf8')
  }
}

function backendStub() {
  const calls = []
  return {
    calls,
    async json(path, init) {
      calls.push({ path, init })
      return { ok: true, created: true, card: { key: 'k1', title: '卡片', doc_type: 'web' } }
    }
  }
}

test('parseLinkUrl 只接受公开的 http(s) 链接', () => {
  assert.equal(parseLinkUrl(WEB_URL).href, WEB_URL)
  assert.equal(parseLinkUrl('http://example.com/a#part').href, 'http://example.com/a')
  for (const bad of [
    '',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:pass@example.com/a',
    'http://127.0.0.1:8080/x',
    'http://localhost/x',
    'http://192.168.1.5/x',
    'http://10.0.0.2/x',
    'http://[::1]/x',
    'http://printer.local/x',
    `https://example.com/${'a'.repeat(2100)}`
  ]) {
    assert.equal(parseLinkUrl(bad), null, bad)
  }
})

test('linkKind 区分飞书文档 / 公众号 / 视频 / 网页', () => {
  assert.equal(linkKind('https://example.feishu.cn/docx/AbCdEf123456').kind, 'feishu-doc')
  assert.equal(linkKind('https://example.feishu.cn/wiki/WikAbc123456').kind, 'feishu-doc')
  // 飞书会议纪要不是文档，按普通网页登记链接卡片
  assert.equal(linkKind('https://example.feishu.cn/minutes/obcn123456').kind, 'web')
  assert.equal(linkKind(WECHAT_URL).kind, 'wechat')
  assert.equal(linkKind('https://www.bilibili.com/video/BV1xx411c7mD').kind, 'video')
  assert.equal(linkKind(WEB_URL).kind, 'web')
  assert.equal(linkKind('not a link').kind, 'invalid')
  assert.equal(linkKind('http://127.0.0.1/x').kind, 'invalid')
})

test('extractArticle 抽公众号标题/账号/时间/正文', () => {
  const article = extractArticle(WECHAT_HTML, WECHAT_URL)
  assert.equal(article.title, '小米发布会：一口气看完')
  assert.equal(article.site, '差评')
  assert.equal(article.publishedAt, '2026-11-03 20:00')
  assert.match(article.content, /发布会/)
  assert.match(article.content, /价格公布/)
  assert.equal(article.blocked, false)
  // 正文容器里的标题不重复进内容
  assert.doesNotMatch(article.content, /^小米发布会/)
})

test('extractArticle 抽网页 og 元数据并排除导航/脚本', () => {
  const article = extractArticle(WEB_HTML, WEB_URL)
  assert.equal(article.title, '一篇普通文章')
  assert.equal(article.site, '示例站点')
  assert.equal(article.author, '张三')
  assert.equal(article.publishedAt, '2026-11-02 09:30')
  assert.equal(article.excerpt, '这是摘要。')
  assert.match(article.content, /第二段正文/)
  assert.doesNotMatch(article.content, /首页 关于|版权所有|var x/)
  assert.doesNotMatch(article.content, /^一篇普通文章/)
})

test('extractArticle 小红书只取标题第一段，正文用 meta description', () => {
  const html = `<html><head><meta name="og:title" content="标题一 \t 正文第一段很长很长 \t 正文第二段">
<meta name="description" content="${LONG_BODY}"><meta name="og:site_name" content="小红书">
<title>标题一 \t 正文第一段很长很长</title></head><body><div id="note-content">短</div></body></html>`
  const article = extractArticle(html, 'https://www.xiaohongshu.com/explore/abc123')
  assert.equal(article.title, '标题一')
  assert.equal(article.site, '小红书')
  assert.match(article.content, /正文第一段/)
})

test('extractArticle 识别验证页/空页面', () => {
  const blocked = extractArticle('<html><body><p>环境异常，完成验证后即可继续访问。</p></body></html>', WECHAT_URL)
  assert.equal(blocked.blocked, true)
  assert.equal(extractArticle('<html><body></body></html>', WEB_URL).blocked, true)
})

test('decodeHtml 按 meta charset 解码', () => {
  const bytes = Buffer.from('<html><head><meta charset="utf-8"></head><body>中文</body></html>', 'utf8')
  assert.match(decodeHtml(bytes, 'text/html'), /中文/)
  assert.match(decodeHtml(bytes, 'text/html; charset=UTF-8'), /中文/)
})

test('fetchLinkPage 跟随跳转、拦截内网跳转并归一化状态码', async () => {
  const page = await fetchLinkPage(WEB_URL, {
    fetchImpl: async () => responseFor(WEB_HTML, { url: 'https://cdn.example.com/final' })
  })
  assert.equal(page.finalUrl, 'https://cdn.example.com/final')
  assert.match(page.html, /一篇普通文章/)

  await assert.rejects(
    () => fetchLinkPage(WEB_URL, {
      fetchImpl: async () => responseFor(WEB_HTML, { url: 'http://127.0.0.1/secret' })
    }),
    (error) => error.code === 'link_private'
  )
  await assert.rejects(
    () => fetchLinkPage(WEB_URL, { fetchImpl: async () => responseFor('', { status: 403 }) }),
    (error) => error.code === 'link_forbidden' && error.status === 403
  )
  await assert.rejects(
    () => fetchLinkPage(WEB_URL, { fetchImpl: async () => responseFor('', { status: 404 }) }),
    (error) => error.code === 'link_not_found'
  )
  await assert.rejects(
    () => fetchLinkPage(WEB_URL, {
      fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
    }),
    (error) => error.code === 'link_timeout'
  )
})

test('fetchLinkPage 对小红书使用移动 UA', async () => {
  let headers = null
  await fetchLinkPage('https://www.xiaohongshu.com/explore/abc123', {
    fetchImpl: async (url, init) => {
      headers = init.headers
      return responseFor('<html><body>ok</body></html>', { url: String(url) })
    }
  })
  assert.match(headers['user-agent'], /iPhone/)
})

test('fetchLinkPage 限制页面体积', async () => {
  const big = await fetchLinkPage(WEB_URL, {
    maxBytes: 10,
    fetchImpl: async () => responseFor('<html>0123456789abcdef</html>')
  }).then(() => null, (error) => error)
  assert.equal(big?.code, 'link_too_large')
})

test('previewLinkCard 网页成功 / 拦截降级 / 404 抛错', async () => {
  const preview = await previewLinkCard({
    url: WEB_URL,
    fetchImpl: async () => responseFor(WEB_HTML)
  })
  assert.equal(preview.ok, true)
  assert.equal(preview.kind, 'web')
  assert.equal(preview.doc_type, 'web')
  assert.equal(preview.title, '一篇普通文章')
  assert.equal(preview.site, '示例站点')
  assert.equal(preview.has_content, true)
  assert.ok(preview.content_chars > 0)
  assert.equal(preview.link_only, false)

  const blocked = await previewLinkCard({
    url: WECHAT_URL,
    fetchImpl: async () => responseFor('', { status: 403 })
  })
  assert.equal(blocked.kind, 'wechat')
  assert.equal(blocked.link_only, true)
  assert.match(blocked.warning, /登录|拒绝/)

  await assert.rejects(
    () => previewLinkCard({ url: WEB_URL, fetchImpl: async () => responseFor('', { status: 404 }) }),
    (error) => error.code === 'link_not_found'
  )
  await assert.rejects(
    () => previewLinkCard({ url: 'chrome://settings' }),
    (error) => error.code === 'invalid_url'
  )
})

test('previewLinkCard 飞书文档仍走飞书预览', async () => {
  const tools = {
    executable: () => true,
    async execute({ calls }) {
      return {
        results: [{
          callId: calls[0].id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ title: '飞书标题', content: '正文', revision_id: 3 }) }],
            isError: false
          }
        }]
      }
    }
  }
  const preview = await previewLinkCard({ tools, url: 'https://example.feishu.cn/docx/ExampleDocToken1' })
  assert.equal(preview.kind, 'feishu-doc')
  assert.equal(preview.doc_type, 'docx')
  assert.equal(preview.title, '飞书标题')
  assert.equal(preview.has_content, true)
})

test('createLinkCard 网页读取成功并把元数据交给后端', async () => {
  const backend = backendStub()
  const result = await createLinkCard({
    backend,
    url: WEB_URL,
    fetchImpl: async () => responseFor(WEB_HTML)
  })
  assert.equal(result.ok, true)
  assert.equal(result.link_only, false)
  assert.equal(backend.calls.length, 1)
  assert.equal(backend.calls[0].path, '/api/cards/doc')
  const payload = JSON.parse(backend.calls[0].init.body)
  assert.equal(payload.url, WEB_URL)
  assert.equal(payload.title, '一篇普通文章')
  assert.match(payload.content, /第二段正文/)
  assert.deepEqual(payload.meta, {
    site: '示例站点',
    author: '张三',
    published_at: '2026-11-02 09:30',
    excerpt: '这是摘要。'
  })
})

test('createLinkCard 环境性失败降级为链接卡，404 不落卡', async () => {
  const backend = backendStub()
  const blocked = await createLinkCard({
    backend,
    url: WECHAT_URL,
    fetchImpl: async () => responseFor('', { status: 403 })
  })
  assert.equal(blocked.link_only, true)
  assert.match(blocked.warning, /已先登记链接卡片/)
  const payload = JSON.parse(backend.calls[0].init.body)
  assert.equal(payload.content, '')
  assert.equal(payload.title, 'mp.weixin.qq.com · AbCdEf123456')

  const other = backendStub()
  await assert.rejects(
    () => createLinkCard({ backend: other, url: WEB_URL, fetchImpl: async () => responseFor('', { status: 404 }) }),
    (error) => error.code === 'link_not_found'
  )
  assert.equal(other.calls.length, 0)
})

test('createLinkCard 仅登记链接时不发请求', async () => {
  const backend = backendStub()
  let fetched = 0
  const result = await createLinkCard({
    backend,
    url: WEB_URL,
    linkOnly: true,
    fetchImpl: async () => { fetched += 1; return responseFor(WEB_HTML) }
  })
  assert.equal(fetched, 0)
  assert.equal(result.link_only, true)
  const payload = JSON.parse(backend.calls[0].init.body)
  assert.equal(payload.content, '')
  assert.equal(payload.title, 'example.com · hello')
})

test('createLinkCard 飞书文档委托 doc-cards 并把后端错误转成卡片错误', async () => {
  const backend = {
    async json() { throw Object.assign(new Error('bad'), { status: 422, data: { detail: [{ loc: ['body', 'url'], msg: 'invalid' }] } }) }
  }
  await assert.rejects(
    () => createLinkCard({ backend, url: WEB_URL, fetchImpl: async () => responseFor(WEB_HTML) }),
    (error) => error.code === 'card_write_failed' && /body.url: invalid/.test(error.message)
  )

  const tools = {
    executable: () => true,
    async execute({ calls }) {
      return {
        results: [{
          callId: calls[0].id,
          result: { content: [{ type: 'text', text: '{"title":"飞书标题","content":"正文"}' }], isError: false }
        }]
      }
    }
  }
  const calls = []
  const feishuBackend = { async json(path, init) { calls.push({ path, init }); return { created: true, card: {} } } }
  const result = await createLinkCard({ tools, backend: feishuBackend, url: 'https://example.feishu.cn/docx/ExampleDocToken1' })
  assert.equal(result.link_only, false)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].init.body).document_id, 'ExampleDocToken1')
})

test('fallbackLinkTitle 用站点和路径末段', () => {
  assert.equal(fallbackLinkTitle(new URL('https://www.example.com/a/b?x=1')), 'example.com · b')
  assert.equal(fallbackLinkTitle(new URL('https://example.com/')), 'example.com')
})
