// 用无头 Chrome 给「设置 → 备份」截图。
// 用法：node build/build-backup-preview.mjs && node build/backup-preview-shot.mjs [--light]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const light = process.argv.includes('--light')
const scenario = (process.argv.find((arg) => arg.startsWith('--scenario=')) || '').split('=')[1] || 'export'
const query = [light ? 'theme=light' : '', scenario === 'export' ? '' : `scenario=${scenario}`].filter(Boolean).join('&')
const page = `file://${path.join(here, 'backup-preview.html')}${query ? `?${query}` : ''}`
const suffix = scenario === 'export' ? '' : `-${scenario}`
const output = path.join(here, light ? `backup-preview${suffix}-light.png` : `backup-preview${suffix}.png`)
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-backup-'))

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
    '--window-size=1080,1500',
    '--virtual-time-budget=12000',
    `--screenshot=${output}`,
    page
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
  console.log(`screenshot written: ${output}`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}
