import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { Crosshair, Upload } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  useCamStore,
  type StoredMachineWorkOffset,
  type WorkOffsetSyncState,
} from '../../store'
import {
  machineWorkOffsetWriteInFlight,
  setWorkOffsetValue,
  subscribeMachineWorkOffsetWrite,
  WORK_OFFSET_WRITE_BUSY,
  type WcsId,
} from '../../lib/machine/machineSession'
import { fmtMachineLength, unitLabel, type Units } from '../../lib/ui/unitFormat'
import { useMachineControl } from '../../store/machineControlStore'
import {
  canActOnWorkOffsets,
  parseWorkOffsetValue,
  WCS_LIST,
  WORK_OFFSET_AXES,
  workOffsetMarkerAttributes,
  WorkRotationCell,
} from './OffsetsPanel'
import { useDisplayUnits } from './useDisplayUnits'
import { PanelCollapseToggle, usePanelCollapsed } from '../common/CollapsiblePanel'
import { resolveUiScale, useUiPrefs } from '../../store/uiPrefs'

// WO-2431: the split between the quick card and this workspace. The quick card
// keeps its old 350px and never narrows below it - narrower truncates ordinary
// values such as 432.512 (audit 5) - and the workspace keeps room for its
// Actions column (950px clipped it at 1440x900).
export const OFFSETS_QUICK_PANEL_KEY = 'control-offsets-quick'
export const OFFSETS_WORKSPACE_PANEL_KEY = 'control-offsets-workspace'
export const OFFSETS_QUICK_DEFAULT_PX = 350
export const OFFSETS_QUICK_MIN_PX = OFFSETS_QUICK_DEFAULT_PX
export const OFFSETS_QUICK_MAX_PX = 560
export const OFFSETS_WORKSPACE_MIN_PX = 1000

export interface OffsetsSplitPx {
  defaultPx: number
  minPx: number
  maxPx: number
  workspaceMinPx: number
}

/** Pure sizing: every pixel figure above is a 100%-scale figure, and the cells
 *  inside both panes scale with the UI, so the bounds scale with it too. The
 *  default is the old 21.875rem (350 / 437.5 / 525px at 100 / 125 / 150%); the
 *  maximum never drops below it. */
export function offsetsSplitPx(scale: number, viewportW: number): OffsetsSplitPx {
  const defaultPx = OFFSETS_QUICK_DEFAULT_PX * scale
  // The workspace's room can never ask for more than the page leaves beside the
  // default quick width (page margins and scrollbar 24px + the 8px bar), so the default itself
  // is always reachable and End leaves the workspace what main's layout gave it.
  const workspaceMinPx = Math.min(OFFSETS_WORKSPACE_MIN_PX * scale, viewportW - 32 - defaultPx)
  return {
    defaultPx,
    minPx: OFFSETS_QUICK_MIN_PX * scale,
    maxPx: Math.max(OFFSETS_QUICK_MAX_PX * scale, defaultPx),
    workspaceMinPx,
  }
}

/** The split's sizes follow the operator's UI scale like the old 21.875rem did.
 *  Resolved the same way App.tsx sets --ui-scale. */
export function useOffsetsSplitPx(): OffsetsSplitPx {
  const pref = useUiPrefs((s) => s.uiScale)
  const [metrics, setMetrics] = useState(() => ({ w: window.innerWidth, dpr: window.devicePixelRatio || 1 }))
  useEffect(() => {
    const sync = () => setMetrics({ w: window.innerWidth, dpr: window.devicePixelRatio || 1 })
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])
  return offsetsSplitPx(resolveUiScale(pref, metrics.w, metrics.dpr), metrics.w)
}

type WorkOffsetAxis = (typeof WORK_OFFSET_AXES)[number]

const AXIS_INDEX: Record<WorkOffsetAxis, number> = { X: 0, Y: 1, Z: 2 }

function axisKey(axis: WorkOffsetAxis): 'x' | 'y' | 'z' {
  return axis.toLowerCase() as 'x' | 'y' | 'z'
}

