import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './config.js'

/**
 * The workspace registry is a peer package, not a hard dependency: the client
 * plugin must keep working on deployments without it, so it is resolved lazily
 * and its absence becomes an actionable message instead of a crash.
 */
export function registryOf(ctx) {
  const registry = ctx?.get?.('workspaceRegistry')
  if (!registry || typeof registry.list !== 'function' || typeof registry.create !== 'function') {
    return null
  }
  return registry
}

/** Title for a newly registered directory; a library folder named "data" is unhelpful. */
export function workspaceTitle(dir) {
  const base = path.basename(path.resolve(dir))
  if (!base || base === path.sep || base === 'data') return '会摘资料'
  return base
}

function canonical(dir) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

function describe(workspace) {
  return {
    id: String(workspace.id),
    title: workspace.title,
    path: workspace.path
  }
}

export function workspaceAt(registry, dir) {
  const target = canonical(dir)
  let workspaces
  try {
    workspaces = registry.list()
  } catch {
    return null
  }
  for (const workspace of workspaces || []) {
    if (canonical(workspace.path) === target) return describe(workspace)
  }
  return null
}

export async function workspaceStatus(ctx, dir) {
  const registry = registryOf(ctx)
  if (!registry) return { available: false, workspace: null }
  return { available: true, workspace: workspaceAt(registry, dir) }
}

/**
 * Register the storage directory as a DSH workspace. `create` is idempotent per
 * canonical path, so repeating this on every setup completion adds nothing twice.
 */
export async function ensureWorkspace(ctx, dir, title) {
  const target = path.resolve(dir)
  const registry = registryOf(ctx)
  if (!registry) {
    const error = new Error(`当前 DSH 不支持从会摘创建工作区，请在左侧栏手动添加 ${target}`)
    error.status = 501
    error.code = 'workspace_unavailable'
    throw error
  }
  ensureDir(target)
  const existing = workspaceAt(registry, target)
  const workspace = await registry.create(target, title || workspaceTitle(target))
  return {
    created: !existing,
    workspace: describe(workspace)
  }
}
