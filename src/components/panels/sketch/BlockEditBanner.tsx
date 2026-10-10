import { Check, X } from 'lucide-react'

interface BlockEditBannerProps {
  /** The block's name, if it has one (SketchBlockEntity#name). */
  name?: string
  onFinish(): void
  onCancel(): void
}

/**
 * SKC-BLOCKS Stage 4: the block edit-in-place session banner. Shown only
 * while a block is open for edit-in-place (host: `sketchBlockEditId` non-
 * null) -- its members are detached, loose, ordinary entities the user is
 * editing with the full sketch toolset, and this is the one persistent,
 * discoverable way back out (mirrors FinishSketchButton's role for the
 * sketch session itself: Finish re-freezes, Cancel reverts).
 *
 * Presentational only -- the host owns the session cursor, undo, and the
 * Finish/Cancel semantics (finishSketchBlockEdit / cancelSketchBlockEdit);
 * this component just renders the row and forwards clicks. Reuses the same
 * `.sketch-finish-btn` / `.sketch-cancel-btn` / `.sketch-session-actions`
 * classes FinishSketchButton's row already uses (see SketchChrome.tsx +
 * app.css), so the two rows read as one family of session-exit controls.
 */
export function BlockEditBanner({ name, onFinish, onCancel }: BlockEditBannerProps) {
  return (
    <div className="tree-section" data-testid="block-edit-banner">
      <div className="tree-section-header">
        <span>Editing block{name ? `: ${name}` : ''}</span>
      </div>
      <div className="sketch-session-actions">
        <button
          type="button"
          className="sketch-finish-btn"
          onClick={onFinish}
          aria-label="Finish editing block"
          data-tooltip="Re-freeze the block with its edited members"
        >
          <Check size={14} />
          <span>Finish</span>
        </button>
        <button
          type="button"
          className="sketch-cancel-btn"
          onClick={onCancel}
          aria-label="Cancel block edit"
          data-tooltip="Discard the edit and restore the block"
        >
          <X size={14} />
          <span>Cancel</span>
        </button>
      </div>
    </div>
  )
}
