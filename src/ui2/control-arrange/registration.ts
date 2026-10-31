// WO-3308: what this lane contributes to the New UI, collected by the workspace registry
// (src/ui2/registry/collect.ts finds this file by its name). The Layout menu, the Arrange window
// and the column renderer are components the Control workspace (WO-3298) mounts; this lane
// registers the command that enters and leaves Arrange, so ribbon, shortcuts and command search
// reach it by id. Arrange is never refused: it works while the machine moves.
import { READY, type CommandSpec } from '../../commands/types'
import type { WorkspaceRegistration } from '../registry'
import { useControlLayouts } from '../../store/slices/controlLayouts'

/** Enter or leave Arrange. Latched: its lamp is Arrange being on. */
export const ARRANGE_COMMAND: CommandSpec = {
  id: 'control.arrange',
  labelKey: 'ui2-control-arrange.wo3308:arrange',
  helpKey: 'ui2-control-arrange.wo3308:windowTitle',
  place: 'control',
  group: 'layout',
  kind: 'latched',
  availability: () => READY,
  run: () => {
    const s = useControlLayouts.getState()
    s.setArranging(!s.arranging)
  },
  isOn: () => useControlLayouts.getState().arranging,
}

export const registration: WorkspaceRegistration = {
  owner: 'control-arrange',
  commands: [ARRANGE_COMMAND],
}
