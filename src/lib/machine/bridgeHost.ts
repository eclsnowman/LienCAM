import { readRegisteredSessionData, writeRegisteredSessionData } from '../../store/persistedKeys'
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

/** WO-2845 (ADR-0058 D4): what an operator's Connect, Start or Restart adds to
 *  a supervisor launch. It asks; it does not decide. supervisor.mjs strips it
 *  and passes it to the bridge only when the bridge's last exit was the
 *  changed-DLL exit (12), and the bridge opens only the DLL that exit named -
 *  the same rule electron/main.cjs applies to its own restart. An automatic
 *  start (opening the Control page) never sends it. */
export const CONNECT_WITH_CHANGED_DLL = '--connect-with-changed-dll'

export interface BridgeStartOptions {
  /** True only for an operator's press (Connect, Start, Restart). */
  operatorPress?: boolean
}

function supervisorLaunchArguments(settings: MachineBridgeLaunchSettings | undefined, options: BridgeStartOptions): string[] {
  const args = machineBridgeArguments(settings)
  return options.operatorPress ? [...args, CONNECT_WITH_CHANGED_DLL] : args
}

export interface BridgeLastExit {
  code: number | null
  signal: string | null
  error: string | null
  /** WO-2847 fix round 3: this exit ends a firmware update whose outcome the
   * host already carries as this console line (BridgeProcessStatus consoleLines). */
  consoleLineId?: string
}

export interface BridgeRespawnStatus {
  attempts: number
  gaveUp: boolean
  lastAttemptAt: number | null
}

/** WO-2847: a line the bridge could not say to a live session, carried by the
 * desktop host (electron/main.cjs) so it still reaches the Control console. */
export interface BridgeConsoleLine {
  id: string
  severity: 'info' | 'warn' | 'error'
  text: string
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
  /** WO-2847: set while the running bridge waits out a controller firmware update. */
  firmwareUpdate?: { since: number; line: string } | null
  /** WO-2847: host-carried console lines, each to be said once (takeBridgeConsoleLines). */
  consoleLines?: BridgeConsoleLine[]
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
  | { ok: false; reason: 'no-socket'; pid: number; port: number; firmwareUpdate?: boolean }
  | { ok: false; reason: 'not-configured' }
  | { ok: false; reason: 'unhosted' }

export type BridgeStopResult =
  | { ok: true }
  | { ok: false; reason: 'unhosted' | 'stop-timeout' }

interface BridgeProcessHost {
  machineBridgeStatus: () => Promise<BridgeProcessStatus>
  machineBridgeStart?: (settings?: MachineBridgeLaunchSettings) => Promise<Exclude<BridgeRestartResult, { reason: 'unhosted' }>>
  machineBridgeRestart: (settings?: MachineBridgeLaunchSettings, options?: BridgeStartOptions) => Promise<Exclude<BridgeRestartResult, { reason: 'unhosted' }>>
  machineBridgeStop?: () => Promise<BridgeStopResult>
  chooseMachinePath?: (kind: MachinePathKind) => Promise<string | null>
}

type HostedBridgeProcess = Partial<BridgeProcessHost>
  & Pick<BridgeProcessHost, 'machineBridgeRestart'>

let supervisorReachability: 'unknown' | 'reachable' | 'unreachable' = 'unknown'

/** WO-3290: the desktop host hears the press too. A fresh Linux install starts
 *  its bridge on the operator's first Connect, never on opening Control. */
function hostedRestart(host: HostedBridgeProcess, settings: MachineBridgeLaunchSettings | undefined, options: BridgeStartOptions) {
  return options.operatorPress === true
    ? host.machineBridgeRestart(settings, { operatorPress: true })
    : host.machineBridgeRestart(settings)
}

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
  options: BridgeStartOptions = {},
): Promise<BridgeRestartResult> {
  const host = hostedBridgeProcess()
  if (host !== null) {
    return typeof host.machineBridgeStart === 'function'
      ? host.machineBridgeStart(settings)
      : hostedRestart(host, settings, options)
  }
  try {
    const result = await supervisorStartBridge(bridgePort, supervisorLaunchArguments(settings, options))
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
  options: BridgeStartOptions = {},
): Promise<BridgeRestartResult> {
  const host = hostedBridgeProcess()
  if (host !== null) return hostedRestart(host, settings, options)
  try {
    const result = await supervisorRestartBridge(bridgePort, supervisorLaunchArguments(settings, options))
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

/**
 * WO-2847 fix round 2 (ADR-0058 point 6): a controller firmware update runs
 * inside the bridge's Open - at startup before it listens, or while nobody is
 * connected - so its lines cannot depend on a socket. The desktop host keeps
 * the ones no session heard; this hands each out ONCE per window, by id, and
 * remembers the ids across a reload, so a later status read, a remounted
 * Control page or a reconnect never says one again.
 */
let bridgeConsoleSaid: Set<string> | null = null

function saidBridgeConsoleLines(): Set<string> {
  if (bridgeConsoleSaid !== null) return bridgeConsoleSaid
  bridgeConsoleSaid = new Set()
  try {
    const stored = JSON.parse(readRegisteredSessionData('bridgeConsoleSaid') ?? '[]')
    if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'string') bridgeConsoleSaid.add(id)
  } catch {
    // No storage: once per page life is still once per event shown here.
  }
  return bridgeConsoleSaid
}

export function takeBridgeConsoleLines(status: BridgeProcessStatus | null): BridgeConsoleLine[] {
  const lines = status?.consoleLines
  if (!Array.isArray(lines) || lines.length === 0) return []
  const said = saidBridgeConsoleLines()
  const fresh = lines.filter((line) => typeof line?.id === 'string' && !said.has(line.id))
  if (fresh.length === 0) return []
  for (const line of fresh) said.add(line.id)
  try {
    writeRegisteredSessionData('bridgeConsoleSaid', JSON.stringify([...said].slice(-100)))
  } catch {
    // As above.
  }
  return fresh
}

const BRIDGE_UPDATING_SENTENCE = 'Not connected yet: the controller is updating its firmware. Do not close LienCAM or power off the controller; press Connect again once the console says the update finished.'

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
  // WO-2847 fix round 3: a firmware update's outcome has one carrier, the
  // host's console line, so Connect says only what it adds itself.
  if (result.reason === 'exited' && result.lastExit?.consoleLineId) {
    return 'Not connected: Connect did not open the controller - see the firmware update line above.'
  }
  if (result.reason === 'no-socket' && result.firmwareUpdate) return BRIDGE_UPDATING_SENTENCE
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
  onStatus?: (status: BridgeProcessStatus) => void,
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
  // WO-2847: lines the host is still carrying (a failed startup update's
  // outcome) are said before anything this press says.
  onStatus?.(status)
  if (status.running && status.firmwareUpdate) {
    // A startup update runs before the bridge listens, so the socket may not
    // answer yet; a lost-board update keeps listening. Try it, and if nothing
    // answers say why, instead of a bare connection error.
    return {
      kind: 'not-started',
      sentence: BRIDGE_UPDATING_SENTENCE,
      socketMayAnswer: true,
    }
  }
  if (status.running) return { kind: 'ready' }
  // The Connect press itself.
  const result = await hostedRestart(host, settings, { operatorPress: true })
  if (!result.ok) {
    if (result.reason === 'exited' && result.lastExit?.consoleLineId) {
      // The child this press started ended a firmware update: its outcome is
      // the host's line, said here first, so the sentence below can point at it.
      try {
        onStatus?.(await host.machineBridgeStatus())
      } catch {
        // The status poll says it instead.
      }
    }
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
