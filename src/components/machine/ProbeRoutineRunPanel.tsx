import { catalogChildren } from './probing/catalogText'
import { jsxTextValue } from '../../i18n/locales/en/probing-screens'
import { textFor, useText } from '../../i18n'
const probeText = textFor('probing-screens')

import { fmtMachineLength, unitLabel } from '../../lib/ui/unitFormat'
// WO-411 slice 3 - Run a checked routine, watch it, confirm what it proposes.
//
// Presentation + the one hand-off to machine code: `runProbeRoutine`
// (machineSession.ts) runs the EXPANDED routine the preview shows, under the
// same gates as the feature probe cycle, and hands back touches, calcs and
// evaluated proposals - it writes nothing. The Confirm buttons below are the
// only writers: a work-offset proposal through the same `setWorkOffsetValue`
// the Probing tab's Confirm uses, a tool-length proposal through
// `confirmProbeRoutineToolLength` - the same tool table the guided tool
// change writes to. The path-clear tick is per preview hash: a new preview
// needs a new tick, and the runner refuses a stale hash before any line.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EMPTY_TOOL_TABLE, findTool, type EffectiveProbeConfig } from '../../lib/machine/toolTable'
import type { MachineEnvelope } from '../../lib/machine/machineEnvelope'
import type { WcsId } from '../../lib/machine/types'
import { formatPosition } from '../../lib/machine/positionFrames'
import {
  listExpandedSteps,
  type ExpandedDisplayUnits,
  type ExpandedRoutine,
} from '../../lib/machine/probeRoutineExpand'
import {
  confirmProbeRoutineToolLength,
  estopControlMode,
  probeRoutineExecutionRefusal,
  runProbeRoutine,
  setWorkOffsetValue,
  subscribeEstopControlMode,
  type ProbeRoutineEvaluatedProposal,
  type ProbeRoutineRunEvent,
  type ProbeRoutineRunResult,
} from '../../lib/machine/machineSession'
import { controlMachine, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useMachineToolTable } from '../../store/machineToolTableStore'
import { EstopControl } from './ControlTransportBar'

const WCS_SLOTS: readonly WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']
const LIVE_POSITION_REFUSAL = probeText('probeRoutineRunPanel1')

export interface ProbeRoutineRunPanelProps {
  expanded: ExpandedRoutine
  /** True when the routine or its inputs changed after this preview was made. */
  stale: boolean
  probe: EffectiveProbeConfig
  envelope: MachineEnvelope
  activeWcs: string | null
  units: ExpandedDisplayUnits
}

function fmt(value: number, units: ExpandedDisplayUnits): string {
  const displayUnits = units === 'in' ? 'inch' : 'mm'
  return `${fmtMachineLength(value, displayUnits)} ${unitLabel(displayUnits)}`
}

function wcsOf(proposalWcs: string, activeWcs: string | null): WcsId | null {
  const name = proposalWcs === 'active' ? activeWcs : proposalWcs
  return name && (WCS_SLOTS as readonly string[]).includes(name) ? (name as WcsId) : null
}

