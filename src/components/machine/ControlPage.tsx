import { catalogChildren, liveCatalog } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

// ControlPage - the machine-control workspace (MACHINE-CONTROL plan, stage 3).
// Hosts the GRBL sender UI. Mounted lazily on first entry and then RETAINED
// (display:none, never unmounted) by App.tsx so a live serial session and its
// state survive tab switches - same lifecycle as the Model workbench.
//
// This stage ships the working skeleton: connection (Web Serial), live DRO +
// machine state, console with MDI. Jog, overrides, and program streaming
// panels land in the next stages of docs/planning/MACHINE-CONTROL-PLAN.md.

import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Plug, PlugZap, Settings, X } from 'lucide-react'
import {
  controlMachine,
  machineSerialBaud,
  useCamStore,
} from '../../store'
import { useMachineControl, type MachineConsoleLine } from '../../store/machineControlStore'
import { isDemoBuild } from '../../lib/demoBuild'
import {
  connectMachine,
  disconnectMachine,
  estopNeedsReset,
  getMachineController,
  subscribeEstopNeedsReset,
  setMachinePosition,
  noHomeSwitchesRefusal,
  sendAppCommand,
  workGotoZeroRefusal,
  webSerialSupported,
  type MachineConnectionKind,
} from '../../lib/machine/machineSession'
import { resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'
import type { MachinePosition } from '../../lib/machine/types'
import { machineHasNoHomeSwitches, type MachineConfig } from '../../types'
import { JogPanel } from './JogPanel'
import { MachineDefinitionPanel } from './MachineDefinitionPanel'
import { OverridePanel } from './OverridePanel'
import { SpindlePanel } from './SpindlePanel'
import { MacroPanel } from './MacroPanel'
import { MachineActionsModal } from './MachineActionsModal'
import {
  OffsetsPanel,
  workOffsetMarkerAttributes,
} from './OffsetsPanel'
import { usePanelCollapsed } from '../common/CollapsiblePanel'
import { OffsetsWorkspace, OFFSETS_WORKSPACE_PANEL_KEY, OFFSETS_QUICK_PANEL_KEY, useOffsetsSplitPx } from './OffsetsWorkspace'
import { ResizableSplit } from '../common/ResizableSplit'
import { ToolsProbePanel } from './ToolsProbePanel'
import { ProbingPanel } from './ProbingPanel'
import { ProbeLamp, useProbeSignals } from './ProbeLamp'
import { ProbeRoutinesTab } from './ProbeRoutinesTab'
import { CycleLogPanel } from './CycleLogPanel'
import { SimulatedPartPanel } from './SimulatedPartPanel'
import { ProgramPanel } from './ProgramPanel'
import { ControlStepRow, ControlTransportBar, type ControlView } from './ControlTransportBar'
import { ToolGlance, toolDescription, useCurrentTool } from './ToolGlance'
import {
  ControlCollapsedReadout,
  ControlPanelCollapseToggle,
  useControlPanelCollapsed,
} from './ControlPanelCollapseToggle'
import { useControlJogKeys } from '../../hooks/useControlJogKeys'
import {
  gotoWorkXYZero,
  machineWorkOffsetWriteInFlight,
  sendMdiLine,
  subscribeMachineWorkOffsetWrite,
  pausedProgramTakesCommands,
  subscribePausedProgramTakesCommands,
  subscribeToolChangeHold,
  toolChangeHoldActive,
  programClampPauseTakesMdi,
  programM0HoldLine,
  zeroWorkAxes,
} from '../../lib/machine/machineSession'
import {
  authorize,
  type OperatorAuthority,
  type OperatorAuthorityFacts,
} from '../../lib/machine/operatorAuthority'
import { Crosshair } from 'lucide-react'
import { useDisplayUnits } from './useDisplayUnits'
import { feedLabel, fmtMachineLength, fmtFeed, parseDimToMm, unitLabel, type Units } from '../../lib/ui/unitFormat'
import {
  MACHINE_PANEL_LEFT_DEFAULT,
  MACHINE_PANEL_LEFT_MAX,
  MACHINE_PANEL_LEFT_MIN,
  MACHINE_PANEL_RIGHT_DEFAULT,
  MACHINE_PANEL_RIGHT_MAX,
  MACHINE_PANEL_RIGHT_MIN,
  machineBridgePort,
  useUiPrefs,
} from '../../store/uiPrefs'
import { programSplitGridStyle, useProgramPreviewPercent } from './ProgramDivider'
import { NumCell } from './NumCell'
import { PendantPanel } from './PendantPanel'
import { controllerSurface } from '../../lib/machine/controllerSurface'
import { backendDefinitionFor } from '../../lib/machine/backendRegistry'
import {
  describeAxisList,
  enabledControlAxes,
  isRotaryAxis,
  type ControlAxis,
} from '../../lib/machine/controller'
import { controllerDisplayName, isGrblFamily } from '../../lib/machine/machineChoice'
import { controllerBoardName } from '../../lib/machine/controllerBoard'
import {
  bridgeHostCapability,
  bridgeProcessStatus,
  prepareHostedBridgeForConnect,
  type BridgeProcessStatus,
} from '../../lib/machine/bridgeHost'

/** Filter only transports a declared controller cannot speak. Generic,
 * LinuxCNC, and legacy unknown declarations keep the pre-WO-1065 capability
 * set: transport is independent of post dialect until a profile rules it out.
 * WO-2066: except the machine bridge, which drives UCCNC and nothing else
 * (Operator ruling 2026-09-26: "UCCNC and LinuxCNC are completely different software").
 * It is offered only where the registry has a bridge route - a UCCNC machine.
 * Every other choice, and every machine's simulator, is offered as before. */
export function controlConnectionKinds(
  machine: Pick<MachineConfig, 'controller'>,
): MachineConnectionKind[] {
  return controllerSurface(machine).connectionKinds
    .filter((kind) => kind !== 'bridge' || backendDefinitionFor(machine.controller, 'bridge') !== null)
}

/** WO-1987: LinuxCNC's own connection - gateway.py on this computer. */
const LINUXCNC_GATEWAY_LABEL = controlText('ControlPage.text001')

/** The declared controller's own default when it is offered (UCCNC: the bridge,
 *  GRBL: serial - both first in their lists, as before; LinuxCNC: its gateway
 *  (WO-1987); Generic: its simulator, where the removed bridge used to sit
 *  first). */
function defaultControlConnectionKind(
  machine: Pick<MachineConfig, 'controller'>,
  serialSupported: boolean,
): MachineConnectionKind {
  const offered = controlConnectionKinds(machine)
  const declared = controllerSurface(machine).defaultConnectionKind
  const first = offered.includes(declared) ? declared : offered[0]
  return first === 'serial' && !serialSupported ? 'simulator' : first
}

/**
 * WO-184: a tool note is free text ("1/4 downcut for the plywood job"), and the
 * collapsed TOOL header is a 26px rail row - an unbounded note wraps it and
 * crushes the identity it exists to show. 16 characters is the widest that
 * still fits beside "T12" and a TLO at the 350px rail default.
 */
const TOOL_DESC_MAX = 16
function shortToolDesc(desc: string): string {
  return desc.length > TOOL_DESC_MAX ? `${desc.slice(0, TOOL_DESC_MAX - 3).trimEnd()}...` : desc
}

type MachineAxisKey = Lowercase<ControlAxis>

function axisKey(axis: ControlAxis): MachineAxisKey {
  return axis.toLowerCase() as MachineAxisKey
}

function axisUnit(axis: ControlAxis, units: Units): string {
  return isRotaryAxis(axis) ? 'deg' : unitLabel(units)
}

function fmtAxis(v: number | null | undefined, axis: ControlAxis, units: Units): string {
  if (v === null || v === undefined) return '---'
  return isRotaryAxis(axis) ? v.toFixed(3) : fmtMachineLength(v, units)
}

/** WO-2474: all Control lengths share two mm / three inch decimals. */
function fmtDroAxis(v: number | null | undefined, axis: ControlAxis, units: Units): string {
  if (v === null || v === undefined) return '---'
  return fmtAxis(v, axis, units)
}

function parseAxisValue(text: string, axis: ControlAxis, units: Units): number {
  if (!isRotaryAxis(axis)) return parseDimToMm(text, units)
  const value = Number(text.trim().replace(/\s*(deg|degree|degrees)\s*$/i, ''))
  return Number.isFinite(value) ? value : Number.NaN
}

// WO-2257: ONE formatter, built once. `toLocaleTimeString` with options builds
// a fresh Intl.DateTimeFormat on every call, and the console called it once
// per row on every Control render - 10.8% of the mini PC's renderer at 203
// rows (C-4, 2026-09-30). Same locale, same options, same text.
let consoleTimeFormat: Intl.DateTimeFormat | null = null

export function formatControlConsoleTime(at: number): string {
  consoleTimeFormat ??= new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return consoleTimeFormat.format(new Date(at))
}

const SWITCHED_NO_DATUM_CONSOLE_TEXT =
  controlText('ControlPage.text002')
const SWITCHED_NO_DATUM_COLLAPSED_TEXT =
  controlText('ControlPage.text003')

function controlConsoleDisplayText(text: string, collapsed: boolean): string {
  // WO-1343: retain the full event in expanded history, but use equivalent
  // compact copy in the one-line view so WO-1321's time and direction remain visible.
  return collapsed && text === SWITCHED_NO_DATUM_CONSOLE_TEXT
    ? SWITCHED_NO_DATUM_COLLAPSED_TEXT
    : text
}

/** One console row. A row never changes after it is pushed, so memo by the
 *  line object skips every row that was already on screen. */
const ControlConsoleRow = memo(function ControlConsoleRow({
  line,
  collapsed,
}: {
  line: MachineConsoleLine
  collapsed: boolean
}) {
  return (
    <div
      className={`control-console-line control-console-${line.dir} ${
        line.severity === 'error' ? 'control-console-error' : ''
      }`}
    >
      <span className="control-console-dir">{line.dir === 'tx' ? '>' : '<'}</span>
      {line.at === undefined ? null : (
        <span
          className="control-console-time"
          style={{ color: 'var(--text-disabled)', flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          {formatControlConsoleTime(line.at)}
        </span>
      )}
      <span className="control-console-text">
        {controlConsoleDisplayText(line.text, collapsed)}
      </span>
    </div>
  )
})

/** WO-2257: the console rows render only when the console changes.
 *
 *  The Control page re-renders on every status frame - 40 a second while an
 *  axis moves - and the rows used to render with it, all 500 of them at the
 *  store's cap. On the mini PC that kept the renderer busy long enough that
 *  the held jog's keep-alive missed the bridge's 250 ms deadman and the jog
 *  stopped under Operator's finger (C-4, 2026-09-30). Same rows, same text, same
 *  times; they are just not rebuilt for a frame that did not touch them. */
const ControlConsoleLines = memo(function ControlConsoleLines({
  lines,
  collapsed,
}: {
  lines: MachineConsoleLine[]
  collapsed: boolean
}) {
  return (
    <>
      {(collapsed ? lines.slice(-1) : lines).map((line) => (
        <ControlConsoleRow key={line.id} line={line} collapsed={collapsed} />
      ))}
    </>
  )
})

function clampW(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Drag handle for the Control-tab column widths (persisted in uiPrefs). */
function ControlColResizer({ side }: { side: 'left' | 'right' }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const prefs = useUiPrefs.getState()
    const startW = side === 'left' ? prefs.machineLeftPanelW : prefs.machineRightPanelW
    const onMove = (ev: PointerEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX
      const w =
        side === 'left'
          ? clampW(startW + delta, MACHINE_PANEL_LEFT_MIN, MACHINE_PANEL_LEFT_MAX)
          : clampW(startW + delta, MACHINE_PANEL_RIGHT_MIN, MACHINE_PANEL_RIGHT_MAX)
      useUiPrefs.setState(side === 'left' ? { machineLeftPanelW: w } : { machineRightPanelW: w })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div
      className="panel-resizer control-col-resizer"
      data-testid={`control-resizer-${side}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() =>
        useUiPrefs.setState(
          side === 'left'
            ? { machineLeftPanelW: MACHINE_PANEL_LEFT_DEFAULT }
            : { machineRightPanelW: MACHINE_PANEL_RIGHT_DEFAULT },
        )
      }
    />
  )
}

/** WO-303: which readout column was typed in - the frame the typed number is
 *  expressed in, which decides both the refusal rules and how it converts to
 *  a machine-frame target for the envelope check. */
type GotoFrame = 'work' | 'machine'

/** A parsed, refusal-checked goto waiting on the confirm dialog. Deliberately
 *  holds only the operator's REQUEST (axis, frame, the typed target) - never
 *  a snapshot of "current position" or "delta", which is exactly the frozen
 *  state that let two earlier attempts compose a move on top of a position
 *  the machine had already left (see the audit history in this WO's queue
 *  file). The current position and the delta are derived FRESH, from live
 *  state, every time they are needed - for display and at confirm time. */
interface PendingGoto {
  axis: ControlAxis
  frame: GotoFrame
  targetMm: number
}

function DroAxisRow({
  axis,
  homed,
  work,
  workUndefined,
  machine,
  machineUndefined,
  zeroGate,
  writeBusy,
  units,
  formatAxis,
  attemptGoto,
  attemptSetDatum,
}: {
  axis: ControlAxis
  homed: boolean
  work: number | null
  /** The reported work position remains the unhomed motion-entry source even
   *  while the display is dashed because the machine datum is unknown. */
  workUndefined: boolean
  machine: number | null
  /** WO-994: this row's machine cell is dashed because there is NO DATUM yet,
   *  as opposed to dashed because nothing has reported at all. It is the only
   *  extra input the row needs to tell the two apart. */
  machineUndefined: boolean
  /** WO-1992: the operator authority table's zeroWorkAxis verdict. */
  zeroGate: OperatorAuthority
  /** WO-1042: an offset write on this machine is awaiting its receipt. Only
   *  one may be in flight, so the zero chip is dead until it lands. */
  writeBusy: boolean
  units: Units
  formatAxis: typeof fmtAxis
  attemptGoto: (frame: GotoFrame, axis: ControlAxis, text: string) => boolean | void
  attemptSetDatum: (axis: ControlAxis, text: string) => boolean | void
}) {
  useText('control-screens-not-probing')
  /**
   * WO-994 - Operator'S DISAMBIGUATION RULE, WRITTEN WHERE IT IS ENFORCED:
   *
   *     cell shows DASHES (undefined)  ->  typing SETS the machine position
   *     cell shows a NUMBER (defined)  ->  typing is a GOTO
   *
   * DERIVED FROM THE DISPLAYED STATE, not from a mode flag, a modifier key or
   * a second control: `machine === null` is exactly the condition `fmt` turns
   * into '---', so this branch and the glyph on screen cannot disagree. The
   * cell cannot mean both because it cannot show both.
   *
   * That is what removes the hazard, and the hazard was real: without this
   * rule an operator could type a number meaning "you are here" and the
   * machine would drive there instead. Under it that cannot happen - a
   * machine that knows where it is shows a number, and a machine that does
   * not shows dashes.
   *
   * `machineUndefined` separates the two reasons a cell can be dashed: no
   * datum yet (typing establishes it) versus nothing reported at all (there
   * is nothing to establish a datum FROM, so the cell stays inert - that is
   * the pre-WO-994 `editable={machine !== null}` tie, kept for exactly the
   * case it was right about).
  */
  const machineCellIsDatumEntry = machine === null && machineUndefined
  const machineCellIntent = machineCellIsDatumEntry
    ? controlText('ControlPage.text004', { value1: String(axis) })
    : controlText('ControlPage.text005', { value1: String(axis) })
  // NumCell remounts its uncontrolled input whenever this string changes.
  // Keep the affordances in the same dependency so a normal MOVE readout
  // update cannot replace the titled input with a bare one.
  const machineShown = formatAxis(machine, axis, units)
  // WO-1136: NumCell deliberately has a narrow shared API and this work order
  // owns only this screen. Keep the state-specific native title beside the
  // state-specific commit routing instead of widening that shared component.
  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>(
      `[data-testid="control-dro-machine-${axis.toLowerCase()}"]`,
    )
    if (input) {
      input.title = machineCellIntent
      input.dataset.tooltip = machineCellIntent
    }
  }, [axis, machineCellIntent, machineShown])
  return (
    <div className="control-dro-row" data-testid={`control-dro-${axis.toLowerCase()}`}>
      <span
        className={`control-dro-axis ${homed ? 'control-dro-axis-homed' : ''}`}
        title={`${axis} ${homed ? controlText('ControlPage.text006') : controlText('ControlPage.text007')}`}
      >
        {axis}
      </span>
      <NumCell
        className="control-dro-work"
        shown={formatAxis(workUndefined ? null : work, axis, units)}
        editable={work !== null}
        testId={`control-dro-work-${axis.toLowerCase()}`}
        onCommit={(text) => attemptGoto('work', axis, text)}
      />
      <NumCell
        className="control-dro-machine"
        shown={machineShown}
        editable={machine !== null || machineCellIsDatumEntry}
        placeholder={machineCellIntent}
        testId={`control-dro-machine-${axis.toLowerCase()}`}
        onCommit={(text) =>
          machineCellIsDatumEntry
            ? attemptSetDatum(axis, text)
            : attemptGoto('machine', axis, text)
        }
      />
      <button
        className="control-chip-btn"
        disabled={zeroGate.disabled}
        aria-disabled={writeBusy || undefined}
        data-testid={`control-zero-${axis.toLowerCase()}`}
        data-tooltip={zeroGate.refusal ?? controlText('ControlPage.text008', { value1: String(axis) })}
        onClick={() => zeroWorkAxes([axis])}
      >
        0
      </button>
    </div>
  )
}

/**
 * WO-303: the confirm-before-move card, with the "do not ask again" checkbox
 * Operator specified. Reuses the app's shared .modal-container/-header/-body/
 * -footer chrome rather than the store's requestConfirm/resolveConfirm seam
 * (that seam's confirmDialog is a plain string body with no checkbox slot,
 * and store/index.ts is outside this order's owned paths) or a fresh member
 * of the overlay census (the lane note says reuse a fitting surface first).
 * Deliberately NOT wrapped in .modal-backdrop - that class is the app's one
 * position:fixed scrim, and a surface built from it needs a census entry
 * this order cannot author. Rendered IN-FLOW right under the DRO rows
 * instead: identical chrome, no full-screen scrim, no backdrop = no census
 * member needed.
 *
 * Decide-and-log: this card is deliberately NON-modal - the D-pad, the
 * global arrow-key jog, the MDI input and every other DRO cell all stay live
 * underneath it, so an operator can keep working while deciding. Two earlier
 * attempts tried to give the card a card-wide "Enter = confirm" shortcut and
 * both were substantiated audit FAILs: a `window` keydown listener fired on
 * an Enter typed anywhere on the page (a different DRO cell, the MDI box),
 * and moving the listener onto this container instead fired on the CARD'S
 * OWN Cancel/close buttons - their native Enter-activates-a-button behavior
 * races a keydown handler sitting on an ancestor, and the ancestor's
 * unconditional onConfirm() call won, so Enter on "Cancel" moved the
 * machine. A programmatic focus() on mount (added to make that ancestor
 * handler reachable by keyboard) caused a THIRD failure the same way, by
 * stealing focus out of whatever the operator had just clicked into. So
 * there is no Enter-anywhere-in-the-card shortcut at all here, and nothing
 * steals focus. Move/Cancel/close fire only from an actual click, or from
 * Tab-focusing that SPECIFIC button and pressing Enter/Space - the browser's
 * own default action for a focused button, needing no code here and immune
 * to all three failures above. Escape is the one card-wide shortcut kept:
 * its meaning ("cancel") does not depend on which element inside the card
 * has focus, so there is no element Escape can be wrong about.
 */
function GotoConfirmDialog({
  pending,
  currentMm,
  units,
  onConfirm,
  onCancel,
}: {
  pending: PendingGoto
  currentMm: number | null
  units: Units
  onConfirm: (dontAskAgain: boolean) => void
  onCancel: () => void
}) {
  useText('control-screens-not-probing')
  const [dontAskAgain, setDontAskAgain] = useState(false)

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const frameLabel = pending.frame === 'work' ? controlText('ControlPage.text009') : controlText('ControlPage.text010')
  const shownUnit = axisUnit(pending.axis, units)
  // The machine column is a machine-frame coordinate - G53 is the standard
  // non-modal prefix that makes a G0 address the machine frame instead of
  // the active WCS, so this names the command that actually matches.
  const mdiEquivalent =
    (pending.frame === 'work' ? 'G0 ' : 'G53 G0 ')
    + `${pending.axis}${fmtAxis(pending.targetMm, pending.axis, units)}`
  const distanceMm = currentMm === null ? null : Math.abs(pending.targetMm - currentMm)

  return (
    <div
      className="modal-container"
      role="alertdialog"
      aria-label={controlText('ControlPage.text011', { value1: String(pending.axis) })}
      data-testid="control-goto-confirm"
      style={{ marginTop: 8 }}
      onKeyDown={onKeyDown}
    >
      <div className="modal-header">
        <AlertTriangle size={15} className="modal-header-icon" style={{ color: 'var(--text-danger)' }} />
        <span className="modal-title">{catalogChildren(controlText('ControlPage.text012', { value1: '\u0000value1\u0000' }), { value1: pending.axis })}</span>
        <button
          className="modal-close-btn"
          data-testid="control-goto-confirm-close"
          onClick={onCancel}
          aria-label={controlText('ControlPage.text013')}
        >
          <X size={14} />
        </button>
      </div>
      <div
        className="modal-body"
        data-testid="control-goto-confirm-body"
        style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}
      >
        <div>{catalogChildren(controlText('ControlPage.text014', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000' }), { value1: frameLabel, value2: mdiEquivalent, value3: ' ' })}</div>
        <div style={{ marginTop: 8 }}>{catalogChildren(controlText('ControlPage.text016', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000', value4: '\u0000value4\u0000', value5: '\u0000value5\u0000', value6: '\u0000value6\u0000', value7: '\u0000value7\u0000' }), { value1: pending.axis, value2: fmtAxis(currentMm, pending.axis, units), value3: shownUnit, value4: ' ', value5: fmtAxis(pending.targetMm, pending.axis, units), value6: shownUnit, value7: distanceMm === null ? '' : controlText('ControlPage.text015', { value1: String(fmtAxis(distanceMm, pending.axis, units)), value2: String(shownUnit) }) })}</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
          <input
            type="checkbox"
            checked={dontAskAgain}
            data-testid="control-goto-confirm-suppress"
            onChange={(e) => setDontAskAgain(e.currentTarget.checked)}
          />{controlText('ControlPage.text017')}</label>
      </div>
      <div
        className="modal-footer"
        style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px' }}
      >
        <button
          type="button"
          className="modal-btn modal-btn-ghost"
          data-testid="control-goto-confirm-cancel"
          onClick={onCancel}
        >{controlText('ControlPage.text018')}</button>
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          data-testid="control-goto-confirm-move"
          onClick={() => onConfirm(dontAskAgain)}
        >{controlText('ControlPage.text019')}</button>
      </div>
    </div>
  )
}

function pick(v: MachinePosition | null, axis: MachineAxisKey): number | null {
  return v?.[axis] ?? null
}

/** WO-2062: Main's own Position (DRO) panel - the SAME component instance
 *  Main and the Probing screen both mount, never a copy or a restyle
 *  (COHESION-STANDARD 22; docs/design/PROBING-PAINT-BY-NUMBERS.md item 8).
 *  Fully self-contained (reads every fact it needs off the stores itself)
 *  because ControlPage keeps Main's own instance mounted-but-hidden while the
 *  Probing screen is open (`hidden`, never unmounted - see the file header),
 *  so a second instance is live at the same time. `announceNoDatum` gates the
 *  one session-level console line (no datum yet) to a single instance - the
 *  same double-mount hazard `ControlTransportBar`'s `probeOnly` flag guards
 *  against for its own keydown listener.
 *  `workLiveRegardlessOfHoming` (2026-09-27 architect ruling, WO-2062): Main's
 *  WORK column dashes together with MACHINE while unhomed (`axisDashed`
 *  below) - correct for Main, but WO-304's pinned requirement for the Probing
 *  screen is the opposite: GRBL always reports WPos once connected, so WORK
 *  is real live data there regardless of homing state; only MACHINE needs a
 *  home reference. Set ONLY at the Probing mount site - Main's own mount
 *  keeps the default (false) and its behavior is unchanged. */
export function PositionPanel({
  announceNoDatum = false,
  workLiveRegardlessOfHoming = false,
  twoDecimalMm = false,
}: { announceNoDatum?: boolean; workLiveRegardlessOfHoming?: boolean; twoDecimalMm?: boolean } = {}) {
  useText('control-screens-not-probing')
  // WO-2261 changes Control Main only; Probing shares this panel and keeps
  // the standard precision, independently of its live-before-homing policy.
  const formatAxis = twoDecimalMm ? fmtDroAxis : fmtAxis
  const machine = useCamStore(controlMachine)
  const controlAxes = enabledControlAxes(machine.controllerDefinition)
  const phase = useMachineControl((s) => s.connectionPhase)
  const connectionKind = useMachineControl((s) => s.connectionKind)
  const machineState = useMachineControl((s) => s.machineState)
  const jobPhase = useMachineControl((s) => s.job.phase)
  const mpos = useMachineControl((s) => s.mpos)
  const wpos = useMachineControl((s) => s.wpos)
  const feed = useMachineControl((s) => s.feed)
  const spindleRpm = useMachineControl((s) => s.spindleRpm)
  const overrides = useMachineControl((s) => s.overrides)
  const offNominalOverrides = (
    [
      ['F', overrides.feed],
      ['R', overrides.rapid],
      ['S', overrides.spindle],
    ] as const
  )
    .filter(([, value]) => value !== null && value !== 100)
    .map(([letter, value]) => `${letter}${value}%`)
  const activeWcs = useMachineControl((s) => s.activeWcs)
  const storedWorkOffsets = useCamStore((s) => s.machineWorkOffsets[controlMachine(s).id])
  const activeStoredWorkOffset = activeWcs ? storedWorkOffsets?.[activeWcs] : undefined
  // WO-2878: the chip names the tool the TOOL glance names - the same hook,
  // so mid-run it follows the last T word streamed instead of the $G report
  // (polled only between jobs; the 10-16 sweep caught chip T0 vs glance T2).
  const { currentTool: activeTool } = useCurrentTool()
  const parserModal = useMachineControl((s) => s.parserModal)
  const homed = useMachineControl((s) => s.homed)
  const settings = useMachineControl((s) => s.settings)
  const units = useDisplayUnits()
  const unitsPref = useUiPrefs((s) => s.machineDisplayUnits)
  const gotoSkipConfirm = useUiPrefs((s) => s.machineGotoSkipConfirm)
  const positionPanelCollapsed = useControlPanelCollapsed('position')
  const [pendingGoto, setPendingGoto] = useState<PendingGoto | null>(null)

  const connected = phase === 'connected'

  const envelope = useMemo(
    () => resolveMachineMotion({
      machine,
      connectionKind: phase === 'connected' && connectionKind === null ? 'serial' : connectionKind,
      settings,
      datumKnown: homed,
    }).envelope,
    [connectionKind, homed, machine, phase, settings],
  )

  // WO-1119/1125: Cartesian DROs and motion gates ask the same per-axis datum
  // resolver. Rotary DROs are presentation-only and use the controller's live
  // status readback; they never enter the XYZ machine-coordinate gate map.
  const droController = connected ? getMachineController() : null
  const resolvedHomedAxes = droController?.homedAxesThisSession?.() ?? null
  const reportedHomedAxes = droController?.status().homed ?? null
  const fallbackHomed = droController?.homedThisSession() === true
  const droAxisHomed = (axis: ControlAxis) => {
    if (isRotaryAxis(axis)) return reportedHomedAxes?.[axis] === true
    return resolvedHomedAxes === null ? fallbackHomed : resolvedHomedAxes[axis] === true
  }
  // Operator 2026-09-14 ("A: Flash, all motion off"): Goto XY0 is motion, so it is
  // dead while the E-STOP blinks for CLEAR. Zeroing is not motion and stays.
  const estopLatched = useSyncExternalStore(subscribeEstopNeedsReset, estopNeedsReset, () => true)
  const machineId = useCamStore((s) => controlMachine(s).id)
  // WO-1042: one offset write per machine may be in flight. While one is, every
  // zero action is dead - the session refuses a second one anyway, and a live
  // button that only produces a console refusal is the defect, not the guard.
  const offsetWriteBusy = useSyncExternalStore(
    subscribeMachineWorkOffsetWrite,
    () => machineWorkOffsetWriteInFlight(machineId),
    () => machineWorkOffsetWriteInFlight(machineId),
  )
  // WO-1992: zero and Goto XY0 are rows of the operator authority table.
  const authorityFacts: OperatorAuthorityFacts = {
    connected,
    machineState,
    jobPhase,
    estopLatched,
    offsetWriteBusy,
    mdiLine: '',
  }
  const zeroGate = authorize('zeroWorkAxis', authorityFacts)
  const gotoGate = authorize('gotoWorkXY0', authorityFacts)

  /**
   * THE DASHED MACHINE READOUT IS DERIVED, NEVER SPECIAL-CASED (WO-985), AND
   * THE PREDICATE IS "THE MACHINE POSITION IS NOT ESTABLISHED" (WO-994). See
   * ControlPage's WO-994/WO-985 history for the full rationale; unchanged
   * here, only relocated with the panel it drives.
   */
  const noHomeSwitches = machineHasNoHomeSwitches(machine)
  const machineCoordsUnknown = !homed
  // WO-1796: an actual bridge report (at least one explicitly false axis) is
  // required before advising a re-home; see ControlPage's WO-1796 note.
  const noDatumAdviceConfirmed = connectionKind !== 'bridge'
    || (resolvedHomedAxes !== null
      && Object.values(resolvedHomedAxes).some((axisHomed) => axisHomed === false))
  const noDatumText = connected && machineCoordsUnknown && noDatumAdviceConfirmed
    ? noHomeSwitches
      ? controlText('ControlPage.text020')
        + controlText('ControlPage.text021')
      : SWITCHED_NO_DATUM_CONSOLE_TEXT
    : null
  const noDatumAnnounced = useRef<string | null>(null)
  useEffect(() => {
    if (!announceNoDatum) return
    if (noDatumText === noDatumAnnounced.current) return
    noDatumAnnounced.current = noDatumText
    if (noDatumText) useMachineControl.getState().pushConsole('tx', noDatumText, 'info')
  }, [announceNoDatum, noDatumText])
  /** The machine-frame value the DRO may honestly show - `null`, which `fmt`
   *  renders as dashes, when there is no datum behind it. That same null is
   *  what routes a typed value to the datum seam instead of to a goto: see
   *  `DroAxisRow`'s disambiguation rule, which reads the DISPLAYED state. */
  const machineDro = (axis: MachineAxisKey, dashed: boolean): number | null =>
    dashed ? null : pick(mpos, axis)
  /** WO-2018: dashed per axis (`dashed`), the same as the machine column - an
   *  axis Home All has already homed shows at once. */
  const workDro = (axis: MachineAxisKey, dashed: boolean): number | null =>
    workLiveRegardlessOfHoming
      ? pick(wpos, axis)
      : dashed ? null : pick(wpos, axis)

  // WO-1016: refusals live only in the console. Remember the last event so a
  // held condition cannot append the same line on every retry or rerender.
  const gotoRefusalAnnounced = useRef<string | null>(null)
  /** WO-994: `what` names the gesture that was refused, because the machine
   *  column now has two of them - a GOTO and a datum SET - and a console line
   *  that says "Goto" about a refused datum entry names the wrong gesture. */
  const setGotoRefusal = (text: string | null, what: 'Goto' | 'Set' = controlText('ControlPage.text022')) => {
    if (!text) return
    const line = `${what} ${text}`
    if (line === gotoRefusalAnnounced.current) return
    gotoRefusalAnnounced.current = line
    useMachineControl.getState().pushConsole('tx', line, 'error')
  }
  const clearGotoRefusal = () => { gotoRefusalAnnounced.current = null }

  type GotoEval =
    /** `workXY`: set only for a work X/Y goto under a rotated work system -
     *  the work point to hand the controller's own work-frame move. */
    | { ok: true; currentMm: number; deltaMm: number; workXY?: { x: number; y: number } }
    | { ok: false; reason: string }

  /**
   * WO-2213: THE ACTIVE WORK SYSTEM'S XY ROTATION, AS THE CONTROLLER REPORTS IT.
   * The AXBB-E bridge says it in the same status frame as the positions
   * (`workRotation`, WO-2203): that number. LinuxCNC reports every system's
   * rotation (`wcsRotations`, WO-2185) but not which system it is in - the
   * store's `activeWcs` is the app's last selection, and an MDI `G55` or a
   * program's M2 (back to G54) moves LinuxCNC without it (measured here) - so
   * with any system rotated the active rotation is `null`: unknown, possibly
   * turned. 0 when nothing is rotated - every other controller.
   */
  const activeWorkRotation = (ctrl: ReturnType<typeof getMachineController>): number | null => {
    const frame = (ctrl.status() as { workRotation?: unknown }).workRotation
    if (typeof frame === 'number' && Number.isFinite(frame)) return frame
    const reported = Object.values(ctrl.wcsRotations?.() ?? {})
    return reported.some((deg) => deg !== 0) ? null : 0
  }

  /**
   * WO-303: every refusal, plus the live current-position read, lives here in
   * one place - reading `machineState` / `homed` / `mpos` / `wpos` / `envelope`
   * fresh from this render's closure, never from anything captured earlier.
   * See ControlPage's original WO-303/WO-087 notes for the full rationale;
   * unchanged here, only relocated with the panel it drives.
   */
  const evaluateGoto = (frame: GotoFrame, axis: ControlAxis, targetMm: number): GotoEval => {
    const ctrl = getMachineController()
    if (machineState === 'alarm') return { ok: false, reason: controlText('ControlPage.text023') }
    if (ctrl.hasActiveJob()) return { ok: false, reason: controlText('ControlPage.text024') }
    if (frame === 'machine' && !homed) {
      return {
        ok: false,
        reason: noHomeSwitches
          ? noHomeSwitchesRefusal(
              controlText('ControlPage.text025'),
            )
          : controlText('ControlPage.text026'),
      }
    }
    if (frame === 'work') {
      const zeroRefusal = workGotoZeroRefusal([axis])
      if (zeroRefusal) return { ok: false, reason: zeroRefusal }
    }

    const axisId = axisKey(axis)
    const currentMm = frame === 'work' ? pick(wpos, axisId) : pick(mpos, axisId)
    if (currentMm === null) return { ok: false, reason: controlText('ControlPage.text027') }

    // WO-2213: under a rotated work system a work X or Y step is a diagonal on
    // the machine (machine = O + Rot(R)(work), docs/design/WCS-ROTATION.md), so
    // one machine-axis jog of `target - work` lands off the typed point (WO-2204
    // measured work X 20 from (0,20) at 30 deg ending at work (17.32, 10)). The
    // move goes to the controller's own work-frame XY verb instead - the one
    // Goto XY0 uses, which the controller turns itself - with the unnamed axis
    // held where it stands. That verb lands on the typed work point whatever
    // the active rotation is, 0 included, so an unknown rotation takes it too.
    // Unrotated, the jog below is exactly what it was.
    const rotation = frame === 'work' && (axisId === 'x' || axisId === 'y') ? activeWorkRotation(ctrl) : 0
    // The single-axis travel check, the idle check and the result below are
    // shared with the unrotated goto; only the machine point differs.
    let workXY: { x: number; y: number } | undefined
    if (rotation !== 0) {
      // `currentMm` came from this same `wpos`, so both work axes are known.
      const workX = pick(wpos, 'x')!
      const workY = pick(wpos, 'y')!
      workXY = axisId === 'x' ? { x: targetMm, y: workY } : { x: workX, y: targetMm }
      // The travel check needs the rotation; unknown, the controller's own
      // soft limits judge the move (one machine axis would be the wrong point).
      if (rotation !== null && homed && mpos) {
        const a = (rotation * Math.PI) / 180
        const dx = workXY.x - workX
        const dy = workXY.y - workY
        const machineTarget = {
          x: mpos.x + dx * Math.cos(a) - dy * Math.sin(a),
          y: mpos.y + dx * Math.sin(a) + dy * Math.cos(a),
        }
        for (const key of ['x', 'y'] as const) {
          const range = envelope[key]
          const mm = machineTarget[key]
          if (range && (mm < range.min || mm > range.max)) {
            return {
              ok: false,
              reason:
                controlText('ControlPage.text028', { value1: String(key.toUpperCase()), value2: String(fmtMachineLength(mm, units)), value3: String(unitLabel(units)) }) +
                controlText('ControlPage.text029', { value1: String(fmtMachineLength(range.min, units)), value2: String(fmtMachineLength(range.max, units)), value3: String(unitLabel(units)) }),
            }
          }
        }
      }
    }

    const axisEnvelope = !workXY && (axisId === 'x' || axisId === 'y' || axisId === 'z')
      ? envelope[axisId]
      : undefined
    if (axisEnvelope) {
      const offsetMm = mpos && wpos ? pick(mpos, axisId)! - pick(wpos, axisId)! : null
      const machineTargetMm =
        frame === 'machine' ? targetMm : homed && offsetMm !== null ? targetMm + offsetMm : null
      if (
        machineTargetMm !== null &&
        (machineTargetMm < axisEnvelope.min || machineTargetMm > axisEnvelope.max)
      ) {
        return {
          ok: false,
          reason:
            controlText('ControlPage.text030', { value1: String(fmtMachineLength(machineTargetMm, units)), value2: String(unitLabel(units)) }) +
            controlText('ControlPage.text031', { value1: String(fmtMachineLength(axisEnvelope.min, units)), value2: String(fmtMachineLength(axisEnvelope.max, units)), value3: String(unitLabel(units)) }),
        }
      }
    }

    if (!ctrl.verifiedIdle()) {
      return { ok: false, reason: controlText('ControlPage.text032') }
    }

    return { ok: true, currentMm, deltaMm: targetMm - currentMm, ...(workXY ? { workXY } : {}) }
  }

  /**
   * WO-1563: under the E-STOP latch a typed goto is HELD before it ever
   * reaches the controller. Only the latch is checked here; every other
   * refusal keeps its home in `evaluateGoto`.
   */
  const heldByEstopLatch = (frame: GotoFrame, axis: ControlAxis): boolean => {
    if (!estopLatched) return false
    setGotoRefusal(controlText('ControlPage.text033', { value1: String(axis), value2: String(frame) }))
    return true
  }

  /** One rapid to an evaluated goto: the work-frame XY verb under a rotation
   *  (WO-2213), otherwise the single-axis jog it always was. */
  const sendGoto = (axis: ControlAxis, result: Extract<GotoEval, { ok: true }>): boolean => {
    const rapidFeed = controlMachine(useCamStore.getState()).rapidRate ?? 3000
    const ctrl = getMachineController()
    return result.workXY
      ? ctrl.jogToWorkXY(result.workXY.x, result.workXY.y, rapidFeed)
      : ctrl.jog(axis, result.deltaMm, rapidFeed)
  }

  /**
   * WO-303: type-a-coordinate-to-go-there. See ControlPage's original note
   * for the full rationale; unchanged here, only relocated.
   */
  const attemptGoto = (frame: GotoFrame, axis: ControlAxis, text: string): boolean | void => {
    const targetMm = parseAxisValue(text, axis, units)
    if (!Number.isFinite(targetMm)) return false

    const result = evaluateGoto(frame, axis, targetMm)
    if (!result.ok) {
      setGotoRefusal(controlText('ControlPage.text034', { value1: String(axis), value2: String(frame), value3: String(result.reason) }))
      return false
    }
    if (heldByEstopLatch(frame, axis)) return false

    if (gotoSkipConfirm) {
      if (!sendGoto(axis, result)) {
        setGotoRefusal(controlText('ControlPage.text035', { value1: String(axis), value2: String(frame) }))
        return false
      }
      clearGotoRefusal()
      return
    }

    clearGotoRefusal()
    setPendingGoto({ axis, frame, targetMm })
    return false
  }

  /**
   * WO-994: TYPE INTO THE DASH TO DEFINE IT. See ControlPage's original note
   * for the full rationale; unchanged here, only relocated.
   */
  const attemptSetMachineDatum = (axis: ControlAxis, text: string): boolean | void => {
    const valueMm = parseAxisValue(text, axis, units)
    if (!Number.isFinite(valueMm)) return false

    if (!mpos) {
      setGotoRefusal(
        controlText('ControlPage.text036', { value1: String(axis) }),
        controlText('ControlPage.text037'),
      )
      return false
    }

    const axisId = axisKey(axis)
    const result = setMachinePosition({ ...mpos, [axisId]: valueMm })
    if (!result.ok) {
      setGotoRefusal(controlText('ControlPage.text038', { value1: String(axis), value2: String(result.reason) }), controlText('ControlPage.text039'))
      return false
    }
    clearGotoRefusal()
    useMachineControl.getState().pushConsole(
      'tx',
      controlText('ControlPage.text040', { value1: String(axis), value2: String(fmtAxis(valueMm, axis, units)), value3: String(axisUnit(axis, units)) }),
      'info',
    )
    return
  }

  const executeGoto = (dontAskAgain: boolean) => {
    if (!pendingGoto) return
    if (dontAskAgain) useUiPrefs.setState({ machineGotoSkipConfirm: true })

    const result = evaluateGoto(pendingGoto.frame, pendingGoto.axis, pendingGoto.targetMm)
    setPendingGoto(null)
    if (!result.ok) {
      setGotoRefusal(controlText('ControlPage.text041', { value1: String(pendingGoto.axis), value2: String(pendingGoto.frame), value3: String(result.reason) }))
      return
    }
    if (heldByEstopLatch(pendingGoto.frame, pendingGoto.axis)) return

    if (!sendGoto(pendingGoto.axis, result)) {
      setGotoRefusal(controlText('ControlPage.text042', { value1: String(pendingGoto.axis), value2: String(pendingGoto.frame) }))
    } else {
      clearGotoRefusal()
    }
  }

  const setUnitsPref = (v: 'default' | 'mm' | 'inch') => {
    useUiPrefs.setState({ machineDisplayUnits: v })
  }

  return (
    <section className="panel control-panel">
      <div className="panel-header">
        <span className="panel-title">{controlText('ControlPage.text043')}</span>
        <span className="control-dro-header-meta">
          <span className="control-units-chips" data-testid="control-units-chips">
            <button
              className={`control-chip-btn ${unitsPref === 'default' ? 'control-chip-active' : ''}`}
              data-testid="control-units-auto"
              data-tooltip={controlText('ControlPage.text044')}
              onClick={() => setUnitsPref('default')}
            >{controlText('ControlPage.text045')}</button>
            <button
              className={`control-chip-btn ${unitsPref === 'mm' ? 'control-chip-active' : ''}`}
              data-testid="control-units-mm"
              data-tooltip={controlText('ControlPage.text046')}
              onClick={() => setUnitsPref('mm')}
            >{controlText('ControlPage.text047')}</button>
            <button
              className={`control-chip-btn ${unitsPref === 'inch' ? 'control-chip-active' : ''}`}
              data-testid="control-units-inch"
              data-tooltip={controlText('ControlPage.text048')}
              onClick={() => setUnitsPref('inch')}
            >{controlText('ControlPage.text049')}</button>
          </span>
          {activeTool !== null && (
            <span className="control-tool-chip" data-testid="control-active-tool">{catalogChildren(controlText('ControlPage.text050', { value1: '\u0000value1\u0000' }), { value1: activeTool })}</span>
          )}
          <span
            className={`control-wcs-active ${activeWcs ? '' : 'control-wcs-unknown'}`}
            data-testid="control-active-wcs"
            {...workOffsetMarkerAttributes(activeStoredWorkOffset?.state)}
            data-tooltip={controlText('ControlPage.text051')}
          >
            {activeWcs ?? 'WCS?'}
          </span>
        </span>
        <ControlPanelCollapseToggle
          panel="position"
          testId="control-position-toggle"
          collapseTip={controlText('ControlPage.text052')}
          expandTip={controlText('ControlPage.text053')}
        />
      </div>
      {positionPanelCollapsed ? (
        <div className="panel-body">
          <div className="control-live-row control-position-compact" data-testid="control-position-compact">
            {controlAxes.map((axis) => (
              <span key={axis}>
                {axis} {formatAxis(workDro(axisKey(axis), machineCoordsUnknown), axis, units)}
                {isRotaryAxis(axis) ? ' deg' : ''}
              </span>
            ))}
            <span>{unitLabel(units)}</span>
            <span data-testid="control-position-compact-feed">{catalogChildren(controlText('ControlPage.text054', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: feed === null ? '---' : fmtFeed(feed, units, 0), value2: feedLabel(units) })}</span>
          </div>
        </div>
      ) : (
      <div className="panel-body">
        <div className="control-dro-head">
          <span className="control-dro-axis" />
          <span className="control-dro-work">{catalogChildren(controlText('ControlPage.text056', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: unitLabel(units), value2: controlAxes.some(isRotaryAxis) ? controlText('ControlPage.text055') : '' })}</span>
          <span
            className="control-dro-machine"
            data-testid="control-dro-machine-head"
            data-tooltip={
              machineCoordsUnknown
                ? noHomeSwitches
                    ? noHomeSwitchesRefusal(
                        controlText('ControlPage.text057'),
                      )
                    : controlText('ControlPage.text058')
                      + controlText('ControlPage.text059')
                : undefined
            }
          >{controlText('ControlPage.text060')}</span>
          <span />
        </div>
        {controlAxes.map((axis) => {
          const key = axisKey(axis)
          const axisHomed = droAxisHomed(axis)
          const axisDashed = machineCoordsUnknown && !(axisHomed && !isRotaryAxis(axis))
          return (
            <DroAxisRow
              key={axis}
              axis={axis}
              homed={axisHomed}
              work={pick(wpos, key)}
              workUndefined={workDro(key, axisDashed) === null}
              machine={machineDro(key, axisDashed)}
              machineUndefined={axisDashed}
              zeroGate={zeroGate}
              writeBusy={offsetWriteBusy}
              units={units}
              formatAxis={formatAxis}
              attemptGoto={attemptGoto}
              attemptSetDatum={attemptSetMachineDatum}
            />
          )
        })}
        {pendingGoto && (
          <GotoConfirmDialog
            pending={pendingGoto}
            currentMm={
              pendingGoto.frame === 'work'
                ? pick(wpos, axisKey(pendingGoto.axis))
                : pick(mpos, axisKey(pendingGoto.axis))
            }
            units={units}
            onConfirm={executeGoto}
            onCancel={() => setPendingGoto(null)}
          />
        )}
        <div className="control-live-row">
          <span>{catalogChildren(controlText('ControlPage.text061', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: feed === null ? '---' : fmtFeed(feed, units, 0), value2: feedLabel(units) })}</span>
          <span>{catalogChildren(controlText('ControlPage.text062', { value1: '\u0000value1\u0000' }), { value1: spindleRpm === null ? '---' : Math.round(spindleRpm) })}</span>
          {offNominalOverrides.length > 0 && (
            <span
              className="control-override-flag"
              data-testid="control-override-flag"
              data-tooltip={controlText('ControlPage.text063')}
            >
              {offNominalOverrides.join(' ')}
            </span>
          )}
          {parserModal && (
            <span data-testid="control-modal-facts">
              {parserModal.units ?? ''} {parserModal.distanceMode === 'incremental' ? 'G91!' : ''}
            </span>
          )}
        </div>
        <div className="control-zero-actions">
          <button
            className="modal-btn modal-btn-ghost"
            disabled={zeroGate.disabled}
            aria-disabled={offsetWriteBusy || undefined}
            data-testid="control-zero-all"
            data-tooltip={zeroGate.refusal
              ?? controlText('ControlPage.text065', { value1: String(describeAxisList(controlAxes)) })}
            onClick={() => zeroWorkAxes(controlAxes)}
          >{catalogChildren(controlText('ControlPage.text064', { value1: '\u0000value1\u0000' }), { value1: activeWcs ? ` (${activeWcs})` : '' })}</button>
          <button
            className="control-jog-btn control-goto-xy control-motion-outline"
            disabled={gotoGate.disabled}
            data-testid="control-goto-xy0"
            data-tooltip={gotoGate.refusal ?? controlText('ControlPage.text066')}
            onClick={() => gotoWorkXYZero(controlMachine(useCamStore.getState()).rapidRate ?? 3000)}
          >
            <Crosshair size={13} />{controlText('ControlPage.text067')}</button>
        </div>
      </div>
      )}
    </section>
  )
}

/* WO-917 - MACHINE IS A CONTAINER, AND ITS SUB-TABS ARE ITS DOORS.
   ==============================================================
   Operator 2026-08-23 (card Q-WHICH-TABS-MOVE-UNDER-MACHINE): "machine actions
   would become just machine and then underneath that there would be sub tabs
   for the tabs that moved there", with Definition / Actions / Macros /
   Diagnostics under it.

   VIEW, NOT MODAL - the decision this order left to the seat. `Machine
   actions` was a MODAL-OPENER on the nav row, so making it `Machine` is a
   change of kind. It is now a real seventh ControlView, hosted in the same
   `.control-aux-workspace` every other subview uses, because:
     - a modal cannot host Macros and Diagnostics AT FULL SIZE, and full size
       is the whole reason those two moved rather than being deleted;
     - the aux workspace already mounts the operator authority row in every
       subview (WO-068 finding 2), and a modal would have hidden it;
     - `hidden` on the Main columns is how every other view switches, so the
       view form costs no new layout mechanism.

   ONE OF THE FOUR SUB-TABS IS A DOOR. Definition used to be the second one
   and is NOT any more - Operator rejected that twice (2026-08-23 and 08-24):
   "the machine definition in control needs to have everything... the modal is
   too cramped to be useful for all the settings that a full .pro file could
   require". The old comment here argued the opposite case out loud, which is
   exactly what made a rejected design read as deliberate to the next reader.
     - Definition renders MachineDefinitionPanel: the FULL control surface,
       every pin including unassigned ones, laid out for a page. ONE TRUTH,
       TWO VIEWS - it edits the same record the CAM modal does, through the
       same store actions, and CAM keeps its narrower field set. The "one
       component instance, not two editors" instinct was right about DATA and
       wrong about VIEW.
     - Actions opens the existing MachineActionsModal, unchanged.
   Both are modals owned by files this order does not own. Turning them into
   in-place panels means editing them, and this order was scoped not to; the
   panel behind each door is the way back once the modal is closed. That is
   the one thing here the architect may want to revisit - see the work order.

   THE STRIP IS THE ARIA PATTERN WITH THE EXISTING SKIN. Markup copied from
   HelpCenterModal.tsx:301-320 (role="tablist" / role="tab" / aria-selected),
   classes copied from the nav row (`.control-strip-nav`, `.control-view-tab`)
   because app.css is not this order's to edit and a third tab look is exactly
   what the order forbids. Outside `.control-uix-subnav` those classes render
   at their 30px base size, so the sub-tabs read as subordinate to the 34px
   top row for free.

   WO-2102 (Operator, 2026-09-27, card Q-REMOVE-THE-ACTIONS-TAB-YOUR-09-1: "Fold
   into Definition and remove the tab"): the Actions door is gone. What each
   stock button sends lives in Definition > Controller > Built-in commands
   (definition/BuiltinCommandsSection.tsx); the spindle and macro gear buttons
   still open MachineActionsModal, which draws the same rows. Three sub-tabs. */
type MachineSubTab = 'definition' | 'macros' | 'diagnostics'

/* WO-1661 (Operator at the machine, 2026-09-17): ONE console. A typed MDI line
   is an ordinary `>` console row followed by the machine's replies, in time
   order with everything else - the separate history box that competed with
   the console for height is gone. Up/Down in the input still recalls the
   typed lines; this caps how many it remembers. */
const MDI_RECALL_LIMIT = 20

// WO-2394: a page-session notice, not a connection event. Clearing the console
// or remounting Control must not announce it again (including StrictMode).
let demoNoticeAnnounced = false

const MACHINE_SUB_TABS: Array<[MachineSubTab, string]> = liveCatalog(() => ([
  ['definition', controlText('ControlPage.text068')],
  ['macros', controlText('ControlPage.text069')],
  ['diagnostics', controlText('ControlPage.text070')],
]))

export function ControlPage() {
  useText('control-screens-not-probing')
  useEffect(() => {
    if (!isDemoBuild() || demoNoticeAnnounced) return
    demoNoticeAnnounced = true
    useMachineControl.getState().pushConsole(
      'rx',
      controlText('ControlPage.text071'),
      'info',
    )
  }, [])
  const machine = useCamStore(controlMachine)
  const offsetsWorkspaceFolded = usePanelCollapsed(OFFSETS_WORKSPACE_PANEL_KEY)
  const offsetsSplitPx = useOffsetsSplitPx()
  const statedBoardName = controllerBoardName(machine)
  /* WO-2066: only a UCCNC machine is offered the bridge, and the bridge drives
     exactly the UCCNC it declares, so the choice names the declared controller
     (WO-1843's "via UCCNC bridge backend" had no route left to name). */
  const bridgeConnectionLabel = controlText('ControlPage.text072', { value1: String(controllerDisplayName(machine.controller)) })
    + `${statedBoardName ? ` / ${statedBoardName}` : ''})`
  // Operator 10-09 (release card item 1): one label for each choice; the select's hover tip shows the
  // selected one in full, so a long machine name cut to "..." is still readable.
  const connectionKindLabel = (connection: MachineConnectionKind) => connection === 'serial'
    ? controlText('ControlPage.text090', { value1: String(isGrblFamily(machine.controller) ? controllerDisplayName(machine.controller) : 'GRBL') })
    : connection === 'bridge'
      ? bridgeConnectionLabel
      : connection === 'gateway'
        ? LINUXCNC_GATEWAY_LABEL
        : controlText('ControlPage.text091', { value1: String(machine.name) })
  const hasBridgeSurface = controllerSurface(machine).bridgeSettings
  // WO-917: the SAME store field ViewportOverlay.tsx:136 sets, so
  // Machine > Definition and the viewport's machine chip land on the one
  // MachineLibraryModal instance App.tsx mounts. Two doors, one editor.
  const phase = useMachineControl((s) => s.connectionPhase)
  const connectionKind = useMachineControl((s) => s.connectionKind)
  const detail = useMachineControl((s) => s.connectionDetail)
  const version = useMachineControl((s) => s.grblVersion)
  const machineState = useMachineControl((s) => s.machineState)
  const jobPhase = useMachineControl((s) => s.job.phase)
  const programRunning = jobPhase === 'streaming' || jobPhase === 'paused'
  const consoleLines = useMachineControl((s) => s.consoleLines)
  const clearConsole = useMachineControl((s) => s.clearConsole)
  const inputs = useMachineControl((s) => s.inputs)
  // Contract v4 (WO-426): six lamps off the decoded `MachineStatus.inputs`
  // rather than a raw `Pn:` letter string. `null` (no report yet, or this
  // controller has no such input) must render as absent/unavailable, never
  // as clear - a door lamp reading clear on a controller with no door input
  // is a lie an operator would act on.
  // WO-1648: the limit lamps sit behind one LIMIT caption, and door and hold
  // say their names - Operator had to ask what "D" and "H" were.
  const limitLamps: Array<[string, string, boolean | null]> = [
    ['X', 'X limit', inputs?.limits?.x ?? null],
    ['Y', 'Y limit', inputs?.limits?.y ?? null],
    ['Z', 'Z limit', inputs?.limits?.z ?? null],
  ]
  const otherInputLamps: Array<[string, string, boolean | null]> = [
    ['DOOR', controlText('ControlPage.text073'), inputs?.door ?? null],
    ['HOLD', controlText('ControlPage.text074'), inputs?.hold ?? null],
  ]
  // WO-1633: the probe is the input an operator actively tests by touch, so
  // it gets two labelled lamps at the head of this row (in place of the old
  // single-letter "P") instead of sharing the small unlabeled lamp style.
  const probeSignals = useProbeSignals()
  // WO-448: what the machine bridge's own hello frame said about THIS
  // session - null on every other connection kind, and null on 'bridge' too
  // until hello arrives. Surfaced BEFORE the operator presses something the
  // bridge will refuse, per BRIDGE-PROTOCOL.md "Hello".
  const bridgeHello = useMachineControl((s) => s.bridgeHello)
  const homed = useMachineControl((s) => s.homed)
  const settings = useMachineControl((s) => s.settings)
  const units = useDisplayUnits()
  const consoleCollapsed = useUiPrefs((s) => s.machineConsoleCollapsed)
  const leftW = useUiPrefs((s) => s.machineLeftPanelW)
  const rightW = useUiPrefs((s) => s.machineRightPanelW)
  const programPreviewPercent = useProgramPreviewPercent()
  // WO-116: every rail panel collapses via the Work offsets chevron; state
  // persists in uiPrefs.collapsedPropsGroups (see ControlPanelCollapseToggle).
  const machinePanelCollapsed = useControlPanelCollapsed('machine')
  const toolPanelCollapsed = useControlPanelCollapsed('tool')
  // WO-184: the collapsed TOOL header shows the SAME identity the glance shows
  // expanded (shared hook - one mid-run rule, not two), plus the offset that
  // makes that identity mean something at the workpiece.
  const { currentTool, entry: currentToolEntry } = useCurrentTool()
  const tlo = useMachineControl((s) => s.tlo)

  const supported = webSerialSupported()
  const availableConnectionKinds = useMemo(
    () => controlConnectionKinds(machine),
    [machine.controller],
  )
  const [kind, setKind] = useState<MachineConnectionKind>(
    () => defaultControlConnectionKind(machine, supported),
  )
  const connectionMachineId = useRef(machine.id)
  const storedSerialBaud = useCamStore((s) => machineSerialBaud(s.appSettings, machine.id))
  const [baud, setBaud] = useState(storedSerialBaud)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mdi, setMdi] = useState('')
  // Typed lines, newest first, for Up/Down recall; -1 = not recalling.
  const mdiRecall = useRef<string[]>([])
  const mdiRecallIndex = useRef(-1)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [activeView, setActiveView] = useState<ControlView>('main')
  // WO-917: which sub-tab the Machine view is showing. Definition first -
  // it is the door this order exists to add.
  const [machineTab, setMachineTab] = useState<MachineSubTab>('definition')
  const [controllerSetupFocus, setControllerSetupFocus] = useState(0)
  const spindleRpmPref = useUiPrefs((s) => s.machineSpindleRpm)
  const consoleEndRef = useRef<HTMLDivElement | null>(null)

  const bridgeSelected = hasBridgeSurface && kind === 'bridge'

  // Process presence is host-owned and independent of the websocket. Poll the
  // landed host contract only for a declared bridge machine; a plain browser
  // returns null, which stays honest `unknown` instead of being inferred from
  // a closed socket. The lifecycle event makes recovery visible immediately
  // while the interval catches an externally killed process.
  useEffect(() => {
    if (!bridgeSelected) {
      useMachineControl.getState().setBridgeProcessPresence('unknown')
      return
    }
    let current = true
    // Electron's status is about the child THIS app launched, not every
    // process that may be listening on the bridge port. Operator also starts the
    // bridge himself, so an initial `running: false` beside an open socket is
    // ignorance, not evidence that the bridge is down. Once this app has
    // observed its own child running, later stopped/gave-up reports are ours.
    // A successful supervisor call is already authoritative for the process
    // it owns, so its running, stopped, and gave-up reports need no such gate.
    // WO-2029: a child that already exited is this app's own fact too, even
    // when the page never saw it running (Operator 09-26: app launched with the
    // controller off, the bridge gave up before Control mounted, and presence
    // sat at 'unknown'). An open socket means some bridge is serving, so that
    // exit then stays ignorance, as above.
    let hostedProcessObserved = false
    let lastStatus: BridgeProcessStatus | null = null
    const publish = (status: BridgeProcessStatus | null) => {
      if (!current) return
      lastStatus = status
      const capability = bridgeHostCapability()
      const hosted = capability === 'hosted'
      if (hosted && status?.running === true) hostedProcessObserved = true
      const control = useMachineControl.getState()
      const socketOpen = control.connectionKind === 'bridge' && control.connectionPhase === 'connected'
      const hostedChildExited = hosted && !socketOpen && status !== null
        && (status.respawn.gaveUp || status.lastExit !== null)
      const processStatusOwned = capability === 'supervisor'
        || (hosted && (hostedProcessObserved || hostedChildExited))
      const presence = status === null || !processStatusOwned
        ? 'unknown'
        : status.respawn.gaveUp || status.health === 'failing'
          ? 'gave-up'
          : status.running ? 'running' : 'stopped'
      const state = useMachineControl.getState()
      if (state.bridgeProcessPresence !== presence) state.setBridgeProcessPresence(presence)
    }
    const refresh = () => {
      let port: number
      try {
        port = machineBridgePort(machine.id)
      } catch {
        publish(null)
        return
      }
      void bridgeProcessStatus(port).then(publish).catch(() => publish(null))
    }
    useMachineControl.getState().setBridgeProcessPresence('unknown')
    refresh()
    window.addEventListener('liencam:bridge-lifecycle', refresh)
    const timer = window.setInterval(refresh, 1_000)
    // The socket edge re-reads the last status at once, so an exited child is
    // never shown as 'gave-up' beside a bridge that just answered.
    const unsubscribeSocket = useMachineControl.subscribe((state, previous) => {
      if (state.connectionPhase !== previous.connectionPhase
        || state.connectionKind !== previous.connectionKind) publish(lastStatus)
    })
    return () => {
      current = false
      unsubscribeSocket()
      window.removeEventListener('liencam:bridge-lifecycle', refresh)
      window.clearInterval(timer)
    }
  }, [bridgeSelected, machine.id])
  // WO-414 batch 3 (R32 MODIFIED, Operator: "don't put any text there at all. Put
  // it all in the console."): the standing "Soft limits are OFF ($20=0)"
  // sentence is gone from the Machine panel - no line, no tooltip. One console
  // line says it at connect (once the settings dump lands) and again whenever
  // $20 flips. The announced value is forgotten on disconnect so the next
  // session announces again.
  const softLimitsAnnounced = useRef<string | null>(null)
  useEffect(() => {
    if (phase !== 'connected') {
      softLimitsAnnounced.current = null
      return
    }
    const value = settings[20]
    if (value === undefined || value === softLimitsAnnounced.current) return
    softLimitsAnnounced.current = value
    useMachineControl
      .getState()
      .pushConsole(
        'tx',
        value === '0'
          ? controlText('ControlPage.text075')
          : controlText('ControlPage.text076', { value1: String(value) }),
        'info',
      )
  }, [phase, settings])
  // WO-414 batch 3 (R30 Approve): the disconnected detail ("port closed",
  // "controller stopped answering"...) is a console line when it arrives and
  // ONE short line in the Machine panel, not a paragraph.
  const detailAnnounced = useRef<string | null>(null)
  useEffect(() => {
    const text = phase === 'disconnected' && detail ? detail : null
    if (text === detailAnnounced.current) return
    detailAnnounced.current = text
    if (text) useMachineControl.getState().pushConsole('rx', text, 'info')
  }, [phase, detail])

  // The runtime store is authoritative once a connection exists. This also
  // keeps the disabled selector truthful if ControlPage is remounted while a
  // simulator session survives (for example during a development hot reload).
  useEffect(() => {
    if (phase !== 'disconnected' && connectionKind && connectionKind !== kind) setKind(connectionKind)
  }, [connectionKind, kind, phase])

  useEffect(() => {
    setBaud(storedSerialBaud)
  }, [machine.id, storedSerialBaud])

  // An operator machine pick starts at that machine's real transport. A live
  // session cannot reach this branch because the header refuses the switch.
  useEffect(() => {
    if (connectionMachineId.current === machine.id) return
    connectionMachineId.current = machine.id
    if (phase === 'disconnected') setKind(defaultControlConnectionKind(machine, supported))
  }, [machine, phase, supported])

  // Editing a profile's controller kind can invalidate a disconnected choice
  // without changing its id. Never leave an impossible transport selected.
  useEffect(() => {
    if (phase === 'disconnected' && !availableConnectionKinds.includes(kind)) {
      setKind(defaultControlConnectionKind(machine, supported))
    }
  }, [availableConnectionKinds, kind, machine, phase, supported])

  useControlJogKeys()

  // WO-448: only ever true on a 'bridge' connection, and only once hello has
  // actually said so - never assumed from the connection kind alone.
  const bridgeReadOnly = connectionKind === 'bridge' && bridgeHello?.readOnly === true
  // `bridgeVfd` was read ONLY by the spindle-link line removed below. Left in
  // place it would be an unused local and fail the build, so it goes with the
  // thing it fed. `bridgeHello.vfd` still arrives on the wire; nothing that
  // needs it has been taken away.

  const connected = phase === 'connected'
  // Operator 2026-09-14 ("A: Flash, all motion off"): Goto XY0 is motion, so it is
  // dead while the E-STOP blinks for CLEAR. Zeroing is not motion and stays.
  const estopLatched = useSyncExternalStore(subscribeEstopNeedsReset, estopNeedsReset, () => true)
  const machineId = useCamStore((s) => controlMachine(s).id)
  // WO-1042: one offset write per machine may be in flight. While one is, every
  // zero action is dead - the session refuses a second one anyway, and a live
  // button that only produces a console refusal is the defect, not the guard.
  const offsetWriteBusy = useSyncExternalStore(
    subscribeMachineWorkOffsetWrite,
    () => machineWorkOffsetWriteInFlight(machineId),
    () => machineWorkOffsetWriteInFlight(machineId),
  )
  // WO-2237: the tool-change hold keeps MDI locked, as it always did.
  const toolChangeHold = useSyncExternalStore(subscribeToolChangeHold, toolChangeHoldActive, () => false)
  // A hold another flow owns keeps MDI locked, as it always did.
  const pauseTakesCommands = useSyncExternalStore(subscribePausedProgramTakesCommands, pausedProgramTakesCommands, () => false)
  // WO-2437 fix round 4: MDI works at a program's parked clamp pause.
  const clampPauseHold = useSyncExternalStore(subscribeToolChangeHold, programClampPauseTakesMdi, () => false)
  // WO-1992: zero, Goto XY0 and MDI are rows of the operator authority table.
  const authorityFacts: OperatorAuthorityFacts = {
    connected,
    machineState,
    jobPhase,
    estopLatched,
    offsetWriteBusy,
    toolChangeHold,
    clampPauseHold,
    pauseTakesCommands,
    mdiLine: mdi,
  }
  // WO-2237: a program paused at rest takes MDI - the line turns the pause into
  // a kept stop - so the box locks only where the authority table locks it.
  const mdiLockedByProgram = programRunning && !authorize('mdiInput', { ...authorityFacts, connected: true }).allowed
  const m0HoldLine = mdiLockedByProgram ? programM0HoldLine() : null

  // Keep the controller's parser units in sync with the effective display
  // units: G20/G21 on connect and whenever the choice changes, so MDI typed
  // by the operator is interpreted in the units on screen.
  //
  // WO-1545: through the G-code translator. A controller with an interpreter
  // gets the line; one without (the AXBB-E, `gcodeText: false`) has the modal
  // state held locally and nothing goes on the wire - never a refusal.
  useEffect(() => {
    if (!connected) return
    const ctrl = getMachineController()
    if (programRunning || ctrl.hasActiveJob()) return
    if (sendAppCommand(units === 'inch' ? 'G20' : 'G21', ctrl).sent) ctrl.refreshState()
  }, [connected, units])

  useEffect(() => {
    const end = consoleEndRef.current
    if (end && typeof end.scrollIntoView === 'function') end.scrollIntoView({ block: 'nearest' })
  }, [consoleLines.length, activeView, consoleCollapsed])

  const onConnect = async () => {
    setConnectError(null)
    setBusy(true)
    try {
      // WO-2029: this handler is the one owner of a desktop-app Connect press
      // (the Machine definition pre-flight stands aside when hosted). Every
      // bridge route is UCCNC's and installs the UCCNC bridge backend
      // (backendRegistry.ts, WO-2066), so every hosted bridge press needs it.
      if (kind === 'bridge' && bridgeHostCapability() === 'hosted') {
        const prepared = await prepareHostedBridgeForConnect(
          useUiPrefs.getState().machineLinks[machine.id],
        )
        if (prepared.kind === 'not-started') {
          if (prepared.socketMayAnswer) {
            try {
              await connectMachine(kind, baud)
              return
            } catch {
              // Nothing answered either: the setup sentence below is the reason.
            }
          }
          setConnectError(prepared.sentence)
          useMachineControl.getState().pushConsole('rx', prepared.sentence, 'error')
          return
        }
        if (prepared.kind === 'started') {
          useMachineControl.getState().pushConsole(
            'rx',
            prepared.again ? controlText('ControlPage.text077') : controlText('ControlPage.text078'),
            'info',
          )
          window.dispatchEvent(new Event('liencam:bridge-lifecycle'))
        }
      }
      await connectMachine(kind, baud)
    } catch (err) {
      // User cancelling the port picker is a normal path, not an error banner.
      const message = err instanceof Error ? err.message : String(err)
      if (!/No port selected/i.test(message)) {
        // WO-414 batch 3 (R30): the reason lands in the console too, so it
        // survives the next click; the panel keeps one short red line.
        setConnectError(message)
        useMachineControl.getState().pushConsole('rx', controlText('ControlPage.text079', { value1: String(message) }), 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const onDisconnect = async () => {
    setBusy(true)
    try {
      await disconnectMachine()
    } finally {
      setBusy(false)
    }
  }

  const onMdiSubmit = () => {
    const text = mdi.trim()
    if (!text) return
    if (mdiLockedByProgram) {
      useMachineControl.getState().pushConsole('tx', controlText('ControlPage.text080'), 'error')
      return
    }
    // The typed line becomes a `>` row BEFORE the send, so every reply the
    // send produces lands under it. The session carries its ID through a
    // deferred kept stop too, removing that dispatch's duplicate echo.
    const control = useMachineControl.getState()
    control.pushConsole('tx', text, 'info')
    const typedRow = useMachineControl.getState().consoleLines.at(-1)
    sendMdiLine(text, typedRow?.id)
    // Keep the page's synchronous dedupe contract for send paths that leave
    // their own echo. The session normally removes it first and retains our
    // row, including when dispatch is deferred through a kept stop.
    if (typedRow !== undefined) {
      const echoed = useMachineControl.getState().consoleLines.some((line) =>
        line.id > typedRow.id && line.dir === 'tx' && line.text === text,
      )
      if (echoed) {
        useMachineControl.setState((s) => ({
          consoleLines: s.consoleLines.filter((line) => line.id !== typedRow.id),
        }))
      }
    }
    mdiRecall.current = [text, ...mdiRecall.current.filter((line) => line !== text)].slice(0, MDI_RECALL_LIMIT)
    mdiRecallIndex.current = -1
    // WO-2568: a connected, unlocked submission was handed to the session.
    // Its execution verdict (including a tool-change reply) is not the
    // lifetime of the text in the box; recall keeps the submitted line.
    if (connected) setMdi('')
  }

  const onMdiRecall = (step: 1 | -1) => {
    const lines = mdiRecall.current
    if (lines.length === 0) return
    const next = Math.max(-1, Math.min(lines.length - 1, mdiRecallIndex.current + step))
    mdiRecallIndex.current = next
    setMdi(next === -1 ? '' : lines[next])
  }

  // WO-2665: one console definition and one mounted instance. Moving it
  // between Main and Probing preserves the existing history, MDI and prefs.
  // The owner's WO-2665 appearance revision: collapsed Probing is just the latest
  // line. Expand to use the same history/MDI; Main keeps its existing MDI row.
  const compactProbeConsole = activeView === 'probing' && consoleCollapsed
  const machineConsole = (
          <section
            className={`panel control-panel control-console-panel ${
              consoleCollapsed ? 'control-console-collapsed' : ''
            }`}
          >
            {/* WO-038: collapsed = EXACTLY the latest line + the MDI row. The
                panel header ("Console", Clear) only exists expanded; collapsed,
                the expand chevron rides inline on the latest-line row so the
                header's vertical slot is released to the program preview. */}
            {!consoleCollapsed && (
              <div className="panel-header">
                <span className="panel-title">{controlText('ControlPage.text107')}</span>
                <button
                  className="panel-action-btn"
                  data-testid="control-console-toggle"
                  onClick={() => useUiPrefs.setState({ machineConsoleCollapsed: true })}
                  data-tooltip={controlText('ControlPage.text108')}
                  aria-label={controlText('ControlPage.text109')}
                >
                  <ChevronDown size={13} />
                </button>
                <button className="panel-action-btn" onClick={clearConsole} data-tooltip={controlText('ControlPage.text110')}>
                  {controlText('ControlPage.text111')}
                </button>
              </div>
            )}
            <div className="panel-body control-console-body" data-testid="control-console">
              {consoleLines.length === 0 ? (
                <div className="panel-empty">
                  {connected
                    ? controlText('ControlPage.text112')
                    : controlText('ControlPage.text113', { value1: String(machine.name) })}
                </div>
              ) : (
                <ControlConsoleLines lines={consoleLines} collapsed={consoleCollapsed} />
              )}
              {consoleCollapsed && (
                <button
                  className="panel-action-btn"
                  data-testid="control-console-toggle"
                  onClick={() => useUiPrefs.setState({ machineConsoleCollapsed: false })}
                  data-tooltip={controlText('ControlPage.text114')}
                  aria-label={controlText('ControlPage.text115')}
                >
                  <ChevronUp size={13} />
                </button>
              )}
              {!consoleCollapsed && <div ref={consoleEndRef} />}
            </div>
            {!compactProbeConsole && <div className="control-mdi-row">
              <input
                className="mform-input mform-input-mono control-mdi-input"
                data-testid="control-mdi-input"
                placeholder={
                  mdiLockedByProgram
                    ? m0HoldLine !== null
                      ? controlText('ControlPage.mdiHeld', { value1: String(m0HoldLine) })
                      : controlText('ControlPage.text116')
                    : connected
                      ? controlText('ControlPage.text117')
                      : controlText('ControlPage.text118')
                }
                value={mdi}
                disabled={authorize('mdiInput', authorityFacts).disabled}
                onChange={(e) => setMdi(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onMdiSubmit()
                  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    onMdiRecall(e.key === 'ArrowUp' ? 1 : -1)
                  }
                }}
              />
              <button
                className="modal-btn modal-btn-ghost"
                disabled={authorize('mdiSend', authorityFacts).disabled}
                onClick={onMdiSubmit}
              >
                {controlText('ControlPage.text119')}
              </button>
            </div>}
          </section>
  )

  return (
    <div className="control-page" data-testid="control-page">
      {/* Q-95: ONE Control-specific strip - and per the approved WO-048
          layout it carries only the subview nav + machine state. The
          transport authority is a center-column grid item under the
          shortened program list (sections="transport" below). */}
      <ControlTransportBar
        sections="nav"
        activeView={activeView}
        onSelectView={setActiveView}
        selectedConnectionKind={kind}
      />
      {/* WO-414 batch 2: the Table card left the viewport; its one safety fact
          (program PARTLY OUTSIDE / OUTSIDE the table, WO-377) used to be an
          amber sentence here under the strip. WO-414 (Operator, on Chat: "The
          partially outside banner steals vertical pixels. Don't do that. Use
          console for messages."): that sentence is gone - ProgramPreview
          still publishes the verdict to ProgramFitStatusLine.publishProgramFit,
          which writes it to the console only. Nothing mounts here any more. */}
      {/* WO-416 (Operator ruling 2026-08-21: "Do not ever apply a huge vertical pixel
          stealing banner across the entire screen ... Don't do that again."):
          the full-width "MESH COMPENSATION ACTIVE" strip that used to live
          here is gone. Active mesh state is now the "Mesh N x N" chip in the
          program controls row (ProgramPanel.tsx), which opens MeshViewerModal
          - a Mainsail-style orbitable flatness viewer - on click. Zero rows. */}
      <div className="control-columns" hidden={activeView !== 'main'}>
        <aside
          className="control-col control-col-left"
          style={{ width: leftW, minWidth: leftW }}
        >
          <div className="control-col-scroll">
          <section className="panel control-panel">
            <div className="panel-header">
              <span className="panel-title" style={{ flexShrink: 0 }}>{controlText('ControlPage.text081')}</span>
              {/* WO-184: folded, this panel used to show NOTHING - and it is
                  the one the whole tab depends on. The collapsed header keeps
                  the answer to "am I even talking to the machine": which
                  controller, at what baud, in what connection state (and the
                  reported firmware once it has said hello). All three come
                  from live state, so a dropped connection changes the readout
                  under the fold instead of leaving a stale "Connected". */}
              {machinePanelCollapsed && (
                <ControlCollapsedReadout testId="control-machine-collapsed-values">
                  {[
                    kind === 'serial'
                      ? version
                        ? `${controllerDisplayName(machine.controller)} ${version}`
                        : controllerDisplayName(machine.controller)
                      : kind === 'bridge'
                        // WO-1732: the folded panel says the SAME thing the
                        // connection select says - the declared board when the
                        // definition states one (auditor consistency note). The
                        // serial and simulator readings above are unchanged.
                        ? bridgeConnectionLabel
                        : kind === 'gateway'
                          ? LINUXCNC_GATEWAY_LABEL
                          : `Simulated ${machine.name}`,
                    kind === 'serial' ? String(baud) : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  {' - '}
                  {phase === 'connected'
                    ? controlText('ControlPage.text082')
                    : phase === 'connecting'
                      ? 'Connecting...'
                      : controlText('ControlPage.text083')}
                  {/* WO-448 SAFETY: folding this panel must never hide the
                      one fact that motion is refused here - same rule as the
                      alarm line just below. */}
                  {bridgeReadOnly ? controlText('ControlPage.text084') : ''}
                </ControlCollapsedReadout>
              )}
              {!machinePanelCollapsed && (
                <button
                  type="button"
                  className="panel-action-btn"
                  data-testid="control-controller-setup"
                  data-tooltip={controlText('ControlPage.text085')}
                  aria-label={controlText('ControlPage.text086')}
                  onClick={() => {
                    setActiveView('machine')
                    setMachineTab('definition')
                    setControllerSetupFocus((value) => value + 1)
                  }}
                >
                  <Settings size={14} />
                </button>
              )}
              <ControlPanelCollapseToggle
                panel="machine"
                testId="control-machine-toggle"
                collapseTip={controlText('ControlPage.text087')}
                expandTip={controlText('ControlPage.text088')}
              />
            </div>
            {/* WO-116 SAFETY, still honoured but no longer by unfolding this
                panel: an ACTIVE ALARM may never be hidden by a fold made for a
                different reason. It is now carried by the transport bar's
                always-visible ALARM state chip and by the console, neither of
                which this fold can hide - a stronger guarantee than the old
                one, which only worked while the operator was looking at THIS
                panel. WO-448 SAFETY: the bridge's readOnly notice still forces
                the panel open, because nothing else reports it. */}
            {(!machinePanelCollapsed || bridgeReadOnly) && (
            <div className="panel-body control-connection-body">
              {!machinePanelCollapsed && (
                <>
                  <div className="control-connect-row">
                    <select
                      className="mform-input control-kind-select"
                      data-testid="control-kind-select"
                      value={kind}
                      disabled={connected || busy}
                      onChange={(e) => setKind(e.target.value as MachineConnectionKind)}
                      data-tooltip={connectionKindLabel(kind)}
                    >
                      {availableConnectionKinds.map((connection) => (
                        <option
                          key={connection}
                          value={connection}
                          disabled={connection === 'serial' && !supported}
                        >
                          {connectionKindLabel(connection)}
                        </option>
                      ))}
                    </select>
                    <div className="control-connect-actions">
                      {connected ? (
                        <button
                          className="modal-btn modal-btn-ghost control-connect-btn"
                          data-testid="control-disconnect"
                          disabled={busy}
                          onClick={() => void onDisconnect()}
                        >
                          {/* WO-1648: the picker beside it already names the connection kind. */}
                          <PlugZap size={13} />{controlText('ControlPage.text092')}</button>
                      ) : (
                        <button
                          className="modal-btn modal-btn-primary control-connect-btn"
                          data-testid="control-connect"
                          disabled={busy || phase === 'connecting'}
                          onClick={() => void onConnect()}
                        >
                          {/* Operator 09-19: the kind select already says "Simulate ..." - the
                              button says Connect, never "simulated" a second time. */}
                          <Plug size={13} /> {phase === 'connecting' ? 'Connecting...' : controlText('ControlPage.text093')}
                        </button>
                      )}
                    </div>
                  </div>
                  {!supported && (
                    <div className="control-connect-detail">{controlText('ControlPage.text094')}</div>
                  )}
                  {connectError && (
                    <div
                      className="control-connect-error control-connect-error-line"
                      data-testid="control-connect-error"
                      title={connectError}
                    >
                      {connectError}
                    </div>
                  )}
                  {phase === 'disconnected' && detail && (
                    <div className="control-state-row">
                      <span className="control-connect-detail control-connect-detail-line" title={detail}>
                        {detail}
                      </span>
                    </div>
                  )}
                  <div className="control-machine-status-row">
                    {connected && (
                      <>
                        {/* WO-426: whichever backend is connected, not a firmware family the
                            operator may not be running - firmwareVersion() via the contract's
                            onReady, unchanged text for GRBL since that's what it always said. */}
                        {version && <span className="control-version">{version}</span>}
                        <div className="control-led-row" data-testid="control-pin-leds">
                          <ProbeLamp kind="probe" value={probeSignals.probe} testId="control-lamp-probe" />
                          <ProbeLamp kind="probing" value={probeSignals.probeCycle} testId="control-lamp-probing" />
                          <span className="control-led-caption" aria-hidden="true">{controlText('ControlPage.text095')}</span>
                          {[...limitLamps, ...otherInputLamps].map(([letter, label, value]) => (
                            <span
                              key={letter}
                              className={`control-led ${letter === otherInputLamps[0][0] ? 'control-led-group-start ' : ''}${
                                value === true
                                  ? 'control-led-on'
                                  : value === null
                                    ? 'control-led-unavailable'
                                    : ''
                              }`}
                              data-tooltip={
                                value === true
                                  ? controlText('ControlPage.text096', { value1: String(label) })
                                  : value === null
                                    ? controlText('ControlPage.text097', { value1: String(label) })
                                    : controlText('ControlPage.text098', { value1: String(label) })
                              }
                            >
                              {letter}
                            </span>
                          ))}
                          <span
                            className={`control-led control-led-home ${homed ? 'control-led-ok' : ''}`}
                            data-testid="control-homed-led"
                            data-tooltip={
                              homed
                                ? controlText('ControlPage.text099')
                                : settings[22] === '0'
                                  ? controlText('ControlPage.text100')
                                  : controlText('ControlPage.text101')
                            }
                          >{controlText('ControlPage.text102')}</span>
                        </div>
                      </>
                    )}
                    <PendantPanel />
                  </div>
                </>
              )}
              {/* WO-448: surfaced the moment the bridge's hello frame says so
                  - BEFORE the operator presses jog/home/probe/start and
                  discovers the refusal that way, which is exactly the
                  failure this WO exists to prevent. Rendered even while the
                  panel is otherwise collapsed (see the fold condition above). */}
              {bridgeReadOnly && (
                <div className="control-connect-detail control-bridge-readonly" data-testid="control-bridge-readonly">{controlText('ControlPage.text103')}</div>
              )}
              {/* The spindle-link line is GONE (2026-08-23, Operator at the machine:
                  "Remove your safety check for the dongle pull... I do not wish
                  to see this. And it is in the UI, not the consol. 2nd fail.").

                  It was the SAME defect as the alarm block below - a div in the
                  left column, growing the layout, for something that belongs in
                  the console. That one was removed this morning for exactly this
                  reason and this one was left standing.

                  Worse, its text was WRONG whenever it mattered. It said
                  "spindleOn will be refused until it is" while the bridge was
                  running --vfd-commission, which prints "the spindle can be
                  started anyway". A message that misstates a safety gate is the
                  defect class this whole day has been about.

                  `verified` can never become true: Operator declined the dongle pull
                  ("I really can't afford to damage it") and that ruling is final,
                  so the gate it described was unsatisfiable by design and always
                  bypassed by a flag. The bridge-side gate goes with it - see
                  Vfd.cs - because a check that can never pass and is always
                  overridden trains people to run in commissioning mode, which is
                  worse than having no check at all. */}
              {/* The alarm block that used to sit here is GONE (2026-08-23).
                  It grew the left column whenever an alarm was live and pushed
                  everything below it down - the thing Operator has ruled against
                  repeatedly. Nothing is lost: machineSession's onAlarm now
                  writes the same sentence to the CONSOLE, where it persists and
                  scrolls, and the always-visible ALARM state chip in the
                  transport bar (ControlTransportBar's STATE_LABEL) carries the
                  fact that cannot be folded away. Its text was also stale - it
                  told the operator to re-home with $H and unlock with $X, GRBL
                  commands this controller does not have. */}
            </div>
            )}
          </section>

          {/* WO-2062: Main's own Position (DRO) panel, mounted here as the
              announcing instance (the one-time "no datum" console line is
              gated to this instance - see PositionPanel's own note). */}
          <PositionPanel announceNoDatum twoDecimalMm />

          {/* WO-048 (approved layout): OVERRIDES lives in the right rail;
              the editable offsets card and the at-a-glance TOOL panel close
              out the left column. */}
          {activeView !== 'offsets' && <OffsetsPanel />}

          <section className="panel control-panel control-tool-panel">
            <div className="panel-header">
              <span className="panel-title">{controlText('ControlPage.text104')}</span>
              {/* WO-184: folded, this panel kept its "Change tool" BUTTON and
                  lost the tool - a control survived, the information did not,
                  which is the rule backwards (Operator's red arrow). The button
                  folds with the body; the IDENTITY stays: which tool is in the
                  spindle, what the table calls it, and the length offset in
                  force. The description is capped so a chatty note cannot wrap
                  the 26px rail header. */}
              {toolPanelCollapsed && (
                <ControlCollapsedReadout testId="control-tool-collapsed-values">
                  {[
                    currentTool !== null ? `T${currentTool}` : '--',
                    shortToolDesc(toolDescription(currentToolEntry)),
                    tlo !== null ? `TLO ${fmtMachineLength(tlo, units)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </ControlCollapsedReadout>
              )}
              <ControlPanelCollapseToggle
                panel="tool"
                testId="control-tool-toggle"
                collapseTip={controlText('ControlPage.text105')}
                expandTip={controlText('ControlPage.text106')}
              />
            </div>
            {!toolPanelCollapsed && (
              <div className="panel-body control-tool-panel-body">
                <ToolGlance onChangeTool={() => setActiveView('tools')} />
              </div>
            )}
          </section>

          </div>
        </aside>

        <ControlColResizer side="left" />

        <main
          className="control-col control-col-main"
          style={programSplitGridStyle(programPreviewPercent)}
        >
          <ProgramPanel />
          {/* WO-048 (Operator markup): transport cluster DIRECTLY BELOW the
              shortened program list - a center-column grid item, not part of
              the top strip - with the STEP row (Single Block toggle + Back +
              Step + the mode explainer) directly under it.
              WO-068: the cluster is mounted HERE only while Main is the
              active view; the aux workspace mounts the same authority when a
              subview takes over. Exactly one mount exists at a time, so the
              transport keyboard shortcut and the one-CYCLE-START invariant
              never double up. */}
          {activeView === 'main' && (
            <>
              <ControlTransportBar sections="transport" />
              <ControlStepRow />
            </>
          )}
          {activeView !== 'probing' && machineConsole}
        </main>

        <ControlColResizer side="right" />

        <aside
          className="control-col control-col-right"
          style={{ width: rightW, minWidth: rightW }}
        >
          {/* WO-068: the regrid stacks FOUR content-sized panels here - more
              than a 900px viewport holds - so the rail gets the same real
              scroll path the left column has. Every macro button stays
              reachable at the acceptance viewports. */}
          <div className="control-col-scroll">
                <JogPanel selectedConnectionKind={kind} />
          <OverridePanel />
          <SpindlePanel onOpenActions={() => setActionsOpen(true)} />
          {/* WO-048 (Operator markup): the user macro buttons close out the
              right rail below Spindle / Coolant. */}
          <MacroPanel onOpenActions={() => setActionsOpen(true)} rpm={spindleRpmPref} />
          </div>
        </aside>
      </div>

      <main className="control-aux-workspace" hidden={activeView === 'main'}>
        {/* WO-068: ordinary auxiliary views retain the fixed program transport.
            WO-385: Probing owns a task-specific authority cluster beside its
            Run action, so an empty program authority row does not mount here.
            WO-411 (Operator ruling 2026-08-21: "no motion buttons on the page"): the
            Routines tab does not mount it either - its Run panel shows ONE
            E-STOP while a routine moves the machine, nothing else. */}
        {activeView !== 'main' && activeView !== 'probing' && activeView !== 'tools' && activeView !== 'routines' && (
          <div className="control-aux-authority" data-testid="control-aux-authority">
            <ControlTransportBar sections="transport" activeView={activeView} />
            {/* WO-327: Single Block, Back and Step are program-stepping
                controls - a probe cycle is not a program single-blocked
                through, so the whole step row does not mount here. */}
            <ControlStepRow />
          </div>
        )}
        {activeView === 'offsets' && (
          // WO-2431: the quick card and the setup workspace sit either side of
          // the shared drag bar; the workspace folds to its header with its chevron.
          <ResizableSplit
            className={`control-offsets-view${offsetsWorkspaceFolded ? ' control-offsets-view-folded' : ''}`}
            testId="control-offsets-split"
            prefKey={OFFSETS_QUICK_PANEL_KEY}
            sizedPane="first"
            defaultSize={offsetsSplitPx.defaultPx}
            minSize={offsetsSplitPx.minPx}
            maxSize={offsetsSplitPx.maxPx}
            fillMinSize={offsetsSplitPx.workspaceMinPx}
            label={controlText('ControlPage.text120')}
            first={
              <aside className="control-offsets-quick-card" aria-label={controlText('ControlPage.text121')}>
                <OffsetsPanel />
              </aside>
            }
            second={<OffsetsWorkspace machineId={machine.id} machineName={machine.name} />}
          />
        )}
        {activeView === 'tools' && <ToolsProbePanel />}
        {activeView === 'probing' && <ProbingPanel machineConsole={machineConsole} />}
        {/* WO-411: the routine library / editor / preview / run in its own
            view. No program transport row here (Operator 2026-08-21); the run
            panel carries its own E-STOP while a routine is in motion. */}
        {activeView === 'routines' && <ProbeRoutinesTab />}
        {/* WO-917: Machine is a container. Its strip is a NEW ROW inside this
            view and nothing else - it does not touch the top nav's height, and
            the sub-views below it get the rest of the workspace. */}
        {activeView === 'machine' && (
          <>
            <div
              className="control-strip-nav"
              role="tablist"
              aria-label={controlText('ControlPage.text122')}
              data-testid="control-machine-subnav"
              style={{ flex: '0 0 auto', marginBottom: 8 }}
            >
              {MACHINE_SUB_TABS.map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={machineTab === tab}
                  data-testid={`control-machine-tab-${tab}`}
                  className={`control-view-tab${machineTab === tab ? ' control-view-tab-active' : ''}`}
                  // WO-939: Definition is NO LONGER A DOOR (Operator, twice: "the
                  // machine definition in control needs to have everything").
                  // WO-2102: nor is Actions - that tab is gone; every sub-tab
                  // renders its own view.
                  onClick={() => setMachineTab(tab)}
                >
                  {label}
                </button>
              ))}
            </div>
            {machineTab === 'definition' && (
              <section className="panel control-panel" data-testid="control-machine-definition">
                <MachineDefinitionPanel
                  connectionKind={kind}
                  connectionBusy={busy}
                  controllerSetupFocus={controllerSetupFocus}
                />
              </section>
            )}
            {/* WO-917: NOT a copy and NOT a shrunken preview - the same
                MacroPanel the Macros tab mounted, at the same full size. Main's
                right rail cuts this panel off (WO-103: the rail overflows and
                MacroPanel is its last card), so this is still the only place
                every macro button is reachable without scrolling that rail. */}
            {machineTab === 'macros' && (
              <MacroPanel onOpenActions={() => setActionsOpen(true)} rpm={spindleRpmPref} />
            )}
            {machineTab === 'diagnostics' && (
              <>
                <CycleLogPanel />
                {/* WO-416: simulator only - SimulatedPartPanel renders nothing
                    against real hardware (checks connectionKind itself). */}
                <SimulatedPartPanel />
              </>
            )}
          </>
        )}
      </main>

      <MachineActionsModal open={actionsOpen} onClose={() => setActionsOpen(false)} />
    </div>
  )
}
