// 用无头 Chrome 给「纪要 × 笔记」面板截图。
// 用法：node build/build-notes-preview.mjs && node build/notes-preview-shot.mjs [--light]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const light = process.argv.includes('--light')
const invalid = process.argv.includes('--invalid')
const query = [light ? 'theme=light' : '', invalid ? 'state=invalid' : ''].filter(Boolean).join('&')
const page = `file://${path.join(here, 'notes-preview.html')}${query ? `?${query}` : ''}`
const output = path.join(here, invalid ? 'notes-preview-invalid.png' : light ? 'notes-preview-light.png' : 'notes-preview.png')
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-notes-'))

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
    '--window-size=1080,900',
    '--virtual-time-budget=4000',
    `--screenshot=${output}`,
    page
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
  console.log(`screenshot written: ${output}`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}