export function storedWorkOffsetDiffers(
  stored: StoredMachineWorkOffset | undefined,
  live: number[] | undefined,
): boolean {
  if (!stored) return false
  return WORK_OFFSET_AXES.some((axis) => {
    const value = stored.offset[axisKey(axis)]
    const reported = live?.[AXIS_INDEX[axis]]
    // Text writes and controller readbacks resolve four canonical-mm decimals.
    return value !== undefined && (reported === undefined
      || Number(value.toFixed(4)) !== Number(reported.toFixed(4)))
  })
}

function storedAxisCount(stored: StoredMachineWorkOffset | undefined): number {
  if (!stored) return 0
  return WORK_OFFSET_AXES.filter((axis) => stored.offset[axisKey(axis)] !== undefined).length
}

/** All calls happen in one event-loop turn, so machineSession coalesces the
 * row's axes into its existing single typed setWorkOffset intent. */
export function pushStoredWorkOffset(
  wcs: WcsId,
  stored: StoredMachineWorkOffset | undefined,
  writeValue: typeof setWorkOffsetValue = setWorkOffsetValue,
): boolean {
  if (!stored) return false
  let started = false
  for (const axis of WORK_OFFSET_AXES) {
    const value = stored.offset[axisKey(axis)]
    if (value === undefined) continue
    const accepted = writeValue(wcs, axis, value)
    started = accepted || started
  }
  return started
}

function waitForWorkOffsetWrite(machineId: string): Promise<void> {
  if (!machineWorkOffsetWriteInFlight(machineId)) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = subscribeMachineWorkOffsetWrite(() => {
      if (machineWorkOffsetWriteInFlight(machineId)) return
      unsubscribe()
      resolve()
    })
    // Close the check/subscribe race if a synchronous test controller settled.
    if (!machineWorkOffsetWriteInFlight(machineId)) {
      unsubscribe()
      resolve()
    }
  })
}

export function workOffsetActionRefusal(input: {
  connected: boolean
  machineState: string
  jobPhase: string
  writeBusy: boolean
}): string | null {
  if (!input.connected) return controlText('OffsetsWorkspace.text001')
  if (input.jobPhase === 'streaming' || input.jobPhase === 'paused') {
    return controlText('OffsetsWorkspace.text002')
  }
  if (input.machineState !== 'idle') return controlText('OffsetsWorkspace.text003')
  if (input.writeBusy) return WORK_OFFSET_WRITE_BUSY
  return null
}

function WorkspaceOffsetCell({
  machineId,
  wcs,
  axis,
  valueMm,
  state,
  units,
}: {
  machineId: string
  wcs: WcsId
  axis: WorkOffsetAxis
  valueMm: number | undefined
  state: WorkOffsetSyncState | undefined
  units: Units
}) {
  useText('control-screens-not-probing')
  const inputRef = useRef<HTMLInputElement>(null)
  const shown = valueMm === undefined ? '' : fmtMachineLength(valueMm, units)
  const markerAttributes = workOffsetMarkerAttributes(state)

  // Store/receipt changes replace an idle field. While the person is typing,
  // the DOM's text is only a keystroke buffer; every valid number has already
  // gone to the shared durable record through onChange below.
  useEffect(() => {
    if (inputRef.current && document.activeElement !== inputRef.current) {
      inputRef.current.value = shown
    }
  }, [shown])

  return (
    <span
      className="control-offset-workspace-value"
      data-wired={markerAttributes['data-wired']}
      data-not-sent={markerAttributes['data-not-sent']}
      data-not-applied={markerAttributes['data-not-applied']}
    >
      <input
        ref={inputRef}
        className="control-offset-workspace-input"
        type="text"
        inputMode="decimal"
        defaultValue={shown}
        aria-label={controlText('OffsetsWorkspace.text004', { value1: String(wcs), value2: String(axis) })}
        data-testid={`offsets-workspace-${wcs.toLowerCase()}-${axis.toLowerCase()}`}
        onChange={(event) => {
          const mm = parseWorkOffsetValue(event.currentTarget.value, units)
          if (mm === null || mm === valueMm) return
          useCamStore.getState().setMachineWorkOffset(
            machineId,
            wcs,
            { [axisKey(axis)]: mm },
            'not-sent',
          )
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            event.currentTarget.value = shown
            event.currentTarget.blur()
          }
        }}
        onBlur={(event) => {
          const current = useCamStore.getState().machineWorkOffsets[machineId]?.[wcs]
            ?.offset[axisKey(axis)]
          event.currentTarget.value = current === undefined ? '' : fmtMachineLength(current, units)
        }}
      />
    </span>
  )
}

