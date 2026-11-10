// Generate the GitHub Release assets for the version in package.json.
//
//   node build/release.mjs --dry-run
//   GITHUB_TOKEN=… node build/release.mjs --upload
//
// Outputs (dist/release/<version>/):
//   dsh-meetclip-<version>.tgz
//   SHA256SUMS.txt
//   latest.json      ← the stable feed the in-app updater reads
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractTarball } from '../src/host/tar.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = String(manifest.version || '')
const tag = `v${version}`
const repo = option('--repo') || 'dengluliang/dsh-meetclip'
const outDir = path.resolve(option('--out') || path.join(root, 'dist', 'release', version))
const upload = process.argv.includes('--upload')
const skipTests = process.argv.includes('--skip-tests')
const allowDirty = process.argv.includes('--allow-dirty')

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`package.json 版本号无效：${version}`)
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail(`仓库名无效：${repo}`)
if (upload && !process.env.GITHUB_TOKEN) fail('上传需要 GITHUB_TOKEN 环境变量')
if (upload && !allowDirty && gitDirty()) fail('工作区有未提交改动；先提交，或显式加 --allow-dirty')

console.log(`MeetClip release ${tag} → ${outDir}`)
console.log('1/5 rebuilding client.js')
run(process.execPath, [path.join(here, 'build-client.mjs')])

if (!skipTests) {
  console.log('2/5 running client/host tests')
  const tests = fs.readdirSync(path.join(root, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join('tests', name))
  run(process.execPath, ['--test', ...tests])
} else {
  console.log('2/5 tests skipped')
}

console.log('3/5 packing npm tarball')
await fsp.mkdir(outDir, { recursive: true })
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-npm-cache-'))
try {
  const packed = execFileSync('npm', [
    'pack',
    '--pack-destination', outDir,
    '--cache', cache,
    '--logs-dir', cache,
    '--silent'
  ], { cwd: root, encoding: 'utf8' }).trim().split('\n').pop()
  const source = path.join(outDir, packed)
  const target = path.join(outDir, `dsh-meetclip-${version}.tgz`)
  await fsp.rename(source, target)

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-release-check-'))
  try {
    const extracted = extractTarball(await fsp.readFile(target), stage)
    const built = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'))
    if (built.name !== manifest.name || built.version !== version) {
      fail(`打包结果与 package.json 不一致：${built.name}@${built.version}`)
    }
    if (!extracted.files.includes('client.js')) fail('打包结果缺少 client.js')
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
} finally {
  fs.rmSync(cache, { recursive: true, force: true })
}

console.log('4/5 hashing and writing latest.json')
const assetPath = path.join(outDir, `dsh-meetclip-${version}.tgz`)
const bytes = fs.readFileSync(assetPath)
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
const notes = releaseNotes()
const assetUrl = `https://github.com/${repo}/releases/download/${tag}/dsh-meetclip-${version}.tgz`
const latest = {
  schemaVersion: 1,
  version,
  tag,
  publishedAt: new Date().toISOString(),
  notes,
  asset: {
    name: `dsh-meetclip-${version}.tgz`,
    url: assetUrl,
    size: bytes.length,
    sha256
  }
}
fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`)
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sha256}  dsh-meetclip-${version}.tgz\n`)
console.log(`    ${sha256}  dsh-meetclip-${version}.tgz`)

if (!upload) {
  console.log('5/5 dry run complete; assets are ready for upload')
  console.log(`\n上传：GITHUB_TOKEN=… node build/release.mjs --upload`)
  process.exit(0)
}

console.log('5/5 creating GitHub release and uploading assets')
await uploadRelease({ notes })
console.log(`\n发布完成：https://github.com/${repo}/releases/tag/${tag}`)
console.log(`更新入口：https://github.com/${repo}/releases/latest/download/latest.json`)

// ------------------------------------------------------------------ helpers

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

function releaseNotes() {
  const file = option('--notes-file')
  if (file) return fs.readFileSync(path.resolve(file), 'utf8').trim()
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^##\\s+${escaped}\\b.*$`, 'm').exec(changelog)
  if (!heading) return `MeetClip ${tag}`
  const rest = changelog.slice(heading.index + heading[0].length)
  const next = rest.search(/^##\s/m)
  return (next < 0 ? rest : rest.slice(0, next)).trim() || `MeetClip ${tag}`
}

function gitDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0
  } catch {
    return false
  }
}

async function uploadRelease({ notes }) {
  const token = process.env.GITHUB_TOKEN
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'MeetClip-Release'
  }
  const existing = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers })
  if (existing.status === 200) fail(`Release ${tag} 已存在；请先提高版本号或删除旧 Release`)
  if (existing.status !== 404) fail(`查询 Release 失败：HTTP ${existing.status}`)

  const created = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: option('--target') || 'main',
      name: tag,
      body: notes,
      draft: false,
      prerelease: false
    })
  })
  if (!created.ok) fail(`创建 Release 失败：HTTP ${created.status} ${await created.text()}`)
  const release = await created.json()
  console.log(`    release id ${release.id}`)

  const assets = [
    ['dsh-meetclip-' + version + '.tgz', 'application/gzip'],
    ['SHA256SUMS.txt', 'text/plain'],
    ['latest.json', 'application/json']
  ]
  for (const [name, type] of assets) {
    const body = fs.readFileSync(path.join(outDir, name))
    const response = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': type, 'content-length': String(body.length) },
      body
    })
    if (!response.ok) fail(`上传 ${name} 失败：HTTP ${response.status} ${await response.text()}`)
    console.log(`    uploaded ${name} (${body.length} bytes)`)
  }
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}
