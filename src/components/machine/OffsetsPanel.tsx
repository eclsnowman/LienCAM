import { catalogChildren } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

// OffsetsPanel - work coordinate systems (MACHINE-CONTROL plan, stage 8).
// CANONICAL-LOCATION rule (Operator 2026-07-31): this panel is about WHICH
// system is active and WHAT is stored - selection + tables only. Zeroing
// lives with the DRO (Position panel); homing lives with motion (Jog panel).

import { ChevronDown, ChevronUp } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import {
  controlMachine,
  useCamStore,
  type WorkOffsetSyncState,
} from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'
import {
  machineWorkOffsetWriteInFlight,
  selectWorkOffset,
  setWorkOffsetValue,
  setWorkRotation,
  subscribeMachineWorkOffsetWrite,
  subscribeToolChangeHold,
  subscribeWorkRotations,
  toolChangeHoldActive,
  workRotations,
  WORK_OFFSET_WRITE_BUSY,
  type WcsId,
} from '../../lib/machine/machineSession'
import { useDisplayUnits } from './useDisplayUnits'
import { fmtMachineLength, parseDimToMm, unitLabel, type Units } from '../../lib/ui/unitFormat'
import { NumCell } from './NumCell'
import { enabledControlAxes, isRotaryAxis, type ControlAxis } from '../../lib/machine/controller'
import { AXIS_NAMES } from '../../types'
import './offsetsRotation.css'

export const WCS_LIST: readonly WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']
export const WORK_OFFSET_AXES = ['X', 'Y', 'Z'] as const

/** Physical work-offset actions share this gate. Editing an offline record is
 * not a physical action: it stays available so it can be pushed later. */
export function canActOnWorkOffsets(
  connected: boolean,
  machineState: string,
  jobPhase: string,
): boolean {
  const streaming = jobPhase === 'streaming' || jobPhase === 'paused'
  return connected && machineState === 'idle' && !streaming
}

export function parseWorkOffsetValue(
  text: string,
  units: Units,
  axis: ControlAxis = 'X',
): number | null {
  const value = isRotaryAxis(axis)
    ? Number(text.trim().replace(/\s*(deg|degree|degrees)\s*$/i, ''))
    : parseDimToMm(text, units)
  return Number.isFinite(value) ? value : null
}

function formatWorkOffsetValue(value: number, units: Units, axis: ControlAxis): string {
  return isRotaryAxis(axis) ? value.toFixed(3) : fmtMachineLength(value, units)
}

/** Reuse the WO-947 provenance markers rather than inventing a second visual
 * language for whether a durable value has reached the machine. WO-1182: the
 * marker attribute is the ONLY trace of sync state the operator sees - no
 * sentence, no second number, no legend (Operator: "they want to put in their
 * offsets and have them obeyed. we don't need to tell them how the sausage is
 * made"). */
export function workOffsetMarkerAttributes(state: WorkOffsetSyncState | undefined) {
  return {
    'data-wired': state === 'sent' || state === 'restored' ? '' : undefined,
    'data-not-sent': state === 'not-sent' || state === 'adopted-from-profile' ? '' : undefined,
    'data-not-applied': state === 'bridge-differs' || state === 'unknown' ? '' : undefined,
  }
}

/**
 * One editable offset register cell: type a value (in display units) and it
 * writes the controller's WCS register through its typed intent when present,
 * or the acknowledged text compatibility route, then re-reads.
 * Uncontrolled with a value-derived key so the shared durable record and
 * controller refreshes replace an idle field.
 */
