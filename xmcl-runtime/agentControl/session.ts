import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  AGENT_CONTROL_DENYLIST,
  agentError,
  defaultGrant,
  failure,
  isDeniedCommandName,
  success,
  type CommandResult,
  type Grant,
  type InstanceId,
  type SessionId,
  type SessionPhase,
  asSessionId,
  asWritableRoot,
} from '@xmcl/runtime-api'
import type { LauncherPort } from './port'
import { agentCommands, commandByName, type ControlDeps } from './registry'
import { TaskBook } from './tasks'

export interface SessionSnapshot {
  sessionId: SessionId
  tokenHash: string
  grant: Grant
}

export interface PairingOptions {
  instanceIds?: InstanceId[]
  allowNewInstances?: boolean
  writableRoots?: string[]
  ttlMs?: number
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest()
}

function hashesEqual(left: string, right: string) {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Pairing state machine: unpaired → pairing → paired → revoked.
 * A paired grant is the only thing that can run in-scope tools.
 */
export class AgentControlHost {
  private phase: SessionPhase = { status: 'unpaired' }
  private codeHash = ''
  private codeExpires = 0
  private tokenHash = ''
  private preset: PairingOptions = {}
  private sessionAbort = new AbortController()
  readonly tasks = new TaskBook()

  constructor(
    readonly port: LauncherPort,
    readonly changesRoot: string,
  ) {}

  getPhase(): SessionPhase {
    if (this.phase.status === 'pairing' && Date.now() > this.codeExpires)
      return { status: 'unpaired' }
    return this.phase
  }

  issuePairingCode(options: PairingOptions = {}): string {
    if (this.phase.status === 'revoked') throw new Error('Session is revoked')
    const code = randomBytes(24).toString('base64url')
    this.codeHash = sha256(code).toString('hex')
    this.codeExpires = Date.now() + (options.ttlMs ?? 10 * 60 * 1000)
    this.preset = options
    this.phase = { status: 'pairing', expiresAt: this.codeExpires }
    return code
  }

  async pair(
    code: string,
  ): Promise<CommandResult<{ token: string; sessionId: SessionId; grant: Grant }>> {
    if (this.phase.status === 'revoked')
      return failure(agentError('denied', 'Session is revoked', { retryable: false }))
    if (this.phase.status !== 'pairing' || Date.now() > this.codeExpires) {
      return failure(
        agentError('denied', 'Pairing code is missing or expired', { retryable: false }),
      )
    }
    const presented = sha256(code).toString('hex')
    if (!hashesEqual(this.codeHash, presented))
      return failure(agentError('denied', 'Pairing code is invalid', { retryable: false }))
    const listed =
      this.preset.instanceIds ?? (await this.port.listInstances()).map((instance) => instance.id)
    const grant = defaultGrant(listed)
    grant.allowNewInstances = this.preset.allowNewInstances ?? true
    if (this.preset.writableRoots?.length)
      grant.writableRoots = this.preset.writableRoots.map((root) => asWritableRoot(root))
    const token = randomBytes(32).toString('base64url')
    const sessionId = asSessionId(randomUUID())
    this.tokenHash = sha256(token).toString('hex')
    this.codeHash = ''
    this.phase = { status: 'paired', sessionId, grant }
    return success({ token, sessionId, grant })
  }

  restore(snapshot: SessionSnapshot) {
    this.tokenHash = snapshot.tokenHash
    this.phase = { status: 'paired', sessionId: snapshot.sessionId, grant: snapshot.grant }
  }

  exportSnapshot(): SessionSnapshot | undefined {
    if (this.phase.status !== 'paired') return undefined
    return { sessionId: this.phase.sessionId, tokenHash: this.tokenHash, grant: this.phase.grant }
  }

  revoke() {
    this.sessionAbort.abort()
    const sessionId =
      this.phase.status === 'paired' || this.phase.status === 'revoked'
        ? this.phase.sessionId
        : asSessionId(randomUUID())
    this.tokenHash = ''
    this.codeHash = ''
    this.phase = { status: 'revoked', sessionId }
  }

  async call(name: string, raw: unknown, token?: string): Promise<CommandResult<unknown>> {
    if (isDeniedCommandName(name) || (AGENT_CONTROL_DENYLIST as readonly string[]).includes(name)) {
      return failure(agentError('denied', `Command is denied: ${name}`, { retryable: false }))
    }
    const command = commandByName(name)
    if (!command)
      return failure(agentError('denied', `Unknown command: ${name}`, { retryable: false }))
    if (command.requiresPair) {
      if (this.phase.status !== 'paired')
        return failure(agentError('denied', 'Session is not paired', { retryable: false }))
      if (!token || !hashesEqual(this.tokenHash, sha256(token).toString('hex'))) {
        return failure(
          agentError('denied', 'Bearer token is missing or invalid', { retryable: false }),
        )
      }
    }
    const result = await command.run(raw ?? {}, this.deps())
    if (result.ok && name === 'session_revoke') this.revoke()
    return result
  }

  toolList() {
    return agentCommands.map((command) => ({
      name: command.name,
      description: command.description,
      inputSchema: command.inputSchema,
    }))
  }

  private deps(): ControlDeps {
    const phase = this.phase
    return {
      port: this.port,
      paired: phase.status === 'paired',
      grant: phase.status === 'paired' ? phase.grant : undefined,
      changesRoot: this.changesRoot,
      tasks: this.tasks,
      signal: this.sessionAbort.signal,
      rememberInstance: (id: InstanceId) => {
        if (this.phase.status !== 'paired') return
        if (!this.phase.grant.instanceIds.includes(id)) this.phase.grant.instanceIds.push(id)
      },
    }
  }
}

export function hashToken(token: string) {
  return sha256(token).toString('hex')
}
