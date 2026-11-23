import { describe, expect, test } from 'vitest'
import type { ProjectVersion } from '@xmcl/modrinth'
import { planModrinthInstall, type DependencyLookup } from './dependencies'

function version(
  id: string,
  project: string,
  dependencies: ProjectVersion['dependencies'] = [],
  options: { loaders?: string[]; game?: string[]; sha1?: string } = {},
): ProjectVersion {
  return {
    id,
    project_id: project,
    author_id: 'author',
    featured: false,
    name: id,
    version_number: id,
    date_published: '2024-01-01',
    downloads: 1,
    version_type: 'release',
    files: [
      {
        hashes: { sha1: options.sha1 ?? `${id}-sha`, sha512: '' },
        url: `https://example.test/${id}.jar`,
        filename: `${id}.jar`,
        primary: true,
        size: 10,
      },
    ],
    dependencies,
    game_versions: options.game ?? ['1.20.1'],
    loaders: options.loaders ?? ['fabric'],
  }
}

function lookup(versions: ProjectVersion[]): DependencyLookup {
  return {
    async getVersion(id) {
      return versions.find((entry) => entry.id === id)
    },
    async getCompatibleVersions(projectId, loaders, gameVersion) {
      return versions.filter(
        (entry) =>
          entry.project_id === projectId &&
          entry.game_versions.includes(gameVersion) &&
          entry.loaders.some((loader) => loaders.includes(loader)),
      )
    },
  }
}

const context = { rootVersionId: 'root', minecraft: '1.20.1', loaders: ['fabric'] }

