import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LauncherAppPlugin } from '~/app'
import { kCommandHost } from '~/commands/kCommandHost'
import { VersionInstallService } from '~/install'
import { InstanceLogService, InstanceService } from '~/instance'
import { InstanceInstallService } from '~/instanceIO'
import { LaunchService } from '~/launch'
import { ModpackService } from '~/modpack'
import { ModrinthV2Client } from '@xmcl/modrinth'
import { parseMarketRef } from '@xmcl/runtime-api'
import {
  curseforgePlan,
  planModrinthInstall,
  readInstalledJarHashes,
  type DependencyPlan,
} from './dependencies'
import { startAgentControlHttp } from './mcpHttp'
import { createServiceLauncherPort } from './servicePort'
import { AgentControlHost, type SessionSnapshot } from './session'
import { serveAgentControlStdio } from './stdio'

/**
 * Starts the loopback MCP endpoint after the launcher engine is ready.
 * Pairing material is a one-time code and a token hash, never an account token.
 */
export const pluginAgentControl: LauncherAppPlugin = (app) => {
  let close: (() => Promise<void>) | undefined
  let stopStdio: (() => Promise<void>) | undefined
  app
    .waitEngineReady()
    .then(async () => {
      const logger = app.getLogger('AgentControl')
      const directory = join(app.appDataPath, 'agent-control')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      logger.log('Agent control is waiting for the game data path and launcher services')
      const instances = await app.registry.getOrCreate(InstanceService)
      const install = await app.registry.getOrCreate(InstanceInstallService)
      const modpack = await app.registry.getOrCreate(ModpackService)
      const versions = await app.registry.getOrCreate(VersionInstallService)
      const processes = await app.registry.getOrCreate(LaunchService)
      const logs = await app.registry.getOrCreate(InstanceLogService)
      const commands = await app.registry.get(kCommandHost)
      const modrinth = await app.registry.get(ModrinthV2Client)
      const port = createServiceLauncherPort({
        instances,
        install,
        modpack,
        versions,
        processes,
        logs,
        commands,
        dependencies: {
          async plan(input) {
            let parsed
            try {
              parsed = parseMarketRef(input.ref)
            } catch (error) {
              const refused: DependencyPlan = {
                provider: 'other',
                context: { minecraft: '', loaders: [] },
                root: null,
                dependencies: [],
                blocked: [
                  {
                    code: 'unresolved',
                    message: error instanceof Error ? error.message : 'The market ref is not valid.',
                  },
                ],
                truncated: false,
                install: [],
              }
              return refused
            }
            const state = await instances.getSharedInstancesState()
            const runtime = (state.all[input.instanceId]?.runtime ?? {}) as {
              minecraft?: string
              fabricLoader?: string
              forge?: string
              quiltLoader?: string
              neoForged?: string
            }
            const minecraft = runtime.minecraft ?? ''
            const loaders = [
              runtime.fabricLoader ? 'fabric' : '',
              runtime.forge ? 'forge' : '',
              runtime.quiltLoader ? 'quilt' : '',
              runtime.neoForged ? 'neoforge' : '',
            ].filter((loader) => loader.length > 0)
            if (parsed.source === 'curseforge') return curseforgePlan(minecraft, loaders)
            if (parsed.source !== 'modrinth' || !parsed.version) {
              const refused: DependencyPlan = {
                provider: 'other',
                context: { minecraft, loaders },
                root: null,
                dependencies: [],
                blocked: [
                  {
                    code: 'unresolved',
                    message: 'Dependency inspection needs a Modrinth ref modrinth:<project>@<versionId>.',
                  },
                ],
                truncated: false,
                install: [],
              }
              return refused
            }
            const hashes = await readInstalledJarHashes(input.instanceId)
            let installed = hashes.map((file) => ({ sha1: file.sha1 }))
            try {
              if (hashes.length > 0) {
                const found = await modrinth.getProjectVersionsByHash(
                  hashes.map((file) => file.sha1),
                  'sha1',
                  input.signal,
                )
                installed = hashes.map((file) => {
                  const version = found[file.sha1]
                  return version
                    ? { sha1: file.sha1, projectId: version.project_id, versionId: version.id }
                    : { sha1: file.sha1 }
                })
              }
            } catch {
              // Sha1 comparison still works. Project identity of other jars stays unknown.
            }
            return planModrinthInstall({
              rootVersionId: parsed.version,
              minecraft,
              loaders,
              includeOptional: input.includeOptional,
              installed,
              signal: input.signal,
              lookup: {
                async getVersion(versionId, signal) {
                  try {
                    return await modrinth.getProjectVersion(versionId, signal)
                  } catch (error) {
                    if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
                      return undefined
                    }
                    throw error
                  }
                },
                getCompatibleVersions(projectId, versionLoaders, gameVersion, signal) {
                  return modrinth.getProjectVersions(
                    projectId,
                    { loaders: versionLoaders, gameVersions: [gameVersion] },
                    signal,
                  )
                },
              },
            })
          },
        },
      })
      const host = new AgentControlHost(port, join(directory, 'changes'))
      const saved = await readFile(join(directory, 'session.json'), 'utf8').catch(() => undefined)
      if (saved) {
        host.restore(JSON.parse(saved) as SessionSnapshot)
      } else {
        const code = host.issuePairingCode()
        const codePath = join(directory, 'pairing-code')
        await writeFile(codePath, code, { mode: 0o600 })
        await chmod(codePath, 0o600)
        logger.log(`Agent control pairing code written to ${codePath}`)
      }
      const persist = async (snapshot: SessionSnapshot | undefined) => {
        const target = join(directory, 'session.json')
        if (!snapshot) {
          await rm(target, { force: true })
          return
        }
        await writeFile(target, JSON.stringify(snapshot), { mode: 0o600 })
        await chmod(target, 0o600)
      }
      const endpoint = await startAgentControlHttp(host, {
        host: process.env.XMCL_AGENT_CONTROL_HOST || '127.0.0.1',
        port: Number(process.env.XMCL_AGENT_CONTROL_PORT || 0),
        onSession: persist,
      })
      close = endpoint.close
      const endpointPath = join(directory, 'endpoint')
      await writeFile(endpointPath, endpoint.url, { mode: 0o600 })
      logger.log(`Agent control MCP listening on ${endpoint.url}`)
      if (process.env.XMCL_AGENT_CONTROL_STDIO === '1') {
        stopStdio = await serveAgentControlStdio(host, process.stdin, process.stdout)
        logger.log('Agent control stdio transport attached')
      }
    })
    .catch((error) => {
      app.getLogger('AgentControl').error(error as Error)
    })
  app.registryDisposer(async () => {
    await stopStdio?.()
    await close?.()
  })
}