function OffsetCell({
  wcs,
  axis,
  valueMm,
  units,
  controllerCanTakeWrite,
  machineId,
  writeBusy,
  allowEmptyInput,
  storedState,
}: {
  wcs: WcsId
  axis: ControlAxis
  valueMm: number | undefined
  units: Units
  /** The controller may receive the existing typed write now. When it may
   * not, a valid edit updates the durable record for a later Push instead. */
  controllerCanTakeWrite: boolean
  machineId: string
  storedState: WorkOffsetSyncState | undefined
  /** WO-1042: an offset write on this machine is awaiting its receipt. Only one
   * may be in flight, so every offset control is disabled until it lands. */
  writeBusy: boolean
  /** Disconnected has no controller readback, but it must still offer a first
   * durable entry. Connected missing registers keep their established dash. */
  allowEmptyInput: boolean
}) {
  // A disconnected controller intentionally has no readback. Its blank durable
  // record is still editable; a connected controller's absent register stays
  // rendered as its established dash.
  const shown = valueMm === undefined
    ? (allowEmptyInput ? '' : null)
    : formatWorkOffsetValue(valueMm, units, axis)
  const cell = shown === null
    ? <span>-</span>
    : (
      <NumCell
        key={valueMm}
        className="control-offset-input"
        shown={shown}
        editable={!writeBusy}
        testId={`control-offset-${wcs.toLowerCase()}-${axis.toLowerCase()}`}
        onCommit={(text) => {
          const mm = parseWorkOffsetValue(text, units, axis)
          if (mm === null) return false
          if (mm === valueMm) return false
          if (controllerCanTakeWrite) return setWorkOffsetValue(wcs, axis, mm)
          const key = axis.toLowerCase() as Lowercase<ControlAxis>
          useCamStore.getState().setMachineWorkOffset(machineId, wcs, { [key]: mm }, 'not-sent')
        }}
      />
    )
  // The hint hangs off a WRAPPER rather than off the input: a disabled control
  // does not reliably fire the hover a tooltip needs (WO-929), and the wrapper
  // is a grid item standing exactly where the input stood, so the row keeps its
  // shape. It is rendered ONLY while a write awaits its receipt, and it clears
  // on that receipt. WO-1547: every controller has a route for these writes.
  const hint = writeBusy ? WORK_OFFSET_WRITE_BUSY : null
  const liveCell = hint
    ? <span aria-disabled={writeBusy || undefined} data-tooltip={hint}>{cell}</span>
    : cell
  if (storedState === undefined) return liveCell
  // One number per axis. The sync state survives only as the marker attribute.
  return (
    <span data-offset-value-pair="" {...workOffsetMarkerAttributes(storedState)}>
      {liveCell}
    </span>
  )
}

/** WO-2202: a work rotation as both offsets tables show it - degrees, three
 * places, like a rotary axis cell. */
export function formatWorkRotation(degrees: number): string {
  return degrees.toFixed(3)
}

