import { useText } from '../../../../i18n'
import { entityLabels } from '../../browserModel'
import { useState } from 'react'
import { resolveCountToInteger, resolveDimInput } from '../../dimExpr'
import { validatePatternValues, type SketchPatternDefinition, type PatternValues } from '../../patterns'
import { sketcherTools } from '../toolController'
import type { SketchEntity } from '../../types'

/** Shared by CAM and Model: the existing pattern values, changed as one undo step. */
export function SketchPatternEditor({ pattern, entities, onClose }: {
  pattern: SketchPatternDefinition; entities: SketchEntity[]; onClose: () => void
}) {
  const workbenchText = useText('sketch-and-model-workbench')
  const v = pattern.values
  const labels = entityLabels(entities)
  const fields = v.kind === 'mirror' ? [] : v.kind === 'path' ? [['count', workbenchText('SketchPatternEditor.count'), v.count], ['spacing', workbenchText('SketchPatternEditor.spacing'), v.fixedSpacing]] as const : v.kind === 'transform' ? [
    ['x', workbenchText('SketchPatternEditor.centerX'), v.center.x], ['y', workbenchText('SketchPatternEditor.centerY'), v.center.y],
    ['shiftX', workbenchText('SketchPatternEditor.moveX'), v.shift.x], ['shiftY', workbenchText('SketchPatternEditor.moveY'), v.shift.y],
    ['angle', workbenchText('SketchPatternEditor.angle'), v.stepAngle * 180 / Math.PI], ['scale', workbenchText('SketchPatternEditor.scale'), v.scale],
  ] as const : v.kind === 'circular' ? [
    ['count', workbenchText('SketchPatternEditor.count'), v.count], ['x', workbenchText('SketchPatternEditor.centerX'), v.center.x],
    ['y', workbenchText('SketchPatternEditor.centerY'), v.center.y], ['angle', workbenchText('SketchPatternEditor.stepAngle'), v.stepAngle * 180 / Math.PI],
  ] as const : [
    ['count', workbenchText('SketchPatternEditor.columns'), v.count], ['rows', workbenchText('SketchPatternEditor.rows'), v.rows],
    ['x', workbenchText('SketchPatternEditor.columnXSpacing'), v.step.x], ['y', workbenchText('SketchPatternEditor.columnYSpacing'), v.step.y],
    ['rowX', workbenchText('SketchPatternEditor.rowXSpacing'), v.rowStep.x], ['rowY', workbenchText('SketchPatternEditor.rowYSpacing'), v.rowStep.y],
  ] as const
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(([key, , value]) => [key, pattern.expressions?.[key] ?? String(value)])))
  const [suppressed, setSuppressed] = useState([...pattern.suppressed])
  const [error, setError] = useState<string | null>(null)
  const [axisId, setAxisId] = useState(v.kind === 'mirror' ? v.axisId : '')
  const [spacingMode, setSpacingMode] = useState<'equal' | 'fixed'>(v.kind === 'path' ? v.spacingMode : 'equal')
  const [followTangent, setFollowTangent] = useState(v.kind === 'path' && v.followTangent)
  const instances = [...new Set(pattern.members.filter(m => m.column < v.count && m.row < (v.kind === 'linear' ? v.rows : 1)).map(m => `${m.column},${m.row}`))]
  function apply() {
    const parsed: Record<string, number> = {}
    for (const [key] of fields) {
      if (key === 'count' || key === 'rows') {
        const result = resolveCountToInteger(draft[key], key === 'count' ? 2 : 1)
        if (!result.ok) { setError(result.message); return }
        parsed[key] = result.count
      } else {
        const result = resolveDimInput(draft[key], key === 'angle', 'mm')
        if (!result.ok) { setError(result.message); return }
        parsed[key] = result.mm
      }
    }
    const values: PatternValues = v.kind === 'path' ? { ...v, count: parsed.count, fixedSpacing: parsed.spacing, spacingMode, followTangent } : v.kind === 'mirror' ? { kind: 'mirror', count: 2, axisId } : v.kind === 'transform'
      ? { kind: 'transform', count: 2, center: { x: parsed.x, y: parsed.y }, shift: { x: parsed.shiftX, y: parsed.shiftY }, stepAngle: parsed.angle, scale: parsed.scale } : v.kind === 'circular'
      ? { kind: 'circular', count: parsed.count, center: { x: parsed.x, y: parsed.y }, stepAngle: parsed.angle }
      : { kind: 'linear', count: parsed.count, rows: parsed.rows, step: { x: parsed.x, y: parsed.y }, rowStep: { x: parsed.rowX, y: parsed.rowY } }
    const invalid = validatePatternValues(values)
    if (invalid) { setError(invalid); return }
    sketcherTools.editSelectedPattern(values, suppressed, draft)
    onClose()
  }
  return <>
    <div className="sketch-context-overlay" onPointerDown={onClose} />
    <form className="sketch-context-menu" role="dialog" aria-label={workbenchText('SketchPatternEditor.editPattern')}
      style={{ left: '50%', top: '30%', maxHeight: '60vh', overflowY: 'auto', padding: 12 }}
      onSubmit={event => { event.preventDefault(); apply() }}>
      <strong>{workbenchText('SketchPatternEditor.editKindPattern', { kind: workbenchText(`SketchPatternEditor.${v.kind}`) })}</strong>
      {v.kind === 'mirror' && <label style={{ display: 'block' }}>{workbenchText('SketchPatternEditor.mirrorLine')}
        <select aria-label={workbenchText('SketchPatternEditor.mirrorLine')} value={axisId} onChange={event => setAxisId(event.target.value)}>
          {entities.filter(e => e.kind === 'line' && !pattern.members.some(m => m.id === e.id) && !pattern.sources.includes(e.id)).map(e => <option key={e.id} value={e.id}>{labels.get(e.id) ?? e.id}</option>)}
        </select>
      </label>}
      {v.kind === 'path' && <><label>{workbenchText('SketchPatternEditor.spacingMode')}<select aria-label={workbenchText('SketchPatternEditor.spacingMode')} value={spacingMode} onChange={e => setSpacingMode(e.target.value as 'equal' | 'fixed')}><option value="equal">{workbenchText('SketchPatternEditor.equalSpacing')}</option><option value="fixed">{workbenchText('SketchPatternEditor.fixedSpacing')}</option></select></label><label><input type="checkbox" checked={followTangent} onChange={e => setFollowTangent(e.target.checked)} />{workbenchText('SketchPatternEditor.followTangent')}</label><p>{workbenchText('SketchPatternEditor.copiesFollowSource')}</p></>}
      {fields.map(([key, label]) => <label key={key} style={{ display: 'block', marginTop: 8 }}>
        {label}<input aria-label={label} value={draft[key]} style={{ display: 'block' }}
          onChange={event => setDraft({ ...draft, [key]: event.target.value })} />
      </label>)}
      <p>{workbenchText('SketchPatternEditor.expressionHint')}</p>
      {instances.map(key => <label key={key} style={{ display: 'block' }}>
        <input type="checkbox" checked={!suppressed.includes(key)} onChange={event => setSuppressed(event.target.checked ? suppressed.filter(k => k !== key) : [...suppressed, key])} />
        {workbenchText('SketchPatternEditor.instance', { key })}
      </label>)}
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="sketch-prompt-btn sketch-prompt-btn-confirm">{workbenchText('SketchPatternEditor.apply')}</button><button type="button" className="sketch-prompt-btn" onClick={onClose}>{workbenchText('SketchPatternEditor.cancel')}</button>
    </form>
  </>
}
