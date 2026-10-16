import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { Plus } from 'lucide-react'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'
import { GrblSettingsTable } from '../GrblSettingsTable'
import { controllerSurface } from '../../../lib/machine/controllerSurface'


type ControllerDefinitionSectionProps = Pick<MachineDefinitionPanelState, 'def' | 'defineController' | 'draft' | 'editDraft' | 'setupKind'>

// WO-1694 T11: the GRBL $-table's real home is All settings (WO-1689/1696),
// with the Controller area (`ControllerArea.tsx`) linking there instead of
// rendering the table. This file's sole call site is the Legacy tab in
// `MachineDefinitionPanel.tsx`, which WO-1694 does not own, so moving the
// table's render location (and dropping the "no controller definition"
// branch it still needs on Legacy today) waits for whichever order next
// touches that file - WO-1696 already does, to wire the setup walkthrough in.
export function ControllerDefinitionSection({ def, defineController, draft, editDraft, setupKind }: ControllerDefinitionSectionProps) {
  useText('control-screens-not-probing')
  return (
    <>
      {controllerSurface(draft).grblSettings && (
        <GrblSettingsTable machine={draft} onChange={editDraft} />
      )}
      {!def && (setupKind === 'serial' ? (
          // WO-1114: GRBL's sentence and action are one compact row directly
          // under its three fields. Non-serial controllers keep their existing
          // undefined state exactly unchanged.
          <div
            data-testid="machine-def-panel-undefined"
            style={{
              display: 'flex', alignItems: 'center', gap: '2px 12px',
              flexWrap: 'wrap', fontSize: 'var(--font-size-sm)',
              color: 'var(--text-muted)', lineHeight: 1.5,
            }}
          >
            {draft.name}{controlText('ControllerDefinitionSection.text001')}<button
              type="button"
              className="control-chip-btn"
              data-testid="machine-def-panel-define"
              data-tooltip={controlText('ControllerDefinitionSection.text002')}
              onClick={defineController}
            >
              <Plus size={12} />{controlText('ControllerDefinitionSection.text003')}</button>
          </div>
        ) : (
          <div className="panel-empty" data-testid="machine-def-panel-undefined">
            {draft.name}{controlText('ControllerDefinitionSection.text004')}<button
              type="button"
              className="control-chip-btn"
              data-testid="machine-def-panel-define"
              data-tooltip={controlText('ControllerDefinitionSection.text005')}
              onClick={defineController}
            >
              <Plus size={12} />{controlText('ControllerDefinitionSection.text006')}</button>
          </div>
        ))}
    </>
  )
}
