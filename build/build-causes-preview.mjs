// 打包「原因卡片」预览（真实组件 + 真实样式）。
// 用法：node build/build-causes-preview.mjs && node build/causes-preview-shot.mjs
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await build({
  entryPoints: [path.join(here, 'causes-preview.jsx')],
  absWorkingDir: root,
  nodePaths: [path.join(here, 'node_modules')],
  bundle: true,
  outfile: path.join(here, 'causes-preview.js'),
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

console.log('causes-preview.js written')
