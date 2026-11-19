// 用无头 Chrome 给散落画布预览页截图，产出 docs/assets/scatter-preview.png。
// 用法：node build/scatter-preview-shot.mjs [--drag] [--dark] [--board] [--paste-text] [--paste-image] [--paste-heic] [--packs] [--packs-dark]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const drag = process.argv.includes('--drag')
const dark = process.argv.includes('--dark')
const pasteText = process.argv.includes('--paste-text')
const pasteImage = process.argv.includes('--paste-image')
const pasteHeic = process.argv.includes('--paste-heic')
const board = process.argv.includes('--board')
const packs = process.argv.includes('--packs')
const links = process.argv.includes('--links')
const packsFeed = process.argv.includes('--packs-feed')
const packsDark = process.argv.includes('--packs-dark')
const packOverlay = process.argv.includes('--pack-overlay')
const packHotzone = process.argv.includes('--pack-hotzone')
const paste = pasteText ? 'paste=text' : pasteImage ? 'paste=image' : pasteHeic ? 'paste=heic' : ''
const darkQuery = dark || packsDark ? 'theme=dark' : ''
const query = [
  drag ? 'demo=drag' : '',
  packHotzone ? 'demo=pack-hotzone' : '',
  packOverlay ? 'packs=1&demo=pack-overlay' : '',
  packsFeed ? 'packs=1&empty=1&demo=feed' : packs || packsDark ? 'packs=1' : '',
  links ? 'links=1' : '',
  darkQuery,
  board ? 'board=1' : '',
  paste
].filter(Boolean).join('&')
const page = `file://${path.join(here, 'scatter-preview.html')}${query ? `?${query}` : ''}`
const output = path.join(root,
  links ? 'build/link-preview.png'
    : packsFeed ? 'build/pack-preview-feed.png'
    : packHotzone ? 'build/pack-hotzone-preview.png'
    : packOverlay ? 'build/pack-overlay-preview.png'
    : pasteText ? 'build/paste-text-preview.png'
      : pasteImage ? 'build/paste-image-preview.png'
        : pasteHeic ? 'build/paste-heic-preview.png'
        : board ? 'build/board-image-preview.png'
        : drag ? 'build/scatter-drag.png'
          : packsDark ? 'build/pack-preview-dark.png'
          : packs ? 'build/pack-preview.png'
            : dark ? 'build/scatter-preview-dark.png'
              : 'docs/assets/scatter-preview.png')
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-scatter-'))

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
    `--user-data-dir=${profile}`,
    // 卡包截图要同时看到两个包，散落画布给大一点的画幅；其余预览保持 1440×1000。
    `--window-size=${packsFeed ? '1440,1240' : packs || packsDark ? '1600,1200' : '1440,1000'}`,
    '--virtual-time-budget=8000',
    `--screenshot=${output}`,
    page
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Chrome exited with ${result.status}`)
  console.log(`screenshot written: ${output}`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}
