import {
  BridgeSupervisorUnavailableError,
  supervisorBridgeStatus,
  supervisorRestartBridge,
  supervisorStartBridge,
  supervisorStopBridge,
} from './bridgeSupervisorClient'
import type { MachineBridgeLaunchSettings } from '../../store/uiPrefs'

export type MachinePathKind = 'install-root' | 'vfd-definition'

export function machineBridgeArguments(settings?: MachineBridgeLaunchSettings): string[] {
  const installRoot = typeof settings?.installRoot === 'string' ? settings.installRoot.trim() : ''
  const profile = typeof settings?.profile === 'string' ? settings.profile.trim() : ''
  const configuredBoard = settings?.board
  const board = configuredBoard === 'auto'
    || (typeof configuredBoard === 'number' && Number.isInteger(configuredBoard))
    ? String(configuredBoard)
    : 'auto'
  return [
    ...(installRoot ? ['--install-root', installRoot] : []),
    ...(profile ? ['--profile', profile] : []),
    '--board', board,
  ]
}

export interface BridgeLastExit {
  code: number | null
  signal: string | null
  error: string | null
}

export interface BridgeRespawnStatus {
  attempts: number
  gaveUp: boolean
  lastAttemptAt: number | null
}

export interface BridgeProcessStatus {
  configured: boolean
  running: boolean
  pid: number | null
  lastExit: BridgeLastExit | null
  respawn: BridgeRespawnStatus
  bridgePort?: number
  health?: 'stopped' | 'starting' | 'healthy' | 'failing'
  failureReason?: string | null
  lastLogs?: string[]
  setup?: {
    state: 'idle' | 'building' | 'ready' | 'missing-install' | 'failed'
    installRoot: string | null
    lookedFor: string | null
    logPath: string | null
    error: string | null
  }
}

export type BridgeRestartResult =
  | { ok: true; pid: number; port: number }
  | { ok: false; reason: 'exited'; lastExit: BridgeLastExit | null }
  | { ok: false; reason: 'no-socket'; pid: number; port: number }
  | { ok: false; reason: 'not-configured' }
  | { ok: false; reason: 'unhosted' }

export type BridgeStopResult =
  | { ok: true }
  | { ok: false; reason: 'unhosted' | 'stop-timeout' }

interface BridgeProcessHost {
  machineBridgeStatus: () => Promise<BridgeProcessStatus>
  machineBridgeStart?: (settings?: MachineBridgeLaunchSettings) => Promise<Exclude<BridgeRestartResult, { reason: 'unhosted' }>>
  machineBridgeRestart: (settings?: MachineBridgeLaunchSettings) => Promise<Exclude<BridgeRestartResult, { reason: 'unhosted' }>>
  machineBridgeStop?: () => Promise<BridgeStopResult>
  chooseMachinePath?: (kind: MachinePathKind) => Promise<string | null>
}

type HostedBridgeProcess = Partial<BridgeProcessHost>
  & Pick<BridgeProcessHost, 'machineBridgeRestart'>

let supervisorReachability: 'unknown' | 'reachable' | 'unreachable' = 'unknown'

function hostedBridgeProcess(): HostedBridgeProcess | null {
  const host = (window as typeof window & { liencamHost?: Partial<BridgeProcessHost> }).liencamHost
  return typeof host?.machineBridgeRestart === 'function'
    ? host as HostedBridgeProcess
    : null
}

/**
 * Answers only whether this bundle can own the bridge process. The restart
 * method is the capability: an older preload may expose status on the same
 * object, but showing a control it cannot honour would make that object lie.
 */
export function bridgeHostCapability(): 'hosted' | 'supervisor' | 'unhosted' {
  if (hostedBridgeProcess() !== null) return 'hosted'
  return supervisorReachability === 'reachable' ? 'supervisor' : 'unhosted'
}

/** An older desktop preload can report status but cannot own the process. */
export function hasLegacyBridgeStatusHost(): boolean {
  const host = (window as typeof window & { liencamHost?: Partial<BridgeProcessHost> }).liencamHost
  return typeof host?.machineBridgeStatus === 'function'
    && typeof host.machineBridgeRestart !== 'function'
}