describe('modrinth dependency plan', () => {
  test('lists required and optional dependencies and installs only required ones', async () => {
    const plan = await planModrinthInstall({
      ...context,
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'need', version_id: 'need-1', dependency_type: 'required' },
          { project_id: 'maybe', version_id: null, dependency_type: 'optional' },
        ]),
        version('need-1', 'need'),
        version('maybe-1', 'maybe'),
      ]),
    })
    expect(plan.blocked).toEqual([])
    expect(plan.dependencies.map((node) => [node.projectId, node.relation, node.state])).toEqual([
      ['need', 'required', 'missing'],
      ['maybe', 'optional', 'missing'],
    ])
    expect(plan.install.map((item) => item.ref)).toEqual([
      'modrinth:root@root',
      'modrinth:need@need-1',
    ])
  })

  test('an opted-in optional dependency installs its required children', async () => {
    const plan = await planModrinthInstall({
      ...context,
      includeOptional: ['maybe'],
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'maybe', version_id: 'maybe-1', dependency_type: 'optional' },
        ]),
        version('maybe-1', 'maybe', [
          { project_id: 'child', version_id: null, dependency_type: 'required' },
        ]),
        version('child-1', 'child'),
      ]),
    })
    expect(plan.install.map((item) => item.versionId)).toEqual(['root', 'maybe-1', 'child-1'])
  })

  test('required dependencies are transitive', async () => {
    const plan = await planModrinthInstall({
      ...context,
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'mid', version_id: null, dependency_type: 'required' },
        ]),
        version('mid-1', 'mid', [
          { project_id: 'leaf', version_id: 'leaf-1', dependency_type: 'required' },
        ]),
        version('leaf-1', 'leaf'),
      ]),
    })
    expect(plan.dependencies.map((node) => node.projectId)).toEqual(['mid', 'leaf'])
    expect(plan.install.map((item) => item.role)).toEqual(['root', 'required', 'required'])
  })

  test('an installed file hash is satisfied and is not staged again', async () => {
    const plan = await planModrinthInstall({
      ...context,
      installed: [{ sha1: 'need-1-sha', projectId: 'need', versionId: 'need-1' }],
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'need', version_id: 'need-1', dependency_type: 'required' },
        ]),
        version('need-1', 'need', [], { sha1: 'need-1-sha' }),
      ]),
    })
    expect(plan.dependencies[0]?.state).toBe('satisfied')
    expect(plan.install.map((item) => item.versionId)).toEqual(['root'])
  })

  test('a pinned version for the wrong loader is incompatible and is not replaced', async () => {
    const plan = await planModrinthInstall({
      ...context,
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'need', version_id: 'forge-only', dependency_type: 'required' },
        ]),
        version('forge-only', 'need', [], { loaders: ['forge'] }),
        version('fabric-ok', 'need'),
      ]),
    })
    expect(plan.dependencies[0]?.state).toBe('incompatible')
    expect(plan.dependencies[0]?.selected?.versionId).toBe('forge-only')
    expect(plan.dependencies[0]?.candidates.map((item) => item.versionId)).toEqual(['fabric-ok'])
    expect(plan.install).toEqual([])
    expect(plan.blocked[0]?.code).toBe('incompatible')
  })

  test('a required dependency with no compatible version stays unresolved', async () => {
    const plan = await planModrinthInstall({
      ...context,
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'need', version_id: null, dependency_type: 'required' },
        ]),
        version('old', 'need', [], { game: ['1.19.2'] }),
      ]),
    })
    expect(plan.dependencies[0]?.state).toBe('unresolved')
    expect(plan.dependencies[0]?.reason).toMatch(/No fabric version/)
    expect(plan.install).toEqual([])
  })

  test('a missing pinned version is unresolved instead of choosing another version', async () => {
    const plan = await planModrinthInstall({
      ...context,
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'need', version_id: 'gone', dependency_type: 'required' },
        ]),
        version('other', 'need'),
      ]),
    })
    expect(plan.dependencies[0]?.state).toBe('unresolved')
    expect(plan.dependencies[0]?.candidates.map((item) => item.versionId)).toEqual(['other'])
    expect(plan.install).toEqual([])
  })

  test('two required versions of one project are a conflict', async () => {
    const plan = await planModrinthInstall({
      ...context,
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'left', version_id: 'left-1', dependency_type: 'required' },
          { project_id: 'right', version_id: 'right-1', dependency_type: 'required' },
        ]),
        version('left-1', 'left', [
          { project_id: 'shared', version_id: 'shared-1', dependency_type: 'required' },
        ]),
        version('right-1', 'right', [
          { project_id: 'shared', version_id: 'shared-2', dependency_type: 'required' },
        ]),
        version('shared-1', 'shared'),
        version('shared-2', 'shared'),
      ]),
    })
    expect(plan.dependencies.find((node) => node.projectId === 'shared')?.state).toBe('conflict')
    expect(plan.blocked.some((entry) => entry.code === 'conflict')).toBe(true)
    expect(plan.install).toEqual([])
  })

  test('a dependency cycle is reported and nothing is staged', async () => {
    const plan = await planModrinthInstall({
      ...context,
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'loop', version_id: 'loop-1', dependency_type: 'required' },
        ]),
        version('loop-1', 'loop', [
          { project_id: 'root', version_id: 'root', dependency_type: 'required' },
        ]),
      ]),
    })
    expect(plan.blocked.some((entry) => entry.code === 'cycle')).toBe(true)
    expect(plan.install).toEqual([])
  })

  test('incompatible and embedded edges are visible and not installed', async () => {
    const plan = await planModrinthInstall({
      ...context,
      lookup: lookup([
        version('root', 'root', [
          { project_id: 'clash', version_id: 'clash-1', dependency_type: 'incompatible' },
          { project_id: 'inside', version_id: null, dependency_type: 'embedded' },
        ]),
        version('clash-1', 'clash'),
      ]),
    })
    expect(plan.dependencies.map((node) => [node.projectId, node.state])).toEqual([
      ['clash', 'incompatible'],
      ['inside', 'embedded'],
    ])
    expect(plan.install.map((item) => item.versionId)).toEqual(['root'])
  })

  test('an instance without a loader does not pretend there are no dependencies', async () => {
    const plan = await planModrinthInstall({
      rootVersionId: 'root',
      minecraft: '1.20.1',
      loaders: [],
      lookup: lookup([version('root', 'root')]),
    })
    expect(plan.blocked[0]?.code).toBe('context')
    expect(plan.dependencies).toEqual([])
    expect(plan.install).toEqual([])
  })
})
