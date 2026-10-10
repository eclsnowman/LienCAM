import { NumericInput } from '../../ui/NumericInput'
import type { SketchBlockEntity } from '../../../lib/sketch/types'

interface BlockPropertiesRowProps {
  /** The single selected block, or null when the current selection is not
   *  exactly one block -- the row renders nothing in that case. */
  block: SketchBlockEntity | null
  onSetScale(scale: number): void
  onSetRotationDeg(deg: number): void
}

/**
 * SKC-BLOCKS Stage 2: typed SCALE + ROTATION fields for the selected block.
 *
 * Both are DIRECT-EDIT INERT values (ADR-0033 pattern; see blocks.ts
 * setBlockScale/setBlockRotationDeg) -- scale/rotation are plain fields on
 * SketchBlockEntity (types.ts), not gcs constraints and not dimension-backed
 * like the ellipse's majorRadius, so this row writes them straight through
 * the host's own block-mutation path with no solver involvement.
 *
 * SHARED by BOTH sketcher hosts (mounted from SketchToolbox.tsx / CAM and
 * WorkbenchToolRail.tsx / Part) so the value contract, labels, and units can
 * never diverge between them -- only the mutation wiring differs per host
 * (CAM's store action vs the workbench's port method), the same split every
 * other selection-driven action in this package already uses (compare the
 * Delete button, wired to deleteSketchSelection in one host and
 * workbenchOverlaysPort.deleteSelection() in the other).
 *
 * Scale is a positive, unitless multiplier of the block's LOCAL frame about
 * its origin (Q-66 / plan sec 8.2: one typed factor, no independent X/Y, no
 * free-drag in v1). Rotation is CCW degrees about the origin, converted
 * to/from the entity's stored radians at this boundary -- the same
 * deg<->rad convention `setSketchTextRotation` already uses.
 *
 * LOCKED (fix-anchored) blocks stay editable here on purpose: a block's
 * `fix` pins its origin POSITION (SKC-BLOCKS Stage 3's imported-block lock),
 * not its definition. Scale/rotation are definition edits, not placement
 * edits, so they are never gated by the lock -- the conservative reading of
 * the plan where it does not spell this out explicitly.
 */
export function BlockPropertiesRow({ block, onSetScale, onSetRotationDeg }: BlockPropertiesRowProps) {
  if (!block) return null
  const rotationDeg = (block.rotation * 180) / Math.PI
  return (
    <div className="tree-section" data-testid="block-properties-row">
      <div className="tree-section-header">
        <span>Block{block.name ? `: ${block.name}` : ''}</span>
      </div>
      <div className="sketch-snap-settings">
        <label
          className="sketch-snap-spacing"
          data-tooltip="Uniform scale factor of the block's members about its origin (no independent X/Y in v1)"
        >
          <span>Scale (x)</span>
          <NumericInput
            className="block-scale-input"
            min={0.001}
            step={0.1}
            value={block.scale}
            onChange={onSetScale}
          />
        </label>
        <label
          className="sketch-snap-spacing"
          data-tooltip="Rotation of the block's members about its origin, in degrees CCW"
        >
          <span>Rotation (deg)</span>
          <NumericInput
            className="block-rotation-input"
            step={15}
            value={rotationDeg}
            onChange={onSetRotationDeg}
          />
        </label>
      </div>
    </div>
  )
}
