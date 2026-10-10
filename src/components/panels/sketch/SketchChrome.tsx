import type { MouseEventHandler } from 'react'
import { Check, Eye, EyeOff, X } from 'lucide-react'

const FINISH_WITH_GEOMETRY_TITLE =
  'Bake this sketch to its geometry layer and exit sketch mode'
const FINISH_EMPTY_TITLE = 'Exit sketch mode (empty sketch is discarded)'

interface SketchFinishButtonProps {
  hasEntities: boolean
  onClick(): void
  testId?: string
}

/** One Finish action for both sketch hosts: same label, icon, and state-aware
 * tooltip, with only the host-specific callback supplied by the consumer. */
export function SketchFinishButton({
  hasEntities,
  onClick,
  testId,
}: SketchFinishButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="sketch-finish-btn"
      onClick={onClick}
      data-tooltip={hasEntities ? FINISH_WITH_GEOMETRY_TITLE : FINISH_EMPTY_TITLE}
    >
      <Check size={14} />
      <span>Finish</span>
    </button>
  )
}

interface SketchCancelButtonProps {
  onClick(): void
  testId?: string
}

/** One cancel action for both hosts. Unlike Finish, this restores the entry
 * snapshot and exits without baking the live document. */
export function SketchCancelButton({ onClick, testId }: SketchCancelButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="sketch-cancel-btn"
      onClick={onClick}
      data-tooltip="Discard sketch edits and restore the entry state"
    >
      <X size={14} />
      <span>Cancel</span>
    </button>
  )
}

interface SketchGlyphToggleProps {
  visible: boolean
  onToggle(): void
  testId?: string
}

/** Shared constraint-glyph chip for CAM and the 3D modeling workspace. The host owns state;
 * this component owns the interaction and presentation contract. */
export function SketchGlyphToggle({
  visible,
  onToggle,
  testId,
}: SketchGlyphToggleProps) {
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    event.stopPropagation()
    onToggle()
  }

  return (
    <button
      type="button"
      data-testid={testId}
      data-sketch-header-toggle="glyphs"
      aria-pressed={visible}
      className={`sketch-header-toggle${visible ? ' sketch-header-toggle-on' : ''}`}
      onClick={handleClick}
      data-tooltip={visible
        ? 'Hide constraint glyphs (dimensions stay visible)'
        : 'Show constraint glyphs'}
    >
      {visible ? <Eye size={12} /> : <EyeOff size={12} />}
      <span>Show</span>
    </button>
  )
}
