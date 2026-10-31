import { useText } from '../../i18n'
import { fmtMachineLength, unitLabel, type Units } from '../../lib/ui/unitFormat'
import type { InsightRange, ProgramInsightFacts } from '../../lib/gcode/programInsight'

/** Read-only facts used by the shared Notes and Insight panel.  The panel owns
 * disclosure so setup notes and the loaded program never need separate buttons. */
export function ProgramInsightDetails({ facts, estimatedMs, units }: {
  facts: ProgramInsightFacts
  estimatedMs: number | null
  units: Units
}) {
  const t = useText('control-screens-not-probing')
  const unknown = t('ProgramInsight.unknown')
  const showRange = (value: InsightRange, scale = 1) => value === null ? unknown
    : value.min === value.max ? String(Number((value.min / scale).toFixed(3)))
      : `${Number((value.min / scale).toFixed(3))} - ${Number((value.max / scale).toFixed(3))}`
  const rows = [
    [t('ProgramInsight.feed'), `${showRange(facts.feedMmMin, units === 'inch' ? 25.4 : 1)}${facts.feedMmMin ? ` ${unitLabel(units)}/min` : ''}`],
    [t('ProgramInsight.spindle'), `${showRange(facts.spindleRpm)}${facts.spindleRpm ? ' RPM' : ''}`],
    [t('ProgramInsight.tools'), [...facts.tools.map((tool) => `T${tool}`), ...(facts.toolsUnknown ? [unknown] : [])].join(', ') || unknown],
    [t('ProgramInsight.bounds'), facts.bounds
      ? (['x', 'y', 'z'] as const).map((axis) => `${axis.toUpperCase()} ${fmtMachineLength(facts.bounds!.min[axis], units)} - ${fmtMachineLength(facts.bounds!.max[axis], units)}`).join(' / ') + ` ${unitLabel(units)}` : unknown],
    [t('ProgramInsight.time'), estimatedMs !== null && Number.isFinite(estimatedMs) && estimatedMs >= 0
      ? t('ProgramInsight.minutes', { value: Number((estimatedMs / 60000).toFixed(1)) }) : unknown],
  ]
  return <div data-testid="program-insight-body" role="region" aria-label={t('ProgramInsight.title')}>
    <dl style={{ margin: 0, display: 'grid', gap: 8 }}>
      {rows.map(([label, value]) => <div key={label}>
        <dt style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{label}</dt>
        <dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{value}</dd>
      </div>)}
    </dl>
    <p style={{ margin: '10px 0 0', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{t('ProgramInsight.note')}</p>
  </div>
}
