import type { StreamerPhase, ConnectionPhase, MachineController } from './controller'
import { unhomedAxes } from './controller'
import type { MachineState } from './types'

export type MachineChipState = 'offline' | 'not-homed' | 'ready' | 'running' | 'held' | 'alarm'

export interface MachineChipView {
  state: MachineChipState
  label: string
}

export interface MachineChipFacts {
  connectionPhase: ConnectionPhase
  machineState: MachineState
  jobPhase: StreamerPhase
  /** Only the session's M0 boundary, not a Feed Hold or a guided stop. */
  programM0Held?: boolean
  /** A stationary tool-change card waiting for Continue, including a typed M6. */
  toolChangeWaiting?: boolean
  /**
   * The live controller is the only datum authority. A connected chip without
   * one fails closed to "Not homed"; it never substitutes the render store's
   * legacy collapsed `homed` snapshot.
   */
  datumResolver: Pick<MachineController, 'homedThisSession' | 'homedAxesThisSession'> | null
}

const OFFLINE: MachineChipView = { state: 'offline', label: 'Offline' }
const NOT_HOMED: MachineChipView = { state: 'not-homed', label: 'Not homed' }
const READY: MachineChipView = { state: 'ready', label: 'Ready' }
const RUNNING: MachineChipView = { state: 'running', label: 'Running' }
const HELD: MachineChipView = { state: 'held', label: 'Held' }
const ALARM: MachineChipView = { state: 'alarm', label: 'Alarm' }

/**
 * Derive the header's one machine reading from live controller facts.
 *
 * Precedence is safety-significant: a departed/half-open connection cannot
 * retain an old alarm or ready claim; alarm cannot be hidden by a live job;
 * and activity remains visible while a homing cycle is establishing datum.
 */
export function deriveMachineChip(facts: MachineChipFacts): MachineChipView {
  if (facts.connectionPhase !== 'connected') return OFFLINE
  if (facts.machineState === 'alarm') return ALARM
  if (facts.programM0Held) return HELD
  if (facts.machineState === 'hold') return HELD
  if (facts.toolChangeWaiting && facts.machineState === 'idle') return HELD

  const activeJob = facts.jobPhase === 'streaming' || facts.jobPhase === 'paused'
  const activeMotion =
    facts.machineState === 'run' ||
    facts.machineState === 'jog' ||
    facts.machineState === 'home'
  if (activeJob || activeMotion) return RUNNING

  if (!facts.datumResolver || unhomedAxes(facts.datumResolver).length > 0) return NOT_HOMED
  return READY
}
