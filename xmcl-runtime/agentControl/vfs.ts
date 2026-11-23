import { createHash, randomUUID } from 'node:crypto'
import {
  open,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import {
  agentError,
  asChangeId,
  asContentHash,
  failure,
  success,
  type AgentControlError,
  type ChangeId,
  type CommandResult,
  type ContentHash,
  type InstanceId,
  type VirtualPath,
  type VfsWrite,
  type WritableRoot,
  FORBIDDEN_INSTANCE_SEGMENTS,
} from '@xmcl/runtime-api'

const MAX_BYTES = 512 * 1024
const MAX_READ_BYTES = 2 * 1024 * 1024
const SNIPPET = 240

export interface VfsContext {
  instanceRoot: string
  instanceId: InstanceId
  virtualPath: VirtualPath
  writableRoots: readonly WritableRoot[]
  changesRoot: string
  forbiddenRoots?: readonly string[]
}

export interface ChangeRecord {
  id: ChangeId
  instanceId: InstanceId
  path: VirtualPath
  previous: string | null
  /** Hash after the write. Null means the write deleted the file. */
  afterHash: ContentHash | null
  createdAt: number
}

function hashText(content: string): ContentHash {
  return asContentHash(`sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`)
}

function inside(parent: string, child: string) {
  const root = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(root)
}

function denied(message: string): AgentControlError {
  return agentError('denied', message, { retryable: false })
}

function validation(message: string): AgentControlError {
  return agentError('validation', message, { retryable: true })
}

async function resolveInstance(root: string) {
  const stat = await lstat(root).catch(() => undefined)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return undefined
  return realpath(root)
}

function topSegment(virtualPath: string) {
  return virtualPath.split('/')[0] ?? ''
}

function rootAllowed(virtualPath: string, roots: readonly string[]) {
  const top = topSegment(virtualPath)
  return roots.includes(top)
}

async function inspectPath(
  instanceRoot: string,
  virtualPath: string,
  intent: 'read' | 'list' | 'write',
) {
  if (virtualPath.startsWith('/') || virtualPath.includes('\\') || virtualPath.includes('\0')) {
    return { error: denied('Absolute paths and backslashes are not virtual paths') }
  }
  const parts = virtualPath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return { error: denied('Virtual paths cannot contain ., .., or empty segments') }
  }
  let current = instanceRoot
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    if ((FORBIDDEN_INSTANCE_SEGMENTS as readonly string[]).includes(part)) {
      return { error: denied(`Path segment '${part}' is a shared launcher directory`) }
    }
    if (
      part.includes(':') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part) ||
      part.endsWith('.') ||
      part.endsWith(' ')
    ) {
      return { error: denied(`Path segment '${part}' is not a portable virtual name`) }
    }
    current = join(current, part)
    const last = index === parts.length - 1
    const stat = await lstat(current).catch(() => undefined)
    if (!stat) {
      if (intent !== 'write') {
        return {
          error: agentError('not_found', `Path not found: ${parts.slice(0, index + 1).join('/')}`, {
            retryable: false,
          }),
        }
      }
      if (!last) {
        const parentStat = await lstat(dirname(current))
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
          return { error: denied('Refusing to create a directory through a symlink') }
        }
        await mkdir(current)
        continue
      }
      return { target: current, exists: false as const, parent: dirname(current) }
    }
    if (stat.isSymbolicLink()) {
      return {
        error: denied(`Refusing to follow symlink at ${parts.slice(0, index + 1).join('/')}`),
      }
    }
    if (!last) {
      if (!stat.isDirectory())
        return { error: denied(`Not a directory: ${parts.slice(0, index + 1).join('/')}`) }
      continue
    }
    if (intent === 'list') {
      if (!stat.isDirectory()) return { error: denied('Not a directory') }
      return {
        target: current,
        exists: true as const,
        parent: dirname(current),
        kind: 'directory' as const,
      }
    }
    if (!stat.isFile()) return { error: denied('Writable targets must be regular files') }
    return {
      target: current,
      exists: true as const,
      parent: dirname(current),
      nlink: stat.nlink,
      kind: 'file' as const,
    }
  }
  return { error: denied('A file path is required') }
}

