import type { MachineConfig } from '../../../../../types'
import { CoolantCapabilitySection } from '../../CoolantCapabilitySection'
import { OutputsSection } from '../../OutputsSection'
import type { SettingSource } from '../../DefinitionFields'

// WO-1696 step 5 (v2/SLICES.md T13) - outputs and coolant: the WO-1692 area,
// unchanged - the outputs list with coolant as its CAM role column, so a row
// added here is the same row the Outputs & coolant tab shows later.

interface Step5Props {
  draft: MachineConfig
  editDraft: (mut: (m: MachineConfig) => MachineConfig) => void
  unsent: SettingSource
}

export function Step5OutputsAndCoolant({ draft, editDraft, unsent }: Step5Props) {
  return (
    <div data-testid="setup-step-outputs">
      <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)' }}>
        What does this machine switch, and what does each output do?
      </p>
      <CoolantCapabilitySection machine={draft} onChange={editDraft} settings={unsent} />
      <OutputsSection machine={draft} onChange={editDraft} />
    </div>
  )
}
