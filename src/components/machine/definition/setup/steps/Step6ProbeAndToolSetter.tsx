import { textFor, useText } from '../../../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { ProbingArea } from '../../ProbingArea'
import type { MachineDefinitionPanelState } from '../../useMachineDefinitionPanel'

// WO-1696 step 6 (v2/SLICES.md T13) - the Probing area (WO-1693), unchanged:
// probe/tool-setter pins and MachineProbeDefaults, the same editor the
// Probing tab shows later.

type Step6Props = Pick<MachineDefinitionPanelState, 'draft' | 'editDraft' | 'patchIoPin' | 'pinProblem' | 'polarityBoxFor'>
  & { def: NonNullable<MachineDefinitionPanelState['def']> }

export function Step6ProbeAndToolSetter(props: Step6Props) {
  useText('control-screens-not-probing')
  return (
    <div data-testid="setup-step-probing">
      <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)' }}>{controlText('Step6ProbeAndToolSetter.text001')}</p>
      <ProbingArea {...props} />
    </div>
  )
}
