import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { ensureDir, readLogTail } from './config.js'

const LOG_LIMIT = 96 * 1024

export class EnvironmentManager {
  constructor(settings) {
    this.settings = settings
    this.job = null
    this.child = null
    this.cache = { at: 0, value: null }
  }

  refresh(settings) {
    this.settings = settings
    this.cache = { at: 0, value: null }
  }

  async status(force = false) {
    const now = Date.now()
    if (!force && this.cache.value && now - this.cache.at < 20_000) {
      return { ...this.cache.value, job: this.jobSnapshot() }
    }
    const python = this.settings.python || this.settings.venvPython
    const exists = fs.existsSync(python)
    const uv = findExecutable('uv')
    let imports = { fastapi: false, mlx: false, detail: '' }
    let version = ''
    if (exists) {
      version = await pythonVersion(python)
      imports = await probeImports(python)
    }
    const value = {
      venvDir: this.settings.venvDir,
      venvPython: this.settings.venvPython,
      python,
      exists,
      version,
      ready: Boolean(exists && imports.fastapi),
      mlx: imports.mlx,
      detail: imports.detail,
      uv,
      job: null
    }
    this.cache = { at: now, value }
    return { ...value, job: this.jobSnapshot() }
  }

  jobSnapshot() {
    if (!this.job) return null
    return {
      state: this.job.state,
      action: this.job.action,
      step: this.job.step,
      log: this.job.log.slice(-8000),
      error: this.job.error,
      done: this.job.done,
      startedAt: this.job.startedAt,
      finishedAt: this.job.finishedAt
    }
  }

