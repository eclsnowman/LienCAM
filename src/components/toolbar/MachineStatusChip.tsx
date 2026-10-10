import { textFor, useText } from '../../i18n'
import { useMachineControl } from '../../store/machineControlStore'
import { deriveMachineChip } from '../../lib/machine/machineChip'
import { getMachineController, programM0HoldLine } from '../../lib/machine/machineSession'

const shellText = textFor('app-shell-settings-menus')

/** Ambient machine truth shared by CAM, Model and Control workspaces. */
export function MachineStatusChip() {
  useText('app-shell-settings-menus')
  const connectionPhase = useMachineControl((s) => s.connectionPhase)
  const machineState = useMachineControl((s) => s.machineState)
  const job = useMachineControl((s) => s.job)
  const toolChange = useMachineControl((s) => s.toolChange)
  // Subscribe only to schedule datum repaints; the controller resolver below
  // remains the authority for which axes are homed.
  useMachineControl((s) => s.homed)

  // Do not install a fallback controller merely to paint the disconnected
  // header. Once connected, machineSession necessarily owns the live one.
  const datumResolver = connectionPhase === 'connected' ? getMachineController() : null
  const chip = deriveMachineChip({ connectionPhase, machineState, jobPhase: job.phase, datumResolver,
    programM0Held: programM0HoldLine() !== null,
    toolChangeWaiting: toolChange?.mode === 'toolChange'
      && (toolChange.step === 'awaiting-swap' || toolChange.step === 'ready') })
  const label = machineStateLabel(chip.label)
  const accessibleLabel = shellText('MachineStatusChip.machineStatus', { label })

  return (
    <div
      className="machine-status-chip"
      data-state={chip.state}
      data-testid="machine-status-chip"
      data-tooltip={accessibleLabel}
      role="status"
      aria-label={accessibleLabel}
      aria-live="polite"
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
    default: return value
  }
}
