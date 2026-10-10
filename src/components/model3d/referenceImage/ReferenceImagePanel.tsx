import type { ReactNode } from 'react'
import { Image } from 'lucide-react'
import type { ReferenceImagePayload } from '../../../referenceImage/referenceImage'
import { DockedPanel } from '../workbench/DockedPanel'
import { SliderRow } from '../relief/ReliefPanel'
import { NumericInput } from '../../ui/NumericInput'
import { fmtDim, parseDimToMm, unitLabel, type Units } from '../../../lib/ui/unitFormat'

export function ReferenceImagePanel({ payload, units, embedded, visibility, onPlace, onOpacity, onRename, onCalibrate, onToggleLock, onClose }: { payload: ReferenceImagePayload; units: Units; embedded?: boolean; visibility?: ReactNode; onPlace(patch: Partial<ReferenceImagePayload>): void; onOpacity(value: number): void; onRename(name: string): void; onCalibrate(): void; onToggleLock(): void; onClose(): void }) {
  const fields = <>
    {visibility}
    <div className="relief-row">
      <label className="relief-row-label" htmlFor="reference-image-name">Name</label>
      <input key={payload.name} id="reference-image-name" aria-label="Reference image name" defaultValue={payload.name}
        style={{ flex: 1, minWidth: 0 }} onBlur={(e) => onRename(e.target.value.trim() || payload.image.fileName)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
    </div>
    <SliderRow label="Opacity" testId="reference-image-opacity" value={payload.opacity * 100}
      min={0} max={100} step={1} decimals={0} unit="%" tooltip="Picture opacity (0 to 100%)"
      onChange={(n) => onOpacity(n / 100)} />
    <div className="relief-row"><span className="relief-row-label">Width</span>
      <output data-testid="reference-image-width">{fmtDim(payload.widthMm, units)} {unitLabel(units)}</output>
    </div>
    {(['x', 'y'] as const).map((axis) => <div className="relief-row" key={axis}>
      <span className="relief-row-label">{axis.toUpperCase()}</span>
      {/* Display precision belongs at the field edge; the saved/preview center retains full precision. */}
      <NumericInput ariaLabel={axis.toUpperCase()} value={parseDimToMm(fmtDim(payload.center?.[axis] ?? 0, units), units)} units={units}
        onChange={(value) => onPlace({ center: { x: payload.center?.x ?? 0, y: payload.center?.y ?? 0, [axis]: value } })} />
      <span>{unitLabel(units)}</span>
    </div>)}
    <div className="relief-row">
      <span className="relief-row-label">Angle</span>
      <NumericInput ariaLabel="Angle" value={payload.angleDeg ?? 0} onChange={(angleDeg) => onPlace({ angleDeg })} />
      <span>deg</span>
    </div>
    <label className="relief-row"><input type="checkbox" data-testid="reference-image-flip-horizontal"
      checked={payload.flipHorizontal === true} onChange={() => onPlace({ flipHorizontal: !payload.flipHorizontal })} />Flip horizontal</label>
    <label className="relief-row"><input type="checkbox" data-testid="reference-image-flip-vertical"
      checked={payload.flipVertical === true} onChange={() => onPlace({ flipVertical: !payload.flipVertical })} />Flip vertical</label>
    {!payload.scaleLocked && <button type="button" className="modal-btn modal-btn-ghost" data-testid="reference-image-calibrate" onClick={onCalibrate}>Calibrate</button>}
    <label className="relief-row">
      <input type="checkbox" data-testid="reference-image-lock-scale" checked={payload.scaleLocked === true} onChange={onToggleLock} />
      Lock scale
    </label>
  </>
  if (embedded) return <section className="reference-image2d-panel" data-testid="reference-image-palette" aria-label={`Reference image - ${payload.name}`}>
    <div className="sketch-section-heading">Reference image - {payload.name}</div>
    {fields}
    <button type="button" className="sketch-header-toggle" data-testid="reference-image-close" onClick={onClose}>Close reference image</button>
  </section>
  return <DockedPanel id="reference-image" testId="reference-image-palette" title={`Reference image - ${payload.name}`}
    icon={<Image size={16} />} width={300} onClose={onClose} closeLabel="Close reference image"
    closeTestId="reference-image-close" className="relief-palette-shell" footer={null}>{fields}</DockedPanel>
}
