// 用无头 Chrome 给会议采集面板预览截图。
// 用法：node build/meeting-preview-shot.mjs [--empty]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const empty = process.argv.includes('--empty')
const light = process.argv.includes('--light')
const query = [empty ? 'empty=1' : '', light ? 'theme=light' : ''].filter(Boolean).join('&')
const page = `file://${path.join(here, 'meeting-preview.html')}${query ? `?${query}` : ''}`
const output = path.join(here, light ? 'meeting-preview-light.png' : empty ? 'meeting-preview-empty.png' : 'meeting-preview.png')
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-meeting-'))

try {
  const result = spawnSync(chrome, [
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
    '--window-size=900,820',
    '--virtual-time-budget=4000',
    `--screenshot=${output}`,
    page
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
  console.log(`screenshot written: ${output}`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}
