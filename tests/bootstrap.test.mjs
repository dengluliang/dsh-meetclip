import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  compareVersions, findUvScript, parseUvWheel, pickPythonAsset, pickStandaloneReleases,
  pypiIndexes, pythonMirrors
} from '../src/host/bootstrap.js'

const UV_PAGE = `
<a href="../../packages/aa/bb/uv-0.9.7-py3-none-macosx_11_0_arm64.whl#sha256=11">uv-0.9.7</a><br/>
<a href="../../packages/cc/dd/uv-0.9.9-py3-none-macosx_11_0_arm64.whl#sha256=22">uv-0.9.9</a><br/>
<a href="../../packages/ee/ff/uv-0.9.9-py3-none-macosx_10_12_x86_64.whl#sha256=33">uv-0.9.9 x86</a><br/>
<a href="../../packages/gg/hh/uv-0.9.9-py3-none-manylinux_2_17_aarch64.whl">linux</a><br/>
`

test('从 PyPI 项目页挑最新的 macOS wheel，并把相对链接解析成绝对地址', () => {
  const wheel = parseUvWheel(UV_PAGE, 'https://pypi.tuna.tsinghua.edu.cn/simple/uv/', 'arm64')
  assert.equal(wheel.version, '0.9.9')
  assert.equal(
    wheel.url,
    'https://pypi.tuna.tsinghua.edu.cn/packages/cc/dd/uv-0.9.9-py3-none-macosx_11_0_arm64.whl'
  )
})

test('Intel 机器只取 x86_64 的 wheel', () => {
  const wheel = parseUvWheel(UV_PAGE, 'https://mirrors.aliyun.com/pypi/simple/uv/', 'x64')
  assert.equal(wheel.url, 'https://mirrors.aliyun.com/pypi/packages/ee/ff/uv-0.9.9-py3-none-macosx_10_12_x86_64.whl')
})

test('页面里没有对应架构的 wheel 时返回 null，便于换下一个镜像', () => {
  assert.equal(parseUvWheel('<a href="/uv-1.0-linux.whl">x</a>', 'https://example.com/uv/', 'arm64'), null)
  assert.equal(parseUvWheel('', 'https://example.com/uv/', 'arm64'), null)
})

test('版本号比较按数字段而不是字符串', () => {
  assert.equal(compareVersions('0.9.10', '0.9.9'), 1)
  assert.equal(compareVersions('0.9.9', '0.9.9'), 0)
  assert.equal(compareVersions('0.10', '0.9.99'), 1)
})

test('python-build-standalone 只挑 3.12 的 install_only 包', () => {
  const entries = [
    { name: 'cpython-3.12.11+20250818-aarch64-apple-darwin-install_only.tar.gz', url: 'u1', size: 1 },
    { name: 'cpython-3.12.12+20250910-aarch64-apple-darwin-install_only.tar.gz', url: 'u2', size: 2 },
    { name: 'cpython-3.12.12+20250910-aarch64-apple-darwin-install_only_stripped.tar.gz', url: 'u3' },
    { name: 'cpython-3.12.12+20250910-x86_64-apple-darwin-install_only.tar.gz', url: 'u4' },
    { name: 'cpython-3.11.9+20240726-aarch64-apple-darwin-install_only.tar.gz', url: 'u5' },
    { name: '20250115/', url: 'dir' }
  ]
  const asset = pickPythonAsset(entries, { arch: 'arm64', series: '3.12' })
  assert.equal(asset.version, '3.12.12')
  assert.equal(asset.url, 'u2')
  assert.equal(pickPythonAsset(entries, { arch: 'x64', series: '3.12' }).url, 'u4')
  assert.equal(pickPythonAsset([], {}), null)
})

test('release 目录按名字倒序，最多取四个候选版本', () => {
  const entries = [
    { name: '20240726/', type: 'dir' },
    { name: '20250910/', type: 'dir' },
    { name: '20250115/', type: 'dir' },
    { name: '20250818/', type: 'dir' },
    { name: 'README.md', type: 'file' }
  ]
  assert.deepEqual(pickStandaloneReleases(entries, 3), ['20250910', '20250818', '20250115'])
})

test('镜像列表默认国内优先，可用环境变量整体覆盖', () => {
  assert.match(pypiIndexes()[0], /tuna/)
  assert.match(pythonMirrors()[0], /npmmirror/)
  const saved = process.env.MEETCLIP_PYPI_MIRROR
  process.env.MEETCLIP_PYPI_MIRROR = 'https://mirror.internal/simple, https://other/simple'
  try {
    assert.deepEqual(pypiIndexes(), ['https://mirror.internal/simple', 'https://other/simple'])
  } finally {
    if (saved === undefined) delete process.env.MEETCLIP_PYPI_MIRROR
    else process.env.MEETCLIP_PYPI_MIRROR = saved
  }
})

test('能在解开的 wheel 里找到 uv 可执行文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetclip-uv-'))
  try {
    const scripts = path.join(root, 'uv-0.9.9.data', 'scripts')
    fs.mkdirSync(scripts, { recursive: true })
    fs.writeFileSync(path.join(scripts, 'uv'), 'bin')
    assert.equal(findUvScript(root), path.join(scripts, 'uv'))
    assert.equal(findUvScript(path.join(root, 'uv-0.9.9.dist-info')), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