  async start(action) {
    if (this.job && this.job.state === 'running') {
      throw new Error('已有环境安装任务在进行中')
    }
    if (!['create-env', 'cleanup-diarize'].includes(action)) {
      throw new Error(`不支持的环境操作：${action}`)
    }
    ensureDir(this.settings.stateDir)
    this.job = {
      state: 'running',
      action,
      step: '准备',
      log: '',
      error: '',
      done: false,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.appendLog(`\n=== ${new Date().toISOString()} ${action} ===`)
    this.run(action).catch((error) => {
      this.job.state = 'error'
      this.job.error = error?.message || String(error)
      this.job.done = true
      this.job.finishedAt = Date.now()
      this.appendLog(`❌ ${this.job.error}`)
    })
    return this.jobSnapshot()
  }

  cancel() {
    if (!this.job || this.job.state !== 'running') return false
    try { this.child?.kill('SIGTERM') } catch {}
    this.job.state = 'cancelled'
    this.job.done = true
    this.job.finishedAt = Date.now()
    this.appendLog('⏹ 已取消')
    return true
  }

  async run(action) {
    if (action === 'cleanup-diarize') {
      this.step('卸载说话人分离依赖')
      const packages = ['pyannote.audio', 'pyannote.core', 'pyannote.database', 'pyannote.metrics',
        'pyannote.pipeline', 'pyannoteai', 'torch', 'torchaudio']
      try {
        await this.exec(this.settings.venvPython, ['-m', 'pip', 'uninstall', '-y', ...packages], '卸载说话人分离依赖')
      } catch {
        this.appendLog('部分依赖未安装，已跳过')
      }
      this.cache = { at: 0, value: null }
      this.job.state = 'done'
      this.job.done = true
      this.job.finishedAt = Date.now()
      this.step('完成')
      return
    }
    const uv = findExecutable('uv')
    let base = this.settings.python || this.settings.venvPython
    if (!fs.existsSync(this.settings.venvPython)) {
      if (uv) {
        this.step('创建独立 venv（uv）')
        await this.exec(uv, ['venv', this.settings.venvDir, '--python', '3.12'], '创建独立 venv')
      } else {
        const python = await this.findBasePython()
        if (!python) {
          throw new Error('未找到 Python 3.10+，也没有 uv。请安装 uv 或 Homebrew python@3.12 后重试')
        }
        this.step('创建独立 venv')
        await this.exec(python, ['-m', 'venv', this.settings.venvDir], '创建独立 venv')
        this.step('升级 pip')
        await this.exec(this.settings.venvPython, ['-m', 'pip', 'install', '-U', 'pip'], '升级 pip')
      }
    }
    if (!fs.existsSync(this.settings.requirementsPath)) {
      throw new Error(`缺少依赖清单：${this.settings.requirementsPath}`)
    }
    this.step('安装后端依赖')
    if (uv) {
      await this.exec(uv, ['pip', 'install', '--python', this.settings.venvPython, '-r', this.settings.requirementsPath], '安装依赖')
    } else {
      await this.exec(this.settings.venvPython, ['-m', 'pip', 'install', '-r', this.settings.requirementsPath], '安装依赖')
    }
    this.step('校验运行环境')
    const imports = await probeImports(this.settings.venvPython, 60_000)
    if (!imports.fastapi) {
      throw new Error(`依赖安装完成，但导入 fastapi/uvicorn 失败：${imports.detail || '未知错误'}`)
    }
    this.cache = { at: 0, value: null }
    this.job.state = 'done'
    this.job.done = true
    this.job.finishedAt = Date.now()
    this.step('完成')
    this.appendLog('✅ 环境就绪')
  }

  step(text) {
    if (this.job) this.job.step = text
    this.appendLog(`→ ${text}`)
  }

  appendLog(line) {
    if (!this.job) return
    this.job.log += `${line}\n`
    if (this.job.log.length > LOG_LIMIT) this.job.log = this.job.log.slice(-LOG_LIMIT)
    try {
      fs.appendFileSync(this.settings.setupLogPath, `${line}\n`)
    } catch {}
  }

  exec(command, args, label) {
    return new Promise((resolve, reject) => {
      this.appendLog(`$ ${command} ${args.join(' ')}`)
      const env = {
        ...process.env,
        UV_CACHE_DIR: path.join(this.settings.stateDir, 'uv-cache'),
        PYTHONDONTWRITEBYTECODE: '1'
      }
      const child = spawn(command, args, {
        env,
        cwd: this.settings.backendRoot,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child
      let tail = ''
      const onData = (chunk) => {
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-4000)
        for (const line of text.split('\n')) {
          if (line.trim()) this.appendLog(line)
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('error', (error) => {
        this.child = null
        reject(new Error(`${label}失败：${error?.message || error}`))
      })
      child.once('exit', (code) => {
        this.child = null
        if (this.job?.state === 'cancelled') {
          reject(new Error(`${label}已取消`))
          return
        }
        if (code === 0) resolve()
        else reject(new Error(`${label}失败（退出码 ${code}）：${tail.split('\n').slice(-6).join(' ')}`))
      })
    })
  }

  async findBasePython() {
    const candidates = [
      this.settings.python,
      this.settings.venvPython,
      '/opt/homebrew/bin/python3.13',
      '/opt/homebrew/bin/python3.12',
      '/opt/homebrew/bin/python3.11',
      '/opt/homebrew/bin/python3.10',
      '/usr/local/bin/python3.12',
      '/usr/local/bin/python3.11',
      '/usr/local/bin/python3.10',
      findExecutable('python3.13'),
      findExecutable('python3.12'),
      findExecutable('python3.11'),
      findExecutable('python3.10'),
      findExecutable('python3')
    ].filter(Boolean)
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue
      const version = await pythonVersion(candidate)
      const [major, minor] = version.split('.').map(Number)
      if (major > 3 || (major === 3 && minor >= 10)) return candidate
    }
    return null
  }

  tail(lines = 120) {
    const inMemory = this.job?.log || ''
    return inMemory ? inMemory.split('\n').slice(-lines).join('\n') : readLogTail(this.settings.setupLogPath, lines)
  }
}

export function findExecutable(name) {
  const paths = [
    process.env.PATH || '',
    path.join(os.homedir(), 'bin'),
    path.join(os.homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ].join(':').split(':').filter(Boolean)
  for (const dir of paths) {
    const candidate = path.join(dir, name)
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

export function pythonVersion(python) {
  return new Promise((resolve) => {
    execFile(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { timeout: 10_000 }, (error, stdout) => {
      if (error) resolve('')
      else resolve(String(stdout).trim())
    })
  })
}

export function probeImports(python, timeout = 30_000) {
  const code = [
    'import importlib.util',
    'import fastapi, uvicorn',
    'print("fastapi ok")',
    'print("mlx ok" if importlib.util.find_spec("mlx") else "mlx missing")'
  ].join('\n')
  return new Promise((resolve) => {
    execFile(python, ['-c', code], { timeout }, (error, stdout) => {
      const text = String(stdout || '')
      resolve({
        fastapi: !error && text.includes('fastapi ok'),
        mlx: text.includes('mlx ok'),
        detail: error ? String(error.message || error).slice(0, 300) : text.trim().slice(0, 300)
      })
    })
  })
}
