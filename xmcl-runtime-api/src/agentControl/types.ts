declare const brand: unique symbol

export type InstanceId = string & { readonly [brand]: 'InstanceId' }
export type VirtualPath = string & { readonly [brand]: 'VirtualPath' }
export type ContentHash = string & { readonly [brand]: 'ContentHash' }
export type TaskId = string & { readonly [brand]: 'TaskId' }
export type ChangeId = string & { readonly [brand]: 'ChangeId' }
export type SessionId = string & { readonly [brand]: 'SessionId' }
export type WritableRoot = string & { readonly [brand]: 'WritableRoot' }

export const DEFAULT_WRITABLE_ROOTS = ['config', 'kubejs', 'defaultconfigs', 'scripts'] as const

export const FORBIDDEN_INSTANCE_SEGMENTS = ['libraries', 'versions', 'assets', 'jre'] as const

/** Methods that must never be dispatched, even if a service class exposes them. */
export const AGENT_CONTROL_DENYLIST = [
  'getOfficialUserProfile',
  'getAccessToken',
  'getToken',
  'refreshToken',
  'accessToken',
  'shell',
  'os_shell',
  'exec',
  'spawn',
  'login',
  'user.login',
] as const

export type AgentControlDenyName = (typeof AGENT_CONTROL_DENYLIST)[number]

export function asInstanceId(value: string): InstanceId {
  return value as InstanceId
}

export function asVirtualPath(value: string): VirtualPath {
  return value as VirtualPath
}

export function asContentHash(value: string): ContentHash {
  return value as ContentHash
}

export function asTaskId(value: string): TaskId {
  return value as TaskId
}

export function asChangeId(value: string): ChangeId {
  return value as ChangeId
}

export function asSessionId(value: string): SessionId {
  return value as SessionId
}

export function asWritableRoot(value: string): WritableRoot {
  return value as WritableRoot
}

export interface VfsReplacement {
  match: string
  replace: string
  all?: boolean
}

export type VfsValidate = 'json' | 'toml' | 'none'

/** Full-file replacement, or exact literal edits. `expectedHash` null creates a file. */
export type VfsWrite =
  | {
      kind: 'content'
      expectedHash: ContentHash | null
      content: string
      validate?: VfsValidate
    }
  | {
      kind: 'replacements'
      expectedHash: ContentHash
      replacements: VfsReplacement[]
      validate?: VfsValidate
    }

export interface Grant {
  instanceIds: InstanceId[]
  allowNewInstances: boolean
  writableRoots: WritableRoot[]
}

export type SessionPhase =
  | { status: 'unpaired' }
  | { status: 'pairing'; expiresAt: number }
  | { status: 'paired'; sessionId: SessionId; grant: Grant }
  | { status: 'revoked'; sessionId: SessionId }

export interface TaskError {
  code: string
  message: string
  retryable: boolean
  hint?: string
}

export interface TaskView {
  taskId: TaskId
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  /** `requested` while the abort is in flight. `honored` when the work stopped. `unsupported` if the effect still landed. */
  cancellation: 'none' | 'requested' | 'honored' | 'unsupported'
  effect: 'none' | 'partial' | 'applied' | 'unknown'
  result?: unknown
  error?: TaskError
}
