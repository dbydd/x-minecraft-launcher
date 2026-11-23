import type { InstanceId } from '@xmcl/runtime-api'

export interface LauncherProcess {
  pid: number
  side: string
  ready: boolean
}

export interface LauncherPort {
  listInstances(): Promise<Array<{ id: InstanceId; name: string }>>
  instanceRoot(id: InstanceId): string | undefined
  createInstance(input: {
    name: string
    minecraft?: string
  }): Promise<{ id: InstanceId; name: string }>
  stageMarket(input: { instanceId: InstanceId; ref: string }): Promise<{ files: string[] }>
  installStatus(
    instanceId: InstanceId,
  ): Promise<{ pending: boolean; files: string[]; oldFiles: string[] }>
  applyInstall(instanceId: InstanceId, signal: AbortSignal): Promise<{ applied: number }>
  importModpack(modpackPath: string, signal: AbortSignal): Promise<{ instanceId: InstanceId }>
  installRuntime(
    instanceId: InstanceId,
    signal: AbortSignal,
    side?: 'client' | 'server',
  ): Promise<{ version: string; side: 'client' | 'server' }>
  launch(
    instanceId: InstanceId,
    signal: AbortSignal,
    options?: { side?: 'client' | 'server'; user?: string },
  ): Promise<{ pid: number }>
  listProcesses(instanceId: InstanceId): Promise<LauncherProcess[]>
  stopProcess(instanceId: InstanceId, pid: number, force?: boolean): Promise<void>
  readLog(
    instanceId: InstanceId,
    name: string,
    side?: 'client' | 'server',
  ): Promise<{ exists: boolean; content: string }>
}
