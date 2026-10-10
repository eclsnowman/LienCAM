import { overviewFacts, type OverviewFacts } from '../../../lib/machine/overviewFacts'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'

// WO-1688 - the Overview tab: five read-only cards stating the machine in
// plain words. v2/SLICES.md T5 (Q2). Every line comes from `overviewFacts`,
// the one pure read over the machine record - this component only lays the
// lines out, so it can never say something the record does not.

const CARDS: { key: keyof OverviewFacts; title: string }[] = [
  { key: 'machine', title: 'Machine' },
  { key: 'spindle', title: 'Spindle' },
  { key: 'outputs', title: 'Outputs & coolant' },
  { key: 'probing', title: 'Probing' },
  { key: 'controller', title: 'Controller' },
]

type OverviewCardsProps = Pick<MachineDefinitionPanelState, 'draft' | 'setSection'>

export function OverviewCards({ draft, setSection }: OverviewCardsProps) {
  const facts = overviewFacts(draft)
  return (
    <div
      data-testid="machine-def-overview"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}
    >
      {CARDS.map(({ key, title }) => (
        <div
          key={key}
          data-testid={`machine-def-overview-card-${key}`}
          style={{
            display: 'flex', flexDirection: 'column', gap: 6, padding: 12,
            border: '1px solid var(--border)', borderRadius: 6,
          }}
        >
          <div style={{
            fontSize: 'var(--font-size-sm)', fontWeight: 600, letterSpacing: '0.04em',
            color: 'var(--text-secondary)', textTransform: 'uppercase',
          }}
          >
            {title}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
            {facts[key].map((line) => (
              <span
                key={line}
                data-testid={`machine-def-overview-line-${key}`}
                style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}
              >
                {line}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="control-chip-btn"
            data-testid={`machine-def-overview-open-${key}`}
            style={{ alignSelf: 'flex-start' }}
            onClick={() => { setSection(key) }}
          >
            Open
          </button>
        </div>
      ))}
    </div>
  )
}
