// 打包「纪要 · 结论和待办」预览（真实组件 + 真实样式）。
// 用法：node build/build-outcomes-preview.mjs && node build/outcomes-preview-shot.mjs
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await build({
  entryPoints: [path.join(here, 'outcomes-preview.jsx')],
  absWorkingDir: root,
  nodePaths: [path.join(here, 'node_modules')],
  bundle: true,
  outfile: path.join(here, 'outcomes-preview.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  loader: { '.css': 'text' },
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: false,
  logLevel: 'info'
})

console.log('outcomes-preview.js written')
