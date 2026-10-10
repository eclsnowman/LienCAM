// WO UI-4 acceptance #6 (BK-49 rider): material assignment + mass/CoM
// readout. Presentational -- material list is a plain <select>, custom
// density a NumericInput, matching BoxSizeDialog.tsx's field idiom.

import { NumericInput } from '../../ui/NumericInput'
import { BUILTIN_MATERIALS, CUSTOM_MATERIAL_ID } from './materialDensity'
import type { MassProperties } from './massProperties'

export interface MassPropertiesPanelProps {
  bodyId: string | null
  materialId: string
  customDensityGPerCm3: number
  onMaterialChange(id: string): void
  onCustomDensityChange(value: number): void
  properties: MassProperties | null
  busy: boolean
}

export function MassPropertiesPanel({
  bodyId,
  materialId,
  customDensityGPerCm3,
  onMaterialChange,
  onCustomDensityChange,
  properties,
  busy,
}: MassPropertiesPanelProps) {
  return (
    <div
      data-testid="mass-properties-panel"
      style={{
        background: 'var(--surface-1)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 'var(--font-size-md)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 8,
        minWidth: 220,
      }}
    >
      {bodyId === null ? (
        <div style={{ color: 'var(--text-muted)' }} data-testid="mass-properties-empty">
          (pick a body)
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <select
              data-testid="mass-material-select"
              value={materialId}
              onChange={(ev) => onMaterialChange(ev.target.value)}
              style={{
                flex: 1,
                background: 'var(--surface-1)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '2px 6px',
              }}
            >
              {BUILTIN_MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value={CUSTOM_MATERIAL_ID}>Custom...</option>
            </select>
          </div>
          {materialId === CUSTOM_MATERIAL_ID && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>density</span>
              <span data-testid="mass-custom-density" style={{ flex: 1 }}>
                <NumericInput value={customDensityGPerCm3} onChange={onCustomDensityChange} min={0.001} style={{ width: '100%' }} />
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>g/cm^3</span>
            </label>
          )}
          {busy && (
            <div data-testid="mass-busy" style={{ color: 'var(--text-muted)' }}>
              computing...
            </div>
          )}
          {!busy && properties !== null && (
            <div data-testid="mass-readout">
              <div data-testid="mass-value">Mass: {properties.massGrams.toFixed(3)} g</div>
              <div data-testid="mass-volume-value">Volume: {properties.volumeMm3.toFixed(3)} mm^3</div>
              <div data-testid="mass-com-value">
                CoM: ({properties.centerOfMass.x.toFixed(3)}, {properties.centerOfMass.y.toFixed(3)}, {properties.centerOfMass.z.toFixed(3)}) mm
                {properties.centerOfMassApprox ? ' (approx, mesh-derived)' : ''}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
