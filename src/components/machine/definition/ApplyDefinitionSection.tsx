import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { SectionHead } from './DefinitionFields'
import { Check } from 'lucide-react'
import { Cpu } from 'lucide-react'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


type ApplyDefinitionSectionProps = Pick<MachineDefinitionPanelState, 'applyIsCurrent' | 'applyState' | 'applyTooltip' | 'applying' | 'handleApply'>

export function ApplyDefinitionSection({ applyIsCurrent: current, applyState, applyTooltip, applying, handleApply }: ApplyDefinitionSectionProps) {
  useText('control-screens-not-probing')
  const applyIsCurrent = current && applyState !== null

  return (
    <><div data-testid="machine-def-panel-apply-section">
              <SectionHead
                title={controlText('ApplyDefinitionSection.text001')}
                summary="Saves first, then writes this definition to the connected controller"
                testId="machine-def-panel-head-apply"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="control-chip-btn"
                  data-testid="machine-def-panel-apply"
                  data-apply-state={
                    applying ? 'applying'
                      : applyIsCurrent ? (applyState.ok ? 'applied' : 'failed')
                        : 'idle'
                  }
                  disabled={applying}
                  data-tooltip={applyTooltip}
                  onClick={() => { void handleApply() }}
                  style={{ minWidth: 148, justifyContent: 'center' }}
                >
                  {applying
                    ? 'Applying...'
                    : applyIsCurrent && applyState.ok
                      ? <><Check size={12} />{controlText('ApplyDefinitionSection.text002')}</>
                      : applyIsCurrent
                        ? <><Cpu size={12} />{controlText('ApplyDefinitionSection.text003')}</>
                        : <><Cpu size={12} />{controlText('ApplyDefinitionSection.text004')}</>}
                </button>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', flex: 1, minWidth: 260 }}>{controlText('ApplyDefinitionSection.text005')}</span>
              </div>
            </div></>
  )
}

