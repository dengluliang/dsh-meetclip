// 用无头 Chrome 生成「内联采集面板底部操作行被裁掉」修复前后对比截图（散落模式，1512×982）。
// 用法：node build/build-capture-clip-preview.mjs && node build/capture-clip-shots.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const html = path.join(here, 'capture-clip-preview.html')

const shots = [
  // 截图统一带上「已经有一个批次在下载」的状态（?active=1），和用户反馈的场景一致。
  { file: 'capture-clip-before.png', query: '?active=1&old=1&shot=1' },
  { file: 'capture-clip-after.png', query: '?active=1&shot=1' }
]

for (const shot of shots) {
  const output = path.join(here, shot.file)
  const profile = mkdtempSync(path.join(tmpdir(), 'dsh-capture-clip-'))
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
      '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`,
      '--window-size=1512,982',
      '--virtual-time-budget=6000',
      `--screenshot=${output}`,
      `file://${html}${shot.query}`
    ], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
    console.log(`screenshot written: ${output}`)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}
