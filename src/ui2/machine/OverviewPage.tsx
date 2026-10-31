// WO-3303: the Overview page: the gantry drawing, one card per area with what still needs fixing,
// and the software-side machine capabilities (moved here from Settings).
import { useText } from '../../i18n'
import { Button, Card, Pill } from '../../components/kit'
import { overviewFacts } from '../../lib/machine/overviewFacts'
import type { MachineConfig } from '../../types'
import { GantryDrawing, type HomeDirection } from './GantryDrawing'
import { capabilityRows } from './capabilities'
import type { FixingItem } from './fixing'
import { fixingCounts } from './fixing'
import type { DefinitionArea } from './windowState'

const AREAS = ['machine', 'spindle', 'outputs', 'probing', 'controller', 'allSettings'] as const
type OverviewKey = 'machine' | 'spindle' | 'outputs' | 'probing' | 'controller'
const FACT_KEY: Record<(typeof AREAS)[number], OverviewKey | null> = {
  machine: 'machine', spindle: 'spindle', outputs: 'outputs', probing: 'probing', controller: 'controller', allSettings: null,
}

function homeOf(machine: MachineConfig, axis: 'X' | 'Y'): HomeDirection {
  const dir = machine.controllerDefinition?.homing.perAxis[axis]?.direction
  return dir === 'positive' || dir === 'negative' ? dir : null
}

export interface OverviewPageProps {
  readonly machine: MachineConfig
  readonly items: readonly FixingItem[]
  readonly areaLabel: (area: DefinitionArea) => string
  open(area: DefinitionArea): void
}

export function OverviewPage({ machine, items, areaLabel, open }: OverviewPageProps) {
  const t = useText('ui2-machine.wo3303')
  const facts = overviewFacts(machine)
  const counts = fixingCounts(items)
  const rows = capabilityRows(machine, {
    notConfigured: t('capNotConfigured'),
    axisNotStated: axis => t('capAxisNotStated', { axis }),
    backOff: (order, backOff) => t('capBackOff', { order, backOff }),
    probingConfigured: t('capProbingConfigured'),
    probingNone: t('capProbingNone'),
    relays: t('capRelays'),
  })
  return (
    <div className="ui2-machine-overview" data-testid="machine-overview">
      <p className="ui2-machine-note">{t('overviewHelp')}</p>
      <div className="ui2-machine-grid">
        {AREAS.map(area => {
          const key = FACT_KEY[area]
          const n = counts[area]
          return (
            <Card
              key={area}
              testId={`machine-overview-card-${area}`}
              title={areaLabel(area)}
              status={n > 0 ? { tone: 'warn', label: t('toFix', { count: n }), testId: `machine-overview-fix-${area}` } : undefined}
              footer={{ ghost: { label: t('openArea', { area: areaLabel(area) }), onPress: () => open(area) } }}
            >
              {area === 'machine' && (
                <GantryDrawing
                  travel={machine.travel}
                  xHome={homeOf(machine, 'X')}
                  yHome={homeOf(machine, 'Y')}
                  label={t('gantryLabel', { x: machine.travel.x, y: machine.travel.y, z: machine.travel.z })}
                />
              )}
              <div className="ui2-machine-facts">
                {key !== null && facts[key].map(line => <p key={line} className="ui2-machine-fact">{line}</p>)}
              </div>
              {key === null && <p className="ui2-machine-fact">{t('allSettingsHelp')}</p>}
            </Card>
          )
        })}
      </div>
      <Card testId="machine-fixing" title={t('fixingTitle')} status={items.length > 0 ? { tone: 'warn', label: t('toFix', { count: items.length }) } : { tone: 'ok', label: t('fixingNoneShort') }}>
        {items.length === 0 && <p className="ui2-machine-note" data-testid="machine-fixing-none">{t('fixingNone')}</p>}
        <ul className="ui2-machine-fixing">
          {items.map(item => (
            <li key={item.id} data-testid="machine-fixing-item" data-area={item.area}>
              <Pill tone="warn" label={item.area === 'overview' ? areaLabel('machine') : areaLabel(item.area)} />
              <span className="ui2-machine-fixing-text">{item.text}</span>
              <Button
                kind="momentary" emphasis="ghost" testId={`machine-fixing-go-${item.id}`}
                label={t('fixingGo')}
                onPress={() => open(item.area === 'overview' ? 'machine' : item.area)}
              />
            </li>
          ))}
        </ul>
      </Card>
      <Card testId="machine-capabilities" title={t('capTitle')}>
        <table className="ui2-machine-table" data-testid="machine-capabilities-table">
          <thead><tr><th>{t('capCapability')}</th><th>{t('capDefinition')}</th><th>{t('capEnforcedBy')}</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} data-testid={`machine-capability-${r.id}`}>
                <th scope="row">{t(`cap_${r.id}`)}</th><td>{r.value}</td><td>{t('capSoftware')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
