import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const arg = (name, fallback = '') => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const html = path.resolve(arg('--html', path.join(here, 'journey-preview.html')))
const outDir = path.resolve(arg('--out', path.join(here, 'journey-shots', 'after')))
mkdirSync(outDir, { recursive: true })

const scenes = [
  ['01-home-topbar', 'home', 900],
  ['02-settings-models', 'settings-models', 1000],
  ['03-settings-account', 'settings-account', 1250],
  ['04-settings-capture', 'settings-capture', 1250],
  ['05-settings-feishu', 'settings-feishu', 750],
  ['06-settings-dialog', 'settings-dialog', 950],
  ['07-setup-step1', 'setup-step1', 950],
  ['08-setup-step2', 'setup-step2', 1050],
  ['09-setup-step3', 'setup-step3', 1200],
  ['10-progress-card', 'progress', 820],
  ['11-video-bili', 'video-bili', 850],
  ['12-video-douyin', 'video-douyin', 950],
  ['13-launch-error', 'launch', 850],
  ['14-doc-login', 'doc', 950],
  ['15-help', 'help', 900],
  ['16-record-login', 'record', 1300],
  ['17-settings-about', 'settings-about', 1300],
  ['18-doc-link', 'doc-link', 1150],
]

const profile = mkdtempSync(path.join(tmpdir(), 'meetclip-journey-'))
try {
  for (const [name, scene, height] of scenes) {
    const output = path.join(outDir, `${name}.png`)
    const page = `file://${html}?scene=${encodeURIComponent(scene)}&theme=light`
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
      `--window-size=1440,${height}`,
      '--virtual-time-budget=6500',
      `--screenshot=${output}`,
      page
    ], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Chrome exited with ${result.status} for ${name}`)
    console.log(`shot ${name}`)
  }
} finally {
  rmSync(profile, { recursive: true, force: true })
}
console.log(`screenshots written: ${outDir}`)
