// 用无头 Chrome 给「纪要 · 结论和待办」截图；加 --metrics 只抓各列边缘，不出图。
// 用法：
//   node build/build-outcomes-preview.mjs && node build/outcomes-preview-shot.mjs [--out=名字.png] [--stress] [--done]
//   node build/build-outcomes-preview.mjs && node build/outcomes-preview-shot.mjs --metrics [--stress]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const metrics = process.argv.includes('--metrics')
const stress = process.argv.includes('--stress')
const done = process.argv.includes('--done')
const query = [metrics ? 'metrics=1' : '', stress ? 'stress=1' : '', done ? 'done=1' : ''].filter(Boolean).join('&')
const named = process.argv.find((arg) => arg.startsWith('--out='))
const output = path.join(here, named ? named.slice('--out='.length) : 'outcomes-preview.png')
const page = `file://${path.join(here, 'outcomes-preview.html')}${query ? `?${query}` : ''}`
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-outcomes-'))

const args = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--no-first-run',
  '--force-prefers-reduced-motion',
  '--force-device-scale-factor=2',
  `--user-data-dir=${profile}`,
  '--window-size=848,900',
  '--virtual-time-budget=4000'
]

try {
  if (metrics) {
    const result = spawnSync(chrome, [...args, '--dump-dom', page], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
    const found = result.stdout.match(/<pre id="metrics">([\s\S]*?)<\/pre>/)
    if (!found) throw new Error('no metrics block in dumped DOM')
    const data = JSON.parse(found[1])
    const uniq = (points) => [...new Set(points.map(([x]) => x))]
    console.log('序号列 x =', uniq(data.index))
    console.log('勾选框 x =', uniq(data.marks))
    console.log('正文列 x =', uniq(data.texts))
    writeFileSync(path.join(here, 'outcomes-preview-metrics.json'), `${JSON.stringify(data, null, 2)}\n`)
    console.log('metrics written: build/outcomes-preview-metrics.json')
  } else {
    const result = spawnSync(chrome, [...args, `--screenshot=${output}`, page], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
    console.log(`screenshot written: ${output}`)
  }
} finally {
  rmSync(profile, { recursive: true, force: true })
}
