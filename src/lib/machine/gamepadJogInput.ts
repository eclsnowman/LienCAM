// WO-3259 (WO-3181 phase A): A GAMEPAD STEP-JOGS THE MACHINE, WITH A HELD DEADMAN.
//
// This module is the input adapter's logic and nothing else: no timers, no
// controller, no React. useControlGamepadJog reads the pad through a snapshot
// provider, hands each sample here with what the app is doing, and carries out
// the actions this returns through the SAME wrapped controller.jog the Jog
// panel's step mode calls - so every refusal, kept stop and E-STOP door the
// pointer jog meets, the pad meets too. No keyboard emulation, no new G-code,
// no new transport.
//
// THE CONTRACT (WO-3181's proposals, adjustable in Settings, not the operator's approved numbers):
//   dead zone     q(a, d) = 0 if |a| <= d, else sign(a) * (|a| - d) / (1 - d)
//                 0 <= d < 1; default 0.20; Settings offers 0.05..0.50.
//   step          delta = sign(q) * machineJogStepMm - never |q| * step. The
//                 pad asks for the Jog panel's step, in mm as stored.
//   feed          machineJogFeedMmMin * speedScale, 0 < speedScale <= 1.
//   one gesture   one step per fresh gesture: a direction leaving neutral
//                 while armed. Holding it, or moving further, sends nothing
//                 more until it returns to neutral (a mapped stick: neutral for
//                 GAMEPAD_STICK_SETTLE_MS, so its spring-back is not a press).
//   deadman       a fresh press at neutral arms; release disarms and cancels a
//                 step this adapter still owns. A deadman already held when the
//                 adapter is enabled, focused or returned to never arms. While
//                 it stays held the arm stays: our own step moving is not lost
//                 eligibility (operator ruling 2026-10-30, "unless I let go of the dead
//                 man it doesn't disable the step").
//   one axis      two mapped axes at once, or both directions of one, send
//                 nothing and say once that simultaneous axes are not
//                 implemented. A direction on an axis the machine does not
//                 enable sends nothing and says so once.
//
// Step mode only. Continuous hold is WO-3260.

import { create } from 'zustand'
import { textFor } from '../../i18n'

export type GamepadJogAxis = 'X' | 'Y' | 'Z'
export type GamepadJogDirection = 'X+' | 'X-' | 'Y+' | 'Y-' | 'Z+' | 'Z-'
export const GAMEPAD_JOG_DIRECTIONS: readonly GamepadJogDirection[] = ['X+', 'X-', 'Y+', 'Y-', 'Z+', 'Z-']
export const GAMEPAD_JOG_AXES: readonly GamepadJogAxis[] = ['X', 'Y', 'Z']

export const GAMEPAD_JOG_SCHEMA_VERSION = 1
export const GAMEPAD_DEAD_ZONE_DEFAULT = 0.2
export const GAMEPAD_DEAD_ZONE_MIN = 0.05
export const GAMEPAD_DEAD_ZONE_MAX = 0.5
export const GAMEPAD_SPEED_SCALE_DEFAULT = 1
/** How often the Control hook reads the pad (ms). */
export const GAMEPAD_POLL_MS = 20
/** Two reads further apart than this mean the reads stopped (a throttled
 *  background tab, a stalled page): what was held may no longer be held. */
export const GAMEPAD_STALE_READ_MS = 250
/** How far a raw axis must travel from where it rested for Settings to
 *  capture it. A capture threshold only; jogging uses the dead zone. */
export const GAMEPAD_CAPTURE_TRAVEL = 0.5
/** A mapped stick must stay inside the dead zone this long (ms) before its
 *  next push counts as fresh. The operator's pad (machine PC, 2026-10-30) let go from a
 *  full push overshot to -0.33 for one 30 ms sample past the 0.20 dead zone;
 *  without this the spring-back is an opposite step. Buttons do not bounce
 *  and need no settle (his fastest D-pad re-press was 88 ms). */
export const GAMEPAD_STICK_SETTLE_MS = 100

/** One raw input on the pad: a button, or one half of an axis. */
export type GamepadRawInput =
  | { kind: 'button'; index: number }
  | { kind: 'axis'; index: number; sign: 1 | -1 }

