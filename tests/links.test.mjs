import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BATCH_LINKS, parseLinks, platformLabel } from '../client-src/lib/links.js'

const SAMPLE = `"https://www.bilibili.com/video/BV1mygw6jEg6/
https://weibo.com/2430711645/RdlEuqnKr"
https://www.bilibili.com/video/BV1mygw6jEg6/
"https://www.bilibili.com/video/BV16kgA6qEo9/
https://v.douyin.com/6DFF61GmvhI/"

https://weibo.com/3309403941/RdlEolQpp
"https://www.ifanr.com/1675208
https://mp.weixin.qq.com/s/mQC3yM3pKw1C7x3Sbo9M1A"


https://weibo.com/1595443924/Rdm4XqaHR
"https://www.bilibili.com/video/BV14Sgs6GEe8
https://weibo.com/6580679823/RdlGHvIUa
https://v.douyin.com/wjMo5rVTnDA"
"https://v.douyin.com/7q3kBDlNXhA/
https://weibo.com/5887230321/RdlJEiDB5"
"https://v.douyin.com/Bxxe9hoy5Ac/
https://weibo.com/3035596071/RdlJxszu1"




https://phone.cnmo.com/reviews/815979.html

https://weibo.com/1662223823/RdlFP1Ye1?refer_flag=1001030103_



https://weibo.com/1668726803/RdlMnepTd
https://weibo.com/1642243964/RdlItwEVP
https://weibo.com/2886358364/5331814923112964
https://weibo.com/1923390687/RdlGeyeIb
https://weibo.com/1257591565/RdlSGtjPt

https://weibo.com/2662447161/RdlEoe9uD

http://www.gfan.com/info/602881.html
https://weibo.com/2814493542/RdlEo3au9
https://weibo.com/1726544024/RdlEomWLb
https://weibo.com/1796445350/RdlPKF8a7


https://weibo.com/2283100957/5331814924943784
https://weibo.com/5311801448/RdlEod2UI
https://weibo.com/2628081005/5331814923370814
https://weibo.com/5128606465/RdlEomXvq




https://mp.weixin.qq.com/s/a9ZDnl3rkHbi_JIPW8Awew?scene=1&click_id=2
https://weibo.com/1859683200/RdlEohrIl`

test('用户粘贴的原文：34 条 → 28 条视频 + 6 条跳过', () => {
  const result = parseLinks(SAMPLE)
  assert.equal(result.total, 34)
  assert.equal(result.accepted.length, 28)
  assert.equal(result.skipped.unsupported, 5)
  assert.equal(result.skipped.duplicate, 1)
  assert.equal(result.skipped.invalid, 0)
  assert.equal(result.skipped.overflow, 0)
  assert.equal(result.live.length, 0)

  const counts = result.accepted.reduce((acc, row) => {
    acc[row.platform] = (acc[row.platform] || 0) + 1
    return acc
  }, {})
  assert.deepEqual(counts, { bilibili: 3, weibo: 21, douyin: 4 })

  for (const row of result.accepted) {
    assert.ok(!/["'“”‘’]/.test(row.url), row.url)
    assert.match(row.url, /^https?:\/\//)
    assert.ok(!/ifanr|weixin|cnmo|gfan/.test(row.url))
  }
  assert.equal(result.accepted.filter((row) => /BV1mygw6jEg6/.test(row.url)).length, 1)
  assert.equal(platformLabel('douyin'), '抖音')
})

test('引号、空行、中文标点与包裹字符', () => {
  const text = '看这个： “https://www.bilibili.com/video/BV1xx411c7mD/”，还有\n<https://youtu.be/dQw4w9WgXcQ>。'
  const result = parseLinks(text)
  assert.equal(result.total, 2)
  assert.equal(result.accepted.length, 2)
  assert.deepEqual(result.accepted.map((row) => row.platform).sort(), ['bilibili', 'youtube'])
  assert.equal(result.accepted[1].url, 'https://youtu.be/dQw4w9WgXcQ')
})

test('直播链接单列，不进入视频列表', () => {
  const result = parseLinks('https://live.bilibili.com/21452505?broadcast_type=0')
  assert.equal(result.accepted.length, 0)
  assert.equal(result.live.length, 1)
  assert.match(result.live[0].url, /live\.bilibili\.com\/21452505/)
})

test('不支持的站点与格式错误跳过', () => {
  const result = parseLinks([
    'https://example.com/video/1',
    'https://www.bilibili.com/',
    'https://www.weibo.com/about',
    'ftp://www.bilibili.com/video/BV1xx411c7mD'
  ].join('\n'))
  assert.equal(result.accepted.length, 0)
  assert.equal(result.skipped.unsupported, 1)
  assert.equal(result.skipped.invalid, 2)
})

test('平台变体与查询参数清理', () => {
  const result = parseLinks([
    'https://www.bilibili.com/video/BV1xx411c7mD/?p=2&t=30&vd_source=abc',
    'https://m.weibo.cn/status/5050505050',
    'https://www.iesdouyin.com/share/video/7673720471061335311/',
    'https://twitter.com/example/status/1234567890?t=abc',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10&list=PL123'
  ].join('\n'))
  assert.equal(result.accepted.length, 5)
  const byPlatform = Object.fromEntries(result.accepted.map((row) => [row.platform, row.url]))
  assert.match(byPlatform.bilibili, /[?&]p=2/)
  assert.ok(!byPlatform.bilibili.includes('vd_source'))
  assert.equal(byPlatform.weibo, 'https://m.weibo.cn/status/5050505050')
  assert.equal(byPlatform.douyin, 'https://www.iesdouyin.com/share/video/7673720471061335311/')
  assert.equal(byPlatform.x, 'https://twitter.com/example/status/1234567890')
  assert.match(byPlatform.youtube, /v=dQw4w9WgXcQ/)
  assert.ok(!byPlatform.youtube.includes('list='))
})

test('同平台去重：BV 地址、追踪参数与 youtu.be 别名', () => {
  const result = parseLinks([
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/video/BV1xx411c7mD/?t=12',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  ].join('\n'))
  assert.equal(result.accepted.length, 2)
  assert.equal(result.skipped.duplicate, 2)
})

test('超过上限只保留前 max 条并计数', () => {
  const text = Array.from({ length: 60 }, (_, i) => `https://www.bilibili.com/video/BV1xx41${String(i).padStart(4, '0')}`).join('\n')
  const result = parseLinks(text, { max: 10 })
  assert.equal(result.accepted.length, 10)
  assert.equal(result.skipped.overflow, 50)
  assert.equal(MAX_BATCH_LINKS, 50)
})

test('普通文字没有链接', () => {
  const result = parseLinks('今天的发布会讲了什么')
  assert.equal(result.total, 0)
  assert.equal(result.accepted.length, 0)
  assert.equal(result.live.length, 0)
})