async function guardParent(
  instanceRoot: string,
  parent: string,
  forbiddenRoots: readonly string[],
) {
  const instanceReal = await resolveInstance(instanceRoot)
  if (!instanceReal) return denied('Instance directory is missing or is a symlink')
  const parentStat = await lstat(parent).catch(() => undefined)
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return agentError('not_found', 'Parent directory does not exist', { retryable: false })
  }
  const parentReal = await realpath(parent)
  if (!inside(instanceReal, parentReal))
    return denied('Resolved path escapes the instance directory')
  for (const root of forbiddenRoots) {
    const forbidden = await realpath(root).catch(() => root)
    if (inside(forbidden, parentReal) || parentReal === forbidden) {
      return denied('Resolved path lands in a shared cache or runtime directory')
    }
  }
  for (const segment of FORBIDDEN_INSTANCE_SEGMENTS) {
    if (inside(join(instanceReal, segment), parentReal)) {
      return denied(`Resolved path lands in ${segment}`)
    }
  }
  return undefined
}

function applyReplacements(
  current: string,
  replacements: Array<{ match: string; replace: string; all?: boolean }>,
) {
  let next = current
  for (const [index, replacement] of replacements.entries()) {
    if (!replacement.match)
      return { error: validation(`replacement ${index + 1} match must not be empty`) }
    if (!next.includes(replacement.match))
      return { error: validation(`replacement ${index + 1} match was not found`) }
    next = replacement.all
      ? next.split(replacement.match).join(replacement.replace)
      : next.replace(replacement.match, replacement.replace)
  }
  return { content: next }
}