export function ProbeRoutineRunPanel({ expanded, stale, probe, envelope, activeWcs, units }: ProbeRoutineRunPanelProps) {
  useText('probing-screens')
  const activeTool = useMachineControl((s) => s.activeTool)
  const machine = useCamStore(controlMachine)
  const machineId = machine?.id ?? 'default'
  const toolTable = useMachineToolTable((s) => s.byMachine[machineId]?.table ?? EMPTY_TOOL_TABLE)
  const [tickedHash, setTickedHash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState<string | null>(null)
  const [result, setResult] = useState<{ hash: string; value: ProbeRoutineRunResult } | null>(null)
  const [written, setWritten] = useState<string | null>(null)

  // A new preview is a new contract: drop the tick and any old result.
  useEffect(() => {
    setTickedHash(null)
    setLive(null)
    setWritten(null)
  }, [expanded.hash])

  // WO-469: the E-STOP here must survive the stop it makes. Subscribed to the
  // mode so this panel keeps showing the control through settling and CLEAR,
  // and drops it once the operator has actually cleared the stop.
  const estopMode = useSyncExternalStore(subscribeEstopControlMode, estopControlMode, () => 'stopped' as const)
  const [estopHeld, setEstopHeld] = useState(false)
  useEffect(() => {
    // A stop made from THIS panel latches the control here until it is
    // cleared. Runs are themselves gated on the latch, so `busy` can only be
    // true with the mode armed - which means this can only ever be set by a
    // stop that landed on a run of ours, never by the startup latch.
    if (busy && estopMode !== 'armed') setEstopHeld(true)
    else if (estopMode === 'armed') setEstopHeld(false)
  }, [busy, estopMode])
  const showEstop = busy || estopHeld

  const ticked = tickedHash === expanded.hash && !stale
  const motionSteps = listExpandedSteps(expanded.steps).filter((s) => s.kind === 'move' || s.kind === 'touch')
  const shown = result && result.hash === expanded.hash && !stale ? result.value : null
  const preflightRefusal = probeRoutineExecutionRefusal(expanded)
  // The execution preflight also reads live controller positions. This panel
  // does not subscribe to status, so only static capability refusals may gate
  // Run here; runProbeRoutine rechecks and reports live refusals at click time.
  const capabilityRefusal = preflightRefusal?.includes(LIVE_POSITION_REFUSAL)
    ? null
    : preflightRefusal
  const announcedExecutionRefusal = useRef<string | null>(null)

  // Refusals belong in the machine console, not in a standing note beside
  // Run. Remember the published reason so React re-renders cannot repeat it;
  // a genuinely changed preflight result gets one new line.
  useEffect(() => {
    if (!capabilityRefusal) {
      announcedExecutionRefusal.current = null
      return
    }
    if (announcedExecutionRefusal.current === capabilityRefusal) return
    announcedExecutionRefusal.current = capabilityRefusal
    useMachineControl.getState().pushConsole(
      'tx',
      probeText('probeRoutineRunPanel2', { value1: String(capabilityRefusal) }),
      'error',
    )
  }, [capabilityRefusal])

  const onRun = async () => {
    if (!ticked || busy || capabilityRefusal) return
    setBusy(true)
    setWritten(null)
    setLive(probeText('probeRoutineRunPanel3', { value1: String(expanded.routineName) }))
    try {
      const r = await runProbeRoutine(expanded, probe, ticked, expanded.hash, {
        envelope,
        onStep: (event: ProbeRoutineRunEvent) => {
          if (event.kind === 'touch') {
            const axis = event.touch.axis.toLowerCase() as 'x' | 'y' | 'z'
            const at = formatPosition({ ...event.frame, machine: { [axis]: event.touch.positionMm }, format: (v) => fmt(v, units) })
            setLive(probeText('probeRoutineRunPanel4', { value1: String(event.step.number), value2: String(event.step.label), value3: String(at) }))
          } else if (event.kind === 'moving') {
            const at = formatPosition({ ...event.frame, machine: event.target, format: (v) => fmt(v, units) })
            setLive(probeText('probeRoutineRunPanel5', { value1: String(event.step.number), value2: String(event.step.label), value3: String(at) }))
          }
        },
      })
      setResult({ hash: expanded.hash, value: r })
      setLive(null)
    } finally {
      setBusy(false)
      // One tick buys one run, like the Probing tab: re-tick before running again.
      setTickedHash(null)
    }
  }

  const onConfirm = (proposal: Extract<ProbeRoutineEvaluatedProposal, { kind: 'workOffset' }>) => {
    const wcs = wcsOf(proposal.wcs, activeWcs)
    if (!wcs) return
    let applied = 0
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const value = proposal.axes[axis]
      if (value === undefined) continue
      if (setWorkOffsetValue(wcs, axis, value)) applied++
    }
    setWritten(applied > 0
      ? probeText('probeRoutineRunPanel6', { value1: String(wcs), value2: String((['X', 'Y', 'Z'] as const).filter((a) => proposal.axes[a] !== undefined).map((a) => `${a} = ${fmt(proposal.axes[a]!, units)}`).join(', ')) })
      : probeText('probeRoutineRunPanel7', { value1: String(wcs) }))
  }

  const onConfirmToolLength = (proposal: Extract<ProbeRoutineEvaluatedProposal, { kind: 'toolLength' }>) => {
    const outcome = confirmProbeRoutineToolLength(proposal)
    if (!outcome.ok) {
      setWritten(probeText('probeRoutineRunPanel8', { value1: String(outcome.reason) }))
      useMachineControl.getState().pushConsole('tx', probeText('probeRoutineRunPanel9', { value1: String(outcome.reason) }), 'error')
      return
    }
    setWritten(outcome.message)
    useMachineControl.getState().pushConsole('tx', probeText('probeRoutineRunPanel10', { value1: String(outcome.message) }), 'info')
  }

  return (
    <div className="probe-routine-run" data-testid="probe-routine-run-panel" data-busy={busy ? 'true' : undefined}>
      <label className="probe-routine-path-clear" data-testid="probe-routine-path-clear">
        <input
          type="checkbox"
          data-testid="probe-routine-path-clear-tick"
          checked={ticked}
          disabled={busy || stale}
          onChange={(e) => setTickedHash(e.target.checked ? expanded.hash : null)}
        />
        <span>{catalogChildren(probeText('probeRoutineRunPanel13', { value1: '\u0000value1\u0000' }), { value1: motionSteps.length })}</span>
      </label>
      <div className="probe-routine-run-row">
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          data-testid="probe-routine-run"
          disabled={!ticked || busy || Boolean(capabilityRefusal)}
          title={capabilityRefusal ?? (stale ? probeText('probeRoutineRunPanel14') : !ticked ? probeText('probeRoutineRunPanel15') : probeText('probeRoutineRunPanel16', { value1: String(expanded.routineName) }))}
          onClick={() => { void onRun() }}
        >
          {busy ? probeText('probeRoutineRunPanel17') : probeText('probeRoutineRunPanel18')}
        </button>
        {showEstop && (
          // Operator ruling 2026-08-21: the Routines tab carries no transport row; while
          // a routine is moving the machine ONE E-STOP sits next to
          // "Running...". It goes away when the run ends.
          //
          // WO-469, and this is the audit finding that failed attempt 1: this
          // used to be a hand-rolled COPY of the transport bar's button -
          // hardcoded to the word "E-STOP", hardcoded to the armed styling,
          // and `onClick={() => { void pressEstop() }}` threw the result away.
          // When pressEstop() gained Operator's clear mode, this control silently
          // became a button that says E-STOP and performs a CLEAR, and could
          // not even report a refusal. A mislabelled stop control is worse
          // than the deadlock this order started from. So it is no longer a
          // copy: it renders THE EstopControl, and inherits the two modes, the
          // settling delay and the refusal sentence.
          //
          // WHY IT OUTLIVES `busy`. runProbeRoutine's `finally` clears busy,
          // so a stop pressed here used to abort the run and UNMOUNT THE ONLY
          // WAY BACK - the Routines tab carries no transport row, so the
          // operator was stranded on the tab they were standing on. That is
          // WO-469's own disease in a second place. The control now stays for
          // as long as the stop it made is still latched, and leaves on its
          // own once the mode returns to armed.
          <EstopControl
            testId="probe-routine-run-estop"
            className="probe-routine-run-estop"
            tooltip="native"
          />
        )}
      </div>
      {live && (
        <div className="probe-routine-run-live" data-testid="probe-routine-run-live" role="status">{live}</div>
      )}
      {shown && (
        <div
          className="probe-routine-run-result"
          data-testid="probe-routine-run-result"
          data-ok={shown.ok ? 'true' : 'false'}
        >
          <div className={`control-probe-status${shown.ok ? '' : ' control-probe-status-error'}`} data-testid="probe-routine-run-message">
            {shown.message}
          </div>
          {shown.touches.length > 0 && (
            <ul className="probe-routine-run-touches" data-testid="probe-routine-run-touches">
              {shown.touches.map((t) => (
                <li key={t.name}>{t.name}: {formatPosition({ machine: { [t.axis.toLowerCase()]: t.positionMm }, format: (v) => fmt(v, units) })}</li>
              ))}
            </ul>
          )}
          {shown.ok && shown.proposals.map((p, i) => {
            if (p.kind === 'workOffset') {
              const wcs = wcsOf(p.wcs, activeWcs)
              const axes = (['X', 'Y', 'Z'] as const).filter((a) => p.axes[a] !== undefined)
              return (
                <div key={i} className="probe-routine-proposal" data-testid="probe-routine-run-proposal" data-kind="workOffset">
                  <strong>{p.label}</strong>
                  <span>
                    {wcs ? `${wcs}: ` : probeText('probeRoutineRunPanel19')}
                    {axes.map((a) => `${a} = ${fmt(p.axes[a]!, units)}`).join(', ')}
                    {p.compensationNote ? ` ${p.compensationNote}` : ''}
                  </span>
                  <button
                    type="button"
                    className="modal-btn modal-btn-primary"
                    data-testid="probe-routine-confirm-offset"
                    disabled={!wcs || axes.length === 0}
                    title={wcs ? probeText('probeRoutineRunPanel20', { value1: String(axes.join(' and ')), value2: String(wcs) }) : probeText('probeRoutineRunPanel21')}
                    onClick={() => onConfirm(p)}
                  >{probeText('probeRoutineRunPanel24', { value1: jsxTextValue(wcs ?? probeText('probeRoutineRunPanel23')) })}
                  </button>
                </div>
              )
            }
            if (p.kind === 'toolLength') {
              const resolvedTool = p.tool === 'active' ? activeTool : p.tool
              const knownTool = resolvedTool !== null && Boolean(findTool(toolTable, resolvedTool))
              const refusal = resolvedTool === null
                ? probeText('probeRoutineRunPanel25')
                : !knownTool
                  ? probeText('probeRoutineRunPanel26', { value1: String(resolvedTool) })
                  : null
              return (
                <div key={i} className="probe-routine-proposal" data-testid="probe-routine-run-proposal" data-kind="toolLength">
                  <strong>{p.label}</strong>
                  <span>{probeText('probeRoutineRunPanel29', { value1: jsxTextValue(p.tool === 'active' ? '(active)' : `T${p.tool}`), value2: jsxTextValue(formatPosition({ machine: { z: p.machineZ }, format: (v) => fmt(v, units) })) })}</span>
                  <button
                    type="button"
                    className="modal-btn modal-btn-primary"
                    data-testid="probe-routine-confirm-tool-length"
                    disabled={refusal !== null}
                    title={refusal ?? probeText('probeRoutineRunPanel30', { value1: String(resolvedTool) })}
                    onClick={() => onConfirmToolLength(p)}
                  >{probeText('probeRoutineRunPanel33', { value1: jsxTextValue(resolvedTool !== null ? `T${resolvedTool}` : probeText('probeRoutineRunPanel32')) })}
                  </button>
                </div>
              )
            }
            return (
              <div key={i} className="probe-routine-proposal" data-testid="probe-routine-run-proposal" data-kind="report">
                <strong>{probeText('probeRoutineRunPanel35')}</strong>
                <ul>
                  {p.items.map((item) => (
                    <li key={item.label}>{item.label}: {item.unit === 'mm' ? fmt(item.value, units) : `${item.value} ${item.unit}`}</li>
                  ))}
                </ul>
              </div>
            )
          })}
          {written && (
            <div className="control-probe-status" data-testid="probe-routine-run-written">{written}</div>
          )}
        </div>
      )}
    </div>
  )
}