export function hasNativeMachinePathPicker(): boolean {
  const host = (window as typeof window & { liencamHost?: Partial<BridgeProcessHost> }).liencamHost
  return typeof host?.chooseMachinePath === 'function'
}

export async function chooseMachinePath(kind: MachinePathKind): Promise<string | null> {
  const host = (window as typeof window & { liencamHost?: Partial<BridgeProcessHost> }).liencamHost
  return typeof host?.chooseMachinePath === 'function' ? host.chooseMachinePath(kind) : null
}

/**
 * WO-2106: A SUPERVISOR THAT IS NOT THERE IS NOT ASKED EVERY SECOND.
 *
 * Rehearsal 2026-09-27: the Control page reads process status every second,
 * and with no supervisor running every read was a refused connection on the
 * supervisor port - a red ERR_CONNECTION_REFUSED line in the browser console
 * each second, which no fetch can silence. After a refusal the status read
 * answers "no supervisor" from memory and asks again after a pause that
 * doubles up to a minute, so a supervisor started later is still found. Start,
 * restart and stop always ask, and an answer ends the pause. A read already in
 * flight is shared: a refused localhost connect takes a second or two on
 * Windows, and the next poll used to open a second one behind it (native-kit
 * run, WO-2106 evidence: the refusals came in threes).
 */
const SUPERVISOR_RETRY_FIRST_MS = 5_000
const SUPERVISOR_RETRY_MAX_MS = 60_000
const supervisorQuiet = new Map<number, { until: number; waitMs: number }>()
const supervisorStatusReads = new Map<number, Promise<BridgeProcessStatus | null>>()

function supervisorAnswered(bridgePort: number): void {
  supervisorReachability = 'reachable'
  supervisorQuiet.delete(bridgePort)
}

export async function bridgeProcessStatus(bridgePort = 8325): Promise<BridgeProcessStatus | null> {
  const host = hostedBridgeProcess()
  if (host !== null && typeof host.machineBridgeStatus === 'function') {
    return host.machineBridgeStatus()
  }
  const quiet = supervisorQuiet.get(bridgePort)
  if (quiet !== undefined && Date.now() < quiet.until) return null
  const inFlight = supervisorStatusReads.get(bridgePort)
  if (inFlight !== undefined) return inFlight
  const read = readSupervisorStatus(bridgePort, quiet)
    .finally(() => supervisorStatusReads.delete(bridgePort))
  supervisorStatusReads.set(bridgePort, read)
  return read
}

async function readSupervisorStatus(
  bridgePort: number,
  quiet: { waitMs: number } | undefined,
): Promise<BridgeProcessStatus | null> {
  try {
    const status = await supervisorBridgeStatus(bridgePort)
    supervisorAnswered(bridgePort)
    return status
  } catch (error) {
    if (error instanceof BridgeSupervisorUnavailableError) {
      supervisorReachability = 'unreachable'
      const waitMs = quiet === undefined
        ? SUPERVISOR_RETRY_FIRST_MS
        : Math.min(quiet.waitMs * 2, SUPERVISOR_RETRY_MAX_MS)
      supervisorQuiet.set(bridgePort, { until: Date.now() + waitMs, waitMs })
      return null
    }
    throw error
  }
}

export async function startBridge(
  bridgePort = 8325,
  settings?: MachineBridgeLaunchSettings,
): Promise<BridgeRestartResult> {
  const host = hostedBridgeProcess()
  if (host !== null) {
    return typeof host.machineBridgeStart === 'function'
      ? host.machineBridgeStart(settings)
      : host.machineBridgeRestart(settings)
  }
  try {
    const result = await supervisorStartBridge(bridgePort, machineBridgeArguments(settings))
    supervisorAnswered(bridgePort)
    return result
  } catch (error) {
    if (error instanceof BridgeSupervisorUnavailableError) {
      supervisorReachability = 'unreachable'
      return { ok: false, reason: 'unhosted' }
    }
    throw error
  }
}

