import { useText } from '../../../i18n'
import type { Units } from '../../../lib/ui/unitFormat'
import { fmtDim, unitLabel } from '../../../lib/ui/unitFormat'
import { measureSketchSelection } from '../../../lib/sketch/measureSelection'
import type { Sketch } from '../../../lib/sketch/types'

export interface SketchMeasureReadoutProps {
  sketch: Sketch | null
  selectedIds: readonly string[]
  displayUnits: Units
  testId?: string
}

/**
 * Host-neutral sketch Measure presentation. CAM and Model supply their own
 * live document and selection; only the open/closed flag is shared by the
 * store-free Sketcher package.
 */
export function SketchMeasureReadout({
  sketch,
  selectedIds,
  displayUnits,
  testId = 'sketch-measure-readout',
}: SketchMeasureReadoutProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const measurement = sketch
    ? measureSketchSelection(sketch.entities, selectedIds)
    : null

  return (
    <div className="sketch-measure-readout" data-testid={testId}>
      {measurement ? (
        <>
          <div className="sketch-measure-title">{measurement.title}</div>
          {measurement.references && measurement.references.length > 0 ? (
            <div className="sketch-measure-row sketch-measure-reference" data-testid="sketch-measure-reference">
              <span>{workbenchText('SketchMeasureReadout.reference')}</span>
              <strong>{measurement.references.map((ref) => ref.label).join(workbenchText('SketchMeasureReadout.to'))}</strong>
            </div>
          ) : null}
          {measurement.values.map((item) => (
            <div className="sketch-measure-row" key={item.label}>
              <span>{item.label}</span>
              <strong>
                {item.kind === 'length'
                  ? `${fmtDim(item.value, displayUnits)} ${unitLabel(displayUnits)}`
                  : item.kind === 'angle'
                    ? workbenchText('SketchMeasureReadout.deg', { value1: String(item.value.toFixed(2)) })
                    : item.value}
              </strong>
            </div>
          ))}
        </>
      ) : (
        <span className="sketch-measure-empty">
          {workbenchText('SketchMeasureReadout.selectOneEntityForItsSizeOrTwoFor')}</span>
      )}
    </div>
  )
}
