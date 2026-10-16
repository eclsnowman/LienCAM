import { jsxTextValue } from '../../i18n/locales/en/probing-screens'
import { textFor, useText } from '../../i18n'
const probeText = textFor('probing-screens')

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
import { currentToolOf } from '../../lib/machine/currentTool'
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
  useText('probing-screens')
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
  // WO-2878: the live-tool star names the same tool as the Control chip and
  // TOOL glance. Measuring still defaults to the store's activeTool.
  const currentTool = useMachineControl(currentToolOf)
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
    ? probeText('toolsProbePanel1')
    : busy
      ? probeText('toolsProbePanel2')
      : machineState === 'hold'
        ? probeText('toolsProbePanel3')
        : streaming
          ? probeText('toolsProbePanel4')
          : machineState !== 'idle'
            ? probeText('toolsProbePanel5', { value1: String(machineState) })
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
        const label = mode === 'measureTool' ? probeText('toolsProbePanel6') : probeText('toolsProbePanel7')
        const fast = result.contacts.fastMachineZ === null
          ? probeText('toolsProbePanel8')
          : probeText('toolsProbePanel9', { value1: String(fmtMachineLength(result.contacts.fastMachineZ, units)), value2: String(unitLabel(units)) })
        useMachineControl.getState().pushConsole(
          'rx',
          probeText('toolsProbePanel10', { value1: String(label), value2: String(fast), value3: String(fmtMachineLength(result.contacts.fineMachineZ, units)), value4: String(unitLabel(units)) }),
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
          probeText('toolsProbePanel11', { value1: String(fmtMachineLength(result.probedMachineZ, units)), value2: String(unitLabel(units)), value3: String(receiptTool) })
            + (refSetterZ === null
              ? probeText('toolsProbePanel12', { value1: String(receiptTool), value2: String(receiptTool) })
              : probeText('toolsProbePanel13', { value1: String(fmtMachineLength(refSetterZ, units)), value2: String(unitLabel(units)) })),
          'info',
        )
      } else if (result.ok && result.probedMachineZ !== null && receiptIsCurrent && receiptTool !== null) {
        store.getState().recordProbedZ(receiptMachineId, receiptTool, result.probedMachineZ, Date.now())
        save()
        // WO-2105: Measure T<n> measured the tool in the spindle - that is T<n>.
        useMachineControl.getState().setActiveTool(receiptTool)
        useMachineControl.getState().pushConsole(
          'rx',
          probeText('toolsProbePanel14', { value1: String(fmtMachineLength(result.probedMachineZ, units)), value2: String(unitLabel(units)), value3: String(receiptTool) }),
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
          probeText('toolsProbePanel15', { value1: String(fmtMachineLength(result.probedMachineZ, units)), value2: String(unitLabel(units)), value3: String(machine?.name ?? receiptMachineId) }),
          'info',
        )
      }
      const suffix =
        result.ok && result.probedMachineZ !== null && !receiptIsCurrent
          ? probeText('toolsProbePanel16')
          : result.ok && receiptTool !== null
          ? mode === 'workZero'
            ? probeText('toolsProbePanel17', { value1: String(receiptTool) })
            : probeText('toolsProbePanel18', { value1: String(receiptTool) })
          : result.ok
            ? mode === 'measureTool'
              ? probeText('toolsProbePanel19')
              : probeText('toolsProbePanel20')
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
      ? probeText('toolsProbePanel21', { value1: String(table.reference), value2: String(table.reference), value3: String(table.reference) })
      : applyResult.reason
    : null
  const availableForThisSession = connected
    && availableMeasurement?.machineId === machineId
    && availableMeasurement.sessionGeneration === sessionGeneration

  const toolsPanel = (
    <section className="panel control-panel" data-testid="control-tools-panel">
      <div className="panel-header">
        <span className="panel-title">{probeText('toolsProbePanel23')}</span>
        <span className="control-offsets-meta">{probeText('toolsProbePanel25', { value1: jsxTextValue(tlo === null ? '-' : fmtMachineLength(tlo, units)), value2: jsxTextValue(unitLabel(units)) })}
        </span>
      </div>
      <div className="panel-body control-tools-body">
        {table.tools.length > 0 && (
          <div className="control-tools-table" data-testid="control-tools-table">
            <div className="control-tools-row control-tools-head">
              <span data-tooltip={probeText('toolsProbePanel26')}>{probeText('toolsProbePanel28')}</span>
              <span>{probeText('toolsProbePanel30')}</span>
              <span>{probeText('toolsProbePanel32', { value1: jsxTextValue(unitLabel(units)) })}</span>
              <span>{probeText('toolsProbePanel34')}</span>
              <span />
            </div>
            {table.tools.map((t) => {
              const isRef = table.reference === t.tool
              const isActive = currentTool === t.tool
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
                        ? probeText('toolsProbePanel35')
                        : probeText('toolsProbePanel36')
                    }
                    aria-label={isRef ? probeText('toolsProbePanel37', { value1: String(t.tool) }) : probeText('toolsProbePanel38', { value1: String(t.tool) })}
                    onClick={(e) => {
                      e.stopPropagation()
                      store.getState().setReference(machineId, isRef ? null : t.tool)
                      save()
                      useMachineControl.getState().pushConsole(
                        'rx',
                        isRef
                          ? probeText('toolsProbePanel39', { value1: String(t.tool) })
                          : t.probedMachineZ === null
                            ? probeText('toolsProbePanel40', { value1: String(t.tool) })
                            : probeText('toolsProbePanel41', { value1: String(t.tool), value2: String(fmtMachineLength(t.probedMachineZ, units)), value3: String(unitLabel(units)) }),
                        'info',
                      )
                    }}
                  >
                    <Star size={12} fill={isRef ? 'currentColor' : 'none'} />
                  </button>
                  <span className={`control-tool-num ${isActive ? 'control-tool-num-active' : ''}`}>
                    T{t.tool}
                    {isActive && <span className="control-tool-live" data-tooltip={probeText('toolsProbePanel42')}>*</span>}
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
                        ? probeText('toolsProbePanel43')
                        : probeText('toolsProbePanel44')}
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
                    data-tooltip={probeText('toolsProbePanel45', { value1: String(t.tool) })}
                    aria-label={probeText('toolsProbePanel46', { value1: String(t.tool) })}
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
          <div className="control-offsets-meta" data-testid="control-tools-ref-needed">{probeText('toolsProbePanel48')}</div>
        )}
        {availableForThisSession && (
          <div
            className="control-probe-status"
            data-testid="control-tool-available-measurement"
            data-machine-id={availableMeasurement.machineId}
            data-session-generation={availableMeasurement.sessionGeneration}
            data-measured-at={availableMeasurement.measuredAt}
          >
            <span>{probeText('toolsProbePanel52', { value1: jsxTextValue(machine?.name ?? machineId), value2: jsxTextValue(' '), value3: jsxTextValue(fmtMachineLength(availableMeasurement.machineZ, units)), value4: jsxTextValue(unitLabel(units)) })}</span>
            <button
              className="modal-btn modal-btn-ghost"
              data-testid="control-tool-attach-measurement"
              disabled={!canEdit || selected === null}
              data-tooltip={selected === null
                ? probeText('toolsProbePanel53')
                : probeText('toolsProbePanel54', { value1: String(selected) })}
              onClick={() => {
                if (selected === null) return
                const attached = store.getState().attachAvailableMeasurement(
                  machineId,
                  sessionGeneration,
                  selected,
                )
                if (!attached) return
                save()
                const text = probeText('toolsProbePanel55', { value1: String(fmtMachineLength(attached.machineZ, units)), value2: String(unitLabel(units)), value3: String(selected) })
                setStatus({ kind: 'ok', text })
                useMachineControl.getState().pushConsole('rx', probeText('toolsProbePanel56', { value1: String(text) }), 'info')
              }}
            >{probeText('toolsProbePanel59', { value1: jsxTextValue(selected === null ? '' : probeText('toolsProbePanel58', { value1: String(selected) })) })}
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
            data-tooltip={addToolInvalid ? probeText('toolsProbePanel60') : probeText('toolsProbePanel61', { value1: String(addToolText) })}
            onClick={onAddTool}
          >
            <Plus size={12} />{probeText('toolsProbePanel63')}</button>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="control-tool-apply"
            disabled={!canAct || !applyResult || !applyResult.ok}
            data-tooltip={
              applyReason !== null
                ? applyReason
                : probeTool !== null && applyResult?.ok
                  ? probeText('toolsProbePanel64', { value1: String(applyResult.line), value2: String(probeTool) })
                  : probeText('toolsProbePanel65')
            }
            onClick={() => {
              if (applyResult?.ok && applyToolLengthOffset(applyResult.deltaMm)) {
                const reference = table.tools.find((entry) => entry.tool === table.reference)
                const measured = table.tools.find((entry) => entry.tool === probeTool)
                setStatus({
                  kind: 'ok',
                  text: probeText('toolsProbePanel66', { value1: String(probeTool), value2: String(applyResult.line) }),
                })
                useMachineControl.getState().pushConsole(
                  'rx',
                  reference && measured
                    ? probeText('toolsProbePanel67', { value1: String(probeTool), value2: String(measured.probedMachineZ === null ? '-' : fmtMachineLength(measured.probedMachineZ!, units)), value3: String(unitLabel(units)), value4: String(reference.tool), value5: String(reference.probedMachineZ === null ? '-' : fmtMachineLength(reference.probedMachineZ!, units)), value6: String(unitLabel(units)), value7: String(fmtMachineLength(applyResult.deltaMm, units)), value8: String(unitLabel(units)), value9: String(applyResult.line) })
                    : probeText('toolsProbePanel68', { value1: String(applyResult.line), value2: String(probeTool) }),
                  'info',
                )
              }
            }}
          >{probeText('toolsProbePanel70')}</button>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="control-tool-g49"
            disabled={!canAct || tlo === null || tlo === 0}
            data-tooltip={probeText('toolsProbePanel71')}
            onClick={() => {
              if (clearToolLengthOffset()) setStatus({ kind: 'ok', text: probeText('toolsProbePanel72') })
            }}
          >{probeText('toolsProbePanel74')}</button>
        </div>

        <div className="control-probe-section">
          <div className="control-probe-cfg">
            <label>{probeText('toolsProbePanel76', { value1: jsxTextValue(feedLabel(units)) })}<NumCell
                shown={fmtFeed(probeCfg.fastFeed, units)}
                editable={canEdit}
                testId="control-probe-cfg-fast"
                onCommit={(t) => commitFeed(t, (v) => {
                  store.getState().setProbeConfig(machineId, { fastFeed: v })
                  save()
                })}
              />
            </label>
            <label>{probeText('toolsProbePanel78', { value1: jsxTextValue(feedLabel(units)) })}<NumCell
                shown={fmtFeed(probeCfg.slowFeed, units)}
                editable={canEdit}
                testId="control-probe-cfg-slow"
                onCommit={(t) => commitFeed(t, (v) => {
                  store.getState().setProbeConfig(machineId, { slowFeed: v })
                  save()
                })}
              />
            </label>
            <label>{probeText('toolsProbePanel80', { value1: jsxTextValue(unitLabel(units)) })}<NumCell
                shown={fmtMachineLength(probeCfg.retract, units)}
                editable={canEdit}
                testId="control-probe-cfg-retract"
                onCommit={(t) => commitDim(t, (v) => {
                  store.getState().setProbeConfig(machineId, { retract: v })
                  save()
                })}
              />
            </label>
            <label>{probeText('toolsProbePanel82', { value1: jsxTextValue(unitLabel(units)) })}<NumCell
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
                <span className="control-probe-summary-label">{probeText('toolsProbePanel84')}</span>
                <span className="control-offsets-meta" data-testid="control-probe-pad-assumption">
                  {workZeroSensing === 'plate'
                    ? probeText('toolsProbePanel85', { value1: String(fmtMachineLength(probeCfg.padThickness, units)), value2: String(unitLabel(units)) })
                    : probeText('toolsProbePanel86')}
                </span>
              </div>
              <div className="control-probe-summary-row">
                <span className="control-probe-summary-label">{probeText('toolsProbePanel88')}</span>
                <span className="control-offsets-meta" data-testid="control-probe-z0-search-plan">
                  {partProbeSearch.basis === 'machine-limit'
                    ? probeText('toolsProbePanel89', { value1: String(fmtMachineLength(partProbeSearch.startMachineZ!, units)), value2: String(fmtMachineLength(partProbeSearch.bottomMachineZ!, units)), value3: String(fmtMachineLength(partProbeSearch.travelMm, units)), value4: String(unitLabel(units)) })
                    : partProbeSearch.basis === 'operator-override'
                      ? partProbeSearch.targetMachineZ === partProbeSearch.bottomMachineZ
                        ? probeText('toolsProbePanel90', { value1: String(fmtMachineLength(partProbeSearch.startMachineZ!, units)), value2: String(fmtMachineLength(partProbeSearch.bottomMachineZ!, units)), value3: String(fmtMachineLength(partProbeSearch.travelMm, units)), value4: String(unitLabel(units)) })
                        : probeText('toolsProbePanel91', { value1: String(fmtMachineLength(partProbeSearch.startMachineZ!, units)), value2: String(fmtMachineLength(partProbeSearch.travelMm, units)), value3: String(unitLabel(units)), value4: String(fmtMachineLength(partProbeSearch.targetMachineZ!, units)) })
                      : probeText('toolsProbePanel94', { value1: String(fmtMachineLength(partProbeSearch.travelMm, units)), value2: String(unitLabel(units)), value3: String(partProbeSearch.bottomMachineZ !== null ? probeText('toolsProbePanel92') : probeText('toolsProbePanel93')) })}
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
                  <label>{probeText('toolsProbePanel98')}<select
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
                        <option key={pad.id} value={pad.id}>{probeText('toolsProbePanel97', { value1: jsxTextValue(index + 1), value2: jsxTextValue(fmtMachineLength(pad.thickness, units)), value3: jsxTextValue(unitLabel(units)) })}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>{probeText('toolsProbePanel100', { value1: jsxTextValue(unitLabel(units)) })}<NumCell
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
                  data-tooltip={probeText('toolsProbePanel101')}
                  onClick={() => {
                    store.getState().addProbePad(machineId, probeCfg.padThickness)
                    save()
                  }}
                >
                  <Plus size={12} />{probeText('toolsProbePanel103')}</button>
              </div>
            </div>
          </div>
        </div>

        {/* WO-297: workpiece probing (edge/corner/bore/boss, second-side zero)
            used to live here. An operator who knows the old place must not
            find a hole - it moved to its own Probing tab, unchanged. */}
        <span className="control-offsets-meta" data-testid="control-tools-probing-pointer">{probeText('toolsProbePanel105')}</span>
      </div>
    </section>
  )

  // WO-2429: Probe work Z0 / Measure and their "sensed by" choice sit in the
  // right column under the jog, as the probe cluster does on Control > Probing.
  // The explanation lines and the pad settings stay in the Tools panel.
  const probeCard = (
    <section className="panel control-panel control-tools-probe-card" data-testid="control-tools-probe-card">
      <div className="panel-header">
        <span className="panel-title">{probeText('toolsProbePanel107')}</span>
      </div>
      <div className="panel-body control-tools-probe-card-body">
        <div className="control-probe-actions">
              <div
                className="control-probe-sensing"
                role="radiogroup"
                aria-label={probeText('toolsProbePanel108')}
                data-testid="control-probe-z0-sensing"
                style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}
              >
                <span>{probeText('toolsProbePanel110')}</span>
                {([
                  ['probe', probeText('toolsProbePanel111')],
                  ['plate', probeText('toolsProbePanel112', { value1: String(fmtMachineLength(probeCfg.padThickness, units)), value2: String(unitLabel(units)) })],
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
                  ? probeText('toolsProbePanel113')
                  : probeText('toolsProbePanel114')}
                onClick={() => void runProbe('workZero')}
              >
                <ArrowDownToLine size={13} /> {busy ? probeText('toolsProbePanel115') : probeText('toolsProbePanel116')}
              </button>
              <button
                className="control-jog-btn control-motion-outline control-probe-btn"
                data-testid="control-probe-measure"
                disabled={!canAct || (probeTool === null && !hasSetter)}
                data-tooltip={
                  whyNotIdle !== null
                    ? whyNotIdle
                    : probeTool !== null
                    ? probeText('toolsProbePanel117', { value1: String(hasSetter ? 'setter' : 'pad'), value2: String(probeTool) })
                    : hasSetter
                      ? probeText('toolsProbePanel118')
                      : probeText('toolsProbePanel119')
                }
                onClick={() => void runProbe('measureTool')}
              >
                <ArrowDownToLine size={13} /> {busy ? probeText('toolsProbePanel120') : probeText('toolsProbePanel121', { value1: String(probeTool !== null ? `T${probeTool}` : 'tool') })}
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
                  if (recoverFromProbeAlarm()) setStatus({ kind: 'ok', text: probeText('toolsProbePanel122') })
                }}
              >{probeText('toolsProbePanel124')}</button>
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
      label={probeText('toolsProbePanel125')}
      first={toolsPanel}
      second={
        <aside className="control-tools-jog" aria-label={probeText('toolsProbePanel126')} data-testid="control-tools-jog">
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
