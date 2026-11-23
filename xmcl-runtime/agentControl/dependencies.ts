import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectVersion } from '@xmcl/modrinth'

export type DependencyRelation = 'required' | 'optional' | 'incompatible' | 'embedded'

export interface DependencyVersionRef {
  versionId: string
  versionNumber: string
  ref: string
  filename?: string
  sha1?: string
}

export interface DependencyNode {
  relation: DependencyRelation
  projectId: string
  requestedVersionId: string | null
  selected: DependencyVersionRef | null
  candidates: DependencyVersionRef[]
  state: 'satisfied' | 'missing' | 'conflict' | 'unresolved' | 'incompatible' | 'cycle' | 'embedded'
  reason?: string
  via: string[]
  installedVersionId?: string
}

export interface DependencyBlock {
  code: 'unresolved' | 'incompatible' | 'conflict' | 'cycle' | 'truncated' | 'context'
  message: string
  projectId?: string
}

export interface DependencyPlan {
  provider: 'modrinth' | 'curseforge' | 'other'
  context: { minecraft: string; loaders: string[] }
  root: {
    projectId: string
    versionId: string
    versionNumber: string
    ref: string
    state: DependencyNode['state']
    reason?: string
  } | null
  dependencies: DependencyNode[]
  blocked: DependencyBlock[]
  truncated: boolean
  limitation?: string
  /** Versions the required-dependency policy would stage. Optional dependencies are absent unless opted in. */
  install: Array<{ ref: string; versionId: string; role: 'root' | 'required' | 'optional' }>
}

export interface DependencyLookup {
  getVersion(versionId: string, signal?: AbortSignal): Promise<ProjectVersion | undefined>
  getCompatibleVersions(
    projectId: string,
    loaders: string[],
    gameVersion: string,
    signal?: AbortSignal,
  ): Promise<ProjectVersion[]>
}

export interface InstalledMod {
  sha1: string
  projectId?: string
  versionId?: string
}

const MAX_NODES = 40
const MAX_DEPTH = 6

function versionRef(version: ProjectVersion): DependencyVersionRef {
  const file = version.files.find((entry) => entry.primary) ?? version.files[0]
  return {
    versionId: version.id,
    versionNumber: version.version_number,
    ref: `modrinth:${version.project_id}@${version.id}`,
    filename: file?.filename,
    sha1: file?.hashes.sha1,
  }
}

function matchesContext(version: ProjectVersion, minecraft: string, loaders: string[]) {
  return (
    version.game_versions.includes(minecraft) &&
    version.loaders.some((loader) => loaders.includes(loader))
  )
}

function installedFor(projectId: string, selected: DependencyVersionRef | null, installed: InstalledMod[]) {
  const byProject = installed.filter((file) => file.projectId === projectId)
  const byHash =
    selected?.sha1 ? installed.find((file) => file.sha1 === selected.sha1) : undefined
  return { byProject, byHash }
}

/**
 * Resolve one Modrinth version against an instance Minecraft version and loader.
 * Required dependencies are transitive. Optional, incompatible, and embedded
 * edges are reported and are not installed unless the caller opts into that
 * optional project. A pinned version that is missing or incompatible is not
 * replaced with a different version.
 */
