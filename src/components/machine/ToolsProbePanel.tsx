// ToolsProbePanel - sender-side tool table + fixed-pad Z probe (MACHINE-
// CONTROL stage 10). One panel, two sections, per the plan: the per-machine
// tool length table (reference star, G43.1 apply, inline-editable cells) and
// the Z probe cycle (probe where the tool is - the operator jogs over the
// pad first). Every motion here is an explicit press on a motion-styled
// button; results echo in the console and land in the DRO/offsets readouts.
//
// WO-297: workpiece probing (edge/corner/bore/boss + the flip-aware second
// side) moved out to its own ProbingPanel/Probing tab - Operator rejected sharing
// this screen with the tool table
// (docs/ui-ux/probing-workspace-requirements.md). The tool table and the
// fixed-pad Z probe stay here unchanged; they measure and record TOOL
// length, not a workpiece feature.

import { useMemo, useState } from 'react'
import { ArrowDownToLine, Plus, Star, Trash2 } from 'lucide-react'
import { controlMachine, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { saveMachineToolRecord, useMachineToolTable } from '../../store/machineToolTableStore'
import {
  findTool,
  machineProbeOverride,
  machineToolTable,
  resolveProbeConfig,
  toolOffsetLine,
  type ZProbeConfig,
} from '../../lib/machine/toolTable'
import {
  applyToolLengthOffset,
  clearToolLengthOffset,
  fixedToolSetterPosition,
  recoverFromProbeAlarm,
  runZProbeCycle,
  setProbeSensing,
  useMachineProbeSensing,
  type ZProbeMode,
} from '../../lib/machine/machineSession'
import { DEFAULT_PROBE_SENSING, type ProbeSensing } from '../../lib/machine/probeFeatureCycle'
import { useDisplayUnits } from './useDisplayUnits'
import { ResizableSplit } from '../common/ResizableSplit'
import { MACHINE_PANEL_RIGHT_DEFAULT, MACHINE_PANEL_RIGHT_MAX, MACHINE_PANEL_RIGHT_MIN } from '../../store/uiPrefs'
import {
  feedLabel,
  fmtMachineLength,
  fmtDim,
  fmtFeed,
  parseDimToMm,
  parseFeedToMmMin,
  unitLabel,
} from '../../lib/ui/unitFormat'
import { NumCell } from './NumCell'
import { JogPanel } from './JogPanel'
import { ControlStepRow, ControlTransportBar } from './ControlTransportBar'
import { ProbeLamp, useProbeSignals } from './ProbeLamp'
import { planPartProbeSearch } from '../../lib/machine/partProbeSearch'
import './ToolsProbePanel.css'

interface ProbeStatus {
  kind: 'ok' | 'error'
  text: string
}

/** WO-2430: the stored jog-rail width on Control > Tools (uiPrefs.panelSizes). */
export const TOOLS_JOG_PANEL_KEY = 'control-tools-jog'
/** The Tools panel's narrowest designed layout (its 420px container step)
 *  plus its padding: the jog rail never widens past what leaves this. */
export const TOOLS_PANEL_MIN_PX = 440

export function ToolsProbePanel() {
  const machine = useCamStore(controlMachine)
  const hasSetter = Boolean(fixedToolSetterPosition(machine))
  const machineId = machine?.id ?? 'default'
  const sessionGeneration = useCamStore((s) => s.control.sessionGeneration ?? 0)
  // WO-1676: read straight off the definition - the tool table and probe
  // overrides live there now, never in a side store the machine's own export
  // does not carry. `machine` already comes from a live `useCamStore`
  // subscription, so a mutation this panel makes (which writes the
  // definition) repaints immediately with no separate subscription needed.
  const table = machineToolTable(machine)
  const probeOverride = machineProbeOverride(machine)
  const probePads = machine?.probePads ?? []
  const activeProbePadId = machine?.activeProbePadId ?? ''
  const probeCfg = useMemo(
    () => resolveProbeConfig(machine?.probing, probeOverride),
    [machine?.probing, probeOverride],
  )
  // WO-2059: Work Z0 subtracts the pad only when this machine's Work Z0 is
  // sensed through a plate; the first-time default is the probe on the part.
  const workZeroSensing: ProbeSensing =
    useMachineProbeSensing(machineId)?.workZero ?? DEFAULT_PROBE_SENSING
  const store = useMachineToolTable
  const availableMeasurement = useMachineToolTable((s) => s.availableMeasurement)
  // WO-1676: the store's own mutators stay pure cache writes (so a direct
  // test call against an arbitrary id never perturbs a machine record it
  // was not for - see the store's file comment); this panel is the one
  // caller that actually knows which record a real edit is for, so it pushes
  // the cache's new value onto that record itself, right after every call.
  const save = () => {
    if (machine) saveMachineToolRecord(machine)
  }

  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const machineState = useMachineControl((s) => s.machineState)
  const jobPhase = useMachineControl((s) => s.job.phase)
  const activeTool = useMachineControl((s) => s.activeTool)
  const tlo = useMachineControl((s) => s.tlo)
  const machineZ = useMachineControl((s) => s.mpos?.z)
  const probeSignals = useProbeSignals()
  const units = useDisplayUnits()

  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ProbeStatus | null>(null)
  const [addText, setAddText] = useState('')

  const streaming = jobPhase === 'streaming' || jobPhase === 'paused'
  const canAct = connected && machineState === 'idle' && !streaming && !busy
  const canEdit = !busy
  // WO-2008: a disabled probe control says WHY. A tool-change hold parks the
  // machine in Hold, which is the state that used to grey Measure with no word.
  const whyNotIdle = !connected
    ? 'Connect to the machine first.'
    : busy
      ? 'A probe is running - wait for it to finish.'
      : machineState === 'hold'
        ? 'A hold (a tool change waiting on you) owns the machine - press Cycle Start to finish it, or Stop, then measure.'
        : streaming
          ? 'A program is running - Feed Hold, then Stop, before measuring.'
          : machineState !== 'idle'
            ? `The machine is ${machineState} - wait until it is idle.`
            : null
  const addToolText = addText.trim()
  const addToolInvalid = !Number.isInteger(Number(addToolText)) || addToolText === ''
  // The tool a probe measurement records against: explicit row pick first,
  // else the controller's active T number.
  const probeTool = selected ?? activeTool
  const partProbeSearch = useMemo(
    () => planPartProbeSearch(machine, machineZ, probeCfg.maxTravel),
    [machine, machineZ, probeCfg.maxTravel],
  )

  const commitDim = (text: string, apply: (mm: number) => void): boolean => {
    const mm = parseDimToMm(text, units)
    if (!Number.isFinite(mm)) return false
    apply(mm)
    return true
  }
  const commitFeed = (text: string, apply: (mmMin: number) => void): boolean => {
    const v = parseFeedToMmMin(text, units)
    if (!Number.isFinite(v) || v <= 0) return false
    apply(v)
    return true
  }

  const runProbe = async (mode: ZProbeMode) => {
    if (busy) return
    // A row click may happen while the native receipt is in flight. Bind the
    // result to the tool and controller session that started the action; a
    // later selection must not silently retarget it.
    const receiptMachineId = machineId
    const receiptGeneration = sessionGeneration
    const receiptTool = probeTool
    setBusy(true)
    setStatus(null)
    try {
      const result = await runZProbeCycle(mode, probeCfg)
      const receiptState = useCamStore.getState()
      const receiptIsCurrent = (receiptState.control.sessionGeneration ?? 0) === receiptGeneration
        && controlMachine(receiptState).id === receiptMachineId
      if (result.ok && result.contacts && receiptIsCurrent) {
        const label = mode === 'measureTool' ? 'Measure tool' : 'Probe work Z0'
        const fast = result.contacts.fastMachineZ === null
          ? 'FAST machine Z unavailable'
          : `FAST machine Z ${fmtMachineLength(result.contacts.fastMachineZ, units)} ${unitLabel(units)}`
        useMachineControl.getState().pushConsole(
          'rx',
          `${label} contacts: ${fast}; FINE machine Z ${fmtMachineLength(result.contacts.fineMachineZ, units)} ${unitLabel(units)}.`,
          'info',
        )
      }
      if (
        result.ok
        && result.probedMachineZ !== null
        && receiptIsCurrent
        && receiptTool !== null
        && mode === 'workZero'
      ) {
        // WO-1995: a part-surface contact is never a tool's setter reading.
        // Work Z0 sets the WORK offset and marks the tool in the spindle as
        // the Ref; the Ref's setter reading comes only from Measure Tn, so
        // Apply length / the guided change only ever subtract setter from
        // setter. (Storing this contact once offered G43.1 Z-18.72.)
        store.getState().setReference(receiptMachineId, receiptTool)
        save()
        // WO-2105: the pad was touched with this tool, so it is in the spindle.
        useMachineControl.getState().setActiveTool(receiptTool)
        const refSetterZ = findTool(store.getState().tableFor(receiptMachineId), receiptTool)?.probedMachineZ ?? null
        useMachineControl.getState().pushConsole(
          'rx',
          `Work Z0 pad fine contact: machine Z ${fmtMachineLength(result.probedMachineZ, units)} ${unitLabel(units)}; T${receiptTool} marked as the reference tool. `
            + (refSetterZ === null
              ? `T${receiptTool} still needs a setter measurement (Measure T${receiptTool}) before Apply length can work.`
              : `Its setter reading stays machine Z ${fmtMachineLength(refSetterZ, units)} ${unitLabel(units)}.`),
          'info',
        )
      } else if (result.ok && result.probedMachineZ !== null && receiptIsCurrent && receiptTool !== null) {
        store.getState().recordProbedZ(receiptMachineId, receiptTool, result.probedMachineZ, Date.now())
        save()
        // WO-2105: Measure T<n> measured the tool in the spindle - that is T<n>.
        useMachineControl.getState().setActiveTool(receiptTool)
        useMachineControl.getState().pushConsole(
          'rx',
          `Tool setter fine contact: machine Z ${fmtMachineLength(result.probedMachineZ, units)} ${unitLabel(units)}; recorded in the table for T${receiptTool}.`,
          'info',
        )
      } else if (
        result.ok
        && result.probedMachineZ !== null
        && receiptIsCurrent
        && mode === 'measureTool'
      ) {
        const measuredAt = Date.now()
        store.getState().retainAvailableMeasurement({
          machineId: receiptMachineId,
          sessionGeneration: receiptGeneration,
          coordinate: 'machineZ',
          machineZ: result.probedMachineZ,
          measuredAt,
        })
        useMachineControl.getState().pushConsole(
          'rx',
          `Tool setter fine contact: machine Z ${fmtMachineLength(result.probedMachineZ, units)} ${unitLabel(units)} on ${machine?.name ?? receiptMachineId}; retained as an available unassigned measurement.`,
          'info',
        )
      }
      const suffix =
        result.ok && result.probedMachineZ !== null && !receiptIsCurrent
          ? ' The machine connection changed before this result could be retained.'
          : result.ok && receiptTool !== null
          ? mode === 'workZero'
            ? ` T${receiptTool} marked as the reference tool.`
            : ` Recorded for T${receiptTool}.`
          : result.ok
            ? mode === 'measureTool'
              ? ' Held as active tool length (the datum).'
              : ' No tool number is active, so no reference tool was marked.'
            : ''
      setStatus({
        kind: result.ok && receiptIsCurrent ? 'ok' : 'error',
        text: result.message + suffix,
      })
    } finally {
      setBusy(false)
    }
  }

  const onAddTool = () => {
    const n = Number(addText.trim())
    if (!Number.isInteger(n) || n < 0) return
    store.getState().addTool(machineId, n)
    save()
    setSelected(n)
    setAddText('')
  }

  const applyResult = probeTool !== null ? toolOffsetLine(table, probeTool) : null
  // WO-1995: the Ref's length comes only from the setter, so when it has no
  // setter reading Apply length names that tool and the one step that fixes it.
  const refEntry = table.reference === null ? undefined : findTool(table, table.reference)
  const applyReason = applyResult && !applyResult.ok
    ? table.reference !== null && (!refEntry || refEntry.probedMachineZ === null)
      ? `Ref tool T${table.reference} has no setter reading - measure T${table.reference} on the setter (Measure T${table.reference}) before Apply length can work.`
      : applyResult.reason
    : null
  const availableForThisSession = connected
    && availableMeasurement?.machineId === machineId
    && availableMeasurement.sessionGeneration === sessionGeneration

  const toolsPanel = (
    <section className="panel control-panel" data-testid="control-tools-panel">
      <div className="panel-header">
        <span className="panel-title">Tools</span>
        <span className="control-offsets-meta">
          TLO {tlo === null ? '-' : fmtMachineLength(tlo, units)} {unitLabel(units)}
        </span>
      </div>
      <div className="panel-body control-tools-body">
        {table.tools.length > 0 && (
          <div className="control-tools-table" data-testid="control-tools-table">
            <div className="control-tools-row control-tools-head">
              <span data-tooltip="Reference tool - the one work Z0 was set with">Ref</span>
              <span>Tool</span>
              <span>Setter Z ({unitLabel(units)})</span>
              <span>Dia</span>
              <span />
            </div>
            {table.tools.map((t) => {
              const isRef = table.reference === t.tool
              const isActive = activeTool === t.tool
              const isSelected = probeTool === t.tool
              return (
                <div
                  key={t.tool}
                  className={`control-tools-row ${isSelected ? 'control-tools-selected' : ''}`}
                  data-testid={`control-tool-row-${t.tool}`}
                  onClick={() => setSelected(t.tool)}
                >
                  <button
                    className={`panel-action-btn control-tool-ref ${isRef ? 'control-tool-ref-on' : ''}`}
                    data-testid={`control-tool-ref-${t.tool}`}
                    disabled={!canEdit}
                    data-tooltip={
                      isRef
                        ? 'This is the reference tool (work Z0 was set with it)'
                        : 'Make this the reference tool'
                    }
                    aria-label={isRef ? `T${t.tool} is the reference tool` : `Make T${t.tool} the reference tool`}
                    onClick={(e) => {
                      e.stopPropagation()
                      store.getState().setReference(machineId, isRef ? null : t.tool)
                      save()
                      useMachineControl.getState().pushConsole(
                        'rx',
                        isRef
                          ? `Tool table: T${t.tool} is no longer the reference tool.`
                          : t.probedMachineZ === null
                            ? `Tool table: T${t.tool} selected as reference; it still needs a setter measurement.`
                            : `Tool table: T${t.tool} selected as reference at machine Z ${fmtMachineLength(t.probedMachineZ, units)} ${unitLabel(units)}.`,
                        'info',
                      )
                    }}
                  >
                    <Star size={12} fill={isRef ? 'currentColor' : 'none'} />
                  </button>
                  <span className={`control-tool-num ${isActive ? 'control-tool-num-active' : ''}`}>
                    T{t.tool}
                    {isActive && <span className="control-tool-live" data-tooltip="Active tool (from the controller)">*</span>}
                  </span>
                  <span className="control-tool-len-cell" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <NumCell
                    shown={t.probedMachineZ === null ? '' : fmtMachineLength(t.probedMachineZ, units)}
                    editable={canEdit}
                    placeholder="-"
                    testId={`control-tool-len-${t.tool}`}
                    onCommit={(text) =>
                      commitDim(text, (mm) => {
                        store.getState().updateTool(machineId, t.tool, {
                          probedMachineZ: mm,
                          // WO-1979: a typed number is not a measurement -
                          // measuredAt stays null so the row says "typed".
                          measuredAt: null,
                        })
                        save()
                      })
                    }
                  />
                  {t.probedMachineZ !== null && (
                    <span
                      className="control-tool-len-source"
                      style={{ fontSize: 10, opacity: 0.7 }}
                      data-testid={`control-tool-len-source-${t.tool}`}
                      data-tooltip={t.measuredAt !== null
                        ? 'Measured by the probe'
                        : 'Typed by hand - not a probe reading'}
                    >
                      {t.measuredAt !== null ? 'measured' : 'typed'}
                    </span>
                  )}
                  </span>
                  <NumCell
                    shown={t.dia === null ? '' : fmtDim(t.dia, units)}
                    editable={canEdit}
                    placeholder="-"
                    testId={`control-tool-dia-${t.tool}`}
                    onCommit={(text) =>
                      commitDim(text, (mm) => {
                        store.getState().updateTool(machineId, t.tool, { dia: mm })
                        save()
                      })
                    }
                  />
                  <button
                    className="panel-action-btn"
                    data-testid={`control-tool-remove-${t.tool}`}
                    disabled={!canEdit}
                    data-tooltip={`Remove T${t.tool} from the table`}
                    aria-label={`Remove T${t.tool} from the table`}
                    onClick={(e) => {
                      e.stopPropagation()
                      store.getState().removeTool(machineId, t.tool)
                      save()
                      if (selected === t.tool) setSelected(null)
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {table.tools.length > 0 && table.reference === null && (
          <div className="control-offsets-meta" data-testid="control-tools-ref-needed">
            No tool is starred Ref. Star the tool you set work Z0 with before Apply length can work.
          </div>
        )}
        {availableForThisSession && (
          <div
            className="control-probe-status"
            data-testid="control-tool-available-measurement"
            data-machine-id={availableMeasurement.machineId}
            data-session-generation={availableMeasurement.sessionGeneration}
            data-measured-at={availableMeasurement.measuredAt}
          >
            <span>
              Available setter touch on {machine?.name ?? machineId}: machine Z{' '}
              {fmtMachineLength(availableMeasurement.machineZ, units)} {unitLabel(units)}. Select a tool to attach it.
            </span>
            <button
              className="modal-btn modal-btn-ghost"
              data-testid="control-tool-attach-measurement"
              disabled={!canEdit || selected === null}
              data-tooltip={selected === null
                ? 'Select an existing tool row first'
                : `Attach this setter contact to T${selected}`}
              onClick={() => {
                if (selected === null) return
                const attached = store.getState().attachAvailableMeasurement(
                  machineId,
                  sessionGeneration,
                  selected,
                )
                if (!attached) return
                save()
                const text = `Attached setter contact machine Z ${fmtMachineLength(attached.machineZ, units)} ${unitLabel(units)} to T${selected}.`
                setStatus({ kind: 'ok', text })
                useMachineControl.getState().pushConsole('rx', `Tool table: ${text}`, 'info')
              }}
            >
              Attach{selected === null ? '' : ` to T${selected}`}
            </button>
          </div>
        )}
        <div className="control-tools-addrow">
          <input
            className="mform-input control-tools-add-input"
            data-testid="control-tool-add-input"
            placeholder="T#"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onAddTool()
            }}
          />
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="control-tool-add"
            disabled={addToolInvalid}
            data-tooltip={addToolInvalid ? 'Type a whole tool number in the T# box first.' : `Add T${addToolText} to the tool table`}
            onClick={onAddTool}
          >
            <Plus size={12} /> Add tool
          </button>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="control-tool-apply"
            disabled={!canAct || !applyResult || !applyResult.ok}
            data-tooltip={
              applyReason !== null
                ? applyReason
                : probeTool !== null && applyResult?.ok
                  ? `Send ${applyResult.line} for T${probeTool}`
                  : 'Pick a measured tool first'
            }
            onClick={() => {
              if (applyResult?.ok && applyToolLengthOffset(applyResult.deltaMm)) {
                const reference = table.tools.find((entry) => entry.tool === table.reference)
                const measured = table.tools.find((entry) => entry.tool === probeTool)
                setStatus({
                  kind: 'ok',
                  text: `Length offset applied for T${probeTool} (${applyResult.line}).`,
                })
                useMachineControl.getState().pushConsole(
                  'rx',
                  reference && measured
                    ? `Tool length: T${probeTool} setter contact ${measured.probedMachineZ === null ? '-' : fmtMachineLength(measured.probedMachineZ!, units)} ${unitLabel(units)} minus reference T${reference.tool} ${reference.probedMachineZ === null ? '-' : fmtMachineLength(reference.probedMachineZ!, units)} ${unitLabel(units)} = ${fmtMachineLength(applyResult.deltaMm, units)} ${unitLabel(units)}; applied ${applyResult.line}.`
                    : `Tool length: applied ${applyResult.line} for T${probeTool}.`,
                  'info',
                )
              }
            }}
          >
            Apply length
          </button>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="control-tool-g49"
            disabled={!canAct || tlo === null || tlo === 0}
            data-tooltip="Clear the tool length offset (G49)"
            onClick={() => {
              if (clearToolLengthOffset()) setStatus({ kind: 'ok', text: 'Length offset cleared (G49).' })
            }}
          >
            Clear
          </button>
        </div>

        <div className="control-probe-section">
          <div className="control-probe-cfg">
            <label>
              Fast ({feedLabel(units)})
              <NumCell
                shown={fmtFeed(probeCfg.fastFeed, units)}
                editable={canEdit}
                testId="control-probe-cfg-fast"
                onCommit={(t) => commitFeed(t, (v) => {
                  store.getState().setProbeConfig(machineId, { fastFeed: v })
                  save()
                })}
              />
            </label>
            <label>
              Fine ({feedLabel(units)})
              <NumCell
                shown={fmtFeed(probeCfg.slowFeed, units)}
                editable={canEdit}
                testId="control-probe-cfg-slow"
                onCommit={(t) => commitFeed(t, (v) => {
                  store.getState().setProbeConfig(machineId, { slowFeed: v })
                  save()
                })}
              />
            </label>
            <label>
              Retract ({unitLabel(units)})
              <NumCell
                shown={fmtMachineLength(probeCfg.retract, units)}
                editable={canEdit}
                testId="control-probe-cfg-retract"
                onCommit={(t) => commitDim(t, (v) => {
                  store.getState().setProbeConfig(machineId, { retract: v })
                  save()
                })}
              />
            </label>
            <label>
              Max travel ({unitLabel(units)})
              <NumCell
                shown={fmtMachineLength(probeCfg.maxTravel, units)}
                editable={canEdit}
                testId="control-probe-cfg-travel"
                onCommit={(t) => commitDim(t, (v) => {
                  store.getState().setProbeConfig(machineId, { maxTravel: v })
                  save()
                })}
              />
            </label>
          </div>
          <div className="control-probe-feedback">
            <div className="probe-lamp-group" data-testid="control-tools-probe-lamps">
              <ProbeLamp kind="probe" value={probeSignals.probe} testId="tools-probe-lamp-probe" />
              <ProbeLamp kind="probing" value={probeSignals.probeCycle} testId="tools-probe-lamp-probing" />
            </div>
            <div className="control-probe-summary">
              <div className="control-probe-summary-row">
                <span className="control-probe-summary-label">Pad compensation</span>
                <span className="control-offsets-meta" data-testid="control-probe-pad-assumption">
                  {workZeroSensing === 'plate'
                    ? `Work Z0 will be set ${fmtMachineLength(probeCfg.padThickness, units)} ${unitLabel(units)} below pad contact.`
                    : 'Work Z0 will be set at the contact - the probe touches the part, no pad is subtracted.'}
                </span>
              </div>
              <div className="control-probe-summary-row">
                <span className="control-probe-summary-label">Z search</span>
                <span className="control-offsets-meta" data-testid="control-probe-z0-search-plan">
                  {partProbeSearch.basis === 'machine-limit'
                    ? `Search from machine Z ${fmtMachineLength(partProbeSearch.startMachineZ!, units)} down to the machine Z limit ${fmtMachineLength(partProbeSearch.bottomMachineZ!, units)} (${fmtMachineLength(partProbeSearch.travelMm, units)} ${unitLabel(units)}).`
                    : partProbeSearch.basis === 'operator-override'
                      ? partProbeSearch.targetMachineZ === partProbeSearch.bottomMachineZ
                        ? `Search from machine Z ${fmtMachineLength(partProbeSearch.startMachineZ!, units)} down to the machine Z limit ${fmtMachineLength(partProbeSearch.bottomMachineZ!, units)} (${fmtMachineLength(partProbeSearch.travelMm, units)} ${unitLabel(units)}); the saved Max travel is longer.`
                        : `Search from machine Z ${fmtMachineLength(partProbeSearch.startMachineZ!, units)} down ${fmtMachineLength(partProbeSearch.travelMm, units)} ${unitLabel(units)}, stopping at machine Z ${fmtMachineLength(partProbeSearch.targetMachineZ!, units)} before the machine Z limit.`
                      : `Search down ${fmtMachineLength(partProbeSearch.travelMm, units)} ${unitLabel(units)} using Max travel${partProbeSearch.bottomMachineZ !== null ? '; current machine Z is not reported' : '; the machine Z limit is not stated'}.`}
                </span>
              </div>
            </div>
            <div className="control-probe-actions">
              {/* WO-1979: the pad is chosen AT PROBING, beside Probe work Z0.
                  The last pad used is the stored active pad (selecting or
                  adding one makes it active), so it is preselected; with one
                  pad there is nothing to pick and the select stays hidden. */}
              <div className="control-probe-pad-choice">
                {probePads.length > 1 && (
                  <label>
                    Pad choice
                    <select
                      className="control-offset-input"
                      data-testid="control-probe-pad-select"
                      value={activeProbePadId}
                      disabled={!canEdit}
                      onChange={(event) => {
                        store.getState().selectProbePad(machineId, event.target.value)
                        save()
                      }}
                    >
                      {probePads.map((pad, index) => (
                        <option key={pad.id} value={pad.id}>
                          Pad {index + 1} - {fmtMachineLength(pad.thickness, units)} {unitLabel(units)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Pad ({unitLabel(units)})
                  <NumCell
                    shown={fmtMachineLength(probeCfg.padThickness, units)}
                    editable={canEdit}
                    testId="control-probe-cfg-pad"
                    onCommit={(t) => commitDim(t, (v) => {
                      store.getState().setProbeConfig(machineId, { padThickness: v })
                      save()
                    })}
                  />
                </label>
                <button
                  className="modal-btn modal-btn-ghost"
                  data-testid="control-probe-pad-add"
                  disabled={!canEdit}
                  data-tooltip="Save the current thickness as another selectable part pad"
                  onClick={() => {
                    store.getState().addProbePad(machineId, probeCfg.padThickness)
                    save()
                  }}
                >
                  <Plus size={12} /> Add pad
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* WO-297: workpiece probing (edge/corner/bore/boss, second-side zero)
            used to live here. An operator who knows the old place must not
            find a hole - it moved to its own Probing tab, unchanged. */}
        <span className="control-offsets-meta" data-testid="control-tools-probing-pointer">
          Use Probing for edge, corner, bore and boss measurements.
        </span>
      </div>
    </section>
  )

  // WO-2429: Probe work Z0 / Measure and their "sensed by" choice sit in the
  // right column under the jog, as the probe cluster does on Control > Probing.
  // The explanation lines and the pad settings stay in the Tools panel.
  const probeCard = (
    <section className="panel control-panel control-tools-probe-card" data-testid="control-tools-probe-card">
      <div className="panel-header">
        <span className="panel-title">Probe</span>
      </div>
      <div className="panel-body control-tools-probe-card-body">
        <div className="control-probe-actions">
              <div
                className="control-probe-sensing"
                role="radiogroup"
                aria-label="Work Z0 sensed by"
                data-testid="control-probe-z0-sensing"
                style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}
              >
                <span>Work Z0 sensed by</span>
                {([
                  ['probe', 'The probe touches the part'],
                  ['plate', `A plate held against it (${fmtMachineLength(probeCfg.padThickness, units)} ${unitLabel(units)})`],
                ] as const).map(([value, label]) => (
                  <label key={value} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <input
                      style={{ width: 'auto', margin: 0, flex: '0 0 auto' }}
                      type="radio"
                      name="control-probe-z0-sensing"
                      value={value}
                      checked={workZeroSensing === value}
                      disabled={busy}
                      data-testid={`control-probe-z0-sensing-${value}`}
                      onChange={() => setProbeSensing(machineId, 'workZero', value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <button
                className="control-jog-btn control-motion-outline control-probe-btn"
                data-testid="control-probe-z0"
                disabled={!canAct}
                data-tooltip={workZeroSensing === 'plate'
                  ? 'Jog the tool over the pad first. Probes down, then sets work Z0 through the pad thickness.'
                  : 'Jog the tool over the part first. Probes down, then sets work Z0 at the contact.'}
                onClick={() => void runProbe('workZero')}
              >
                <ArrowDownToLine size={13} /> {busy ? 'Probing...' : 'Probe work Z0'}
              </button>
              <button
                className="control-jog-btn control-motion-outline control-probe-btn"
                data-testid="control-probe-measure"
                disabled={!canAct || (probeTool === null && !hasSetter)}
                data-tooltip={
                  whyNotIdle !== null
                    ? whyNotIdle
                    : probeTool !== null
                    ? `Probe the ${hasSetter ? 'setter' : 'pad'} and record the length of T${probeTool}`
                    : hasSetter
                      ? 'Probe the tool setter and hold the length as the active tool datum'
                      : 'Pick a tool row (or load a tool) so the measurement has a T number'
                }
                onClick={() => void runProbe('measureTool')}
              >
                <ArrowDownToLine size={13} /> {busy ? 'Probing...' : `Measure ${probeTool !== null ? `T${probeTool}` : 'tool'}`}
              </button>
        </div>
            {status && (
          <div
            className={`control-probe-status ${status.kind === 'error' ? 'control-probe-status-error' : ''}`}
            data-testid="control-probe-status"
          >
            {status.text}
            {status.kind === 'error' && machineState === 'alarm' && (
              <button
                className="modal-btn modal-btn-ghost control-probe-unlock"
                data-testid="control-probe-unlock"
                onClick={() => {
                  if (recoverFromProbeAlarm()) setStatus({ kind: 'ok', text: 'Unlocked - motion mode restored.' })
                }}
              >
                Unlock
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )

  // WO-2430: the Tools panel and the jog rail sit either side of the shared
  // drag bar. The rail starts at Main's rail width and keeps Main's bounds;
  // the Tools panel keeps room for its narrowest designed layout. The jog
  // collapses to its header with JogPanel's own chevron (the same chevron
  // and stored state as on Main).
  return (
    <ResizableSplit
      className="control-tools-workspace"
      testId="control-tools-split"
      prefKey={TOOLS_JOG_PANEL_KEY}
      sizedPane="second"
      defaultSize={MACHINE_PANEL_RIGHT_DEFAULT}
      minSize={MACHINE_PANEL_RIGHT_MIN}
      maxSize={MACHINE_PANEL_RIGHT_MAX}
      fillMinSize={TOOLS_PANEL_MIN_PX}
      label="Resize the Tools and jog panels"
      first={toolsPanel}
      second={
        <aside className="control-tools-jog" aria-label="Tools jog controls" data-testid="control-tools-jog">
          <div className="control-col-scroll">
            <JogPanel />
            {probeCard}
            <div className="control-aux-authority" data-testid="control-aux-authority">
              <ControlTransportBar sections="transport" activeView="tools" />
              <ControlStepRow />
            </div>
          </div>
        </aside>
      }
    />
  )
}

export type { ZProbeConfig }
