import { describe, expect, test } from 'vitest'
import { TaskBook } from './tasks'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('task cancellation', () => {
  test('a cooperative abort is cancelled with no effect', async () => {
    const book = new TaskBook()
    let wrote = false
    const id = book.start(async (signal) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('task cancelled'), { code: 'task_cancelled' })),
          { once: true },
        )
        setTimeout(resolve, 200)
      })
      wrote = true
      return { wrote }
    })
    const requested = book.cancel(id)
    expect(requested?.state).toBe('running')
    expect(requested?.cancellation).toBe('requested')
    await wait(20)
    const done = book.poll(id)
    expect(done?.state).toBe('cancelled')
    expect(done?.cancellation).toBe('honored')
    expect(done?.effect).toBe('none')
    expect(wrote).toBe(false)
  })

  test('work that finishes after abort is not reported as stopped', async () => {
    const book = new TaskBook()
    const id = book.start(async () => {
      await wait(30)
      return { applied: true }
    })
    book.cancel(id)
    await wait(50)
    const done = book.poll(id)
    expect(done?.state).toBe('succeeded')
    expect(done?.cancellation).toBe('unsupported')
    expect(done?.effect).toBe('applied')
    expect(done?.result).toEqual({ applied: true })
  })
})
