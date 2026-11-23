import type { ContentHash, TaskId } from './types'

export type AgentControlErrorCode =
  | 'denied'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'too_large'
  | 'task_cancelled'
  | 'unavailable'

export interface AgentControlRetry {
  tool: string
  arguments: Record<string, unknown>
}

export interface AgentControlError {
  code: AgentControlErrorCode
  message: string
  retryable: boolean
  currentHash?: ContentHash
  snippet?: string
  taskId?: TaskId
  retry?: AgentControlRetry
}

export type CommandResult<T> = { ok: true; data: T } | { ok: false; error: AgentControlError }

export function agentError(
  code: AgentControlErrorCode,
  message: string,
  extra: Partial<Omit<AgentControlError, 'code' | 'message' | 'retryable'>> & {
    retryable?: boolean
  } = {},
): AgentControlError {
  const retryable =
    extra.retryable ??
    (code === 'conflict' ||
      code === 'validation' ||
      code === 'unavailable' ||
      code === 'task_cancelled')
  return { code, message, retryable, ...extra }
}

export function failure<T>(error: AgentControlError): CommandResult<T> {
  return { ok: false, error }
}

export function success<T>(data: T): CommandResult<T> {
  return { ok: true, data }
}
