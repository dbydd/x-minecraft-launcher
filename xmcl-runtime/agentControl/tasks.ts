import { randomUUID } from 'node:crypto'
import { asTaskId, type TaskId, type TaskView } from '@xmcl/runtime-api'

interface RecordedTask {
  taskId: TaskId
  state: TaskView['state']
  controller: AbortController
  result?: unknown
  error?: string
}

/**
 * In-process task table. Cancel aborts the same `AbortController` shape the
 * launcher task plugin uses; work that observes the signal stops, and a late
 * success cannot overwrite a cancellation.
 */
export class TaskBook {
  private readonly tasks = new Map<string, RecordedTask>()

  start(work: (signal: AbortSignal) => Promise<unknown>): TaskId {
    const taskId = asTaskId(randomUUID())
    const controller = new AbortController()
    const record: RecordedTask = { taskId, state: 'running', controller }
    this.tasks.set(taskId, record)
    work(controller.signal).then(
      (result) => {
        if (record.state === 'cancelled' || controller.signal.aborted) {
          record.state = 'cancelled'
          return
        }
        record.state = 'succeeded'
        record.result = result
      },
      (error) => {
        if (record.state === 'cancelled' || controller.signal.aborted) {
          record.state = 'cancelled'
          return
        }
        record.state = 'failed'
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
      result: record.result,
      error: record.error,
    }
  }

  cancel(taskId: string): TaskView | undefined {
    const record = this.tasks.get(taskId)
    if (!record) return undefined
    record.state = 'cancelled'
    record.controller.abort()
    return { taskId: record.taskId, state: 'cancelled' }
  }
}
