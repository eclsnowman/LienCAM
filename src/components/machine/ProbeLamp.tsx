// WO-1633: two probe lamps - PROBE (the probe input, a touch) and PROBING (a
// probe cycle in process). Operator ruling 2026-09-17: "those are two separate
// indicators with two different use cases." One shared component and one
// selector for both signals, used by all three surfaces (Control screen,
// Probing panel, Tools/Probe panel) so there is never a second reading of
// either input that could disagree with the first.

import { useMachineControl } from '../../store/machineControlStore'

export type ProbeLampValue = boolean | null
export type ProbeLampKind = 'probe' | 'probing'

export function useProbeSignals(): { probe: ProbeLampValue; probeCycle: ProbeLampValue } {
  const probe = useMachineControl((s) => s.inputs?.probe ?? null)
  // WO-1671: written from every status frame by machineSession.
  const probeCycle = useMachineControl((s) => s.probeCycle)
  return { probe, probeCycle }
}

function lampState(value: ProbeLampValue): 'on' | 'off' | 'unavailable' {
  return value === true ? 'on' : value === null ? 'unavailable' : 'off'
}

const LAMP_LABEL: Record<ProbeLampKind, string> = {
  probe: 'PROBE',
  probing: 'PROBING',
}

const LAMP_TOOLTIP: Record<ProbeLampKind, Record<'on' | 'off' | 'unavailable', string>> = {
  probe: {
    on: 'PROBE: the probe input is triggered (a touch)',
    off: 'PROBE: the probe input is clear',
    unavailable: 'PROBE: not reported by this controller',
  },
  probing: {
    on: 'PROBING: a probe cycle is in process',
    off: 'PROBING: no probe cycle running',
    unavailable: 'PROBING: not reported by this controller',
  },
}

// WO-2075: a wire recording (2026-09-26) showed 186 false PROBE pulses in
// 24.1 min of spindle-turning run time and 0 in 41.6 min stopped, no debounce
// threshold separating them from a real 53-216 ms touch. Nobody probes with
// the spindle spinning, so the PROBE input (never PROBING, a cycle-in-process
// flag unrelated to the raw input) is shown not-read - greyed like the
// existing "unavailable" look - whenever the spindle is reported turning.
// The store's `inputs.probe` and every probe/measure cycle are untouched;
// this overrides only what this lamp renders.
//
// Audit fix (attempt 2): RPM alone missed the reported-running route - a
// startup frame can report running (A: field 'cw'/'ccw') before RPM climbs
// off zero, and a coast-down frame can report RPM at zero before the A:
// field clears to 'off'. "Turning" is now RPM > 0 OR the controller's own
// reported accessory state says the spindle is running, so either signal
// alone is enough to grey the lamp.
const SPINDLE_TURNING_TOOLTIP = 'PROBE: not read while the spindle turns'

export function ProbeLamp({
  kind,
  value,
  testId,
}: {
  kind: ProbeLampKind
  value: ProbeLampValue
  testId: string
}) {
  const spindleRpm = useMachineControl((s) => s.spindleRpm)
  const spindleAccessory = useMachineControl((s) => s.reportedAccessories.spindle)
  const notReadWhileTurning =
    kind === 'probe' && ((spindleRpm ?? 0) > 0 || spindleAccessory !== 'off')
  const state = notReadWhileTurning ? 'unavailable' : lampState(value)
  const tooltip = notReadWhileTurning ? SPINDLE_TURNING_TOOLTIP : LAMP_TOOLTIP[kind][state]
  return (
    <span
      className={`probe-lamp probe-lamp-${kind} probe-lamp-${state}`}
      data-testid={testId}
      data-tooltip={tooltip}
    >
      {LAMP_LABEL[kind]}
    </span>
  )
}
