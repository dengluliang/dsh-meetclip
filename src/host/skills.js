import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 随插件内置的 skill：让 /jianbao 在工作区里直接可用，不依赖用户级 skill 目录。
// 名称受 DSH 约束：skill 名必须是 ASCII kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$），
// 中文只能出现在 description 与正文里，因此这里用拼音 jianbao 作为命令词。
const SKILL_NAME = 'jianbao'
const ASSET_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url))
const PROVIDER_NAME = 'dsh-meetclip'
// 与 dsh-skill-filesystem 的 root rank 对齐：bundled 为 600（project 100 / user 400 / agents 500）。
const BUNDLED_RANK = 600

const PYTHON_CANDIDATES = [
  fileURLToPath(new URL('../../../meetclip/venv/bin/python', import.meta.url)),
  '/usr/bin/python3',
  'python3'
]

export function registerSkills(ctx) {
  const skills = ctx.get('skills')
  if (!skills) return
  const provider = createProvider()
  ctx.effect(() => {
    const dispose = skills.registerProvider(() => provider)
    return typeof dispose === 'function' ? dispose : () => {}
  })
}

function createProvider() {
  const skillDir = `${ASSET_ROOT}${SKILL_NAME}/`
  const locator = `${skillDir}SKILL.md`
  const summary = parseFrontmatter(readFileSafe(locator))
  const candidate = {
    name: SKILL_NAME,
    description: summary.description,
    ...(summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse }),
    invocation: { modelInvocable: true, userInvocable: summary.userInvocable },
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank: BUNDLED_RANK,
    resourceBase: { kind: 'directory', path: skillDir },
    locator
  }
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    async get(current, options) {
      const raw = options?.signal
        ? await readFile(current.locator, { encoding: 'utf8', signal: options.signal })
        : await readFile(current.locator, { encoding: 'utf8' })
      const { body } = parseFrontmatter(raw)
      return {
        name: current.name,
        description: current.description,
        ...(current.whenToUse === undefined ? {} : { whenToUse: current.whenToUse }),
        invocation: current.invocation,
        provider: current.provider,
        source: current.source,
        resourceBase: current.resourceBase,
        content: body.trim() + runtimeSection(skillDir)
      }
    }
  }
}

/**
 * 说明脚本与参考资料的绝对路径：模型在 shell 里必须用绝对路径调用，
 * 且 MeetClip 的 venv 自带 Pillow，配图脚本的感知去重只有在它下面才生效。
 */
function runtimeSection(skillDir) {
  const python = PYTHON_CANDIDATES.find((candidate) => existsSync(candidate)) ?? 'python3'
  const payload = {
    skillAssets: {
      references: `${skillDir}references/`,
      scripts: `${skillDir}scripts/`,
      framesScript: `${skillDir}scripts/frames.py`,
      buildDocScript: `${skillDir}scripts/build_doc.py`
    },
    python,
    note: 'Use these absolute paths. frames.py 不需要安装依赖；在 MeetClip venv 的 python 下会额外启用感知去重。'
  }
  return `\n\n## 本机路径（由会摘插件注入）\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
}

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`meetclip skills: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const BOOLEAN_TRUE = new Set(['true', 'yes', 'on', '1'])
const BOOLEAN_FALSE = new Set(['false', 'no', 'off', '0'])

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback
  const normalized = String(value).trim().replace(/^['"]|['"]$/g, '').toLowerCase()
  if (BOOLEAN_TRUE.has(normalized)) return true
  if (BOOLEAN_FALSE.has(normalized)) return false
  throw new Error(`meetclip skills: invalid boolean "${value}"`)
}

/** 只解析本插件需要的几个键，避免为一个 frontmatter 引入 YAML 依赖。 */
export function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!match) throw new Error('meetclip skills: SKILL.md has no YAML frontmatter')
  const fields = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    fields[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
  }
  const name = fields.name
  const description = fields.description
  if (!name) throw new Error('meetclip skills: SKILL.md has no name')
  if (!description) throw new Error('meetclip skills: SKILL.md has no description')
  return {
    name,
    description,
    whenToUse: fields.whenToUse,
    userInvocable: parseBoolean(fields['user-invocable'], true),
    modelInvocable: !parseBoolean(fields['disable-model-invocation'], false),
    body: raw.slice(match[0].length)
  }
}

export const internals = { ASSET_ROOT, SKILL_NAME, PROVIDER_NAME, BUNDLED_RANK }
