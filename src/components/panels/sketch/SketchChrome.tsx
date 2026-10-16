import { useText } from '../../../i18n'
import type { MouseEventHandler } from 'react'
import { Check, Eye, EyeOff, X } from 'lucide-react'




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
  const workbenchText = useText('sketch-and-model-workbench')
  const FINISH_EMPTY_TITLE = workbenchText('SketchChrome.exitSketchModeEmptySketchIsDiscarded')
  const FINISH_WITH_GEOMETRY_TITLE =
  workbenchText('SketchChrome.bakeThisSketchToItsGeometryLayerAndExit')
  return (
    <button
      type="button"
      data-testid={testId}
      className="sketch-finish-btn"
      onClick={onClick}
      data-tooltip={hasEntities ? FINISH_WITH_GEOMETRY_TITLE : FINISH_EMPTY_TITLE}
    >
      <Check size={14} />
      <span>{workbenchText('SketchChrome.finish')}</span>
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
  const workbenchText = useText('sketch-and-model-workbench')
  return (
    <button
      type="button"
      data-testid={testId}
      className="sketch-cancel-btn"
      onClick={onClick}
      data-tooltip={workbenchText('SketchChrome.discardSketchEditsAndRestoreTheEntryState')}
    >
      <X size={14} />
      <span>{workbenchText('SketchChrome.cancel')}</span>
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
  const workbenchText = useText('sketch-and-model-workbench')
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
        ? workbenchText('SketchChrome.hideConstraintGlyphsDimensionsStayVisible')
        : workbenchText('SketchChrome.showConstraintGlyphs')}
    >
      {visible ? <Eye size={12} /> : <EyeOff size={12} />}
      <span>{workbenchText('SketchChrome.show')}</span>
    </button>
  )
}
