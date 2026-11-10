import { build } from 'esbuild'
import { copyFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await build({
  entryPoints: [path.join(here, 'libraries-preview.jsx')],
  absWorkingDir: root,
  nodePaths: [path.join(here, 'node_modules')],
  bundle: true,
  outfile: path.join(here, 'libraries-preview.js'),
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

writeFileSync(path.join(here, 'libraries-preview.html'), `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>会摘 · 资料空间预览</title>
<style>
  body { margin: 0; font-family: -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
         background: #191919; color: #f2f2f2; }
  #root { min-height: 100vh; }
</style>
</head>
<body>
<div id="root"></div>
<script src="libraries-preview.js"></script>
</body>
</html>
`)

console.log('libraries-preview.js + .html written')