/** What uiPrefs keeps. Never a slot index, an enable, an arm, a handle or a
 *  sample: those belong to one session and one plug-in. */
export interface GamepadJogPrefs {
  schemaVersion: typeof GAMEPAD_JOG_SCHEMA_VERSION
  /** Which pad these mappings were captured on (gamepadFingerprint). */
  deviceFingerprint: string | null
  mappings: Record<GamepadJogDirection, GamepadRawInput | null>
  deadman: { kind: 'button'; index: number } | null
  deadZone: number
  inverted: Record<GamepadJogAxis, boolean>
  speedScale: number
}

/** A read of one pad, copied from the browser's Gamepad object. */
export interface GamepadSnapshot {
  id: string
  index: number
  connected: boolean
  timestamp: number
  axes: readonly number[]
  buttons: readonly { pressed: boolean; value: number }[]
}

/** navigator.getGamepads(), or a test's stand-in. A slot may be null. */
export type GamepadSnapshotProvider = () => readonly (GamepadSnapshot | null)[]

export function emptyGamepadJogPrefs(deviceFingerprint: string | null = null): GamepadJogPrefs {
  return {
    schemaVersion: GAMEPAD_JOG_SCHEMA_VERSION,
    deviceFingerprint,
    mappings: { 'X+': null, 'X-': null, 'Y+': null, 'Y-': null, 'Z+': null, 'Z-': null },
    deadman: null,
    deadZone: GAMEPAD_DEAD_ZONE_DEFAULT,
    inverted: { X: false, Y: false, Z: false },
    speedScale: GAMEPAD_SPEED_SCALE_DEFAULT,
  }
}

// ── Numbers ──────────────────────────────────────────────────────────────

/** The dead-zone normalization. A non-finite reading is neutral. */
export function normalizeGamepadAxis(a: number, deadZone: number): number {
  if (!Number.isFinite(a)) return 0
  const clamped = Math.max(-1, Math.min(1, a))
  const magnitude = Math.abs(clamped)
  if (magnitude <= deadZone) return 0
  return Math.sign(clamped) * (magnitude - deadZone) / (1 - deadZone)
}

/** The one step the pad asks for: the Jog panel's step, signed. */
export function gamepadStepDeltaMm(q: number, machineJogStepMm: number): number {
  return q === 0 ? 0 : Math.sign(q) * machineJogStepMm
}

/** The Jog panel's feed scaled by this pad's speed scale. */
export function gamepadStepFeedMmMin(machineJogFeedMmMin: number, speedScale: number): number {
  return machineJogFeedMmMin * speedScale
}

export function validDeadZone(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1
}

export function validSpeedScale(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
}

// ── Pads ─────────────────────────────────────────────────────────────────

/** Copy a browser Gamepad into a plain snapshot (the live object mutates). */
export function snapshotOf(pad: Gamepad | null | undefined): GamepadSnapshot | null {
  if (pad === null || pad === undefined) return null
  return {
    id: pad.id,
    index: pad.index,
    connected: pad.connected,
    timestamp: pad.timestamp,
    axes: [...pad.axes],
    buttons: pad.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
  }
}

/** The browser's pads. Absent API (a host without it) reads as no pads. */
export const browserGamepadSnapshots: GamepadSnapshotProvider = () => {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return []
  try {
    return Array.from(navigator.getGamepads(), (pad) => snapshotOf(pad))
  } catch {
    return []
  }
}

let provider: GamepadSnapshotProvider = browserGamepadSnapshots

/** The provider the Control hook and Settings read through. */
export function gamepadSnapshots(): readonly (GamepadSnapshot | null)[] {
  return provider()
}

/** Tests and desk evidence install a scripted pad here; null restores the browser. */
export function installGamepadSnapshotProvider(next: GamepadSnapshotProvider | null): void {
  provider = next ?? browserGamepadSnapshots
}

/** How a pad is found again: its id and shape, never its slot. */
export function gamepadFingerprint(pad: Pick<GamepadSnapshot, 'id' | 'axes' | 'buttons'>): string {
  return `${pad.id} [${pad.axes.length} axes, ${pad.buttons.length} buttons]`
}

