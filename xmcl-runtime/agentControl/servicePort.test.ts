import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { asInstanceId } from '@xmcl/runtime-api'
import { createServiceLauncherPort, type XmclControlServices } from './servicePort'

describe('service launcher port', () => {
  test('stages through mod.install and launches through instance.launch', async () => {
    const calls: string[] = []
    let manifest: { files: Array<{ path: string }>; oldFiles: Array<{ path: string }> } = {
      files: [],
      oldFiles: [],
    }
    const services: XmclControlServices = {
      instances: {
        async getSharedInstancesState() {
          return {
            instances: [{ path: '/inst', name: 'Pack' }],
            all: { '/inst': { runtime: { minecraft: '1.21.1' }, version: '1.21.1' } },
          }
        },
        async createInstance(options) {
          calls.push(JSON.stringify({ create: options }))
          return '/inst'
        },
      },
      install: {
        async stageInstanceFiles() {
          calls.push('stage-direct')
        },
        async getInstanceInstallManifest() {
          return manifest
        },
        async applyInstanceInstallManifest() {
          calls.push('apply')
        },
      },
      modpack: {
        async importModpack() {
          return { instancePath: '/imported' }
        },
      },
      versions: {
        async installInstance() {
          return { version: '1.21.1' }
        },
        async install(request) {
          calls.push(`server:${request.path}`)
          return '1.21.1'
        },
      },
      processes: {
        async kill() {
          calls.push('kill')
        },
        async getGameProcesses() {
          return [{ pid: 7, side: 'client', ready: true, options: { gameDirectory: '/inst' } }]
        },
      },
      logs: {
        async getLogContent() {
          return 'hello\n'
        },
        async getServerLogContent() {
          return ''
        },
      },
      commands: {
        async dispatch(id, input) {
          calls.push(JSON.stringify({ id, input }))
          if (id === 'mod.install') {
            const ref = (input as { ref?: string }).ref
            manifest = { files: [{ path: `mods/${ref}.jar` }], oldFiles: [] }
          }
          if (id === 'instance.launch') return 7
          return undefined
        },
      },
    }
    const port = createServiceLauncherPort(services)
    const staged = await port.stageMarket({
      instanceId: asInstanceId('/inst'),
      ref: 'modrinth:sodium@1',
    })
    expect(staged.files).toEqual(['mods/modrinth:sodium@1.jar'])
    expect(calls.some((call) => call.includes('"id":"mod.install"'))).toBe(true)
    expect(calls).not.toContain('stage-direct')
    const launched = await port.launch(asInstanceId('/inst'), new AbortController().signal, {
      side: 'server',
      user: 'OFFLINE',
    })
    expect(launched.pid).toBe(7)
    expect(calls.some((call) => call.includes('"user":"OFFLINE"') && call.includes('"side":"server"'))).toBe(
      true,
    )
    const server = await port.installRuntime(asInstanceId('/inst'), new AbortController().signal, 'server')
    expect(server).toEqual({ version: '1.21.1', side: 'server' })
    await port.createInstance({ name: 'Fabric', minecraft: '1.20.1', fabricLoader: '0.20.1' })
    expect(calls.some((call) => call.includes('"fabricLoader":"0.20.1"'))).toBe(true)
    await port.stopProcess(asInstanceId('/inst'), 7)
    expect(calls).toContain('kill')
    const source = await readFile(new URL('./servicePort.ts', import.meta.url), 'utf8')
    expect(source.includes('getOfficialUserProfile')).toBe(false)
    expect(source.includes('accessToken')).toBe(false)
  })
})