export function OffsetsWorkspace({
  machineId,
  machineName,
}: {
  machineId: string
  machineName: string
}) {
  useText('control-screens-not-probing')
  const storedOffsets = useCamStore((s) => s.machineWorkOffsets[machineId])
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const machineState = useMachineControl((s) => s.machineState)
  const activeWcs = useMachineControl((s) => s.activeWcs)
  const liveOffsets = useMachineControl((s) => s.offsets)
  const machinePosition = useMachineControl((s) => s.mpos)
  const jobPhase = useMachineControl((s) => s.job.phase)
  const writeBusy = useSyncExternalStore(
    subscribeMachineWorkOffsetWrite,
    () => machineWorkOffsetWriteInFlight(machineId),
    () => machineWorkOffsetWriteInFlight(machineId),
  )
  const units = useDisplayUnits()
  const [pushingAll, setPushingAll] = useState(false)
  const actionRefusal = workOffsetActionRefusal({
    connected,
    machineState,
    jobPhase,
    writeBusy,
  })
  const canAct = canActOnWorkOffsets(connected, machineState, jobPhase)
    && !writeBusy
  const differingRows = WCS_LIST.filter((wcs) =>
    storedWorkOffsetDiffers(storedOffsets?.[wcs], liveOffsets[wcs]))

  const setFromPosition = (wcs: WcsId) => {
    if (!canAct || !machinePosition) return
    const offset = {
      x: machinePosition.x,
      y: machinePosition.y,
      z: machinePosition.z,
    }
    pushStoredWorkOffset(wcs, {
      ...(storedOffsets?.[wcs]?.label !== undefined
        ? { label: storedOffsets[wcs]!.label }
        : {}),
      offset,
      state: 'not-sent',
    })
  }

  const pushAll = async () => {
    if (!canAct || differingRows.length === 0) return
    setPushingAll(true)
    try {
      for (const wcs of differingRows) {
        const current = useMachineControl.getState()
        if (!canActOnWorkOffsets(
          current.connectionPhase === 'connected',
          current.machineState,
          current.job.phase,
        )) break
        const stored = useCamStore.getState().machineWorkOffsets[machineId]?.[wcs]
        if (!storedWorkOffsetDiffers(stored, current.offsets[wcs])) continue
        if (!pushStoredWorkOffset(wcs, stored)) break
        await waitForWorkOffsetWrite(machineId)
      }
    } finally {
      setPushingAll(false)
    }
  }

  const collapsed = usePanelCollapsed(OFFSETS_WORKSPACE_PANEL_KEY)

  return (
    <section
      className={`panel control-panel control-offset-workspace${collapsed ? ' control-offset-workspace-collapsed' : ''}`}
      data-testid="offsets-workspace"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="panel-header control-offset-workspace-header">
        <div>
          <span className="panel-title">{controlText('OffsetsWorkspace.text005')}</span>
          <span className="control-offset-workspace-subtitle">
            {machineName} ({unitLabel(units)})
          </span>
        </div>
        <button
          type="button"
          className="modal-btn modal-btn-ghost control-offset-workspace-push-all"
          data-testid="offsets-workspace-push-all"
          disabled={pushingAll || actionRefusal !== null || differingRows.length === 0}
          data-tooltip={pushingAll ? WORK_OFFSET_WRITE_BUSY : actionRefusal ?? undefined}
          onClick={() => { void pushAll() }}
        >
          <Upload size={14} />{controlText('OffsetsWorkspace.text006')}{differingRows.length})
        </button>
        <PanelCollapseToggle
          panelKey={OFFSETS_WORKSPACE_PANEL_KEY}
          testId="offsets-workspace-collapse"
          collapseTip={controlText('OffsetsWorkspace.text007')}
          expandTip={controlText('OffsetsWorkspace.text008')}
        />
      </div>
      {!collapsed && <div className="panel-body control-offset-workspace-body">
        <div className="control-offset-workspace-table" role="table" aria-label={controlText('OffsetsWorkspace.text009')}>
          <div className="control-offset-workspace-row control-offset-workspace-table-head offsets-rotation-row" role="row">
            <span role="columnheader">{controlText('OffsetsWorkspace.text010')}</span>
            {WORK_OFFSET_AXES.map((axis) => <span key={axis} role="columnheader">{axis}</span>)}
            <span
              role="columnheader"
              data-tooltip={controlText('OffsetsWorkspace.text011')}
            >{controlText('OffsetsWorkspace.text012')}</span>
            <span role="columnheader">{controlText('OffsetsWorkspace.text013')}</span>
          </div>
          {WCS_LIST.map((wcs) => {
            const stored = storedOffsets?.[wcs]
            const hasStoredAxes = storedAxisCount(stored) > 0
            const rowPushDisabled = actionRefusal !== null || !hasStoredAxes
            const positionRefusal = actionRefusal
              ?? (!machinePosition ? controlText('OffsetsWorkspace.text014') : null)
            return (
              <div
                key={wcs}
                className={`control-offset-workspace-row offsets-rotation-row${activeWcs === wcs ? ' control-offset-workspace-active' : ''}`}
                role="row"
                data-testid={`offsets-workspace-row-${wcs.toLowerCase()}`}
              >
                <label className="control-offset-workspace-label" role="cell">
                  <strong>{wcs}</strong>
                  <input
                    type="text"
                    value={stored?.label ?? ''}
                    placeholder={controlText('OffsetsWorkspace.text015')}
                    aria-label={controlText('OffsetsWorkspace.text016', { value1: String(wcs) })}
                    data-testid={`offsets-workspace-label-${wcs.toLowerCase()}`}
                    onChange={(event) => useCamStore.getState()
                      .setMachineWorkOffsetLabel(machineId, wcs, event.currentTarget.value)}
                  />
                </label>
                {WORK_OFFSET_AXES.map((axis) => (
                  <WorkspaceOffsetCell
                    key={axis}
                    machineId={machineId}
                    wcs={wcs}
                    axis={axis}
                    valueMm={stored?.offset[axisKey(axis)]}
                    state={stored?.state}
                    units={units}
                  />
                ))}
                {/* WO-2202: the rotation lives in the controller, not in this
                    stored record - it is sent as typed and shows the report. */}
                <WorkRotationCell
                  wcs={wcs}
                  connected={connected}
                  className="control-offset-workspace-input"
                  wrapperClassName="control-offset-workspace-value offsets-rotation-value"
                  testId={`offsets-workspace-${wcs.toLowerCase()}-rot`}
                />
                <span className="control-offset-workspace-actions" role="cell">
                  <button
                    type="button"
                    className="modal-btn modal-btn-ghost"
                    data-testid={`offsets-workspace-set-position-${wcs.toLowerCase()}`}
                    disabled={positionRefusal !== null}
                    data-tooltip={positionRefusal ?? undefined}
                    onClick={() => setFromPosition(wcs)}
                  >
                    <Crosshair size={13} />{controlText('OffsetsWorkspace.text017')}</button>
                  <button
                    type="button"
                    className="modal-btn modal-btn-ghost"
                    data-testid={`offsets-workspace-push-${wcs.toLowerCase()}`}
                    disabled={rowPushDisabled}
                    data-tooltip={actionRefusal ?? undefined}
                    onClick={() => pushStoredWorkOffset(wcs, stored)}
                  >
                    <Upload size={13} />{controlText('OffsetsWorkspace.text018')}</button>
                </span>
              </div>
            )
          })}
        </div>
      </div>}
    </section>
  )
}
