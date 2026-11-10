// 用无头 Chrome 给「设置 → 模型」截图。
// 用法：node build/build-settings-preview.mjs && node build/settings-preview-shot.mjs [--light]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const light = process.argv.includes('--light')
const query = light ? 'theme=light' : ''
const page = `file://${path.join(here, 'settings-preview.html')}${query ? `?${query}` : ''}`
const output = path.join(here, light ? 'settings-preview-light.png' : 'settings-preview.png')
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-settings-'))

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
    '--window-size=1080,1180',
    '--virtual-time-budget=4000',
    `--screenshot=${output}`,
    page
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
  console.log(`screenshot written: ${output}`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}
