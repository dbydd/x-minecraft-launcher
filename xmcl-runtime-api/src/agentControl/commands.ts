import { z } from 'zod'
import {
  AGENT_CONTROL_DENYLIST,
  DEFAULT_WRITABLE_ROOTS,
  type ContentHash,
  type InstanceId,
  type VirtualPath,
  asContentHash,
  asInstanceId,
  asVirtualPath,
  asWritableRoot,
} from './types'

const unsafePath = (value: string) =>
  !value ||
  value.includes('\0') ||
  value.includes('\\') ||
  value.startsWith('/') ||
  /^[a-zA-Z]:/.test(value)

export const InstanceIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0') && !value.includes('\n'), 'Invalid instance id')
  .transform(asInstanceId)

export const VirtualPathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (unsafePath(value)) return false
    return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  }, 'Invalid virtual path')
  .transform(asVirtualPath)

export const ContentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/i)
  .transform((value) => asContentHash(value.toLowerCase()))

export const WritableRootSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (unsafePath(value) || value.includes('/')) return false
    return true
  }, 'Invalid writable root')
  .transform(asWritableRoot)

export const VfsValidateSchema = z.enum(['json', 'toml', 'none'])

const replacementSchema = z.object({
  match: z.string().min(1),
  replace: z.string(),
  all: z.boolean().optional(),
})

export const VfsWriteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('content'),
    instanceId: InstanceIdSchema,
    path: VirtualPathSchema,
    expectedHash: z.union([ContentHashSchema, z.null()]),
    content: z.string(),
    validate: VfsValidateSchema.optional(),
  }),
  z.object({
    kind: z.literal('replacements'),
    instanceId: InstanceIdSchema,
    path: VirtualPathSchema,
    expectedHash: ContentHashSchema,
    replacements: z.array(replacementSchema).min(1),
    validate: VfsValidateSchema.optional(),
  }),
])

export const GrantSchema = z.object({
  instanceIds: z.array(InstanceIdSchema),
  allowNewInstances: z.boolean(),
  writableRoots: z.array(WritableRootSchema).min(1),
})

export function defaultGrant(instanceIds: InstanceId[] = []): z.infer<typeof GrantSchema> {
  return {
    instanceIds,
    allowNewInstances: true,
    writableRoots: DEFAULT_WRITABLE_ROOTS.map((root) => asWritableRoot(root)),
  }
}

export function isDeniedCommandName(name: string): boolean {
  return (AGENT_CONTROL_DENYLIST as readonly string[]).includes(name)
}

export type ParsedVfsWrite =
  | {
      kind: 'content'
      instanceId: InstanceId
      path: VirtualPath
      expectedHash: ContentHash | null
      content: string
      validate?: 'json' | 'toml' | 'none'
    }
  | {
      kind: 'replacements'
      instanceId: InstanceId
      path: VirtualPath
      expectedHash: ContentHash
      replacements: Array<{ match: string; replace: string; all?: boolean }>
      validate?: 'json' | 'toml' | 'none'
    }
