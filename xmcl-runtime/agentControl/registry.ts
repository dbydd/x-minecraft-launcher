import {
  agentError,
  failure,
  success,
  VirtualPathSchema,
  VfsWriteSchema,
  type CommandResult,
  type Grant,
  type InstanceId,
  type TaskId,
  type WritableRoot,
  asChangeId,
  asContentHash,
  asInstanceId,
  asTaskId,
} from '@xmcl/runtime-api'
import { z } from 'zod'
import type { LauncherPort } from './port'
import { TaskBook } from './tasks'
import {
  grepVirtualFiles,
  listVirtualDirectory,
  readVirtualFile,
  deleteVirtualFile,
  rollbackChange,
  writeVirtualFile,
} from './vfs'

const instanceInput = z.object({ instanceId: z.string().min(1) })

export interface ControlDeps {
  port: LauncherPort
  paired: boolean
  grant: Grant | undefined
  changesRoot: string
  tasks: TaskBook
  signal: AbortSignal
  rememberInstance(id: InstanceId): void
}

export interface AgentCommand {
  name: string
  description: string
  requiresPair: boolean
  inputSchema: Record<string, unknown>
  run(raw: unknown, deps: ControlDeps): Promise<CommandResult<unknown>>
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const stringProp = { type: 'string' }
const instanceProp = { instanceId: stringProp }

function scoped(deps: ControlDeps, instanceId: InstanceId) {
  if (!deps.paired || !deps.grant)
    return agentError('denied', 'Session is not paired', { retryable: false })
  if (!deps.grant.instanceIds.includes(instanceId))
    return agentError('denied', 'Instance is outside the paired scope', { retryable: false })
  const root = deps.port.instanceRoot(instanceId)
  if (!root)
    return agentError('not_found', 'Instance directory is not available', { retryable: false })
  return { root, roots: deps.grant.writableRoots }
}

function unsafePath(raw: unknown) {
  if (!raw || typeof raw !== 'object' || !('path' in raw)) return undefined
  const path = (raw as { path?: unknown }).path
  if (typeof path !== 'string' || VirtualPathSchema.safeParse(path).success) return undefined
  return agentError('denied', 'Invalid virtual path', { retryable: false })
}

function startTask(
  deps: ControlDeps,
  work: (signal: AbortSignal) => Promise<unknown>,
): CommandResult<{ taskId: TaskId }> {
  return success({
    taskId: deps.tasks.start((signal) => work(AbortSignal.any([signal, deps.signal]))),
  })
}

export const agentCommands: readonly AgentCommand[] = [
  {
    name: 'capabilities',
    description:
      'Report pairing state, granted instances, writable roots, and whether this server pushes events.',
    requiresPair: false,
    inputSchema: objectSchema({}),
    async run(_raw, deps) {
      return success({
        protocol: 'xmcl-agent-control/1',
        phase: deps.paired ? 'paired' : 'unpaired',
        pushes: false,
        poll: ['task_status', 'task_cancel'],
        writableRoots: deps.grant?.writableRoots ?? [],
        instanceIds: deps.grant?.instanceIds ?? [],
        allowNewInstances: deps.grant?.allowNewInstances ?? false,
        tools: agentCommands.map((command) => command.name),
      })
    },
  },
  {
    name: 'instances_list',
    description: 'List instances in the paired scope.',
    requiresPair: true,
    inputSchema: objectSchema({}),
    async run(_raw, deps) {
      const all = await deps.port.listInstances()
      const allowed = new Set(deps.grant?.instanceIds ?? [])
      return success({ instances: all.filter((instance) => allowed.has(instance.id)) })
    },
  },
  {
    name: 'instances_create',
    description: 'Create a managed instance and add it to this session scope.',
    requiresPair: true,
    inputSchema: objectSchema({ name: stringProp, minecraft: stringProp }, ['name']),
    async run(raw, deps) {
      const input = z
        .object({ name: z.string().min(1), minecraft: z.string().min(1).optional() })
        .safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'name is required', { retryable: true }))
      if (!deps.grant?.allowNewInstances)
        return failure(
          agentError('denied', 'This session cannot create instances', { retryable: false }),
        )
      const created = await deps.port.createInstance(input.data)
      deps.rememberInstance(created.id)
      return success(created)
    },
  },
  {
    name: 'vfs_list',
    description:
      'List one directory inside a granted writable root. Symlinks are reported and not followed.',
    requiresPair: true,
    inputSchema: objectSchema(
      { ...instanceProp, path: stringProp, offset: { type: 'number' }, limit: { type: 'number' } },
      ['instanceId'],
    ),
    async run(raw, deps) {
      const blocked = unsafePath(raw)
      if (blocked) return failure(blocked)
      const input = instanceInput
        .extend({
          path: z.string().optional(),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'Invalid vfs_list input', { retryable: true }))
      const scope = scoped(deps, asInstanceId(input.data.instanceId))
      if ('code' in scope) return failure(scope)
      const path = input.data.path ? VirtualPathSchema.safeParse(input.data.path) : undefined
      if (path && !path.success)
        return failure(agentError('validation', 'Invalid virtual path', { retryable: true }))
      return listVirtualDirectory(
        {
          instanceRoot: scope.root,
          instanceId: asInstanceId(input.data.instanceId),
          virtualPath: path?.success ? path.data : undefined,
          writableRoots: scope.roots,
          changesRoot: deps.changesRoot,
        },
        input.data.offset,
        input.data.limit,
      )
    },
  },
  {
    name: 'vfs_read',
    description: 'Read a bounded slice of a text file and return its sha256.',
    requiresPair: true,
    inputSchema: objectSchema(
      { ...instanceProp, path: stringProp, offset: { type: 'number' }, limit: { type: 'number' } },
      ['instanceId', 'path'],
    ),
    async run(raw, deps) {
      const blocked = unsafePath(raw)
      if (blocked) return failure(blocked)
      const input = instanceInput
        .extend({
          path: z.string(),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().optional(),
        })
        .safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'Invalid vfs_read input', { retryable: true }))
      const path = VirtualPathSchema.safeParse(input.data.path)
      if (!path.success)
        return failure(agentError('denied', 'Invalid virtual path', { retryable: false }))
      const scope = scoped(deps, asInstanceId(input.data.instanceId))
      if ('code' in scope) return failure(scope)
      return readVirtualFile(
        {
          instanceRoot: scope.root,
          instanceId: asInstanceId(input.data.instanceId),
          virtualPath: path.data,
          writableRoots: scope.roots,
          changesRoot: deps.changesRoot,
        },
        input.data.offset,
        input.data.limit,
      )
    },
  },
  {
    name: 'vfs_grep',
    description: 'Search granted text files with a bounded regular expression.',
    requiresPair: true,
    inputSchema: objectSchema(
      {
        ...instanceProp,
        pattern: stringProp,
        path: stringProp,
        ignoreCase: { type: 'boolean' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      ['instanceId', 'pattern'],
    ),
    async run(raw, deps) {
      const blocked = unsafePath(raw)
      if (blocked) return failure(blocked)
      const input = instanceInput
        .extend({
          pattern: z.string(),
          path: z.string().optional(),
          ignoreCase: z.boolean().optional(),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'Invalid vfs_grep input', { retryable: true }))
      const scope = scoped(deps, asInstanceId(input.data.instanceId))
      if ('code' in scope) return failure(scope)
      const path = input.data.path ? VirtualPathSchema.safeParse(input.data.path) : undefined
      if (path && !path.success)
        return failure(agentError('validation', 'Invalid virtual path', { retryable: true }))
      return grepVirtualFiles({
        instanceRoot: scope.root,
        roots: scope.roots as readonly WritableRoot[],
        pattern: input.data.pattern,
        path: path?.success ? path.data : undefined,
        ignoreCase: input.data.ignoreCase,
        offset: input.data.offset,
        limit: input.data.limit,
      })
    },
  },
  {
    name: 'vfs_write',
    description:
      'Create or edit a text file with expectedHash, literal replacements or full content, then record a changeId.',
    requiresPair: true,
    inputSchema: objectSchema(
      {
        kind: { enum: ['content', 'replacements'] },
        ...instanceProp,
        path: stringProp,
        expectedHash: { type: ['string', 'null'] },
        content: stringProp,
        replacements: { type: 'array' },
        validate: { enum: ['json', 'toml', 'none'] },
      },
      ['kind', 'instanceId', 'path'],
    ),
    async run(raw, deps) {
      const blocked = unsafePath(raw)
      if (blocked) return failure(blocked)
      const parsed = VfsWriteSchema.safeParse(raw)
      if (!parsed.success)
        return failure(agentError('validation', 'Invalid vfs_write input', { retryable: true }))
      const scope = scoped(deps, parsed.data.instanceId)
      if ('code' in scope) return failure(scope)
      const { instanceId, path, ...write } = parsed.data
      return writeVirtualFile(
        {
          instanceRoot: scope.root,
          instanceId,
          virtualPath: path,
          writableRoots: scope.roots,
          changesRoot: deps.changesRoot,
          signal: deps.signal,
        },
        write,
      )
    },
  },
  {
    name: 'vfs_rollback',
    description: 'Restore a file to the bytes recorded for a changeId.',
    requiresPair: true,
    inputSchema: objectSchema({ ...instanceProp, changeId: stringProp }, [
      'instanceId',
      'changeId',
    ]),
    async run(raw, deps) {
      const input = instanceInput.extend({ changeId: z.string().uuid() }).safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'Invalid vfs_rollback input', { retryable: true }))
      const scope = scoped(deps, asInstanceId(input.data.instanceId))
      if ('code' in scope) return failure(scope)
      return rollbackChange({
        instanceRoot: scope.root,
        instanceId: asInstanceId(input.data.instanceId),
        changeId: asChangeId(input.data.changeId),
        changesRoot: deps.changesRoot,
        writableRoots: scope.roots,
      })
    },
  },
  {
    name: 'vfs_delete',
    description: 'Delete one text file inside a granted root when expectedHash still matches.',
    requiresPair: true,
    inputSchema: objectSchema({ ...instanceProp, path: stringProp, expectedHash: stringProp }, [
      'instanceId',
      'path',
      'expectedHash',
    ]),
    async run(raw, deps) {
      const blocked = unsafePath(raw)
      if (blocked) return failure(blocked)
      const input = instanceInput
        .extend({ path: z.string(), expectedHash: z.string() })
        .safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'Invalid vfs_delete input', { retryable: true }))
      const path = VirtualPathSchema.safeParse(input.data.path)
      if (!path.success)
        return failure(agentError('denied', 'Invalid virtual path', { retryable: false }))
      const scope = scoped(deps, asInstanceId(input.data.instanceId))
      if ('code' in scope) return failure(scope)
      return deleteVirtualFile(
        {
          instanceRoot: scope.root,
          instanceId: asInstanceId(input.data.instanceId),
          virtualPath: path.data,
          writableRoots: scope.roots,
          changesRoot: deps.changesRoot,
          signal: deps.signal,
        },
        asContentHash(input.data.expectedHash),
      )
    },
  },
  {
    name: 'install_stage',
    description:
      'Stage one market ref through the launcher mod.install command. Nothing is copied until install_apply.',
    requiresPair: true,
    inputSchema: objectSchema({ ...instanceProp, ref: stringProp }, ['instanceId', 'ref']),
    async run(raw, deps) {
      const input = instanceInput.extend({ ref: z.string().min(1) }).safeParse(raw)
      if (!input.success)
        return failure(
          agentError('validation', 'install_stage requires instanceId and ref', {
            retryable: true,
          }),
        )
      const scope = scoped(deps, asInstanceId(input.data.instanceId))
      if ('code' in scope) return failure(scope)
      return success(
        await deps.port.stageMarket({
          instanceId: asInstanceId(input.data.instanceId),
          ref: input.data.ref,
        }),
      )
    },
  },
  {
    name: 'install_status',
    description: 'Read the pending install manifest.',
    requiresPair: true,
    inputSchema: objectSchema(instanceProp, ['instanceId']),
    async run(raw, deps) {
      const input = instanceInput.safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'instanceId is required', { retryable: true }))
      const scope = scoped(deps, asInstanceId(input.data.instanceId))
      if ('code' in scope) return failure(scope)
      return success(await deps.port.installStatus(asInstanceId(input.data.instanceId)))
    },
  },
  {
    name: 'install_apply',
    description: 'Apply the pending install manifest. Returns a taskId immediately.',
    requiresPair: true,
    inputSchema: objectSchema(instanceProp, ['instanceId']),
    async run(raw, deps) {
      const input = instanceInput.safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'instanceId is required', { retryable: true }))
      const id = asInstanceId(input.data.instanceId)
      const scope = scoped(deps, id)
      if ('code' in scope) return failure(scope)
      return startTask(deps, (signal) => deps.port.applyInstall(id, signal))
    },
  },
  {
    name: 'import_modpack',
    description: 'Import a local modpack archive into a new instance. Returns a taskId.',
    requiresPair: true,
    inputSchema: objectSchema({ path: stringProp }, ['path']),
    async run(raw, deps) {
      const input = z.object({ path: z.string().min(1) }).safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'path is required', { retryable: true }))
      if (!deps.grant?.allowNewInstances)
        return failure(
          agentError('denied', 'This session cannot import instances', { retryable: false }),
        )
      return startTask(deps, async (signal) => {
        const imported = await deps.port.importModpack(input.data.path, signal)
        deps.rememberInstance(imported.instanceId)
        return imported
      })
    },
  },
  {
    name: 'runtime_install',
    description: 'Install the instance Minecraft runtime. Returns a taskId.',
    requiresPair: true,
    inputSchema: objectSchema(instanceProp, ['instanceId']),
    async run(raw, deps) {
      const input = instanceInput.safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'instanceId is required', { retryable: true }))
      const id = asInstanceId(input.data.instanceId)
      const scope = scoped(deps, id)
      if ('code' in scope) return failure(scope)
      return startTask(deps, (signal) => deps.port.installRuntime(id, signal))
    },
  },
  {
    name: 'launch',
    description:
      'Launch the instance with the launcher-selected account. Returns a taskId. The account token is not returned.',
    requiresPair: true,
    inputSchema: objectSchema(instanceProp, ['instanceId']),
    async run(raw, deps) {
      const input = instanceInput.safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'instanceId is required', { retryable: true }))
      const id = asInstanceId(input.data.instanceId)
      const scope = scoped(deps, id)
      if ('code' in scope) return failure(scope)
      return startTask(deps, (signal) => deps.port.launch(id, signal))
    },
  },
  {
    name: 'processes_list',
    description: 'List Minecraft processes started for one instance.',
    requiresPair: true,
    inputSchema: objectSchema(instanceProp, ['instanceId']),
    async run(raw, deps) {
      const input = instanceInput.safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'instanceId is required', { retryable: true }))
      const id = asInstanceId(input.data.instanceId)
      const scope = scoped(deps, id)
      if ('code' in scope) return failure(scope)
      return success({ processes: await deps.port.listProcesses(id) })
    },
  },
  {
    name: 'process_stop',
    description: 'Stop one Minecraft process for this instance.',
    requiresPair: true,
    inputSchema: objectSchema(
      { ...instanceProp, pid: { type: 'number' }, force: { type: 'boolean' } },
      ['instanceId', 'pid'],
    ),
    async run(raw, deps) {
      const input = instanceInput
        .extend({ pid: z.number().int().positive(), force: z.boolean().optional() })
        .safeParse(raw)
      if (!input.success)
        return failure(
          agentError('validation', 'instanceId and pid are required', { retryable: true }),
        )
      const id = asInstanceId(input.data.instanceId)
      const scope = scoped(deps, id)
      if ('code' in scope) return failure(scope)
      await deps.port.stopProcess(id, input.data.pid, input.data.force)
      return success({ stopped: input.data.pid })
    },
  },
  {
    name: 'logs_read',
    description:
      'Read a bounded tail of one instance log file. This is launcher output, not in-game control.',
    requiresPair: true,
    inputSchema: objectSchema(
      { ...instanceProp, name: stringProp, tailLines: { type: 'number' } },
      ['instanceId', 'name'],
    ),
    async run(raw, deps) {
      const input = instanceInput
        .extend({
          name: z.string().min(1),
          tailLines: z.number().int().positive().max(2000).optional(),
        })
        .safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'Invalid logs_read input', { retryable: true }))
      if (
        input.data.name.includes('/') ||
        input.data.name.includes('\\') ||
        input.data.name.includes('..')
      ) {
        return failure(
          agentError('denied', 'Log name must be a single file name', { retryable: false }),
        )
      }
      const id = asInstanceId(input.data.instanceId)
      const scope = scoped(deps, id)
      if ('code' in scope) return failure(scope)
      const content = await deps.port.readLog(id, input.data.name)
      const tailLines = input.data.tailLines ?? 200
      const lines = content.split('\n')
      const sliced = lines.slice(-tailLines)
      return success({
        name: input.data.name,
        lines: sliced,
        truncated: lines.length > sliced.length,
        returned: sliced.length,
      })
    },
  },
  {
    name: 'task_status',
    description: 'Poll a task started by this session.',
    requiresPair: true,
    inputSchema: objectSchema({ taskId: stringProp }, ['taskId']),
    async run(raw, deps) {
      const input = z.object({ taskId: z.string().uuid() }).safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'taskId is required', { retryable: true }))
      const view = deps.tasks.poll(asTaskId(input.data.taskId))
      if (!view) return failure(agentError('not_found', 'Task not found', { retryable: false }))
      return success(view)
    },
  },
  {
    name: 'task_cancel',
    description: 'Cancel a task by aborting its AbortController.',
    requiresPair: true,
    inputSchema: objectSchema({ taskId: stringProp }, ['taskId']),
    async run(raw, deps) {
      const input = z.object({ taskId: z.string().uuid() }).safeParse(raw)
      if (!input.success)
        return failure(agentError('validation', 'taskId is required', { retryable: true }))
      const view = deps.tasks.cancel(asTaskId(input.data.taskId))
      if (!view) return failure(agentError('not_found', 'Task not found', { retryable: false }))
      return success(view)
    },
  },
  {
    name: 'session_revoke',
    description: 'Revoke this paired session.',
    requiresPair: true,
    inputSchema: objectSchema({}),
    async run() {
      return success({ revoke: true })
    },
  },
]

export function commandByName(name: string) {
  return agentCommands.find((command) => command.name === name)
}
