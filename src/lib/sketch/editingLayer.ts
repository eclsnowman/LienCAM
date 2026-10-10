// Which 2D layer's BAKED loops must be hidden in the viewport right now?
//
// USER BUG (2026-06-11): re-editing a finished sketch and deleting a line
// left the line visible until the next Finish. The ghost was the layer's
// stale baked loop rendering under the live sketch (enterSketchView keeps
// imported/baked 2D geometry visible as reference). While a document is
// OPEN in sketch mode, the live sketch entities are the truth for ITS
// layer — that layer's baked rendering must be hidden; every OTHER layer
// stays visible as reference geometry.
//
// Pure predicate over store state so it is headless-testable and the
// Viewport subscription stays a primitive (string | null) selector.

import type { Sketch } from './types'

export function sketchEditingLayerId(s: {
  viewer: { mode: string }
  activeSketch: Sketch | null
}): string | null {
  return s.viewer.mode === 'sketch' && s.activeSketch ? s.activeSketch.layerId : null
}
