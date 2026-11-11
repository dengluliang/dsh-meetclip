// 用无头 Chrome 给「批次失败项重试」预览截图（浅色 / 深色各一张）。
// 用法：node build/build-batch-retry-preview.mjs && node build/batch-retry-preview-shot.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const html = path.join(here, 'batch-retry-preview.html')

for (const theme of ['light', 'dark']) {
  const output = path.join(here, `batch-retry-preview-${theme}.png`)
  const query = theme === 'dark' ? '?view=both&theme=dark' : '?view=both'
  const profile = mkdtempSync(path.join(tmpdir(), `dsh-batch-retry-${theme}-`))
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
      '--window-size=1220,900',
      '--virtual-time-budget=4000',
      `--screenshot=${output}`,
      `file://${html}${query}`
    ], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
    console.log(`screenshot written: ${output}`)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}
