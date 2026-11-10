import assert from 'node:assert/strict'
import test from 'node:test'
import { internals, parseFrontmatter, registerSkills } from '../src/host/skills.js'

test('parseFrontmatter 读取内置 skill 的元数据', async () => {
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(new URL('../skills/jianbao/SKILL.md', import.meta.url), 'utf8')
  const meta = parseFrontmatter(raw)
  assert.equal(meta.name, 'jianbao')
  assert.match(meta.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(meta.description.length > 10)
  assert.equal(meta.userInvocable, true)
  assert.equal(meta.modelInvocable, true)
  assert.ok(meta.body.length > 200)
})

test('registerSkills 在缺少 skills 服务时不报错', () => {
  registerSkills({ get: () => undefined, effect: () => {} })
})

test('provider 暴露单个可被用户调用的 skill，并注入绝对路径', async () => {
  let registered
  const ctx = {
    get: (name) => (name === 'skills' ? { registerProvider: (factory) => { registered = factory; return () => {} } } : undefined),
    effect: (run) => run()
  }
  registerSkills(ctx)
  const provider = registered()
  assert.equal(provider.name, internals.PROVIDER_NAME)
  const list = await provider.list()
  assert.equal(list.length, 1)
  const [candidate] = list
  assert.equal(candidate.name, 'jianbao')
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(candidate.rank, internals.BUNDLED_RANK)
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.ok(candidate.resourceBase.path.endsWith('skills/jianbao/'))

  const loaded = await provider.get(candidate, {})
  assert.equal(loaded.name, 'jianbao')
  assert.ok(loaded.content.includes('本机路径'))
  assert.ok(loaded.content.includes('build_doc.py'))
  assert.ok(!loaded.content.startsWith('---'))
})
