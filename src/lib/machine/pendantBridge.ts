import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'
import type { MachineStatus } from './controller'
import { currentToolOf } from './currentTool'

export type PendantBridgePhase = 'disabled' | 'connecting' | 'connected' | 'error'

export interface PendantBridgeSnapshot {
  enabled: boolean
  phase: PendantBridgePhase
  brokerUrl: string
  pairingToken: string
  connectedPendants: number
  lanIps: string[]
  brokerPort: number
  lastError: string | null
  lastActivity: string | null
}

export type PendantCommand =
  | { kind: 'jog-step'; axis: 'X' | 'Y' | 'Z'; deltaMm: number; feedMmMin: number }
  | { kind: 'jog-continuous'; axis: 'X' | 'Y' | 'Z'; direction: 1 | -1; feedMmMin: number }
  | { kind: 'jog-cancel' }
  | { kind: 'feed-hold' }
  | { kind: 'soft-reset' }
  | { kind: 'zero-axes'; axes: Array<'X' | 'Y' | 'Z'> }
  | { kind: 'select-wcs'; wcs: 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59' }
  | { kind: 'override'; channel: 'feed' | 'rapid' | 'spindle'; value: number }
  | { kind: 'spindle'; direction: 'cw' | 'ccw' | 'off' }
  | { kind: 'macro'; id: 'raise-z' | 'park-rear' | 'go-xy-zero' | 'center-table' }
  | {
      kind: 'probe-start'
      routineId: 'bore' | 'boss' | 'edge' | 'corner' | 'zSurface' | 'rectPocket' | 'rectBoss' | 'angle'
      params: {
        probeFeed: number
        searchTravel: number
        tipRadius: number
        nominalSize: number
        edgeAxis: 'X' | 'Y'
        edgeDirection: '+' | '-'
        pathClearConfirmed: boolean
      }
    }
  | { kind: 'apply-probe-zero' }

type ProbeRoutineId = Extract<PendantCommand, { kind: 'probe-start' }>['routineId']
type ProbeParams = Extract<PendantCommand, { kind: 'probe-start' }>['params']

export interface PendantCommandOutcome {
  ok: boolean
  error?: string
  data?: unknown
}

export interface PendantCommandContext {
  clientId: string
  emit: (event: string, data: unknown) => void
}

export type PendantCommandExecutor = (
  command: PendantCommand,
  context: PendantCommandContext,
) => PendantCommandOutcome | Promise<PendantCommandOutcome>

interface BridgeCommandEnvelope {
  type: 'command'
  requestId: string
  clientId: string
  command: unknown
}

interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
}

export type PendantWebSocketFactory = (url: string) => WebSocketLike

