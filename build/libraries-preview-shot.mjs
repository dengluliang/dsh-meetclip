// 用无头 Chrome 给资料空间预览截图。
// 用法：node build/build-libraries-preview.mjs && node build/libraries-preview-shot.mjs [--light]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const light = process.argv.includes('--light')
const page = `file://${path.join(here, 'libraries-preview.html')}${light ? '?theme=light' : ''}`
const output = path.join(here, light ? 'libraries-preview-light.png' : 'libraries-preview.png')
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-libraries-'))

try {
  const result = spawnSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--disable-breakpad', '--hide-scrollbars', '--allow-file-access-from-files',
    '--no-first-run', '--force-prefers-reduced-motion', '--force-device-scale-factor=2',
    `--user-data-dir=${profile}`, '--window-size=1040,2100', '--virtual-time-budget=4000',
    `--screenshot=${output}`, page
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
  console.log(`screenshot written: ${output}`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}
