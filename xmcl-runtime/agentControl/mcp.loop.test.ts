import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import { AGENT_CONTROL_DENYLIST, asInstanceId, type InstanceId } from '@xmcl/runtime-api'
import { startAgentControlHttp } from './mcpHttp'
import type { LauncherPort } from './port'
import { AgentControlHost } from './session'
import { serveAgentControlStdio } from './stdio'

class FixturePort implements LauncherPort {
  launchDelay = 0
  readonly instances = new Map<string, string>()
  readonly staged = new Map<string, string[]>()
  readonly processes = new Map<string, Array<{ pid: number; side: string; ready: boolean }>>()
  readonly sentinel = 'sentinel-token'

  constructor(readonly directory: string) {}

  async listInstances() {
    return [...this.instances].map(([id, name]) => ({ id: asInstanceId(id), name }))
  }

  instanceRoot(id: InstanceId) {
    return this.instances.has(id) ? id : undefined
  }

  async createInstance(input: { name: string }) {
    const path = await mkdtemp(join(this.directory, 'instance-'))
    for (const folder of [
      'config',
      'kubejs/server_scripts',
      'defaultconfigs',
      'scripts',
      'mods',
      'logs',
    ]) {
      await mkdir(join(path, folder), { recursive: true })
    }
    this.instances.set(path, input.name)
    return { id: asInstanceId(path), name: input.name }
  }

  async stageMarket(input: { instanceId: InstanceId }) {
    const files = ['mods/example.jar']
    this.staged.set(input.instanceId, files)
    return { files }
  }

  async installStatus(instanceId: InstanceId) {
    const files = this.staged.get(instanceId) ?? []
    return { pending: files.length > 0, files, oldFiles: [] }
  }

  async applyInstall(instanceId: InstanceId, signal: AbortSignal) {
    if (signal.aborted) throw new Error('task cancelled')
    const files = this.staged.get(instanceId) ?? []
    for (const file of files) {
      await mkdir(join(instanceId, 'mods'), { recursive: true })
      await writeFile(join(instanceId, file), 'example-mod')
    }
    this.staged.set(instanceId, [])
    return { applied: files.length }
  }

  async importModpack(modpackPath: string) {
    await readFile(modpackPath)
    const created = await this.createInstance({ name: 'Imported' })
    await writeFile(join(created.id, 'config', 'imported.txt'), 'imported')
    return { instanceId: created.id }
  }

  async installRuntime(instanceId: InstanceId, signal: AbortSignal) {
    if (signal.aborted) throw new Error('task cancelled')
    await writeFile(join(instanceId, 'runtime.txt'), '1.21.1')
    return { version: '1.21.1' }
  }

  async launch(instanceId: InstanceId, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.launchDelay)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('task cancelled'))
        },
        { once: true },
      )
    })
    const processes = this.processes.get(instanceId) ?? []
    processes.push({ pid: 4242, side: 'client', ready: true })
    this.processes.set(instanceId, processes)
    return { pid: 4242 }
  }

  async listProcesses(instanceId: InstanceId) {
    return this.processes.get(instanceId) ?? []
  }

  async stopProcess(instanceId: InstanceId, pid: number) {
    const processes = (this.processes.get(instanceId) ?? []).filter(
      (process) => process.pid !== pid,
    )
    this.processes.set(instanceId, processes)
  }

  async readLog(instanceId: InstanceId, name: string) {
    return readFile(join(instanceId, 'logs', name), 'utf8')
  }
}

const accept = 'application/json, text/event-stream'
let directory = ''
let endpoint: { url: string; close(): Promise<void> } | undefined