export async function planModrinthInstall(input: {
  rootVersionId: string
  minecraft: string
  loaders: string[]
  includeOptional?: string[]
  lookup: DependencyLookup
  installed?: InstalledMod[]
  signal?: AbortSignal
}): Promise<DependencyPlan> {
  const installed = input.installed ?? []
  const includeOptional = new Set(input.includeOptional ?? [])
  const plan: DependencyPlan = {
    provider: 'modrinth',
    context: { minecraft: input.minecraft, loaders: input.loaders },
    root: null,
    dependencies: [],
    blocked: [],
    truncated: false,
    install: [],
  }
  const block = (entry: DependencyBlock) => {
    plan.blocked.push(entry)
  }
  if (!input.minecraft || input.loaders.length === 0) {
    block({
      code: 'context',
      message: 'The instance needs a Minecraft version and a loader before dependencies can be filtered.',
    })
    return plan
  }

  const root = await input.lookup.getVersion(input.rootVersionId, input.signal)
  if (!root) {
    block({
      code: 'unresolved',
      message: `Modrinth did not return version ${input.rootVersionId}.`,
    })
    return plan
  }
  const rootSelected = versionRef(root)
  const rootMatches = matchesContext(root, input.minecraft, input.loaders)
  const rootInstalled = installedFor(root.project_id, rootSelected, installed)
  plan.root = {
    projectId: root.project_id,
    versionId: root.id,
    versionNumber: root.version_number,
    ref: rootSelected.ref,
    state: !rootMatches ? 'incompatible' : rootInstalled.byHash ? 'satisfied' : 'missing',
    reason: rootMatches
      ? undefined
      : `Version ${root.version_number} does not support Minecraft ${input.minecraft} on ${input.loaders.join(', ')}.`,
  }
  if (!rootMatches) {
    block({
      code: 'incompatible',
      projectId: root.project_id,
      message: plan.root.reason ?? 'The requested version is incompatible with this instance.',
    })
    return plan
  }
  const rootVersion = root

  const stack = [rootVersion.project_id]
  const expanded = new Set<string>()

  async function consider(
    edge: { projectId: string; versionId: string | null; relation: DependencyRelation },
    via: string[],
    depth: number,
  ) {
    if (plan.truncated) return
    if (plan.dependencies.length >= MAX_NODES || depth > MAX_DEPTH) {
      plan.truncated = true
      block({
        code: 'truncated',
        message: `Dependency walk stopped at ${MAX_NODES} projects or depth ${MAX_DEPTH}.`,
      })
      return
    }
    if (stack.includes(edge.projectId)) {
      const message = `Dependency cycle includes ${edge.projectId}.`
      const existing = plan.dependencies.find((node) => node.projectId === edge.projectId)
      if (existing) {
        existing.state = 'cycle'
        existing.reason = message
      } else {
        plan.dependencies.push({
          relation: edge.relation,
          projectId: edge.projectId,
          requestedVersionId: edge.versionId,
          selected: null,
          candidates: [],
          state: 'cycle',
          reason: message,
          via,
        })
      }
      block({ code: 'cycle', projectId: edge.projectId, message })
      return
    }
    if (edge.relation === 'incompatible' || edge.relation === 'embedded') {
      let selected: DependencyVersionRef | null = null
      if (edge.versionId) {
        const version = await input.lookup.getVersion(edge.versionId, input.signal).catch(() => undefined)
        if (version) selected = versionRef(version)
      }
      plan.dependencies.push({
        relation: edge.relation,
        projectId: edge.projectId,
        requestedVersionId: edge.versionId,
        selected,
        candidates: [],
        state: edge.relation === 'embedded' ? 'embedded' : 'incompatible',
        reason:
          edge.relation === 'embedded'
            ? `${edge.projectId} is embedded by ${via[via.length - 1] ?? 'the parent'}.`
            : `${edge.projectId} is marked incompatible by ${via[via.length - 1] ?? 'the parent'}.`,
        via,
      })
      return
    }

    const existing = plan.dependencies.find((node) => node.projectId === edge.projectId)
    if (existing && edge.relation !== 'required' && edge.relation !== 'optional') return

    let compatible: ProjectVersion[] = []
    try {
      compatible = await input.lookup.getCompatibleVersions(
        edge.projectId,
        input.loaders,
        input.minecraft,
        input.signal,
      )
    } catch (error) {
      const message = `Could not list versions of ${edge.projectId}: ${error instanceof Error ? error.message : String(error)}`
      plan.dependencies.push({
        relation: edge.relation,
        projectId: edge.projectId,
        requestedVersionId: edge.versionId,
        selected: null,
        candidates: [],
        state: 'unresolved',
        reason: message,
        via,
      })
      if (edge.relation === 'required') block({ code: 'unresolved', projectId: edge.projectId, message })
      return
    }

    let pinned: ProjectVersion | undefined
    if (edge.versionId) {
      try {
        pinned = await input.lookup.getVersion(edge.versionId, input.signal)
      } catch (error) {
        pinned = undefined
        if (edge.relation === 'required') {
          const message = `Could not read pinned version ${edge.versionId}: ${error instanceof Error ? error.message : String(error)}`
          plan.dependencies.push({
            relation: edge.relation,
            projectId: edge.projectId,
            requestedVersionId: edge.versionId,
            selected: null,
            candidates: compatible.slice(0, 5).map(versionRef),
            state: 'unresolved',
            reason: message,
            via,
          })
          block({ code: 'unresolved', projectId: edge.projectId, message })
          return
        }
      }
      if (!pinned) {
        const message = `Pinned version ${edge.versionId} of ${edge.projectId} was not returned by Modrinth.`
        plan.dependencies.push({
          relation: edge.relation,
          projectId: edge.projectId,
          requestedVersionId: edge.versionId,
          selected: null,
          candidates: compatible.slice(0, 5).map(versionRef),
          state: 'unresolved',
          reason: message,
          via,
        })
        if (edge.relation === 'required') block({ code: 'unresolved', projectId: edge.projectId, message })
        return
      }
      if (!matchesContext(pinned, input.minecraft, input.loaders)) {
        const message = `Pinned version ${pinned.version_number} of ${edge.projectId} does not support Minecraft ${input.minecraft} on ${input.loaders.join(', ')}.`
        plan.dependencies.push({
          relation: edge.relation,
          projectId: edge.projectId,
          requestedVersionId: edge.versionId,
          selected: versionRef(pinned),
          candidates: compatible.slice(0, 5).map(versionRef),
          state: 'incompatible',
          reason: message,
          via,
        })
        if (edge.relation === 'required') block({ code: 'incompatible', projectId: edge.projectId, message })
        return
      }
    }

    const selectedVersion = pinned ?? compatible[0]
    if (!selectedVersion) {
      const message = `No ${input.loaders.join(', ')} version of ${edge.projectId} supports Minecraft ${input.minecraft}.`
      plan.dependencies.push({
        relation: edge.relation,
        projectId: edge.projectId,
        requestedVersionId: edge.versionId,
        selected: null,
        candidates: [],
        state: 'unresolved',
        reason: message,
        via,
      })
      if (edge.relation === 'required') block({ code: 'unresolved', projectId: edge.projectId, message })
      return
    }

    const selected = versionRef(selectedVersion)
    if (existing) {
      if (existing.selected && existing.selected.versionId !== selected.versionId) {
        const message = `${edge.projectId} is required as ${existing.selected.versionId} and ${selected.versionId}.`
        existing.state = 'conflict'
        existing.reason = message
        block({ code: 'conflict', projectId: edge.projectId, message })
      } else if (!existing.via.includes(via[via.length - 1] ?? '')) {
        existing.via.push(via[via.length - 1] ?? rootVersion.id)
      }
      return
    }

    const found = installedFor(edge.projectId, selected, installed)
    let state: DependencyNode['state'] = found.byHash ? 'satisfied' : 'missing'
    let reason: string | undefined
    let installedVersionId = found.byHash?.versionId ?? found.byProject[0]?.versionId
    if (!found.byHash && found.byProject.length > 0 && found.byProject.some((file) => file.versionId && file.versionId !== selected.versionId)) {
      state = 'conflict'
      installedVersionId = found.byProject[0]?.versionId
      reason = `Installed version ${installedVersionId} of ${edge.projectId} is not ${selected.versionId}.`
      if (edge.relation === 'required' || includeOptional.has(edge.projectId)) {
        block({ code: 'conflict', projectId: edge.projectId, message: reason })
      }
    }

    const node: DependencyNode = {
      relation: edge.relation,
      projectId: edge.projectId,
      requestedVersionId: edge.versionId,
      selected,
      candidates: compatible.slice(0, 5).map(versionRef),
      state,
      reason,
      via,
      installedVersionId,
    }
    plan.dependencies.push(node)

    const expand =
      (edge.relation === 'required' || includeOptional.has(edge.projectId)) && state !== 'conflict'
    if (!expand || expanded.has(edge.projectId)) return
    expanded.add(edge.projectId)
    stack.push(edge.projectId)
    for (const child of selectedVersion.dependencies) {
      await consider(
        {
          projectId: child.project_id,
          versionId: child.version_id,
          relation: child.dependency_type,
        },
        [...via, selected.versionId],
        depth + 1,
      )
    }
    stack.pop()
  }

  for (const child of root.dependencies ?? []) {
    await consider(
      {
        projectId: child.project_id,
        versionId: child.version_id,
        relation: child.dependency_type,
      },
      [root.id],
      1,
    )
  }

  const install: DependencyPlan['install'] = []
  if (plan.blocked.length === 0 && plan.root.state === 'missing') {
    install.push({ ref: plan.root.ref, versionId: plan.root.versionId, role: 'root' })
  }
  if (plan.blocked.length === 0) {
    for (const node of plan.dependencies) {
      const opted = node.relation === 'optional' && includeOptional.has(node.projectId)
      if (node.state !== 'missing' || !node.selected) continue
      if (node.relation === 'required' || opted) {
        install.push({
          ref: node.selected.ref,
          versionId: node.selected.versionId,
          role: node.relation === 'required' ? 'required' : 'optional',
        })
      }
    }
  }
  plan.install = install
  return plan
}

export function curseforgePlan(minecraft: string, loaders: string[]): DependencyPlan {
  return {
    provider: 'curseforge',
    context: { minecraft, loaders },
    root: null,
    dependencies: [],
    blocked: [
      {
        code: 'unresolved',
        message:
          'CurseForge dependency metadata is not queried here. An empty list would mean the file was not inspected, not that it has no dependencies.',
      },
    ],
    truncated: false,
    limitation:
      'This interface resolves Modrinth version dependencies. CurseForge file dependencies need the CurseForge client and are left unresolved.',
    install: [],
  }
}

export async function readInstalledJarHashes(instancePath: string) {
  const directory = join(instancePath, 'mods')
  const names = await readdir(directory).catch(() => [] as string[])
  const files = []
  for (const name of names) {
    if (!name.endsWith('.jar')) continue
    const bytes = await readFile(join(directory, name))
    files.push({ sha1: createHash('sha1').update(bytes).digest('hex') })
  }
  return files
}
