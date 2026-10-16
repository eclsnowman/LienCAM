import { catalogChildren } from '../../catalogText'
import { textFor, useText } from '../../../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { Check, Cpu } from 'lucide-react'
import { OverviewCards } from '../../OverviewCards'
import type { MachineDefinitionPanelState } from '../../useMachineDefinitionPanel'
import type { OverviewFacts } from '../../../../../lib/machine/overviewFacts'

// WO-1696 step 7 (v2/SLICES.md T13) - check and save: WO-1688's five
// overview cards (the same `overviewFacts(machine)` sentences the Overview
// tab shows), "Apply to the controller now" when connected, and Save.

type Step7Props = Pick<MachineDefinitionPanelState,
  | 'draft' | 'applying' | 'applyState' | 'applyTooltip' | 'applyIsCurrent' | 'handleApply' | 'commit' | 'connectionPhase' | 'editsConnectedMachine'>
  & { onSaved: () => void
    // AUDIT FIX (fix round 2): each card's "Open" button used to call a
    // no-op (`setSection={() => {}}`) - five inert controls. It now jumps
    // back to the walkthrough step that edits that card, keyed the same way
    // WO-1709 keyed the Overview tab's own Open buttons
    // (`machine`/`spindle`/`outputs`/`probing`/`controller`). See
    // SetupWalkthrough.tsx for why "jump to the step" was picked over
    // "close the walkthrough and switch the definition page's tab".
    onOpenArea: (key: keyof OverviewFacts) => void }

export function Step7CheckAndSave({ draft, applying, applyState, applyTooltip, applyIsCurrent, handleApply, commit, connectionPhase, editsConnectedMachine, onOpenArea, onSaved }: Step7Props) {
  useText('control-screens-not-probing')
  const applyCurrent = applyIsCurrent && applyState !== null
  // AUDIT FIX (fix round 1): the outcome names this button "Apply to the
  // controller now" WHEN CONNECTED - it was rendering unconditionally, so
  // the review step offered it while Offline/Not connected.
  const connected = connectionPhase === 'connected'
  // REVIEW FIX (fix round 2): Apply sends to the connected machine. The
  // Machine Library's walkthrough can be about another record (a New one),
  // so there the button is not offered at all.
  const canApply = connected && editsConnectedMachine
  return (
    <div data-testid="setup-step-review" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{catalogChildren(controlText('Step7CheckAndSave.text001', { value1: '\u0000value1\u0000' }), { value1: draft.name })}</p>
      {connected && !editsConnectedMachine && (
        <p data-testid="setup-step-review-not-connected" style={{ margin: 0, color: 'var(--text-secondary)' }}>{controlText('Step7CheckAndSave.text002')}</p>
      )}

      <OverviewCards draft={draft} setSection={(key) => { onOpenArea(key as keyof OverviewFacts) }} />

      <div style={{ display: 'flex', gap: 8 }}>
        {canApply && (
          <button
            type="button"
            className="control-chip-btn"
            data-testid="setup-step-review-apply"
            disabled={applying}
            data-tooltip={applyTooltip}
            onClick={() => { void handleApply() }}
          >
            {applying
              ? 'Applying...'
              : applyCurrent && applyState!.ok
                ? <><Check size={12} />{controlText('Step7CheckAndSave.text003')}</>
                : applyCurrent
                  ? <><Cpu size={12} />{controlText('Step7CheckAndSave.text004')}</>
                  : <><Cpu size={12} />{controlText('Step7CheckAndSave.text005')}</>}
          </button>
        )}
        <button
          type="button"
          className="control-chip-btn"
          data-testid="setup-step-review-save"
          onClick={() => { commit(); onSaved() }}
        >{controlText('Step7CheckAndSave.text006')}</button>
      </div>
    </div>
  )
}