/** The first connected pad with this fingerprint, or null. */
export function findGamepad(
  pads: readonly (GamepadSnapshot | null)[],
  fingerprint: string | null,
): GamepadSnapshot | null {
  if (fingerprint === null) return null
  for (const pad of pads) {
    if (pad !== null && pad.connected && gamepadFingerprint(pad) === fingerprint) return pad
  }
  return null
}

export function connectedGamepads(pads: readonly (GamepadSnapshot | null)[]): GamepadSnapshot[] {
  return pads.filter((pad): pad is GamepadSnapshot => pad !== null && pad.connected)
}

// ── Stored preferences ───────────────────────────────────────────────────

export type GamepadJogPrefsRead =
  | { status: 'unmapped' }
  | { status: 'ok'; prefs: GamepadJogPrefs }
  /** A version this build does not know, or a blob it cannot read. Inactive
   *  until the operator edits and applies, or resets. */
  | { status: 'unreadable' }

function rawInput(value: unknown): GamepadRawInput | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (!Number.isInteger(v.index) || (v.index as number) < 0) return undefined
  if (v.kind === 'button') return { kind: 'button', index: v.index as number }
  if (v.kind === 'axis' && (v.sign === 1 || v.sign === -1)) {
    return { kind: 'axis', index: v.index as number, sign: v.sign }
  }
  return undefined
}

/** Read what uiPrefs holds. Absent (an older blob) is unmapped. */
export function readGamepadJogPrefs(stored: unknown): GamepadJogPrefsRead {
  if (stored === null || stored === undefined) return { status: 'unmapped' }
  if (typeof stored !== 'object') return { status: 'unreadable' }
  const s = stored as Record<string, unknown>
  if (s.schemaVersion !== GAMEPAD_JOG_SCHEMA_VERSION) return { status: 'unreadable' }
  const prefs = emptyGamepadJogPrefs(typeof s.deviceFingerprint === 'string' ? s.deviceFingerprint : null)
  const mappings = s.mappings
  if (mappings === null || typeof mappings !== 'object') return { status: 'unreadable' }
  for (const direction of GAMEPAD_JOG_DIRECTIONS) {
    const input = rawInput((mappings as Record<string, unknown>)[direction] ?? null)
    if (input === undefined) return { status: 'unreadable' }
    prefs.mappings[direction] = input
  }
  const deadman = rawInput(s.deadman ?? null)
  if (deadman === undefined || (deadman !== null && deadman.kind !== 'button')) return { status: 'unreadable' }
  prefs.deadman = deadman
  if (!validDeadZone(s.deadZone) || !validSpeedScale(s.speedScale)) return { status: 'unreadable' }
  prefs.deadZone = s.deadZone
  prefs.speedScale = s.speedScale
  const inverted = s.inverted
  if (inverted === null || typeof inverted !== 'object') return { status: 'unreadable' }
  for (const axis of GAMEPAD_JOG_AXES) {
    const flag = (inverted as Record<string, unknown>)[axis]
    if (typeof flag !== 'boolean') return { status: 'unreadable' }
    prefs.inverted[axis] = flag
  }
  return { status: 'ok', prefs }
}

export function sameRawInput(a: GamepadRawInput | null, b: GamepadRawInput | null): boolean {
  if (a === null || b === null || a.kind !== b.kind || a.index !== b.index) return false
  return a.kind === 'button' || (b.kind === 'axis' && a.sign === b.sign)
}

export type GamepadMappingClash =
  | { kind: 'deadman-is-direction'; direction: GamepadJogDirection }
  | { kind: 'shared'; first: GamepadJogDirection; second: GamepadJogDirection }

/** The first raw input two roles share, or null. A deadman that is also a
 *  direction would arm and move on one press; two directions on one input
 *  would make every press a conflict. */
