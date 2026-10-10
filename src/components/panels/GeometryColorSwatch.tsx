import { textFor, useText } from '../../i18n'
import { useRef } from 'react'
import { useCamStore } from '../../store'
import type { ImportedGeometry } from '../../types'

const shellText = textFor('app-shell-settings-menus')

// PP-SWATCH (POST-MERGE-WORKPLAN.md PP-SELECTION-UTILITY, corrected 2026-07-26):
// the shared whole-part color swatch, ported out of DesignTree.tsx's
// handleSwatchClick/handleColorChange pair (DesignTree.tsx ~1175-1197,
// ~1824-1840 before this extraction) so BOTH the design tree's own row AND
// PropertiesPanel's imported-part action row (data-testid="geo-action-row")
// mount the SAME control -- same popup (the native <input type="color">
// picker), same handlers (updateGeometryColor + the viewport's setPartColor
// bridge), not two copies of the click-through-to-hidden-input pattern.
//
// Scope: the GEOMETRY-level (whole-part) color only -- geo.color, layerId
// null in the pre-extraction DesignTree vocabulary. DesignTree's own 2D-LAYER
// color swatches (per-layer, a materially different target) are unaffected
// and keep their own local colorInputRef/handleSwatchClick/handleColorChange
// trio for that case.
interface VpColorHandle {
  setPartColor?: (id: string, color: string) => void
}
const getVp = (): VpColorHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpColorHandle) ?? null

// 3D parts (stl/step) always show their part color; default to the
// renderer's workpiece blue (--vp-workpiece) so the swatch is populated even
// for legacy parts imported before color was stored. Pure 2D parts (dxf/svg/
// sketch) have no part-level color -> blank. Model bodies are 3D parts too
// (INT-17A) -> populated swatch (default workpiece blue) + border, like
// STL/STEP. Exported so PP and the tree read the identical default.
export function isSwatchable3dFormat(format: ImportedGeometry['format']): boolean {
  return format === 'stl' || format === 'step' || format === 'model'
}

export function GeometryColorSwatch({ geo }: { geo: ImportedGeometry }) {
  useText('app-shell-settings-menus')
  const updateGeometryColor = useCamStore((s) => s.updateGeometryColor)
  const colorInputRef = useRef<HTMLInputElement>(null)
  const is3dPart = isSwatchable3dFormat(geo.format)
  const swatchColor = geo.color ?? (is3dPart ? '#8ab4cc' : 'transparent')

  const handleSwatchClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    colorInputRef.current?.click()
  }

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const color = e.target.value
    updateGeometryColor(geo.id, color)
    getVp()?.setPartColor?.(geo.id, color)
  }

  return (
    <>
      <span
        className="tree-geo-swatch"
        data-testid="geo-color-swatch"
        style={{
          background: swatchColor,
          border: is3dPart ? undefined : 'none',
        }}
        data-tooltip={shellText('GeometryColorSwatch.clickToChangeColor')}
        onClick={handleSwatchClick}
      />
      <input
        ref={colorInputRef}
        type="color"
        value={geo.color ?? '#8ab4cc'}
        style={{ display: 'none' }}
        onChange={handleColorChange}
        data-testid="geo-color-swatch-input"
      />
    </>
  )
}
