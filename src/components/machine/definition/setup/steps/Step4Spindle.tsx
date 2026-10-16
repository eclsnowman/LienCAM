import { textFor, useText } from '../../../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { SpindleArea } from '../../SpindleArea'
import type { MachineDefinitionPanelState } from '../../useMachineDefinitionPanel'

// WO-1696 step 4 (v2/SLICES.md T13) - the Spindle area (WO-1691), unchanged:
// the same drive/rpm/direction/VFD-link editor an operator would reach later
// from the Spindle tab, so nothing typed here is a second copy of the record.

type Step4Props = Pick<MachineDefinitionPanelState,
  | 'draft' | 'editDraft' | 'source' | 'unsent'
  | 'spindleLink' | 'spindleLinkIsForeign' | 'spindleLinkOtherMachine' | 'spindleStoredIsStated' | 'vfdEdit'>

export function Step4Spindle(props: Step4Props) {
  useText('control-screens-not-probing')
  return (
    <div data-testid="setup-step-spindle">
      <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)' }}>{controlText('Step4Spindle.text001')}</p>
      <SpindleArea {...props} />
    </div>
  )
}