export function gamepadMappingClash(prefs: GamepadJogPrefs): GamepadMappingClash | null {
  for (const direction of GAMEPAD_JOG_DIRECTIONS) {
    const input = prefs.mappings[direction]
    if (prefs.deadman !== null && input !== null && input.kind === 'button' && input.index === prefs.deadman.index) {
      return { kind: 'deadman-is-direction', direction }
    }
  }
  for (let i = 0; i < GAMEPAD_JOG_DIRECTIONS.length; i++) {
    for (let j = i + 1; j < GAMEPAD_JOG_DIRECTIONS.length; j++) {
      const first = GAMEPAD_JOG_DIRECTIONS[i]
      const second = GAMEPAD_JOG_DIRECTIONS[j]
      if (sameRawInput(prefs.mappings[first], prefs.mappings[second])) return { kind: 'shared', first, second }
    }
  }
  return null
}

// ── Reading a sample ─────────────────────────────────────────────────────

/** How far one mapped direction is pressed, 0..1. Unreadable input is 0. */
export function directionLevel(
  pad: GamepadSnapshot,
  input: GamepadRawInput | null,
  deadZone: number,
): number {
  if (input === null) return 0
  if (input.kind === 'button') return pad.buttons[input.index]?.pressed === true ? 1 : 0
  const raw = pad.axes[input.index]
  if (raw === undefined) return 0
  return Math.max(0, input.sign * normalizeGamepadAxis(raw, deadZone))
}

/** One XYZ axis's signed value: plus level minus minus level, inverted if set.
 *  `opposed` is both directions pressed at once. */
export function axisSignal(
  pad: GamepadSnapshot,
  prefs: GamepadJogPrefs,
  axis: GamepadJogAxis,
): { value: number; opposed: boolean } {
  const plus = directionLevel(pad, prefs.mappings[`${axis}+`], prefs.deadZone)
  const minus = directionLevel(pad, prefs.mappings[`${axis}-`], prefs.deadZone)
  const value = plus - minus
  return { value: prefs.inverted[axis] ? -value : value, opposed: plus > 0 && minus > 0 }
}

export type GamepadGesture =
  | { kind: 'neutral' }
  | { kind: 'direction'; axis: GamepadJogAxis; sign: 1 | -1; q: number }
  /** Two axes, or both directions of one: not implemented, so no motion. */
  | { kind: 'simultaneous' }

export function readGamepadGesture(pad: GamepadSnapshot, prefs: GamepadJogPrefs): GamepadGesture {
  const active: { axis: GamepadJogAxis; value: number }[] = []
  for (const axis of GAMEPAD_JOG_AXES) {
    const { value, opposed } = axisSignal(pad, prefs, axis)
    if (opposed) return { kind: 'simultaneous' }
    if (value !== 0) active.push({ axis, value })
  }
  if (active.length === 0) return { kind: 'neutral' }
  if (active.length > 1) return { kind: 'simultaneous' }
  const [{ axis, value }] = active
  return { kind: 'direction', axis, sign: value > 0 ? 1 : -1, q: value }
}

export function deadmanHeld(pad: GamepadSnapshot, prefs: GamepadJogPrefs): boolean {
  return prefs.deadman !== null && pad.buttons[prefs.deadman.index]?.pressed === true
}

/** A sample the adapter must not act on, or null when it is usable. */
export function unusableSample(
  pad: GamepadSnapshot,
  prefs: GamepadJogPrefs,
  lastTimestamp: number | null,
): 'disconnected' | 'invalid' | 'went-back' | null {
  if (!pad.connected) return 'disconnected'
  if (!Number.isFinite(pad.timestamp)) return 'invalid'
  if (lastTimestamp !== null && pad.timestamp < lastTimestamp) return 'went-back'
  const inputs = [...GAMEPAD_JOG_DIRECTIONS.map((d) => prefs.mappings[d]), prefs.deadman]
  for (const input of inputs) {
    if (input === null) continue
    if (input.kind === 'button') {
      const b = pad.buttons[input.index]
      if (b === undefined || typeof b.pressed !== 'boolean') return 'invalid'
    } else if (!Number.isFinite(pad.axes[input.index])) {
      return 'invalid'
    }
  }
  return null
}

