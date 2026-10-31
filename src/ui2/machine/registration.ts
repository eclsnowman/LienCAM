// WO-3303: what the Machine lane adds to the New UI: the window, the machine pill, and the two
// commands other lanes call (`machine.open`, `machine.openDefinition`). The window does NOT take
// over the hosted Machine library modal yet: that modal is the only editor of the CAM half of a
// profile, New machine and profile import, and every old door (the status chip, the ribbon, the
// Controller area) opens it with `openModal('machine-config')`. Wave 3 ports those and deletes it.
import { READY } from '../../commands/types'
import { MachinePill } from './MachinePill'
import { MachineWindow } from './MachineWindow'
import type { WorkspaceRegistration } from '../registry/types'
import { openMachineDefinition, openMachineWindow } from './windowState'

export const registration: WorkspaceRegistration = {
  owner: 'machine',
  windows: [{ id: 'machine', Component: MachineWindow }],
  appBarItems: [{ id: 'machine.pill', order: 0, area: 'status', Component: MachinePill }],
  commands: [
    {
      id: 'machine.open',
      labelKey: 'ui2-machine.wo3303:cmdOpen',
      helpKey: 'ui2-machine.wo3303:cmdOpenHelp',
      place: 'global',
      group: 'machine',
      kind: 'momentary',
      availability: () => READY,
      run: () => { openMachineWindow() },
    },
    {
      id: 'machine.openDefinition',
      labelKey: 'ui2-machine.wo3303:cmdOpenDefinition',
      helpKey: 'ui2-machine.wo3303:cmdOpenDefinitionHelp',
      place: 'global',
      group: 'machine',
      kind: 'momentary',
      availability: () => READY,
      run: () => { openMachineDefinition() },
    },
  ],
}
