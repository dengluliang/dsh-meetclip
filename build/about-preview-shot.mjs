// 用无头 Chrome 给「设置 → 关于」截图。
// 用法：node build/build-about-preview.mjs && node build/about-preview-shot.mjs [state] [outfile] [--theme=light]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = process.argv.slice(2).filter((item) => !item.startsWith('--'))
const state = args[0] || 'downloading'
const output = path.resolve(args[1] || path.join(here, `about-preview-${state}.png`))
const themeArg = process.argv.find((item) => item.startsWith('--theme='))
const theme = themeArg ? themeArg.split('=')[1] : 'light'
const page = `file://${path.join(here, 'about-preview.html')}?state=${encodeURIComponent(state)}&theme=${theme}`
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-about-'))
const widthArg = process.argv.find((item) => item.startsWith('--width='))
const width = widthArg ? Number(widthArg.split('=')[1]) : 900

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
    `--window-size=${width},980`,
    '--virtual-time-budget=4000',
    `--screenshot=${output}`,
    page
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
  console.log(`screenshot written: ${output}`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}
