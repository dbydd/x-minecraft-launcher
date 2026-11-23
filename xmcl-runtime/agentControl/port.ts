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
  installRuntime(instanceId: InstanceId, signal: AbortSignal): Promise<{ version: string }>
  launch(instanceId: InstanceId, signal: AbortSignal): Promise<{ pid: number }>
  listProcesses(instanceId: InstanceId): Promise<LauncherProcess[]>
  stopProcess(instanceId: InstanceId, pid: number, force?: boolean): Promise<void>
  readLog(instanceId: InstanceId, name: string): Promise<string>
}
