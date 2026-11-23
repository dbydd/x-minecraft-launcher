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
        async createInstance() {
          calls.push('create')
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
        async dispatch(id, input) {
          calls.push(id)
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
    expect(calls).toContain('mod.install')
    expect(calls).not.toContain('stage-direct')
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