/** WO-2202: typed degrees ("30", "-0.73", "12 deg"); blank is no change. */
export function parseWorkRotation(text: string): number | null {
  const trimmed = text.trim().replace(/\s*(deg|degree|degrees)\s*$/i, '')
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/**
 * WO-2202 (Operator ruling 2026-09-29: "see and even edit this in the offsets panel and
 * offsets tab"): one work system's rotation, degrees CCW seen from +Z
 * (docs/design/WCS-ROTATION.md), in the same cell the X Y Z registers use.
 * The number is the controller's REPORT (machineSession.workRotations, 0 when
 * it reports none) - never the typed text: a commit goes to the controller
 * through setWorkRotation (0 clears) and the field goes straight back to the
 * report, which then shows whatever the controller says it now holds. A
 * controller that cannot rotate reports 0; typing into it gets the session's
 * console line saying so. Disconnected there is no report: a dash.
 */
export function WorkRotationCell({
  wcs,
  connected,
  className,
  wrapperClassName = 'offsets-rotation-value',
  testId,
}: {
  wcs: WcsId
  connected: boolean
  className?: string
  wrapperClassName?: string
  testId: string
}) {
  const rotations = useSyncExternalStore(subscribeWorkRotations, workRotations, workRotations)
  if (!connected) return <span className={wrapperClassName} data-testid={testId}>-</span>
  const degrees = rotations[wcs] ?? 0
  const shown = formatWorkRotation(degrees)
  return (
    <span className={wrapperClassName} data-rotated={degrees !== 0 ? '' : undefined}>
      <NumCell
        className={className}
        shown={shown}
        testId={testId}
        onCommit={(text) => {
          const value = parseWorkRotation(text)
          if (value !== null && formatWorkRotation(value) !== shown) void setWorkRotation(wcs, value)
          return false
        }}
      />
    </span>
  )
}

const ROTATION_HEAD_TOOLTIP = controlText('OffsetsPanel.text001')
  + controlText('OffsetsPanel.text002')

export function OffsetsPanel() {
  useText('control-screens-not-probing')
  const machine = useCamStore(controlMachine)
  const axes = enabledControlAxes(machine.controllerDefinition)
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const machineState = useMachineControl((s) => s.machineState)
  const activeWcs = useMachineControl((s) => s.activeWcs)
  const offsets = useMachineControl((s) => s.offsets)
  const tlo = useMachineControl((s) => s.tlo)
  const probe = useMachineControl((s) => s.probe)
  const jobPhase = useMachineControl((s) => s.job.phase)
  const storedOffsets = useCamStore((s) => s.machineWorkOffsets[controlMachine(s).id])
  const machineId = useCamStore((s) => controlMachine(s).id)
  // WO-1042: the machine session owns this fact because the bridge call
  // outlives this panel. One offset write may be in flight per machine, so
  // while one is, every cell here is dead - the session refuses a second one.
  const writeBusy = useSyncExternalStore(
    subscribeMachineWorkOffsetWrite,
    () => machineWorkOffsetWriteInFlight(machineId),
    () => machineWorkOffsetWriteInFlight(machineId),
  )
  const units = useDisplayUnits()

  const collapsed = useUiPrefs((s) => s.machineOffsetsCollapsed)

  const canAct = canActOnWorkOffsets(connected, machineState, jobPhase)
  // WO-1330: at a tool-change hold every cell writes LIVE, so its commit reaches
  // `setWorkOffsetValue` and the session's one answer about which frame and axis
  // this hold sets (`workOffsetWriteRefusal`). This panel keeps no copy of that
  // rule; a refused commit puts the old value back and the console says why.
  const toolChangeHold = useSyncExternalStore(
    subscribeToolChangeHold,
    toolChangeHoldActive,
    () => false,
  )
  const liveAtHold = toolChangeHold && connected && machineState === 'idle'
  const activeOffsetReported = connected && activeWcs !== null && offsets[activeWcs] !== undefined

  // Collapsed: the ACTIVE system's row only (Operator 2026-07-31) - still
  // inline-editable, everything else waits behind the chevron.
  const shownList: readonly WcsId[] = collapsed
    ? (activeWcs ? [activeWcs] : [])
    : WCS_LIST
  // WO-2202: the rotation column follows the axes; the 3-axis grid is in
  // offsetsRotation.css.
  const rowGrid = axes.length === 3
    ? undefined
    : { gridTemplateColumns: controlText('OffsetsPanel.text003', { value1: String(axes.length) }) }

  return (
    <section className="panel control-panel">
      <div className="panel-header">
        <span className="panel-title">{controlText('OffsetsPanel.text004')}</span>
        {collapsed && !activeWcs && <span className="control-offsets-meta">-</span>}
        <button
          className="panel-action-btn"
          data-testid="control-offsets-toggle"
          onClick={() => useUiPrefs.setState({ machineOffsetsCollapsed: !collapsed })}
          data-tooltip={
            collapsed ? controlText('OffsetsPanel.text005') : controlText('OffsetsPanel.text006')
          }
          aria-label={collapsed ? controlText('OffsetsPanel.text007') : controlText('OffsetsPanel.text008')}
        >
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>
      <div className="panel-body control-offsets-body">
        {!collapsed && (
          // WO-1046: these stay LIVE on a controller with no text path.
          // `selectWorkOffset` goes through `selectWcs`, which is a CALL on
          // every backend (the bridge sends a `selectWcs` frame), so this
          // control has a route whatever the hello said about text.
          <div className="control-wcs-row">
            {WCS_LIST.map((wcs) => (
              <button
                key={wcs}
                className={`control-chip-btn control-wcs-chip ${activeOffsetReported && activeWcs === wcs ? 'control-chip-active' : ''}`}
                data-testid={`control-wcs-${wcs.toLowerCase()}`}
                disabled={!canAct}
                data-tooltip={controlText('OffsetsPanel.text009', { value1: String(wcs) })}
                onClick={() => selectWorkOffset(wcs)}
              >
                {wcs}
              </button>
            ))}
          </div>
        )}
        <div className="control-offsets-table" data-testid="control-offsets-table">
          <div
            className="control-offsets-row control-offsets-head offsets-rotation-row"
            style={rowGrid}
          >
            <span>{collapsed ? controlText('OffsetsPanel.text010') : ''}</span>
            {axes.map((axis) => (
              <span key={axis}>{axis}{isRotaryAxis(axis) ? ' (deg)' : ''}</span>
            ))}
            <span className="offsets-rotation-head" data-tooltip={ROTATION_HEAD_TOOLTIP}>{controlText('OffsetsPanel.text011')}</span>
          </div>
          {shownList.map((wcs) => {
            const v = offsets[wcs]
            const stored = storedOffsets?.[wcs]
            return (
              <div
                key={wcs}
                className={`control-offsets-row offsets-rotation-row ${activeOffsetReported && activeWcs === wcs ? 'control-offsets-active' : ''}`}
                style={rowGrid}
              >
                <span
                  className="control-offsets-label"
                  {...workOffsetMarkerAttributes(stored?.state === 'unknown' ? stored.state : undefined)}
                >
                  {wcs}
                </span>
                {axes.map((axis) => (
                  <OffsetCell
                    key={axis}
                    wcs={wcs}
                    axis={axis}
                    // WO-1266: connected, this table shows what the controller
                    // REPORTED and nothing else - a slot it has not reported
                    // is a dash, never this computer's remembered number and
                    // never an unsent edit (that intent lives on the Offsets
                    // tab beside its Push button). Disconnected, this compact
                    // machine-status card shows dashes; the editable durable
                    // record remains available in the Offsets workspace.
                    valueMm={connected ? v?.[AXIS_NAMES.indexOf(axis)] : undefined}
                    units={units}
                    controllerCanTakeWrite={canAct || liveAtHold}
                    machineId={machineId}
                    writeBusy={writeBusy}
                    allowEmptyInput={false}
                    storedState={stored?.state}
                  />
                ))}
                <WorkRotationCell
                  wcs={wcs}
                  connected={connected}
                  testId={`control-offset-${wcs.toLowerCase()}-rot`}
                />
              </div>
            )
          })}
          {collapsed && shownList.length === 0 && (
            <div className="control-offsets-row offsets-rotation-row">
              <span className="control-offsets-label">{controlText('OffsetsPanel.text012')}</span>
              <span>-</span>
              <span>-</span>
              <span>-</span>
              <span>-</span>
            </div>
          )}
        </div>
        {!collapsed && (
          <div className="control-offsets-meta">
            <span>({unitLabel(units)})</span>
            <span>{catalogChildren(controlText('OffsetsPanel.text013', { value1: '\u0000value1\u0000' }), { value1: tlo === null ? '-' : fmtMachineLength(tlo, units) })}</span>
            <span>{catalogChildren(controlText('OffsetsPanel.text014', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: ' ', value2: probe
                ? `${probe.values.map((v) => fmtMachineLength(v, units)).join(', ')}${probe.success ? '' : ' (failed)'}`
                : '-' })}</span>
          </div>
        )}
      </div>
    </section>
  )
}
