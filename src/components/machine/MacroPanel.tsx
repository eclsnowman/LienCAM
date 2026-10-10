// MacroPanel - user-defined machine buttons (MACHINE-CONTROL stage 9).
// Renders whatever the operator wired up in the Machine Actions modal,
// color-coded per the contract. Confirm-flagged buttons ARM on first press
// and fire on the second within a short window - a glove-friendly guard,
// no modal on the operating surface.

import { cloneElement, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ParkingSquare, Settings2, SquarePen } from 'lucide-react'
import { controlMachine, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { parkCarrierMachine, saveParkMachineRecord, useMachineActions } from '../../store/machineActionsStore'
import {
  machineParkList,
  parkMacroPositions,
  machineSafeZValue,
} from '../../lib/machine/machineActions'
import {
  ESTOP_BLOCKS_MOTION,
  estopNeedsReset,
  noHomeSwitchesRefusal,
  runParkMove,
  subscribeEstopNeedsReset,
} from '../../lib/machine/machineSession'
import {
  activeMacroRun,
  continueHeldMacro,
  runUserMacro,
  shownMacros,
  stopUserMacro,
  subscribeMacroRun,
} from '../../lib/machine/macros/macroRuntime'
import { machineHasNoHomeSwitches, parsePositionMacroBody, withMacroToolChangeFlag, type MachineMacro } from '../../types'
import {
  ControlCollapsedReadout,
  ControlPanelCollapseToggle,
  useControlPanelCollapsed,
} from './ControlPanelCollapseToggle'
import { MacroEditor } from './MacroEditor'

const ARM_WINDOW_MS = 3000

export function MacroPanel({ onOpenActions, rpm: _rpm }: { onOpenActions: () => void; rpm: number }) {
  const machine = useCamStore(controlMachine)
  const machineId = machine?.id ?? 'default'
  const storedActions = useMachineActions((s) => s.byMachine[machineId])
  const parkMachine = useCamStore(parkCarrierMachine)
  // WO-1680/1681/1707: the user's own macros, from the definition, in their
  // order - former custom buttons included (moved onto the record once, by
  // `machineActionsStore`). A macro marked hidden stays off the panel - and,
  // WO-2657, does not run from anywhere (`shownMacros`, the one filter).
  const userMacros = useMemo(() => shownMacros(parkMachine), [parkMachine])
  // A machine with no position macro of its own still offers whatever
  // `machineParkList` resolves (its G30 points, or a park saved with the
  // wiring before WO-1670) as plain park buttons - the one case a park is
  // NOT already a macro button above. A machine with a position macro never
  // reaches this: `machineParkList` prefers those, so this is empty then.
  const fallbackParks = useMemo(() => {
    if (parkMacroPositions(parkMachine).length > 0) return []
    return machineParkList(parkMachine, storedActions)
  }, [parkMachine, storedActions])
  const safeZ = machineSafeZValue(parkMachine, storedActions)
  const macroRun = useSyncExternalStore(subscribeMacroRun, activeMacroRun, () => null)
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const jobPhase = useMachineControl((s) => s.job.phase)
  const machineState = useMachineControl((s) => s.machineState)
  const homed = useMachineControl((s) => s.homed)
  const canAct = connected && jobPhase !== 'streaming' && jobPhase !== 'paused'
  // Operator 2026-09-14 ("A: Flash, all motion off"): a park is motion.
  const estopLatched = useSyncExternalStore(subscribeEstopNeedsReset, estopNeedsReset, () => true)
  const canPark = canAct && !estopLatched && machineState === 'idle' && homed
  const [parkError, setParkError] = useState<string | null>(null)

  const [macroEditorOpen, setMacroEditorOpen] = useState(false)
  const [armedId, setArmedId] = useState<string | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapsed = useControlPanelCollapsed('macros')
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
    },
    [],
  )
  useEffect(() => {
    if (armedId !== null && !userMacros.some((m) => m.id === armedId)) {
      setArmedId(null)
      if (armTimer.current !== null) clearTimeout(armTimer.current)
    }
  }, [armedId, userMacros])

  // WO-1707: every macro's own press - a folded custom button's confirm-first
  // flag arms on the first press and fires on the second within the window,
  // the same guard the old custom-button grid gave; a plain macro fires at
  // once, as it always has.
  const pressMacro = (m: MachineMacro) => {
    if (m.confirm && armedId !== m.id) {
      setArmedId(m.id)
      if (armTimer.current !== null) clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setArmedId(null), ARM_WINDOW_MS)
      return
    }
    setArmedId(null)
    if (armTimer.current !== null) clearTimeout(armTimer.current)
    runUserMacro(m)
  }

  return (
    <section className="panel control-panel">
      <div className="panel-header">
        <span className="panel-title">Macros</span>
        {/* WO-184: folded, Macros used to show NOTHING. What is worth a glance
            is WHAT IS WIRED UP - how many buttons are waiting behind the fold
            - so an empty rig reads as empty rather than as a panel that
            happens to be shut. Both counts come from the per-machine actions
            store, so configuring one updates this live. */}
        {collapsed && (
          <ControlCollapsedReadout testId="control-macros-collapsed-values">
            {fallbackParks.length === 0 && userMacros.length === 0
              ? 'None configured'
              : [
                  fallbackParks.length > 0 ? `${fallbackParks.length} park${fallbackParks.length === 1 ? '' : 's'}` : null,
                  userMacros.length > 0 ? `${userMacros.length} macro${userMacros.length === 1 ? '' : 's'}` : null,
                ]
                  .filter(Boolean)
                  .join(' - ')}
          </ControlCollapsedReadout>
        )}
        {/* WO-184: the gear is a CONTROL, and a collapsed panel keeps only
            READINGS - it also stole the header width the readout needs. It
            folds with the body; the transport bar's "Machine actions" button
            reaches the same modal while Macros is shut. */}
        {!collapsed && (
          <button
            className="panel-action-btn"
            data-testid="control-macros-edit"
            onClick={() => setMacroEditorOpen(true)}
            data-tooltip="Add, edit, remove and reorder macros"
            aria-label="Edit macros"
          >
            <SquarePen size={13} />
          </button>
        )}
        {!collapsed && (
          <button
            className="panel-action-btn"
            data-testid="control-actions-gear"
            onClick={onOpenActions}
            data-tooltip="Configure machine actions and custom buttons"
            aria-label="Configure machine actions"
          >
            <Settings2 size={13} />
          </button>
        )}
        {/* WO-116: same Work offsets chevron as every other rail panel. An
            ARMED confirm button survives the fold - armedId is state on this
            panel, which stays mounted; the arm window still times out. */}
        <ControlPanelCollapseToggle
          panel="macros"
          testId="control-macros-toggle"
          collapseTip="Collapse the macro buttons"
          expandTip="Show the macro buttons"
        />
      </div>
      {!collapsed && (
      <div className="panel-body control-macro-body">
        {fallbackParks.length > 0 && (
          <div className="control-macro-grid control-park-grid" data-testid="control-park-grid">
            {fallbackParks.map((p) => (
              <button
                key={p.id}
                className="control-macro-btn macro-green"
                data-testid={`control-park-${p.id}`}
                disabled={!canPark}
                data-tooltip={
                  connected && estopLatched
                    ? ESTOP_BLOCKS_MOTION
                    : !homed && connected
                    ? machineHasNoHomeSwitches(machine)
                      ? noHomeSwitchesRefusal(
                          'set the machine position first because park positions are machine coordinates.',
                        )
                      : 'Home the machine first - park positions are machine coordinates'
                    : `Raise to safe Z, then rapid to machine X${p.x} Y${p.y}`
                }
                onClick={() => {
                  const r = runParkMove(p, safeZ)
                  setParkError(r.ok ? null : (r.reason ?? 'Park refused.'))
                }}
              >
                <ParkingSquare size={12} /> {p.label}
              </button>
            ))}
          </div>
        )}
        {parkError && (
          <div className="control-park-error" data-testid="control-park-error">
            {parkError}
          </div>
        )}
        {userMacros.length > 0 ? (
          <div className="control-macro-grid" data-testid="control-user-macro-grid">
            {userMacros.map((m) => {
              const running = macroRun?.macroId === m.id
              const armed = armedId === m.id
              const isPositionMacro = parsePositionMacroBody(m.body) !== null
              const macroButton = (
                <button
                  className={`control-macro-btn ${running || armed ? 'macro-armed' : `macro-${m.color ?? 'cyan'}`}`}
                  data-testid={`control-user-macro-${m.id}`}
                  disabled={!running && (!canAct || macroRun !== null)}
                  aria-pressed={running}
                  // The running label says more than a name; it wraps rather than clips.
                  style={{
                    ...(running ? { whiteSpace: 'normal' as const } : {}),
                    ...(isPositionMacro ? { flex: 1 } : {}),
                  }}
                  data-tooltip={
                    running
                      ? `Macro "${m.name}" is running - Stop ends it`
                      : `Run macro "${m.name}"${m.mCode !== undefined ? ` (M${m.mCode})` : ''}`
                  }
                  onClick={() => {
                    if (!running) pressMacro(m)
                  }}
                >
                  {running
                    ? `${m.name} - ${macroRun.phase === 'held' ? 'holding' : 'running'}`
                    : armed
                      ? 'Press again'
                      : m.name}
                </button>
              )
              if (!isPositionMacro) return cloneElement(macroButton, { key: m.id })
              return (
                <div key={m.id} style={{ display: 'flex', gap: 4 }}>
                  {macroButton}
                  <button
                    className={`control-chip-btn ${m.usedForToolChange ? 'control-chip-active' : ''}`}
                    data-testid={`control-macro-tc-${m.id}`}
                    aria-pressed={!!m.usedForToolChange}
                    aria-label={`${m.usedForToolChange ? 'Unmark' : 'Mark'} "${m.name}" as used for tool change`}
                    data-tooltip={
                      m.usedForToolChange
                        ? 'Used for tool change - the guided/automatic change parks here'
                        : 'Mark used for tool change (the guided/automatic change parks here)'
                    }
                    onClick={() =>
                      saveParkMachineRecord(withMacroToolChangeFlag(parkMachine, m.id, !m.usedForToolChange))
                    }
                  >
                    TC
                  </button>
                </div>
              )
            })}
            {macroRun !== null && macroRun.phase === 'held' && (
              <button
                className="control-macro-btn macro-green"
                data-testid="control-user-macro-continue"
                data-tooltip={`Continue macro "${macroRun.name}" from its hold`}
                onClick={() => continueHeldMacro()}
              >
                Cycle Start
              </button>
            )}
            {macroRun !== null && (
              <button
                className="control-macro-btn macro-red"
                data-testid="control-user-macro-stop"
                data-tooltip={`End macro "${macroRun.name}" now - nothing more is sent`}
                onClick={() => stopUserMacro()}
              >
                Stop macro
              </button>
            )}
          </div>
        ) : (
          <button
            className="modal-btn modal-btn-ghost control-macro-empty"
            data-testid="control-macros-empty"
            onClick={() => setMacroEditorOpen(true)}
          >
            Add macros (vacuum, dust boot, lights...)
          </button>
        )}
      </div>
      )}
      <MacroEditor open={macroEditorOpen} onClose={() => setMacroEditorOpen(false)} />
    </section>
  )
}