/** Settings' capture: the first input that moved from where it rested. */
export function capturedRawInput(
  baseline: GamepadSnapshot,
  now: GamepadSnapshot,
  buttonsOnly = false,
): GamepadRawInput | null {
  for (let i = 0; i < now.buttons.length; i++) {
    if (now.buttons[i]?.pressed && !baseline.buttons[i]?.pressed) return { kind: 'button', index: i }
  }
  if (buttonsOnly) return null
  for (let i = 0; i < now.axes.length; i++) {
    const from = baseline.axes[i] ?? 0
    const to = now.axes[i]
    if (!Number.isFinite(to) || !Number.isFinite(from)) continue
    if (Math.abs(to - from) >= GAMEPAD_CAPTURE_TRAVEL) return { kind: 'axis', index: i, sign: to > from ? 1 : -1 }
  }
  return null
}

// ── The state machine ────────────────────────────────────────────────────

export type GamepadJogPhase =
  /** Enable is off for this session, or nothing usable is mapped. */
  | 'session-disabled'
  /** Enabled; waiting for the deadman released and every direction at rest. */
  | 'waiting-neutral'
  /** At rest: a fresh deadman press arms. */
  | 'ready'
  /** Deadman held: a fresh direction sends one step. */
  | 'armed'
  /** A direction is held and its one step has been asked for. */
  | 'active-step'

/** Why the adapter is not armed, for the status line. */
export type GamepadJogHoldReason =
  | 'disabled'
  | 'unmapped'
  | 'unreadable'
  | 'no-pad'
  | 'stale'
  | 'invalid'
  | 'away'
  | 'not-eligible'
  | 'stopped'
  | null

export interface GamepadJogContext {
  /** Monotonic time of this read (performance.now). */
  now: number
  enabled: boolean
  prefs: GamepadJogPrefsRead
  /** The pad found by fingerprint this read, or null. */
  pad: GamepadSnapshot | null
  /** Control is not the visible, focused, undisturbed workspace: another
   *  workspace, a dialog, typing focus, a hidden or blurred page. */
  away: boolean
  /** authorize('jog', currentJogAuthorityFacts(...)). */
  jogAllowed: boolean
  jogRefusal: string | null
  enabledAxes: readonly string[]
  machineState: string
  machineJogStepMm: number
  machineJogFeedMmMin: number
}

export type GamepadJogAction =
  | { type: 'jog'; axis: GamepadJogAxis; deltaMm: number; feedMmMin: number; gesture: number }
  /** Cancel the step this adapter owns (sent inside its own gesture). */
  | { type: 'cancel'; gesture: number }
  | { type: 'say'; text: GamepadJogSentence; axis?: GamepadJogAxis; refusal?: string }

export type GamepadJogSentence = 'simultaneous' | 'axis-not-enabled' | 'refused'

export class GamepadJogMachine {
  phase: GamepadJogPhase = 'session-disabled'
  hold: GamepadJogHoldReason = 'disabled'
  /** The gesture number of a step this adapter sent and still owns. */
  ownedStep: number | null = null
  private ownedSawMotion = false
  private gestureConsumed = false
  private nextGesture = 1
  private lastRead: number | null = null
  private lastTimestamp: number | null = null
  private lastPadIndex: number | null = null
  /** When a mapped stick was last outside the dead zone (performance.now). */
  private stickOutAt = Number.NEGATIVE_INFINITY

  /** Drop the arm. A step still owned is cancelled when `cancel` (a release,
   *  leaving, a dead read); a stop or another input already ended it. */
  private disarm(actions: GamepadJogAction[], cancel: boolean, next: GamepadJogPhase, hold: GamepadJogHoldReason): void {
    if (this.ownedStep !== null) {
      if (cancel) actions.push({ type: 'cancel', gesture: this.ownedStep })
      this.ownedStep = null
    }
    this.phase = next
    this.hold = hold
    this.gestureConsumed = false
  }

  /** Another input is about to move the machine (WO-3258 intent, not ours). */
  noteExternalIntent(): void {
    this.ownedStep = null
  }

  /** A stop went out or arrived (Feed Hold, Stop, Reset, E-STOP, another
   *  input's jog cancel). It already stopped what was moving. */
  noteStop(kind: string): GamepadJogAction[] {
    this.ownedStep = null
    if (kind === 'jog-cancel' || kind === 'jog-stop') return []
    if (this.phase === 'session-disabled') return []
    const actions: GamepadJogAction[] = []
    this.disarm(actions, false, 'waiting-neutral', 'stopped')
    return actions
  }

