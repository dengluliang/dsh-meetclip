import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await build({
  entryPoints: [path.join(here, 'about-preview.jsx')],
  absWorkingDir: root,
  nodePaths: [path.join(here, 'node_modules')],
  bundle: true,
  outfile: path.join(here, 'about-preview.js'),
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

console.log('about-preview.js written')
