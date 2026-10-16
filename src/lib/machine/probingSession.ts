import { create } from 'zustand'
import { useMachineControl } from '../../store/machineControlStore'
import type { Tool } from '../../types'
import { calculateYawAngle, type YawAngleInput, type YawAngleResult } from './probeRoutines'

// WO-1634: Operator probes with the cutter in the collet, not a dedicated
// stylus - "That's pretty typical for low-cost cncs that don't have a
// dedicated actual three-dimensional probe." The tip radius the touch
// routines compensate with should default to whatever tool is actually
// in the spindle, named the same way WO-1323 names a tool in G-code text:
// the library entry only when its T-number is unambiguous, never a guess
// among duplicates. WO-2105: duplicates are settled by the machine's own tool
// table - the entry whose diameter is the one the table holds for that T.
export function activeToolFromLibrary(
  activeTool: number | null,
  toolLibrary: readonly Tool[],
  tableDiaMm: number | null = null,
): Tool | null {
  if (activeTool === null) return null
  const matches = toolLibrary.filter((tool) => tool.toolNumber === activeTool)
  if (matches.length === 1) return matches[0]
  if (tableDiaMm === null || !(tableDiaMm > 0)) return null
  return matches.find((tool) => Math.abs(tool.diameter - tableDiaMm) < 0.001) ?? null
}

// WO-1998: ControlPage mounts this panel only while the Probing sub-tab is
// open, and the Probing tab has no jog - so the operator MUST leave it between
// the touches of a corner. The chosen routine, its settings and the touches
// already taken live here, outside the component, until the routine is
// restarted or changed; they belong to one machine and are dropped when the
// Control tab is driving another. The path-clear confirmation is deliberately
// NOT kept: leaving the tab to move the machine is what it has to be re-given for.
interface ProbingSessionState {
  machineId: string | null
  values: Readonly<Record<string, unknown>>
}

export const useProbingSession = create<ProbingSessionState>(() => ({ machineId: null, values: {} }))
const PROBING_SESSION_UNSET = Symbol('probing-session-unset')

// A disconnect ends the probing session: the touches are machine positions,
// and nothing vouches for them across a new connection.
useMachineControl.subscribe((state, previous) => {
  if (previous.connectionPhase === 'connected' && state.connectionPhase === 'disconnected') {
    useProbingSession.setState({ machineId: null, values: {} })
    probingSessionRefs = { machineId: null, refs: new Map() }
  }
})

export function __resetProbingSessionForTest(): void {
  useProbingSession.setState({ machineId: null, values: {} })
  probingSessionRefs = { machineId: null, refs: new Map() }
}

// WO-2139: the followed run's step tracker is written as the frame renders
// (never state per position report), so it lives beside the session, not in it.
let probingSessionRefs: { machineId: string | null; refs: Map<string, { current: unknown }> } = { machineId: null, refs: new Map() }

/** useRef, kept for the machine's probing session across unmounts. */
export function useProbingSessionRef<T>(machineId: string, key: string, initial: T): { current: T } {
  if (probingSessionRefs.machineId !== machineId) probingSessionRefs = { machineId, refs: new Map() }
  let holder = probingSessionRefs.refs.get(key)
  if (!holder) {
    holder = { current: initial }
    probingSessionRefs.refs.set(key, holder)
  }
  return holder as { current: T }
}

type SessionSetter<T> = (next: T | ((current: T) => T)) => void

/** useState, kept for the machine's probing session across unmounts. A
 *  functional update reads the stored value at the moment it runs, so a touch
 *  that lands while the panel is unmounted is still recorded. */
export function useProbingSessionState<T>(machineId: string, key: string, initial: T): [T, SessionSetter<T>] {
  const stored = useProbingSession((s) => (
    s.machineId === machineId && key in s.values ? s.values[key] : PROBING_SESSION_UNSET
  ))
  const value = stored === PROBING_SESSION_UNSET ? initial : stored as T
  const set: SessionSetter<T> = (next) => useProbingSession.setState((s) => {
    const values = s.machineId === machineId ? s.values : {}
    const current = key in values ? values[key] as T : initial
    const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next
    if (s.machineId === machineId && key in values && Object.is(resolved, current)) return s
    return { machineId, values: { ...values, [key]: resolved } }
  })
  return [value, set]
}

/** Read only the setup for the machine this session belongs to. */
export function probingSessionValues(machineId: string): Readonly<Record<string, unknown>> {
  const session = useProbingSession.getState()
  return session.machineId === machineId ? session.values : {}
}

// WO-2112 / WO-2809: the Angle result, for the Probing screen and the phone
// alike. The angle is the line's, whichever way along the face point 2 was
// taken: measured with Point 2 on the minus side, the line from point 1 runs
// backwards along the axis and reads as ~180 deg.
export function faceAngleFromTouches(input: YawAngleInput): YawAngleResult {
  const forward = input.second.alongMm >= input.first.alongMm
  return calculateYawAngle({
    ...input,
    first: forward ? input.first : input.second,
    second: forward ? input.second : input.first,
  })
}