afterEach(async () => {
  await endpoint?.close()
  endpoint = undefined
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function boot() {
  directory = await mkdtemp(join(tmpdir(), 'xmcl-mcp-'))
  const port = new FixturePort(directory)
  const host = new AgentControlHost(port, join(directory, 'changes'))
  const code = host.issuePairingCode({ allowNewInstances: true, instanceIds: [] })
  endpoint = await startAgentControlHttp(host)
  const paired = await fetch(endpoint.url.replace(/\/mcp$/, '/pair'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const pairBody = (await paired.json()) as { ok: true; data: { token: string } }
  const token = pairBody.data.token
  const opened = await rpc(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  })
  if (!opened.session) throw new Error('MCP session was not created')
  return { port, token, session: opened.session, pairBody }
}

async function rpc(id: number, method: string, params: unknown, token?: string, session?: string) {
  const response = await fetch(endpoint!.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return {
    status: response.status,
    session: response.headers.get('mcp-session-id'),
    body: (await response.json()) as any,
  }
}

async function tool(
  token: string,
  session: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpc(
    name.length + argsLength(args),
    'tools/call',
    { name, arguments: args },
    token,
    session,
  )
  const result = response.body.result
  const structured = result.structuredContent
  return {
    isError: result.isError as boolean,
    text: result.content[0].text as string,
    data: structured.ok ? structured.data : undefined,
    error: structured.ok ? undefined : structured.error,
    raw: JSON.stringify(response.body),
  }
}

function argsLength(args: Record<string, unknown>) {
  return JSON.stringify(args).length
}

async function poll(token: string, session: string, taskId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await tool(token, session, 'task_status', { taskId })
    if (status.data?.state && status.data.state !== 'running') return status.data
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`task ${taskId} stayed running`)
}

describe('MCP agent control loop', () => {
  test('a client using only MCP tools customizes files and controls the instance', async () => {
    const { port, token, session } = await boot()
    const listed = await rpc(2, 'tools/list', {}, token, session)
    const names = listed.body.result.tools.map((entry: { name: string }) => entry.name)
    for (const denied of AGENT_CONTROL_DENYLIST) expect(names).not.toContain(denied)

    const created = await tool(token, session, 'instances_create', { name: 'Custom Pack' })
    expect(created.isError).toBe(false)
    const instanceId = created.data.id as string
    const staged = await tool(token, session, 'install_stage', {
      instanceId,
      provider: 'modrinth',
      versionId: 'abc',
    })
    expect(staged.data.files).toEqual(['mods/example.jar'])
    const status = await tool(token, session, 'install_status', { instanceId })
    expect(status.data.pending).toBe(true)
    const apply = await tool(token, session, 'install_apply', { instanceId })
    const applied = await poll(token, session, apply.data.taskId)
    expect(applied.state).toBe('succeeded')
    expect(await readFile(join(instanceId, 'mods/example.jar'), 'utf8')).toBe('example-mod')

    const files = [
      ['config/pack.toml', 'name = "pack"\n'],
      ['kubejs/server_scripts/recipes.js', 'ServerEvents.recipes(event => {})\n'],
      ['defaultconfigs/common.json', '{"enabled":true}\n'],
      ['scripts/start.txt', 'hello scripts\n'],
    ] as const
    for (const [path, content] of files) {
      const wrote = await tool(token, session, 'vfs_write', {
        kind: 'content',
        instanceId,
        path,
        expectedHash: null,
        content,
      })
      expect(wrote.isError, wrote.raw).toBe(false)
      const read = await tool(token, session, 'vfs_read', { instanceId, path })
      expect(read.data.content).toBe(content)
      const conflict = await tool(token, session, 'vfs_write', {
        kind: 'content',
        instanceId,
        path,
        expectedHash: 'sha256:' + '0'.repeat(64),
        content: 'nope',
        validate: 'none',
      })
      expect(conflict.isError).toBe(true)
      expect(conflict.error.code).toBe('conflict')
      expect(conflict.error.currentHash).toBe(read.data.hash)
      const edited = await tool(token, session, 'vfs_write', {
        kind: 'replacements',
        instanceId,
        path,
        expectedHash: read.data.hash,
        replacements: [{ match: content.trim().slice(0, 4), replace: 'EDIT' }],
        validate: 'none',
      })
      expect(edited.isError, edited.raw).toBe(false)
      const rolled = await tool(token, session, 'vfs_rollback', {
        instanceId,
        changeId: edited.data.changeId,
      })
      expect(rolled.isError, rolled.raw).toBe(false)
      expect(await readFile(join(instanceId, path), 'utf8')).toBe(content)
    }
    const found = await tool(token, session, 'vfs_grep', {
      instanceId,
      pattern: 'hello scripts',
      path: 'scripts',
    })
    expect(found.data.matches[0].file).toBe('scripts/start.txt')

    const runtime = await tool(token, session, 'runtime_install', { instanceId })
    expect((await poll(token, session, runtime.data.taskId)).state).toBe('succeeded')
    const launched = await tool(token, session, 'launch', { instanceId })
    const running = await poll(token, session, launched.data.taskId)
    expect(running.state).toBe('succeeded')
    expect(running.result.pid).toBe(4242)
    const processes = await tool(token, session, 'processes_list', { instanceId })
    expect(processes.data.processes).toEqual([{ pid: 4242, side: 'client', ready: true }])
    const stopped = await tool(token, session, 'process_stop', { instanceId, pid: 4242 })
    expect(stopped.data.stopped).toBe(4242)
    expect((await tool(token, session, 'processes_list', { instanceId })).data.processes).toEqual(
      [],
    )

    port.launchDelay = 250
    const cancelling = await tool(token, session, 'launch', { instanceId })
    const cancel = await tool(token, session, 'task_cancel', { taskId: cancelling.data.taskId })
    expect(cancel.data.state).toBe('cancelled')
    const cancelled = await poll(token, session, cancelling.data.taskId)
    expect(cancelled.state).toBe('cancelled')

    const lines = Array.from({ length: 50 }, (_, index) => `line-${index}`)
    await writeFile(join(instanceId, 'logs', 'latest.log'), lines.join('\n'))
    const log = await tool(token, session, 'logs_read', {
      instanceId,
      name: 'latest.log',
      tailLines: 5,
    })
    expect(log.data.lines).toEqual(lines.slice(-5))
    expect(log.data.truncated).toBe(true)
    expect(log.raw.includes(port.sentinel)).toBe(false)

    const denied = await tool(token, session, 'getOfficialUserProfile')
    expect(denied.isError).toBe(true)
    expect(denied.error.code).toBe('denied')
  })

  test('symlink follow, path escape, and hardlink overwrite are refused or broken', async () => {
    const { token, session } = await boot()
    const created = await tool(token, session, 'instances_create', { name: 'Links' })
    const instanceId = created.data.id as string
    const outside = await mkdtemp(join(directory, 'outside-'))
    const cache = await mkdtemp(join(directory, 'cache-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(instanceId, 'config', 'linked.txt'))
    await writeFile(join(cache, 'shared.toml'), 'cached = true\n')
    await link(join(cache, 'shared.toml'), join(instanceId, 'config', 'shared.toml'))

    const linked = await tool(token, session, 'vfs_write', {
      kind: 'content',
      instanceId,
      path: 'config/linked.txt',
      expectedHash: null,
      content: 'pwn',
    })
    expect(linked.error.code).toBe('denied')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    const escape = await tool(token, session, 'vfs_write', {
      kind: 'content',
      instanceId,
      path: 'config/../../outside.txt',
      expectedHash: null,
      content: 'pwn',
      validate: 'none',
    })
    expect(escape.error.code).toBe('denied')
    const current = await tool(token, session, 'vfs_read', {
      instanceId,
      path: 'config/shared.toml',
    })
    const broken = await tool(token, session, 'vfs_write', {
      kind: 'content',
      instanceId,
      path: 'config/shared.toml',
      expectedHash: current.data.hash,
      content: 'cached = false\n',
    })
    expect(broken.isError).toBe(false)
    expect(broken.data.brokeLink).toBe(true)
    expect(await readFile(join(cache, 'shared.toml'), 'utf8')).toBe('cached = true\n')
    expect(await readFile(join(instanceId, 'config', 'shared.toml'), 'utf8')).toBe(
      'cached = false\n',
    )
  })

  test('stdio initialize returns the server info without a push channel', async () => {
    directory = await mkdtemp(join(tmpdir(), 'xmcl-stdio-'))
    const host = new AgentControlHost(new FixturePort(directory), join(directory, 'changes'))
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (chunk) => {
      text += chunk.toString()
    })
    serveAgentControlStdio(host, input, output)
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    input.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(text).toContain('xmcl-agent-control')
    expect(text).toContain('does not push events')
  })
})