/** Refusal is data, not an exception, so browser-only callers can stay honest. */
export async function restartBridge(
  bridgePort = 8325,
  settings?: MachineBridgeLaunchSettings,
): Promise<BridgeRestartResult> {
  const host = hostedBridgeProcess()
  if (host !== null) return host.machineBridgeRestart(settings)
  try {
    const result = await supervisorRestartBridge(bridgePort, machineBridgeArguments(settings))
    supervisorAnswered(bridgePort)
    return result
  } catch (error) {
    if (error instanceof BridgeSupervisorUnavailableError) {
      supervisorReachability = 'unreachable'
      return { ok: false, reason: 'unhosted' }
    }
    throw error
  }
}

export type HostedConnectPreparation =
  | { kind: 'ready' }
  | { kind: 'started'; again: boolean }
  | { kind: 'not-started'; sentence: string; socketMayAnswer: boolean }

/** One console sentence for a bridge that did not come up. An exit is named
 * by the bridge's own last line (WO-1306), never a paraphrase. */
export function bridgeNotStartedSentence(
  result: Exclude<BridgeRestartResult, { ok: true }>,
  status: BridgeProcessStatus | null = null,
): string {
  if (result.reason === 'exited') {
    const lastLine = result.lastExit?.error?.trim()
    return lastLine
      ? `Not connected: the machine connection stopped at start (${lastLine.replace(/[.]$/, '')}).`
      : 'Not connected: the machine connection stopped at start and printed nothing.'
  }
  if (result.reason === 'no-socket') {
    return `Not connected: the machine connection started but is not answering on port ${result.port}.`
  }
  if (result.reason === 'not-configured') {
    const setupError = status?.setup?.error?.trim()
    return setupError
      ? `Not connected: ${setupError}`
      : 'Not connected: the machine connection is not set up on this computer.'
  }
  return 'Not connected: this app cannot start the machine connection.'
}

/**
 * WO-2029 (Operator at the machine, 09-26): the desktop app started with the
 * controller off, its bridge child gave up, and Connect then did nothing until
 * the app was restarted. The desktop app owns that child, so a Connect press
 * that finds it not running starts it (the host resets its give-up state)
 * before the socket connect, or answers the one sentence saying why it could
 * not. Browser supervisors keep their own lifecycle row; they answer 'ready'.
 */
export async function prepareHostedBridgeForConnect(
  settings?: MachineBridgeLaunchSettings,
): Promise<HostedConnectPreparation> {
  const host = hostedBridgeProcess()
  if (host === null || typeof host.machineBridgeStatus !== 'function') return { kind: 'ready' }
  let status: BridgeProcessStatus
  try {
    status = await host.machineBridgeStatus()
  } catch {
    // Status is advisory: the socket connect reports its own concrete error.
    return { kind: 'ready' }
  }
  if (status.running) return { kind: 'ready' }
  const result = await host.machineBridgeRestart(settings)
  if (!result.ok) {
    return {
      kind: 'not-started',
      sentence: bridgeNotStartedSentence(result, status),
      // A restart that ran its child probed the port first, so a bridge serving
      // it would already have answered. An app with no bridge set up never
      // looked, and a bridge the operator started outside the app may be
      // serving it (main connected here; review FAIL 09-26).
      socketMayAnswer: result.reason === 'not-configured',
    }
  }
  return {
    kind: 'started',
    again: status.lastExit !== null || status.respawn.gaveUp || status.respawn.attempts > 0,
  }
}

export async function stopBridge(bridgePort = 8325): Promise<BridgeStopResult> {
  const host = hostedBridgeProcess()
  if (host !== null) {
    return typeof host.machineBridgeStop === 'function'
      ? host.machineBridgeStop()
      : { ok: false, reason: 'unhosted' }
  }
  try {
    const result = await supervisorStopBridge(bridgePort)
    supervisorAnswered(bridgePort)
    return result
  } catch (error) {
    if (error instanceof BridgeSupervisorUnavailableError) {
      supervisorReachability = 'unreachable'
      return { ok: false, reason: 'unhosted' }
    }
    throw error
  }
}
