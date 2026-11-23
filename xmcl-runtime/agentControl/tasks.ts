import { randomUUID } from 'node:crypto'
import { asTaskId, type TaskId, type TaskView } from '@xmcl/runtime-api'

interface RecordedTask {
  taskId: TaskId
  state: TaskView['state']
  cancellation: TaskView['cancellation']
  effect: TaskView['effect']
  controller: AbortController
  result?: unknown
  error?: string
}

function cancelledError(error: unknown) {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'task_cancelled'
  )
}

/**
 * Cancel requests the AbortSignal. The task stays `running` with
 * `cancellation: requested` until the work settles. A result means the effect
 * happened (`unsupported`). Only a `task_cancelled` rejection is `honored`.
 */
export class TaskBook {
  private readonly tasks = new Map<string, RecordedTask>()

  start(work: (signal: AbortSignal) => Promise<unknown>): TaskId {
    const taskId = asTaskId(randomUUID())
    const controller = new AbortController()
    const record: RecordedTask = {
      taskId,
      state: 'running',
      cancellation: 'none',
      effect: 'unknown',
      controller,
    }
    this.tasks.set(taskId, record)
    work(controller.signal).then(
      (result) => {
        record.result = result
        record.effect = 'applied'
        record.state = 'succeeded'
        if (record.cancellation === 'requested') record.cancellation = 'unsupported'
      },
      (error) => {
        if (cancelledError(error)) {
          record.state = 'cancelled'
          record.cancellation = 'honored'
          record.effect = 'none'
          record.error = error instanceof Error ? error.message : String(error)
          return
        }
        record.state = 'failed'
        record.effect = 'unknown'
        if (record.cancellation === 'requested') record.cancellation = 'unsupported'
        record.error = error instanceof Error ? error.message : String(error)
      },
    )
    return taskId
  }

  poll(taskId: string): TaskView | undefined {
    const record = this.tasks.get(taskId)
    if (!record) return undefined
    return {
      taskId: record.taskId,
      state: record.state,
      cancellation: record.cancellation,
      effect: record.effect,
      result: record.result,
      error: record.error,
    }
  }

  cancel(taskId: string): TaskView | undefined {
    const record = this.tasks.get(taskId)
    if (!record) return undefined
    if (record.state === 'running' && record.cancellation === 'none') {
      record.cancellation = 'requested'
      record.controller.abort()
    }
    return this.poll(taskId)
  }
}
