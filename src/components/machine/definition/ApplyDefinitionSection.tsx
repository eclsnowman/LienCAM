import { SectionHead } from './DefinitionFields'
import { Check } from 'lucide-react'
import { Cpu } from 'lucide-react'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


type ApplyDefinitionSectionProps = Pick<MachineDefinitionPanelState, 'applyIsCurrent' | 'applyState' | 'applyTooltip' | 'applying' | 'handleApply'>

export function ApplyDefinitionSection({ applyIsCurrent: current, applyState, applyTooltip, applying, handleApply }: ApplyDefinitionSectionProps) {
  const applyIsCurrent = current && applyState !== null

  return (
    <><div data-testid="machine-def-panel-apply-section">
              <SectionHead
                title="Send to machine"
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
                      ? <><Check size={12} /> Applied</>
                      : applyIsCurrent
                        ? <><Cpu size={12} /> Apply failed</>
                        : <><Cpu size={12} /> Apply to Machine</>}
                </button>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', flex: 1, minWidth: 260 }}>
                  Writes steps per unit, soft limits, homing and pin assignments
                  to the connected controller. The controller's own report - every
                  line of it - goes to the machine console.
                </span>
              </div>
            </div></>
  )
}

