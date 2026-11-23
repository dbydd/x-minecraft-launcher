import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  asChangeId,
  asInstanceId,
  asVirtualPath,
  asWritableRoot,
  type WritableRoot,
} from '@xmcl/runtime-api'
import {
  deleteVirtualFile,
  grepVirtualFiles,
  hashText,
  listVirtualDirectory,
  readVirtualFile,
  rollbackChange,
  writeVirtualFile,
} from './vfs'

const roots = ['config', 'kubejs', 'defaultconfigs', 'scripts'].map(asWritableRoot)
let dir: string

async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'xmcl-vfs-'))
  for (const root of ['config', 'kubejs', 'defaultconfigs', 'scripts', 'libraries']) {
    await mkdir(join(dir, root), { recursive: true })
  }
  return dir
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

function ctx(path: string, instance = dir) {
  return {
    instanceRoot: instance,
    instanceId: asInstanceId(instance),
    virtualPath: asVirtualPath(path),
    writableRoots: roots as readonly WritableRoot[],
    changesRoot: join(instance, '.changes'),
  }
}

describe('agent control vfs', () => {
  test('writes, conflicts, and rolls back config, kubejs, defaultconfigs, and scripts', async () => {
    const instance = await setup()
    for (const path of [
      'config/foo.toml',
      'kubejs/server_scripts/a.js',
      'defaultconfigs/common.json',
      'scripts/start.txt',
    ]) {
      await mkdir(join(instance, path.split('/').slice(0, -1).join('/')), { recursive: true })
      const initial = path.endsWith('.json')
        ? '{"a":1}\n'
        : path.endsWith('.toml')
          ? 'value = "alpha"\n'
          : 'alpha\n'
      const created = await writeVirtualFile(ctx(path), {
        kind: 'content',
        expectedHash: null,
        content: initial,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const conflict = await writeVirtualFile(ctx(path), {
        kind: 'content',
        expectedHash: hashText('stale'),
        content: initial,
        validate: 'none',
      })
      expect(conflict.ok).toBe(false)
      if (conflict.ok) return
      expect(conflict.error.code).toBe('conflict')
      expect(conflict.error.currentHash).toBe(created.data.hash)
      const edited = await writeVirtualFile(ctx(path), {
        kind: 'replacements',
        expectedHash: created.data.hash,
        replacements: [
          {
            match: path.endsWith('.json') ? '"a":1' : 'alpha',
            replace: path.endsWith('.json') ? '"a":2' : 'beta',
          },
        ],
        validate: 'none',
      })
      expect(edited.ok).toBe(true)
      const rolled = await rollbackChange({
        instanceRoot: instance,
        instanceId: asInstanceId(instance),
        changeId: edited.ok ? edited.data.changeId : asChangeId('missing'),
        changesRoot: join(instance, '.changes'),
        writableRoots: roots,
      })
      expect(rolled.ok).toBe(true)
      const body = await readFile(join(instance, path), 'utf8')
      expect(body).toBe(initial)
    }
  })

  test('breaks a hardlink instead of mutating the cache inode', async () => {
    const instance = await setup()
    const cache = await mkdtemp(join(tmpdir(), 'xmcl-cache-'))
    try {
      const source = join(cache, 'shared.toml')
      await writeFile(source, 'cached = true\n')
      await link(source, join(instance, 'config', 'shared.toml'))
      const before = hashText('cached = true\n')
      const written = await writeVirtualFile(ctx('config/shared.toml'), {
        kind: 'content',
        expectedHash: before,
        content: 'cached = false\n',
      })
      expect(written.ok).toBe(true)
      if (!written.ok) return
      expect(written.data.brokeLink).toBe(true)
      expect(await readFile(source, 'utf8')).toBe('cached = true\n')
      expect(await readFile(join(instance, 'config', 'shared.toml'), 'utf8')).toBe(
        'cached = false\n',
      )
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })

  test('refuses symlink follow, path escape, and shared directories', async () => {
    const instance = await setup()
    const outside = await mkdtemp(join(tmpdir(), 'xmcl-out-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await symlink(join(outside, 'secret.txt'), join(instance, 'config', 'linked.txt'))
      await symlink(outside, join(instance, 'config', 'linked-dir'))
      const linked = await writeVirtualFile(ctx('config/linked.txt'), {
        kind: 'content',
        expectedHash: null,
        content: 'nope',
      })
      expect(linked.ok).toBe(false)
      if (!linked.ok) expect(linked.error.code).toBe('denied')
      const throughDir = await writeVirtualFile(ctx('config/linked-dir/pwn.txt'), {
        kind: 'content',
        expectedHash: null,
        content: 'nope',
      })
      expect(throughDir.ok).toBe(false)
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
      const escape = await writeVirtualFile(ctx('config/../../outside.txt'), {
        kind: 'content',
        expectedHash: null,
        content: 'x',
        validate: 'none',
      })
      expect(escape.ok).toBe(false)
      if (!escape.ok) expect(escape.error.code).toBe('denied')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
    const shared = await writeVirtualFile(ctx('libraries/lwjgl.jar'), {
      kind: 'content',
      expectedHash: null,
      content: 'nope',
      validate: 'none',
    })
    expect(shared.ok).toBe(false)
    if (!shared.ok) expect(shared.error.code).toBe('denied')
  })

  test('lists, reads a window, greps, and rejects invalid toml', async () => {
    const instance = await setup()
    await writeFile(join(instance, 'config', 'a.toml'), 'value = 1\n')
    const listed = await listVirtualDirectory({
      ...ctx('config'),
      virtualPath: asVirtualPath('config'),
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.entries.some((entry) => entry.name === 'a.toml')).toBe(true)
    const read = await readVirtualFile(ctx('config/a.toml'), 0, 5)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.content).toBe('value')
    expect(read.data.truncated).toBe(true)
    const found = await grepVirtualFiles({
      instanceRoot: instance,
      roots,
      pattern: 'value',
      path: asVirtualPath('config'),
    })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.data.matches[0]?.file).toBe('config/a.toml')
    const bad = await writeVirtualFile(ctx('config/broken.toml'), {
      kind: 'content',
      expectedHash: null,
      content: 'value = [\n',
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('validation')
  })

  test('rollback refuses another instance, a stale postimage, a second attempt, and a swapped parent symlink', async () => {
    const instance = await setup()
    const other = await mkdtemp(join(tmpdir(), 'xmcl-other-'))
    const outside = await mkdtemp(join(tmpdir(), 'xmcl-swap-'))
    try {
      await mkdir(join(other, 'config'), { recursive: true })
      const created = await writeVirtualFile(ctx('config/a.txt'), {
        kind: 'content',
        expectedHash: null,
        content: 'one\n',
        validate: 'none',
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const edited = await writeVirtualFile(ctx('config/a.txt'), {
        kind: 'content',
        expectedHash: created.data.hash,
        content: 'two\n',
        validate: 'none',
      })
      expect(edited.ok).toBe(true)
      if (!edited.ok) return
      const foreign = await rollbackChange({
        instanceRoot: other,
        instanceId: asInstanceId(other),
        changeId: edited.data.changeId,
        changesRoot: join(instance, '.changes'),
        writableRoots: roots,
      })
      expect(foreign.ok).toBe(false)
      if (!foreign.ok) expect(foreign.error.code).toBe('denied')
      const newer = await writeVirtualFile(ctx('config/a.txt'), {
        kind: 'content',
        expectedHash: edited.data.hash,
        content: 'three\n',
        validate: 'none',
      })
      expect(newer.ok).toBe(true)
      const stale = await rollbackChange({
        instanceRoot: instance,
        instanceId: asInstanceId(instance),
        changeId: edited.data.changeId,
        changesRoot: join(instance, '.changes'),
        writableRoots: roots,
      })
      expect(stale.ok).toBe(false)
      if (!stale.ok) expect(stale.error.code).toBe('conflict')
      expect(await readFile(join(instance, 'config/a.txt'), 'utf8')).toBe('three\n')
      if (!newer.ok) return
      const once = await rollbackChange({
        instanceRoot: instance,
        instanceId: asInstanceId(instance),
        changeId: newer.data.changeId,
        changesRoot: join(instance, '.changes'),
        writableRoots: roots,
      })
      expect(once.ok).toBe(true)
      expect(await readFile(join(instance, 'config/a.txt'), 'utf8')).toBe('two\n')
      const twice = await rollbackChange({
        instanceRoot: instance,
        instanceId: asInstanceId(instance),
        changeId: newer.data.changeId,
        changesRoot: join(instance, '.changes'),
        writableRoots: roots,
      })
      expect(twice.ok).toBe(false)
      if (!twice.ok) expect(twice.error.code).toBe('conflict')
      expect(await readFile(join(instance, 'config/a.txt'), 'utf8')).toBe('two\n')
      await rm(join(instance, 'config'), { recursive: true })
      await symlink(outside, join(instance, 'config'))
      const swapped = await rollbackChange({
        instanceRoot: instance,
        instanceId: asInstanceId(instance),
        changeId: created.data.changeId,
        changesRoot: join(instance, '.changes'),
        writableRoots: roots,
      })
      expect(swapped.ok).toBe(false)
      if (!swapped.ok) expect(swapped.error.code).toBe('denied')
    } finally {
      await rm(other, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a failed change record leaves the previous file bytes in place', async () => {
    const instance = await setup()
    const created = await writeVirtualFile(ctx('config/a.txt'), {
      kind: 'content',
      expectedHash: null,
      content: 'one\n',
      validate: 'none',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const blocked = join(instance, 'not-a-directory')
    await writeFile(blocked, 'x')
    const kept = await writeVirtualFile(
      { ...ctx('config/a.txt'), changesRoot: blocked },
      { kind: 'content', expectedHash: created.data.hash, content: 'lost\n', validate: 'none' },
    )
    expect(kept.ok).toBe(false)
    if (!kept.ok) expect(kept.error.code).toBe('unavailable')
    expect(await readFile(join(instance, 'config/a.txt'), 'utf8')).toBe('one\n')
  })

  test('parallel writes with the same expectedHash cannot both succeed', async () => {
    const instance = await setup()
    const created = await writeVirtualFile(ctx('config/a.txt'), {
      kind: 'content',
      expectedHash: null,
      content: 'base\n',
      validate: 'none',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const [left, right] = await Promise.all([
      writeVirtualFile(ctx('config/a.txt'), {
        kind: 'content',
        expectedHash: created.data.hash,
        content: 'left\n',
        validate: 'none',
      }),
      writeVirtualFile(ctx('config/a.txt'), {
        kind: 'content',
        expectedHash: created.data.hash,
        content: 'right\n',
        validate: 'none',
      }),
    ])
    expect([left, right].filter((result) => result.ok)).toHaveLength(1)
    expect(
      [left, right].filter((result) => !result.ok && result.error.code === 'conflict'),
    ).toHaveLength(1)
    expect(['left\n', 'right\n']).toContain(await readFile(join(instance, 'config/a.txt'), 'utf8'))
  })

  test('refuses device names, does not read through symlinks, and delete drops only this hardlink', async () => {
    const instance = await setup()
    const device = await writeVirtualFile(ctx('config/CON'), {
      kind: 'content',
      expectedHash: null,
      content: 'nope',
      validate: 'none',
    })
    expect(device.ok).toBe(false)
    const outside = await mkdtemp(join(tmpdir(), 'xmcl-grep-'))
    const cache = await mkdtemp(join(tmpdir(), 'xmcl-del-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret-token')
      await symlink(join(outside, 'secret.txt'), join(instance, 'config', 'linked.txt'))
      expect((await readVirtualFile(ctx('config/linked.txt'))).ok).toBe(false)
      const found = await grepVirtualFiles({
        instanceRoot: instance,
        roots,
        pattern: 'secret-token',
      })
      expect(found.ok).toBe(true)
      if (!found.ok) return
      expect(found.data.matches).toEqual([])
      await writeFile(join(cache, 'shared.txt'), 'cached\n')
      await link(join(cache, 'shared.txt'), join(instance, 'config', 'shared.txt'))
      const current = await readVirtualFile(ctx('config/shared.txt'))
      expect(current.ok).toBe(true)
      if (!current.ok) return
      expect((await deleteVirtualFile(ctx('config/shared.txt'), current.data.hash)).ok).toBe(true)
      expect(await readFile(join(cache, 'shared.txt'), 'utf8')).toBe('cached\n')
    } finally {
      await rm(outside, { recursive: true, force: true })
      await rm(cache, { recursive: true, force: true })
    }
  })
})
