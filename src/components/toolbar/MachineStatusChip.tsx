import { useCallback, useState, useSyncExternalStore } from 'react'
import { useCamStore } from '../../store'
import { textFor, useText } from '../../i18n'
import { useMachineControl } from '../../store/machineControlStore'
import { deriveMachineChip } from '../../lib/machine/machineChip'
import {
  estopNeedsReset,
  getMachineController,
  programM0HoldLine,
  subscribeEstopNeedsReset,
} from '../../lib/machine/machineSession'

const shellText = textFor('app-shell-settings-menus')
// WO-3098: the latched stop reads in the Control state chip's own word.
const controlText = textFor('control-screens-not-probing')

/** The chip's one derivation: what the machine is doing now, in the operator's word. The New UI's
 *  machine pill reads the same facts through this hook, so the two can never disagree. */
export function useMachineChipView() {
  useText('app-shell-settings-menus')
  const connectionPhase = useMachineControl((s) => s.connectionPhase)
  const machineState = useMachineControl((s) => s.machineState)
  const job = useMachineControl((s) => s.job)
  const toolChange = useMachineControl((s) => s.toolChange)
  const probeRunStopped = useMachineControl((s) => s.probeRunStopped)
  // WO-3190 (CT-2): the whole latch, connect-time included - the same fact
  // the Control state chip and the motion gates read.
  const estopTripped = useSyncExternalStore(subscribeEstopNeedsReset, estopNeedsReset, () => false)
  // Subscribe only to schedule datum repaints; the controller resolver below
  // remains the authority for which axes are homed.
  useMachineControl((s) => s.homed)

  // Do not install a fallback controller merely to paint the disconnected
  // header. Once connected, machineSession necessarily owns the live one.
  const datumResolver = connectionPhase === 'connected' ? getMachineController() : null
  const chip = deriveMachineChip({ connectionPhase, machineState, jobPhase: job.phase, datumResolver,
    programM0Held: programM0HoldLine() !== null, probeRunStopped, estopTripped,
    toolChangeWaiting: toolChange?.mode === 'toolChange'
      && (toolChange.step === 'awaiting-swap' || toolChange.step === 'ready') })
  return { chip, label: machineStateLabel(chip.label) }
}

/** Ambient machine truth shared by CAM, Model and Control workspaces. */
export function MachineStatusChip() {
  useText('app-shell-settings-menus')
  const { chip, label } = useMachineChipView()
  const accessibleLabel = shellText('MachineStatusChip.machineStatus', { label })
  // WO-3303: inside the New UI the chip is the machine entry (every workspace shows it): a click or
  // Enter / Space opens machine settings. The classic header renders it exactly as before.
  const openModal = useCamStore((s) => s.openModal)
  const [inNewUi, setInNewUi] = useState(false)
  const open = () => openModal('machine-config')
  const markNewUi = useCallback((el: HTMLDivElement | null) => { if (el) setInNewUi(el.closest('[data-ui2]') != null) }, [])

  return (
    <div
      className="machine-status-chip"
      data-state={chip.state}
      data-testid="machine-status-chip"
      data-tooltip={accessibleLabel}
      ref={markNewUi}
      role={inNewUi ? 'button' : 'status'}
      tabIndex={inNewUi ? 0 : undefined}
      onClick={inNewUi ? open : undefined}
      onKeyDown={inNewUi ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } } : undefined}
      aria-label={accessibleLabel}
      aria-live="polite"
      // WO-2774: a stopped probe run reads in its stop line's red.
      style={chip.state === 'stopped' ? { color: 'var(--accent-red)' } : undefined}
    >
      <span className="machine-status-dot" aria-hidden="true" />
      <span className="machine-status-label">{label}</span>
    </div>
  )
}

function machineStateLabel(value: string): string {
  switch (value) {
    case 'Offline': return shellText('MachineStatusChip.offline')
    case 'Not homed': return shellText('MachineStatusChip.notHomed')
    case 'Ready': return shellText('MachineStatusChip.ready')
    case 'Running': return shellText('MachineStatusChip.running')
    case 'Held': return shellText('MachineStatusChip.held')
    case 'Alarm': return shellText('MachineStatusChip.alarm')
    case 'Stopped': return shellText('MachineStatusChip.stopped')
    case 'E-STOP': return controlText('ControlTransportBar.text020')
    default: return value
  }
}