const WS_OPEN = 1
const STATUS_INTERVAL_MS = 67
const CONTINUOUS_JOG_WATCHDOG_MS = 350
const DEFAULT_SNAPSHOT: PendantBridgeSnapshot = {
  enabled: false,
  phase: 'disabled',
  brokerUrl: 'ws://127.0.0.1:8324/bridge',
  pairingToken: '',
  connectedPendants: 0,
  lanIps: [],
  brokerPort: 8324,
  lastError: null,
  lastActivity: null,
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseCommand(value: unknown): PendantCommand | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const kind = raw.kind
  if (kind === 'jog-step') {
    if (!['X', 'Y', 'Z'].includes(String(raw.axis)) || !finite(raw.deltaMm) || !finite(raw.feedMmMin)) return null
    return { kind, axis: raw.axis as 'X' | 'Y' | 'Z', deltaMm: raw.deltaMm, feedMmMin: raw.feedMmMin }
  }
  if (kind === 'jog-continuous') {
    if (!['X', 'Y', 'Z'].includes(String(raw.axis)) || (raw.direction !== 1 && raw.direction !== -1) || !finite(raw.feedMmMin)) return null
    return { kind, axis: raw.axis as 'X' | 'Y' | 'Z', direction: raw.direction, feedMmMin: raw.feedMmMin }
  }
  if (kind === 'jog-cancel' || kind === 'feed-hold' || kind === 'soft-reset' || kind === 'apply-probe-zero') return { kind }
  if (kind === 'zero-axes') {
    if (!Array.isArray(raw.axes) || raw.axes.length === 0 || raw.axes.some((axis) => !['X', 'Y', 'Z'].includes(String(axis)))) return null
    return { kind, axes: [...new Set(raw.axes as Array<'X' | 'Y' | 'Z'>)] }
  }
  if (kind === 'select-wcs') {
    if (!['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].includes(String(raw.wcs))) return null
    return { kind, wcs: raw.wcs as 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59' }
  }
  if (kind === 'override') {
    if (!['feed', 'rapid', 'spindle'].includes(String(raw.channel)) || !finite(raw.value)) return null
    return { kind, channel: raw.channel as 'feed' | 'rapid' | 'spindle', value: raw.value }
  }
  if (kind === 'spindle') {
    if (!['cw', 'ccw', 'off'].includes(String(raw.direction))) return null
    return { kind, direction: raw.direction as 'cw' | 'ccw' | 'off' }
  }
  if (kind === 'macro') {
    if (!['raise-z', 'park-rear', 'go-xy-zero', 'center-table'].includes(String(raw.id))) return null
    return { kind, id: raw.id as 'raise-z' | 'park-rear' | 'go-xy-zero' | 'center-table' }
  }
  if (kind === 'probe-start') {
    const params = raw.params as Record<string, unknown> | undefined
    if (
      !['bore', 'boss', 'edge', 'corner', 'zSurface', 'rectPocket', 'rectBoss', 'angle'].includes(String(raw.routineId))
      || !params
      || !finite(params.probeFeed)
      || !finite(params.searchTravel)
      || !finite(params.tipRadius)
      || !finite(params.nominalSize)
      || !['X', 'Y'].includes(String(params.edgeAxis))
      || !['+', '-'].includes(String(params.edgeDirection))
      || typeof params.pathClearConfirmed !== 'boolean'
    ) return null
    return {
      kind,
      routineId: raw.routineId as ProbeRoutineId,
      params: {
        probeFeed: params.probeFeed as number,
        searchTravel: params.searchTravel as number,
        tipRadius: params.tipRadius as number,
        nominalSize: params.nominalSize as number,
        edgeAxis: params.edgeAxis as ProbeParams['edgeAxis'],
        edgeDirection: params.edgeDirection as ProbeParams['edgeDirection'],
        pathClearConfirmed: params.pathClearConfirmed,
      },
    }
  }
  return null
}

// WO-426: the store no longer keeps GRBL's raw `Pn:` string - it holds the
// contract's decoded `inputs`. Rebuilt here so the pendant's wire payload
// (out of this WO's owned paths) is unchanged for every letter anything in
// this app ever inspected (X/Y/Z limits, Probe, Door, Hold). GRBL's own R/S
// (reset/cycle-start) pins were never read anywhere in-app and are not in
// the contract, so they are not reconstructed.
function pinsString(inputs: MachineStatus['inputs']): string {
  if (!inputs) return ''
  let out = ''
  if (inputs.limits?.x) out += 'X'
  if (inputs.limits?.y) out += 'Y'
  if (inputs.limits?.z) out += 'Z'
  if (inputs.probe) out += 'P'
  if (inputs.door) out += 'D'
  if (inputs.hold) out += 'H'
  return out
}

function machineStatusPayload() {
  const state = useMachineControl.getState()
  const mpos = state.mpos ? [state.mpos.x, state.mpos.y, state.mpos.z] : [0, 0, 0]
  const wpos = state.wpos ? [state.wpos.x, state.wpos.y, state.wpos.z] : [0, 0, 0]
  return {
    state: state.machineState === 'unknown'
      ? 'Unknown'
      : state.machineState.charAt(0).toUpperCase() + state.machineState.slice(1),
    mpos,
    wpos,
    wco: mpos.map((value, index) => value - wpos[index]),
    activeWcs: state.activeWcs ?? 'G54',
    theme: useUiPrefs.getState().uiTheme,
    colorMode: useUiPrefs.getState().uiColorMode,
    feed: state.feed ?? 0,
    spindleRpm: state.spindleRpm ?? 0,
    spindleState: state.reportedAccessories.spindle,
    overrides: { ...state.overrides },
    overrideAvailability: { ...state.overrideAvailability },
    parserState: {
      motion: state.parserModal?.motionMode ?? null,
      distance: state.parserModal?.distanceMode ?? null,
      units: state.parserModal?.units ?? null,
      wcs: state.activeWcs,
      spindle: state.commandedAccessories?.spindle ?? null,
    },
    // WO-2878: the phone's tool readouts name the same tool as the Control
    // screen's chip and TOOL glance - one selector (raw activeTool lags a run).
    tool: currentToolOf(state) ?? 0,
    toolInfo: { number: currentToolOf(state) ?? 0, name: 'Active tool', diameterMm: null },
    tlo: state.tlo ?? 0,
    pins: pinsString(state.inputs),
  }
}

export class PendantBridgeClient {
  private readonly execute: PendantCommandExecutor
  private readonly socketFactory: PendantWebSocketFactory
  private snapshotValue: PendantBridgeSnapshot = { ...DEFAULT_SNAPSHOT }
  private readonly listeners = new Set<() => void>()
  private socket: WebSocketLike | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private jogWatchdog: ReturnType<typeof setTimeout> | null = null
  private activeJogClient: string | null = null
  private activeJogKey: string | null = null
  // WO-2468: one number per press. Client + key name the button, not the
  // press, so a late answer to an earlier press must not touch a newer one.
  private activeJogHold = 0
  private jogHoldCount = 0
  private commandQueue: Promise<void> = Promise.resolve()
  private generation = 0

  constructor(
    execute: PendantCommandExecutor,
    socketFactory: PendantWebSocketFactory = (url) => new WebSocket(url),
  ) {
    this.execute = execute
    this.socketFactory = socketFactory
  }

  snapshot = (): PendantBridgeSnapshot => this.snapshotValue

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  enable(brokerUrl: string, pairingToken: string): void {
    this.disable()
    if (!/^wss?:\/\//i.test(brokerUrl)) {
      this.patch({ enabled: false, phase: 'error', lastError: 'Broker URL must begin with ws:// or wss://.' })
      return
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(pairingToken)) {
      this.patch({ enabled: false, phase: 'error', lastError: 'Pairing code is invalid.' })
      return
    }
    const generation = ++this.generation
    this.patch({
      enabled: true,
      phase: 'connecting',
      brokerUrl,
      pairingToken,
      connectedPendants: 0,
      lanIps: [],
      lastError: null,
      lastActivity: null,
    })
    let socket: WebSocketLike
    try {
      socket = this.socketFactory(brokerUrl)
    } catch (error) {
      this.patch({ enabled: false, phase: 'error', lastError: error instanceof Error ? error.message : String(error) })
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (generation !== this.generation) return
      this.send({ type: 'hello', role: 'desktop', pairingToken })
    }
    socket.onmessage = (event) => {
      if (generation !== this.generation) return
      this.handleMessage(event.data)
    }
    socket.onerror = () => {
      if (generation !== this.generation) return
      this.patch({ phase: 'error', lastError: 'Could not reach the pendant broker.' })
    }
    socket.onclose = () => {
      if (generation !== this.generation) return
      this.cancelJog()
      this.stopStatus()
      this.socket = null
      this.patch({ enabled: false, phase: 'error', connectedPendants: 0, lastError: 'Pendant broker disconnected.' })
    }
  }

  disable(): void {
    this.generation++
    this.cancelJog()
    this.stopStatus()
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState <= WS_OPEN) socket.close(1000, 'Remote control disabled')
    this.snapshotValue = { ...DEFAULT_SNAPSHOT, brokerUrl: this.snapshotValue.brokerUrl }
    this.notify()
  }

  private patch(patch: Partial<PendantBridgeSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WS_OPEN) this.socket.send(JSON.stringify(message))
  }

  private handleMessage(text: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (message.type === 'hello-ack' && message.role === 'desktop') {
      this.patch({
        phase: 'connected',
        lanIps: Array.isArray(message.lanIps) ? message.lanIps.filter((ip): ip is string => typeof ip === 'string') : [],
        brokerPort: finite(message.port) ? message.port : 8324,
        lastError: null,
      })
      this.publishStatus()
      this.statusTimer = setInterval(() => this.publishStatus(), STATUS_INTERVAL_MS)
      return
    }
    if (message.type === 'clients') {
      const count = finite(message.connectedPendants) ? message.connectedPendants : message.count
      this.patch({ connectedPendants: finite(count) ? Math.max(0, Math.floor(count)) : 0 })
      return
    }
    if (message.type === 'status-request') {
      this.publishStatus()
      return
    }
    if (message.type === 'error') {
      this.patch({ phase: 'error', lastError: typeof message.error === 'string' ? message.error : 'Pendant broker error.' })
      return
    }
    if (message.type === 'command') this.acceptCommand(message as unknown as BridgeCommandEnvelope)
  }

  private publishStatus(): void {
    this.send({ type: 'status', data: machineStatusPayload() })
  }

  private acceptCommand(envelope: BridgeCommandEnvelope): void {
    if (typeof envelope.requestId !== 'string' || typeof envelope.clientId !== 'string') return
    const command = parseCommand(envelope.command)
    if (!command) {
      this.reply(envelope, { ok: false, error: 'The pendant sent an unsupported or invalid command.' })
      return
    }
    if (command.kind === 'feed-hold' || command.kind === 'soft-reset' || command.kind === 'jog-cancel') {
      void this.run(envelope, command)
      return
    }
    if (command.kind === 'jog-continuous') {
      if (this.activeJogClient && this.activeJogClient !== envelope.clientId) {
        this.reply(envelope, { ok: false, error: 'Another pendant is actively jogging. Release it first.' })
        return
      }
      const jogKey = `${command.axis}:${command.direction}:${command.feedMmMin}`
      if (this.activeJogClient === envelope.clientId && this.activeJogKey === jogKey) {
        this.armJogWatchdog(envelope.clientId, jogKey, this.activeJogHold)
        this.reply(envelope, { ok: true })
        return
      }
      if (this.activeJogClient) this.cancelJog()
      // WO-2468: armed BEFORE the start runs. A native start waits for the
      // controller's answer, and the phone's next keep-alive (every 150 ms)
      // must renew this jog rather than start a second one. Released before
      // the answer, the watchdog still sends the jog-cancel.
      const hold = ++this.jogHoldCount
      this.armJogWatchdog(envelope.clientId, jogKey, hold)
      void this.run(envelope, command).then((outcome) => {
        if (!outcome.ok && this.activeJogHold === hold) this.clearJogWatchdog()
      })
      return
    }
    this.commandQueue = this.commandQueue.then(async () => {
      await this.run(envelope, command)
    })
  }

  private async run(envelope: BridgeCommandEnvelope, command: PendantCommand): Promise<PendantCommandOutcome> {
    try {
      const outcome = await this.execute(command, {
        clientId: envelope.clientId,
        emit: (event, data) => this.send({ type: 'event', event, data, clientId: envelope.clientId }),
      })
      this.patch({
        lastActivity: outcome.ok
          ? `Remote ${command.kind} accepted.`
          : `Remote ${command.kind} refused: ${outcome.error ?? 'Machine state did not allow it.'}`,
      })
      if (command.kind === 'jog-cancel' || command.kind === 'feed-hold' || command.kind === 'soft-reset') this.clearJogWatchdog()
      this.reply(envelope, outcome)
      this.publishStatus()
      return outcome
    } catch (error) {
      const outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
      this.patch({ lastActivity: `Remote ${command.kind} failed: ${outcome.error}` })
      this.reply(envelope, outcome)
      return outcome
    }
  }

  private reply(envelope: BridgeCommandEnvelope, outcome: PendantCommandOutcome): void {
    this.send({ type: 'command-result', requestId: envelope.requestId, clientId: envelope.clientId, ...outcome })
  }

  private armJogWatchdog(clientId: string, jogKey: string, hold: number): void {
    this.clearJogWatchdog()
    this.activeJogClient = clientId
    this.activeJogKey = jogKey
    this.activeJogHold = hold
    this.jogWatchdog = setTimeout(() => this.cancelJog(), CONTINUOUS_JOG_WATCHDOG_MS)
  }

  private clearJogWatchdog(): void {
    if (this.jogWatchdog) clearTimeout(this.jogWatchdog)
    this.jogWatchdog = null
    this.activeJogClient = null
    this.activeJogKey = null
    this.activeJogHold = 0
  }

  private cancelJog(): void {
    if (!this.activeJogClient) return
    this.clearJogWatchdog()
    void this.execute({ kind: 'jog-cancel' }, { clientId: 'watchdog', emit: () => undefined })
  }

  private stopStatus(): void {
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null
  }
}

let defaultBridge: PendantBridgeClient | null = null

export function configurePendantBridge(execute: PendantCommandExecutor): PendantBridgeClient {
  defaultBridge?.disable()
  defaultBridge = new PendantBridgeClient(execute)
  return defaultBridge
}

export function getPendantBridge(): PendantBridgeClient {
  if (!defaultBridge) throw new Error('Pendant bridge has not been configured.')
  return defaultBridge
}
