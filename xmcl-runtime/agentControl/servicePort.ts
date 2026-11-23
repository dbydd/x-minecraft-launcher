import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { asInstanceId } from '@xmcl/runtime-api'
import type { LauncherPort } from './port'

export interface XmclControlServices {
  instances: {
    getSharedInstancesState(): Promise<{
      instances: Array<{ path: string; name: string; runtime?: object; version?: string }>
      all: Record<string, { runtime?: object; version?: string }>
    }>
    createInstance(options: { name: string; runtime?: { minecraft?: string } }): Promise<string>
  }
  install: {
    stageInstanceFiles(options: {
      path: string
      oldFiles: unknown[]
      files: unknown[]
    }): Promise<unknown>
    getInstanceInstallManifest(
      path: string,
    ): Promise<{ files?: Array<{ path: string }>; oldFiles?: Array<{ path: string }> } | undefined>
    applyInstanceInstallManifest(path: string): Promise<void>
  }
  modpack: {
    importModpack(path: string): Promise<{ instancePath: string }>
  }
  versions: {
    installInstance(request: {
      type: 'instance'
      instancePath: string
      runtime: object
      selectedVersion?: string
    }): Promise<{ version: string }>
    install(request: { type: 'server'; runtime: object; path: string }): Promise<string>
  }
  processes: {
    kill(pid: number, force?: boolean): Promise<void>
    getGameProcesses(): Promise<
      Array<{ pid: number; side: string; ready: boolean; options: { gameDirectory: string } }>
    >
  }
  logs: {
    getLogContent(instancePath: string, name: string): Promise<string>
    getServerLogContent(instancePath: string, name: string): Promise<string>
  }
  commands: {
    dispatch(
      id: string,
      input: unknown,
      opts?: { signal?: AbortSignal; mode?: 'cli' },
    ): Promise<unknown>
  }
}

function cancelled() {
  return Object.assign(new Error('task cancelled'), { code: 'task_cancelled', effect: 'none' as const })
}

function accountRequired(error: unknown) {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: string }).name === 'CommandMissingInput' &&
    /user selection required/i.test(error instanceof Error ? error.message : '')
  )
}

/**
 * Adapt existing launcher services onto the agent-control port.
 * Launch goes through the allowlisted `instance.launch` command so account
 * tokens stay inside that command and are not part of this port's result.
 */
export function createServiceLauncherPort(services: XmclControlServices): LauncherPort {
  return {
    async listInstances() {
      const state = await services.instances.getSharedInstancesState()
      return state.instances.map((instance) => ({
        id: asInstanceId(instance.path),
        name: instance.name,
      }))
    },
    instanceRoot(id) {
      return id
    },
    async createInstance(input) {
      const runtime = input.minecraft
        ? { minecraft: input.minecraft, ...(input.fabricLoader ? { fabricLoader: input.fabricLoader } : {}) }
        : undefined
      const path = await services.instances.createInstance({
        name: input.name,
        runtime,
      })
      return { id: asInstanceId(path), name: input.name }
    },
    async stageMarket(input) {
      await services.commands.dispatch('mod.install', {
        ref: input.ref,
        instance: input.instanceId,
        dependencies: false,
      })
      const manifest = await services.install.getInstanceInstallManifest(input.instanceId)
      return { files: manifest?.files?.map((file) => file.path) ?? [] }
    },
    async installStatus(instanceId) {
      const manifest = await services.install.getInstanceInstallManifest(instanceId)
      return {
        pending:
          !!manifest && ((manifest.files?.length ?? 0) > 0 || (manifest.oldFiles?.length ?? 0) > 0),
        files: manifest?.files?.map((file) => file.path) ?? [],
        oldFiles: manifest?.oldFiles?.map((file) => file.path) ?? [],
      }
    },
    async applyInstall(instanceId, signal) {
      if (signal.aborted) throw cancelled()
      const pending = await services.install.getInstanceInstallManifest(instanceId)
      await services.install.applyInstanceInstallManifest(instanceId)
      return { applied: pending?.files?.length ?? 0 }
    },
    async importModpack(modpackPath, signal) {
      if (signal.aborted) throw cancelled()
      const imported = await services.modpack.importModpack(modpackPath)
      return { instanceId: asInstanceId(imported.instancePath) }
    },
    async installRuntime(instanceId, signal, side = 'client') {
      if (signal.aborted) throw cancelled()
      const state = await services.instances.getSharedInstancesState()
      const instance = state.all[instanceId]
      if (!instance) {
        throw Object.assign(new Error(`Instance not found: ${instanceId}`), {
          code: 'not_found',
          retryable: false,
        })
      }
      if (side === 'server') {
        const version = await services.versions.install({
          type: 'server',
          runtime: instance.runtime ?? {},
          path: instanceId,
        })
        return { version, side }
      }
      const installed = await services.versions.installInstance({
        type: 'instance',
        instancePath: instanceId,
        runtime: instance.runtime ?? {},
        selectedVersion: instance.version,
      })
      return { version: installed.version, side }
    },
    async launch(instanceId, signal, options) {
      if (signal.aborted) throw cancelled()
      let pid: unknown
      try {
        pid = await services.commands.dispatch(
          'instance.launch',
          {
            instance: instanceId,
            modCount: 0,
            side: options?.side ?? 'client',
            ...(options?.user ? { user: options.user } : {}),
          },
          { mode: 'cli', signal },
        )
      } catch (error) {
        if (accountRequired(error)) {
          throw Object.assign(new Error('No account is selected'), {
            code: 'account_required',
            retryable: false,
            hint: 'Log in with the launcher user.login command. Offline accounts use authority x://dev, or the CLI alias offline, plus a username. Pass that account id as launch.user. This interface does not create accounts or return tokens.',
          })
        }
        throw error
      }
      if (typeof pid !== 'number') {
        throw Object.assign(new Error('Launch did not return a process id'), {
          code: 'launch_failed',
          retryable: false,
        })
      }
      return { pid }
    },
    async listProcesses(instanceId) {
      const processes = await services.processes.getGameProcesses()
      return processes
        .filter((process) => process.options.gameDirectory === instanceId)
        .map((process) => ({ pid: process.pid, side: process.side, ready: process.ready }))
    },
    async stopProcess(instanceId, pid, force) {
      const processes = await services.processes.getGameProcesses()
      const owned = processes.some(
        (process) => process.pid === pid && process.options.gameDirectory === instanceId,
      )
      if (!owned) throw new Error('Process is not running for this instance')
      await services.processes.kill(pid, force)
    },
    async readLog(instanceId, name, side = 'client') {
      const file = join(instanceId, ...(side === 'server' ? ['server', 'logs', name] : ['logs', name]))
      try {
        await access(file)
      } catch {
        return { exists: false, content: '' }
      }
      const content =
        side === 'server'
          ? await services.logs.getServerLogContent(instanceId, name)
          : await services.logs.getLogContent(instanceId, name)
      return { exists: true, content }
    },
  }
}
