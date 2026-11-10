// 用无头 Chrome 给「纪要 · 原因卡片」截图。
// 用法：node build/build-causes-preview.mjs && node build/causes-preview-shot.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const page = `file://${path.join(here, 'causes-preview.html')}`
const output = path.join(here, 'causes-preview.png')
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-causes-'))

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
    '--window-size=1144,760',
    '--virtual-time-budget=4000',
    `--screenshot=${output}`,
    page
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
  console.log(`screenshot written: ${output}`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}
