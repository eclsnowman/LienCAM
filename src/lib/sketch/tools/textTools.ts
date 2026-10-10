// Single-line ENGRAVING text tool (sketch text, item C3 part A): a SINGLE-
// CLICK tool. One click places the text anchor (baseline-left origin) and
// commits ONE solver-inert text entity built from the current toolbox string
// + cap height (threaded through the ToolClickCtx). Same pure-machine
// contract as toolMachine.ts -- no document mutation here; the click returns
// a ToolCommit. There is no chain (the entity commits on the first click,
// exactly like the point tool).
//
// The committed entity is SOLVER-INERT (types.ts): the glyph geometry is
// carried verbatim (string + height) and only the anchor participates in
// later constraints, so nothing solver-specific happens at commit time.

import type { Vec2, SketchTextEntity } from '../types'
import type { ToolCommit } from './toolMachine'
import { isDegenerateText } from '../text'

/** Toolbox-supplied parameters for the text tool (live store values). */
export interface TextToolParams {
  /** The string to engrave. */
  text: string
  /** Cap height in mm (> 0). */
  height: number
  /** Baseline rotation in radians (default 0). */
  rotation?: number
  /** Face: 'single-line' (Hershey strokes) or 'outline' (TTF contours).
   *  Defaults to 'single-line'. */
  fontStyle?: 'single-line' | 'outline'
  /** OUTLINE font family (registry key). Unset -> the default M+ face. Ignored
   *  for single-line (Hershey). Carried verbatim onto the committed entity. */
  fontFamily?: string
}

/**
 * Click behavior: places the anchor and commits ONE single-line text entity
 * carrying the toolbox string + height verbatim. Returns null (rejected, no
 * commit) for DEGENERATE input -- an empty/whitespace-only string or a
 * non-positive height -- so the click is a clean no-op rather than committing
 * an invisible entity. v1 rotation defaults to 0 (horizontal baseline).
 */
export function textClick(
  world: Vec2, params: TextToolParams, construction: boolean, newId: () => string,
): ToolCommit | null {
  if (isDegenerateText(params.text, params.height)) return null
  const entity: SketchTextEntity = {
    id: newId(),
    kind: 'text',
    construction,
    at: { x: world.x, y: world.y },
    text: params.text,
    height: params.height,
    rotation: params.rotation ?? 0,
    fontStyle: params.fontStyle ?? 'single-line',
    // Carry the family only for outline text; single-line ignores it. Left
    // undefined for the default face so default text stays byte-identical.
    fontFamily: params.fontStyle === 'outline' ? params.fontFamily : undefined,
  }
  return { entities: [entity], constraints: [] }
}

// NOTE: there is deliberately NO cursor preview for the armed text tool. The
// WYSIWYG workflow (click places an EMPTY entity, the user types in place)
// has no string to ghost; the old textPreviewStrokes ghost of the toolbox
// string rendered as a floating dashed duplicate of the live-typed text.
