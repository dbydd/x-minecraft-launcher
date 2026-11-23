import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { MarketType, asInstanceId } from '@xmcl/runtime-api'
import { createServiceLauncherPort, type XmclControlServices } from './servicePort'

describe('service launcher port', () => {
  test('stages, launches through instance.launch, and never asks for an account token', async () => {
    const calls: string[] = []
    const services: XmclControlServices = {
      instances: {
        async getSharedInstancesState() {
          return {
            instances: [{ path: '/inst', name: 'Pack' }],
            all: { '/inst': { runtime: { minecraft: '1.21.1' }, version: '1.21.1' } },
          }
        },
        async createInstance() {
          calls.push('create')
          return '/inst'
        },
      },
      mods: {
        async resolveFromMarket(options) {
          calls.push(`resolve:${options.market}`)
          return [{ path: 'mods/a.jar' }]
        },
      },
      install: {
        async stageInstanceFiles() {
          calls.push('stage')
        },
        async getInstanceInstallManifest() {
          return { files: [{ path: 'mods/a.jar' }], oldFiles: [] }
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
      },
      commands: {
        async dispatch(id) {
          calls.push(id)
          return 7
        },
      },
    }
    const port = createServiceLauncherPort(services)
    const staged = await port.stageMarket({
      instanceId: asInstanceId('/inst'),
      provider: 'modrinth',
      versionId: 'ver',
    })
    expect(staged.files).toEqual(['mods/a.jar'])
    expect(calls).toContain(`resolve:${MarketType.Modrinth}`)
    expect(calls).toContain('stage')
    const launched = await port.launch(asInstanceId('/inst'), new AbortController().signal)
    expect(launched.pid).toBe(7)
    expect(calls).toContain('instance.launch')
    await port.stopProcess(asInstanceId('/inst'), 7)
    expect(calls).toContain('kill')
    const source = await readFile(new URL('./servicePort.ts', import.meta.url), 'utf8')
    expect(source.includes('getOfficialUserProfile')).toBe(false)
    expect(source.includes('accessToken')).toBe(false)
  })
})