function validateContent(
  virtualPath: string,
  content: string,
  mode: 'json' | 'toml' | 'none' | undefined,
) {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (content.includes('\0')) return validation('Binary content is not supported')
  if (bytes > MAX_BYTES)
    return agentError('too_large', `Content exceeds ${MAX_BYTES} bytes`, { retryable: false })
  const selected =
    mode ??
    (virtualPath.endsWith('.json') ? 'json' : virtualPath.endsWith('.toml') ? 'toml' : 'none')
  if (selected === 'json') {
    try {
      JSON.parse(content)
    } catch (error) {
      return validation(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (selected === 'toml') {
    try {
      parseToml(content)
    } catch (error) {
      return validation(`Invalid TOML: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return undefined
}

type LoadedFile = { content: string; nlink: number; hash: ContentHash }

function isLoadedFile(
  value: { error: AgentControlError } | LoadedFile | undefined,
): value is LoadedFile {
  return !!value && 'content' in value
}

async function readChecked(target: string): Promise<{ error: AgentControlError } | LoadedFile> {
  const stat = await lstat(target)
  if (stat.isSymbolicLink() || !stat.isFile())
    return { error: denied('Refusing to read through a symlink or non-file') }
  if (stat.size > MAX_READ_BYTES)
    return {
      error: agentError('too_large', `File exceeds ${MAX_READ_BYTES} bytes`, { retryable: false }),
    }
  const content = await readFile(target, 'utf8')
  return { content, nlink: stat.nlink, hash: hashText(content) }
}

export async function readVirtualFile(
  ctx: VfsContext,
  offset = 0,
  limit = MAX_BYTES,
): Promise<
  CommandResult<{
    path: VirtualPath
    hash: ContentHash
    offset: number
    content: string
    truncated: boolean
    bytes: number
  }>
> {
  if (!rootAllowed(ctx.virtualPath, ctx.writableRoots))
    return failure(denied(`Path is outside the granted writable roots: ${ctx.virtualPath}`))
  const walked = await inspectPath(ctx.instanceRoot, ctx.virtualPath, 'read')
  if ('error' in walked && walked.error) return failure(walked.error)
  if (!('exists' in walked) || !walked.exists)
    return failure(
      agentError('not_found', `File not found: ${ctx.virtualPath}`, { retryable: false }),
    )
  const guard = await guardParent(ctx.instanceRoot, walked.parent, ctx.forbiddenRoots ?? [])
  if (guard) return failure(guard)
  const loaded = await readChecked(walked.target)
  if ('error' in loaded && loaded.error) return failure(loaded.error)
  if (!('content' in loaded))
    return failure(agentError('unavailable', 'Unable to read file', { retryable: true }))
  const start = Math.max(0, offset)
  const slice = loaded.content.slice(start, start + Math.max(1, limit))
  return success({
    path: ctx.virtualPath,
    hash: loaded.hash,
    offset: start,
    content: slice,
    truncated: start + slice.length < loaded.content.length,
    bytes: Buffer.byteLength(loaded.content, 'utf8'),
  })
}

export async function listVirtualDirectory(
  ctx: Omit<VfsContext, 'virtualPath'> & { virtualPath?: VirtualPath },
  offset = 0,
  limit = 50,
): Promise<
  CommandResult<{
    path: string
    total: number
    offset: number
    entries: Array<{ name: string; type: 'file' | 'directory' | 'symlink' }>
  }>
> {
  const relative = ctx.virtualPath ?? ''
  if (relative && !rootAllowed(relative, ctx.writableRoots))
    return failure(denied(`Path is outside the granted writable roots: ${relative}`))
  const target = relative ? join(ctx.instanceRoot, relative) : ctx.instanceRoot
  if (relative) {
    const walked = await inspectPath(ctx.instanceRoot, relative, 'list')
    if ('error' in walked && walked.error) return failure(walked.error)
  }
  const stat = await lstat(target).catch(() => undefined)
  if (!stat)
    return failure(
      agentError('not_found', `Directory not found: ${relative || '.'}`, { retryable: false }),
    )
  if (stat.isSymbolicLink()) return failure(denied('Refusing to list through a symlink'))
  if (!stat.isDirectory()) return failure(denied('Not a directory'))
  const guard = await guardParent(
    ctx.instanceRoot,
    relative ? dirname(target) : ctx.instanceRoot,
    ctx.forbiddenRoots ?? [],
  )
  if (relative && guard) return failure(guard)
  const entries = await readdir(target, { withFileTypes: true })
  const visible = entries
    .filter((entry) => !(FORBIDDEN_INSTANCE_SEGMENTS as readonly string[]).includes(entry.name))
    .filter((entry) => entry.name !== '.agent-control')
    .map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink()
        ? ('symlink' as const)
        : entry.isDirectory()
          ? ('directory' as const)
          : ('file' as const),
    }))
  const start = Math.max(0, offset)
  return success({
    path: relative || '.',
    total: visible.length,
    offset: start,
    entries: visible.slice(start, start + Math.max(1, Math.min(limit, 200))),
  })
}

export async function grepVirtualFiles(input: {
  instanceRoot: string
  roots: readonly WritableRoot[]
  pattern: string
  path?: VirtualPath
  ignoreCase?: boolean
  offset?: number
  limit?: number
  forbiddenRoots?: readonly string[]
}): Promise<
  CommandResult<{
    matches: Array<{ file: string; line: number; text: string }>
    offset: number
    limit: number
    hasMore: boolean
  }>
> {
  if (!input.pattern || input.pattern.length > 200)
    return failure(validation('pattern must be 1-200 characters'))
  let expression: RegExp
  try {
    expression = new RegExp(input.pattern, input.ignoreCase ? 'i' : '')
  } catch (error) {
    return failure(
      validation(
        `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
  const scope = input.path
  if (scope && !rootAllowed(scope, input.roots))
    return failure(denied(`Path is outside the granted writable roots: ${scope}`))
  const matches: Array<{ file: string; line: number; text: string }> = []
  const offset = input.offset ?? 0
  const limit = Math.min(input.limit ?? 50, 200)
  let seen = 0
  const roots = scope ? [scope] : [...input.roots]
  for (const root of roots) {
    const files = await collectFiles(input.instanceRoot, root)
    for (const file of files) {
      const loaded = await readChecked(join(input.instanceRoot, file)).catch(() => undefined)
      if (!isLoadedFile(loaded)) continue
      if (Buffer.byteLength(loaded.content, 'utf8') > MAX_BYTES) continue
      for (const [index, line] of loaded.content.split('\n').entries()) {
        expression.lastIndex = 0
        const match = expression.exec(line)
        if (!match) continue
        if (seen >= offset && matches.length < limit) {
          matches.push({
            file,
            line: index + 1,
            text: line.slice(Math.max(0, match.index - 40), match.index + 160),
          })
        }
        seen++
        if (seen > offset + limit) return success({ matches, offset, limit, hasMore: true })
      }
    }
  }
  return success({ matches, offset, limit, hasMore: false })
}

async function collectFiles(instanceRoot: string, relative: string): Promise<string[]> {
  const target = join(instanceRoot, relative)
  const stat = await lstat(target).catch(() => undefined)
  if (!stat || stat.isSymbolicLink()) return []
  if (stat.isFile()) return [relative]
  if (!stat.isDirectory()) return []
  const found: string[] = []
  const entries = await readdir(target, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await collectFiles(instanceRoot, child)))
    else if (entry.isFile()) found.push(child)
  }
  return found
}

const pathLocks = new Map<string, Promise<void>>()

function withPathLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(key) ?? Promise.resolve()
  const runOnce = previous.catch(() => undefined).then(run)
  pathLocks.set(
    key,
    runOnce.then(
      () => undefined,
      () => undefined,
    ),
  )
  return runOnce
}

async function persistRecord(changesRoot: string, record: ChangeRecord) {
  await mkdir(changesRoot, { recursive: true })
  const recordPath = join(changesRoot, `${record.id}.json`)
  await writeFile(recordPath, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  return recordPath
}

async function commitNewFile(
  target: string,
  next: string,
  record: ChangeRecord,
  changesRoot: string,
): Promise<CommandResult<{ hash: ContentHash }>> {
  const temp = `${target}.${randomUUID()}.tmp`
  let recordPath: string | undefined
  try {
    await writeFile(temp, next, { flag: 'wx' })
    const handle = await open(temp, 'r+')
    await handle.sync()
    await handle.close()
    recordPath = await persistRecord(changesRoot, record)
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    if (recordPath) await rm(recordPath, { force: true })
    return failure(
      agentError('unavailable', error instanceof Error ? error.message : String(error), {
        retryable: true,
      }),
    )
  }
  const written = await readChecked(target)
  if (!isLoadedFile(written) || written.content !== next) {
    return failure(agentError('unavailable', 'Write verification failed', { retryable: true }))
  }
  return success({ hash: written.hash })
}

async function writeVirtualFileBody(
  ctx: VfsContext,
  write: VfsWrite,
): Promise<
  CommandResult<{
    path: VirtualPath
    changeId: ChangeId
    hash: ContentHash
    brokeLink: boolean
    created: boolean
  }>
> {
  if (!rootAllowed(ctx.virtualPath, ctx.writableRoots))
    return failure(denied(`Path is outside the granted writable roots: ${ctx.virtualPath}`))
  if (ctx.virtualPath.split('/').includes('.agent-control'))
    return failure(denied('Refusing to write the agent control directory'))
  const walked = await inspectPath(ctx.instanceRoot, ctx.virtualPath, 'write')
  if ('error' in walked && walked.error) return failure(walked.error)
  if (!('target' in walked)) return failure(denied('Unable to resolve path'))
  const guard = await guardParent(ctx.instanceRoot, walked.parent, ctx.forbiddenRoots ?? [])
  if (guard) return failure(guard)

  let previous: string | null = null
  let currentHash: ContentHash | null = null
  if (walked.exists) {
    const loaded = await readChecked(walked.target)
    if ('error' in loaded && loaded.error) return failure(loaded.error)
    if (!('content' in loaded))
      return failure(agentError('unavailable', 'Unable to read file', { retryable: true }))
    previous = loaded.content
    currentHash = loaded.hash
    if (write.expectedHash === null) {
      return failure(
        agentError('conflict', 'File already exists', {
          currentHash: loaded.hash,
          snippet: loaded.content.slice(0, SNIPPET),
          retry: {
            tool: 'vfs_read',
            arguments: { instanceId: ctx.instanceId, path: ctx.virtualPath },
          },
        }),
      )
    }
    if (loaded.hash !== write.expectedHash) {
      return failure(
        agentError('conflict', 'expectedHash does not match the current file', {
          currentHash: loaded.hash,
          snippet: loaded.content.slice(0, SNIPPET),
          retry: {
            tool: 'vfs_read',
            arguments: { instanceId: ctx.instanceId, path: ctx.virtualPath },
          },
        }),
      )
    }
  } else if (write.kind === 'replacements' || write.expectedHash !== null) {
    return failure(
      agentError('not_found', `File not found: ${ctx.virtualPath}`, {
        retryable: false,
        retry: {
          tool: 'vfs_write',
          arguments: {
            instanceId: ctx.instanceId,
            path: ctx.virtualPath,
            kind: 'content',
            expectedHash: null,
          },
        },
      }),
    )
  }

  let next = ''
  if (write.kind === 'content') next = write.content
  else {
    const applied = applyReplacements(previous ?? '', write.replacements)
    if ('error' in applied && applied.error) return failure(applied.error)
    if (!('content' in applied) || applied.content === undefined)
      return failure(validation('No replacement produced content'))
    next = applied.content
  }
  const invalid = validateContent(ctx.virtualPath, next, write.validate)
  if (invalid) return failure(invalid)
  if (previous !== null && next === previous) {
    return failure(validation('No changes to write'))
  }

  const latest = walked.exists ? await readChecked(walked.target) : undefined
  if (isLoadedFile(latest) && currentHash && latest.hash !== currentHash) {
    return failure(
      agentError('conflict', 'File changed while preparing the write', {
        currentHash: latest.hash,
        snippet: latest.content.slice(0, SNIPPET),
        retry: {
          tool: 'vfs_read',
          arguments: { instanceId: ctx.instanceId, path: ctx.virtualPath },
        },
      }),
    )
  }
  const brokeLink = isLoadedFile(latest) && latest.nlink > 1
  const changeId = asChangeId(randomUUID())
  const afterHash = hashText(next)
  const record: ChangeRecord = {
    id: changeId,
    instanceId: ctx.instanceId,
    path: ctx.virtualPath,
    previous,
    afterHash,
    createdAt: Date.now(),
  }
  const committed = await commitNewFile(walked.target, next, record, ctx.changesRoot)
  if (!committed.ok) return committed
  const finalReal = await realpath(walked.target)
  const instanceReal = await realpath(ctx.instanceRoot)
  if (!inside(instanceReal, finalReal)) {
    return failure(denied('Write resolved outside the instance directory'))
  }
  return success({
    path: ctx.virtualPath,
    changeId,
    hash: afterHash,
    brokeLink,
    created: previous === null,
  })
}

export function writeVirtualFile(ctx: VfsContext, write: VfsWrite) {
  return withPathLock(`${ctx.instanceRoot}\0${ctx.virtualPath}`, () =>
    writeVirtualFileBody(ctx, write),
  )
}

const changeRecordSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().min(1),
  path: z.string().min(1),
  previous: z.string().nullable(),
  afterHash: z.string().nullable(),
  createdAt: z.number(),
})

function postimageConflict(
  currentHash: ContentHash | null,
  snippet: string,
  instanceId: InstanceId,
  path: VirtualPath,
) {
  return agentError('conflict', 'The file no longer matches this change', {
    ...(currentHash ? { currentHash } : {}),
    snippet,
    retry: { tool: 'vfs_read', arguments: { instanceId, path } },
  })
}

async function rollbackChangeBody(input: {
  instanceRoot: string
  instanceId: InstanceId
  changeId: ChangeId
  changesRoot: string
  writableRoots: readonly WritableRoot[]
  forbiddenRoots?: readonly string[]
}): Promise<CommandResult<{ changeId: ChangeId; path: VirtualPath; hash: ContentHash | null }>> {
  const raw = await readFile(join(input.changesRoot, `${input.changeId}.json`), 'utf8').catch(
    () => undefined,
  )
  if (!raw)
    return failure(
      agentError('not_found', `Change not found: ${input.changeId}`, { retryable: false }),
    )
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return failure(agentError('validation', 'Change record is unreadable', { retryable: false }))
  }
  const parsed = changeRecordSchema.safeParse(json)
  if (!parsed.success)
    return failure(agentError('validation', 'Change record is unreadable', { retryable: false }))
  if (parsed.data.instanceId !== input.instanceId)
    return failure(denied('Change belongs to a different instance'))
  const path = parsed.data.path as VirtualPath
  if (!rootAllowed(path, input.writableRoots))
    return failure(denied('Change path is outside the granted roots'))
  const base = {
    instanceRoot: input.instanceRoot,
    instanceId: input.instanceId,
    virtualPath: path,
    writableRoots: input.writableRoots,
    changesRoot: input.changesRoot,
    forbiddenRoots: input.forbiddenRoots,
  }
  if (parsed.data.afterHash === null) {
    const present = await inspectPath(input.instanceRoot, path, 'read')
    if (!('error' in present) || !present.error)
      return failure(postimageConflict(null, 'file still exists', input.instanceId, path))
    if (present.error.code !== 'not_found') return failure(present.error)
    if (parsed.data.previous === null)
      return failure(
        agentError('validation', 'Change has no bytes to restore', { retryable: false }),
      )
    const restored = await writeVirtualFileBody(base, {
      kind: 'content',
      expectedHash: null,
      content: parsed.data.previous,
      validate: 'none',
    })
    if (!restored.ok) return restored
    return success({ changeId: input.changeId, path, hash: restored.data.hash })
  }
  const walked = await inspectPath(input.instanceRoot, path, 'read')
  if ('error' in walked) {
    if (!walked.error)
      return failure(agentError('unavailable', 'Unable to resolve path', { retryable: true }))
    return failure(
      walked.error.code === 'not_found'
        ? postimageConflict(null, 'file is gone', input.instanceId, path)
        : walked.error,
    )
  }
  const guard = await guardParent(input.instanceRoot, walked.parent, input.forbiddenRoots ?? [])
  if (guard) return failure(guard)
  const loaded = await readChecked(walked.target)
  if (!isLoadedFile(loaded))
    return failure(
      'error' in loaded
        ? loaded.error
        : agentError('unavailable', 'Unable to read file', { retryable: true }),
    )
  if (loaded.hash !== parsed.data.afterHash)
    return failure(
      postimageConflict(loaded.hash, loaded.content.slice(0, SNIPPET), input.instanceId, path),
    )
  if (parsed.data.previous === null) {
    await unlink(walked.target)
    return success({ changeId: input.changeId, path, hash: null })
  }
  const restored = await writeVirtualFileBody(base, {
    kind: 'content',
    expectedHash: loaded.hash as ContentHash,
    content: parsed.data.previous,
    validate: 'none',
  })
  if (!restored.ok) return restored
  return success({ changeId: input.changeId, path, hash: restored.data.hash })
}

export function rollbackChange(input: {
  instanceRoot: string
  instanceId: InstanceId
  changeId: ChangeId
  changesRoot: string
  writableRoots: readonly WritableRoot[]
  forbiddenRoots?: readonly string[]
}) {
  return withPathLock(`change:${input.changeId}`, async () => {
    const peek = await readFile(join(input.changesRoot, `${input.changeId}.json`), 'utf8').catch(
      () => undefined,
    )
    let path: string | undefined
    try {
      path = peek ? (JSON.parse(peek) as { path?: string }).path : undefined
    } catch {
      path = undefined
    }
    if (!path) return rollbackChangeBody(input)
    return withPathLock(`${input.instanceRoot}\0${path}`, () => rollbackChangeBody(input))
  })
}

export function deleteVirtualFile(
  ctx: VfsContext,
  expectedHash: ContentHash,
): Promise<CommandResult<{ path: VirtualPath; changeId: ChangeId }>> {
  return withPathLock(`${ctx.instanceRoot}\0${ctx.virtualPath}`, async () => {
    if (!rootAllowed(ctx.virtualPath, ctx.writableRoots))
      return failure(denied(`Path is outside the granted writable roots: ${ctx.virtualPath}`))
    const walked = await inspectPath(ctx.instanceRoot, ctx.virtualPath, 'read')
    if ('error' in walked && walked.error) return failure(walked.error)
    if (!('target' in walked))
      return failure(
        agentError('not_found', `File not found: ${ctx.virtualPath}`, { retryable: false }),
      )
    const guard = await guardParent(ctx.instanceRoot, walked.parent, ctx.forbiddenRoots ?? [])
    if (guard) return failure(guard)
    const loaded = await readChecked(walked.target)
    if (!isLoadedFile(loaded))
      return failure(
        'error' in loaded
          ? loaded.error
          : agentError('unavailable', 'Unable to read file', { retryable: true }),
      )
    if (loaded.hash !== expectedHash) {
      return failure(
        agentError('conflict', 'expectedHash does not match the current file', {
          currentHash: loaded.hash,
          snippet: loaded.content.slice(0, SNIPPET),
          retry: {
            tool: 'vfs_read',
            arguments: { instanceId: ctx.instanceId, path: ctx.virtualPath },
          },
        }),
      )
    }
    const changeId = asChangeId(randomUUID())
    let recordPath: string | undefined
    try {
      recordPath = await persistRecord(ctx.changesRoot, {
        id: changeId,
        instanceId: ctx.instanceId,
        path: ctx.virtualPath,
        previous: loaded.content,
        afterHash: null,
        createdAt: Date.now(),
      })
      await unlink(walked.target)
    } catch (error) {
      if (recordPath) await rm(recordPath, { force: true })
      return failure(
        agentError('unavailable', error instanceof Error ? error.message : String(error), {
          retryable: true,
        }),
      )
    }
    return success({ path: ctx.virtualPath, changeId })
  })
}

export { hashText }
