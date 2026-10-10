import { Check, SkipForward } from 'lucide-react'

// WO-1696 (v2/SLICES.md T13) - the left rail. Every step is always reachable
// by a click: rule 11 forbids a refusal, and a wizard that only lets you go
// forward is exactly that for anyone who wants to fix an earlier answer.

export type SetupStepStatus = 'pending' | 'current' | 'done' | 'skipped'

export interface SetupStepRailItem {
  key: string
  label: string
  status: SetupStepStatus
}

interface StepRailProps {
  steps: SetupStepRailItem[]
  onSelect: (index: number) => void
}

export function StepRail({ steps, onSelect }: StepRailProps) {
  return (
    <nav
      className="setup-walkthrough-rail"
      data-testid="setup-walkthrough-rail"
      aria-label="Setup steps"
      style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 190 }}
    >
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {steps.map((step, index) => (
          <li key={step.key}>
            <button
              type="button"
              className="control-chip-btn"
              data-testid={`setup-walkthrough-rail-${step.key}`}
              data-step-status={step.status}
              aria-current={step.status === 'current' ? 'step' : undefined}
              onClick={() => { onSelect(index) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                justifyContent: 'flex-start',
                fontWeight: step.status === 'current' ? 600 : 400,
              }}
            >
              <span style={{ minWidth: 14, textAlign: 'center' }}>
                {step.status === 'done'
                  ? <Check size={12} />
                  : step.status === 'skipped'
                    ? <SkipForward size={12} />
                    : index + 1}
              </span>
              {step.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