  /** The controller was replaced or disconnected. */
  noteConnection(): GamepadJogAction[] {
    this.ownedStep = null
    if (this.phase === 'session-disabled') return []
    const actions: GamepadJogAction[] = []
    this.disarm(actions, false, 'waiting-neutral', 'stopped')
    return actions
  }

  /** Leaving Control, a dialog, typing, blur, hidden, pagehide, a pad gone:
   *  stop the owned step now, without waiting for the next read. */
  leave(hold: GamepadJogHoldReason): GamepadJogAction[] {
    const actions: GamepadJogAction[] = []
    if (this.phase === 'session-disabled') return actions
    this.disarm(actions, true, 'waiting-neutral', hold)
    this.lastRead = null
    return actions
  }

  /** One read of the pad. Returns what the hook must do, in order. */
  step(ctx: GamepadJogContext): GamepadJogAction[] {
    const actions: GamepadJogAction[] = []
    const lastRead = this.lastRead
    this.lastRead = ctx.now

    if (this.ownedStep !== null) {
      // The UCCNC bridge reports a jog as 'run' (real board, 2026-10-30).
      if (ctx.machineState === 'jog' || ctx.machineState === 'run') this.ownedSawMotion = true
      else if (this.ownedSawMotion && ctx.machineState === 'idle') this.ownedStep = null
    }

    if (!ctx.enabled || ctx.prefs.status !== 'ok' || ctx.prefs.prefs.deadman === null) {
      const hold: GamepadJogHoldReason = !ctx.enabled
        ? 'disabled'
        : ctx.prefs.status === 'unreadable' ? 'unreadable' : 'unmapped'
      this.disarm(actions, true, 'session-disabled', hold)
      this.lastTimestamp = null
      return actions
    }
    const prefs = ctx.prefs.prefs
    if (this.phase === 'session-disabled') {
      // Just enabled: whatever is already held must be let go first.
      this.phase = 'waiting-neutral'
      this.hold = null
    }

    const pad = ctx.pad
    if (pad === null) {
      this.disarm(actions, true, 'waiting-neutral', 'no-pad')
      this.lastTimestamp = null
      this.lastPadIndex = null
      return actions
    }
    if (this.lastPadIndex !== pad.index) this.lastTimestamp = null
    this.lastPadIndex = pad.index
    const unusable = unusableSample(pad, prefs, this.lastTimestamp)
    if (unusable !== null) {
      this.disarm(actions, true, 'waiting-neutral', unusable === 'disconnected' ? 'no-pad' : 'invalid')
      this.lastTimestamp = null
      return actions
    }
    this.lastTimestamp = pad.timestamp
    if (lastRead !== null && ctx.now - lastRead > GAMEPAD_STALE_READ_MS) {
      this.disarm(actions, true, 'waiting-neutral', 'stale')
      return actions
    }
    if (ctx.away) {
      this.disarm(actions, true, 'waiting-neutral', 'away')
      return actions
    }

    const deadman = deadmanHeld(pad, prefs)
    const gesture = readGamepadGesture(pad, prefs)
    const atRest = gesture.kind === 'neutral'
    for (const input of Object.values(prefs.mappings)) {
      if (input?.kind === 'axis' && Math.abs(pad.axes[input.index] ?? 0) > prefs.deadZone) this.stickOutAt = ctx.now
    }

    if (!ctx.jogAllowed && this.ownedStep !== null && (this.phase === 'armed' || this.phase === 'active-step')
      && (ctx.machineState === 'run' || ctx.machineState === 'jog')) {
      // Our own step is moving: the gate refuses a second jog until it ends,
      // which is not lost eligibility - a stop, another input or a lost
      // connection clears ownedStep first. Keep the arm; a press now is not
      // queued, it must come fresh once the step has ended.
      if (!deadman) {
        this.disarm(actions, true, 'ready', null)
        return actions
      }
      this.phase = 'active-step'
      this.gestureConsumed = true
      return actions
    }
    if (!ctx.jogAllowed) {
      // Eligibility lost: E-STOP, alarm, homing, a running program, the
      // bridge gone. The machine side already stopped or another input owns
      // the motion, so nothing is sent; the arm drops.
      if (this.phase === 'ready' && deadman && atRest && ctx.jogRefusal !== null) {
        // A fresh press the jog cannot take says why, once per press.
        actions.push({ type: 'say', text: 'refused', refusal: ctx.jogRefusal })
      }
      this.ownedStep = null
      this.gestureConsumed = false
      // Anything held now must be let go before the pad arms again.
      this.phase = deadman || !atRest ? 'waiting-neutral' : 'ready'
      this.hold = 'not-eligible'
      return actions
    }
    if (this.hold === 'not-eligible') this.hold = null

    switch (this.phase) {
      case 'waiting-neutral':
        if (!deadman && atRest) {
          this.phase = 'ready'
          this.hold = null
        }
        return actions
      case 'ready':
        this.hold = null
        if (!deadman) return actions
        if (atRest) {
          this.phase = 'armed'
          this.gestureConsumed = false
        } else {
          // Pressed with a direction already held: not a fresh arm.
          this.phase = 'waiting-neutral'
        }
        return actions
      case 'armed':
      case 'active-step': {
        if (!deadman) {
          this.disarm(actions, true, 'ready', null)
          return actions
        }
        if (atRest) {
          if (ctx.now - this.stickOutAt >= GAMEPAD_STICK_SETTLE_MS) this.gestureConsumed = false
          this.phase = 'armed'
          return actions
        }
        if (this.gestureConsumed) return actions
        this.gestureConsumed = true
        if (gesture.kind === 'simultaneous') {
          actions.push({ type: 'say', text: 'simultaneous' })
          return actions
        }
        if (!ctx.enabledAxes.includes(gesture.axis)) {
          actions.push({ type: 'say', text: 'axis-not-enabled', axis: gesture.axis })
          return actions
        }
        const id = this.nextGesture++
        this.ownedStep = id
        this.ownedSawMotion = false
        this.phase = 'active-step'
        actions.push({
          type: 'jog',
          axis: gesture.axis,
          deltaMm: gamepadStepDeltaMm(gesture.q, ctx.machineJogStepMm),
          feedMmMin: gamepadStepFeedMmMin(ctx.machineJogFeedMmMin, prefs.speedScale),
          gesture: id,
        })
        return actions
      }
      default:
        return actions
    }
  }
}

// ── The session-only switch and status ───────────────────────────────────

/** Session-only: Enable is never persisted, so a reload starts disabled. */
export interface GamepadJogSessionState {
  enabled: boolean
  phase: GamepadJogPhase
  hold: GamepadJogHoldReason
  setEnabled: (enabled: boolean) => void
}

export const useGamepadJogSession = create<GamepadJogSessionState>()((set) => ({
  enabled: false,
  phase: 'session-disabled',
  hold: 'disabled',
  setEnabled: (enabled) => set({ enabled: enabled === true }),
}))

// ── Words ────────────────────────────────────────────────────────────────

const gamepadText = textFor('gamepad-jog.wo3259')

/** The Control status line: "Gamepad step: armed". Says "Gamepad step" in
 *  every pointer mode - the pad only ever steps. */
export function gamepadJogStatusLine(phase: GamepadJogPhase, hold: GamepadJogHoldReason): string {
  const state = (() => {
    switch (hold) {
      case 'disabled': return gamepadText('stateOff')
      case 'unmapped': return gamepadText('stateUnmapped')
      case 'unreadable': return gamepadText('stateUnreadable')
      case 'no-pad': return gamepadText('stateNoPad')
      case 'stale': return gamepadText('stateStale')
      case 'invalid': return gamepadText('stateInvalid')
      case 'away': return gamepadText('stateAway')
      case 'not-eligible': return gamepadText('stateNotEligible')
      case 'stopped': return gamepadText('stateStopped')
      default: break
    }
    switch (phase) {
      case 'session-disabled': return gamepadText('stateOff')
      case 'waiting-neutral': return gamepadText('stateWaiting')
      case 'ready': return gamepadText('stateReady')
      case 'armed': return gamepadText('stateArmed')
      case 'active-step': return gamepadText('stateActive')
    }
  })()
  return gamepadText('status', { state })
}
