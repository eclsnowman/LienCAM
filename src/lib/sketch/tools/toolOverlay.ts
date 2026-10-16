// Tool overlay previews (interaction framework, MODIFY-tool UX rework).
//
// One pure entry point answering "what should the viewport draw OVER the
// sketch for the armed tool at this cursor position?" — three channels:
//
//   removal   geometry a click/swipe is about to REMOVE (trim hover and
//             swipe highlights; rendered in the removal color)
//   ghosts    geometry the flow WILL create (extend landings, fillet
//             arcs, offsets, mirrored copies, pattern instances;
//             rendered in the shared ghost style: dimmed + dashed)
//   warnings  spots that cannot resolve at the current values (fillet
//             corners the radius does not fit; warning markers)
//
// PURE module following the toolMachine doctrine: no store, no three.js,
// no DOM. Built from the SAME geometry helpers the commits use, so every
// preview is exactly what the commit produces (preview-equals-commit
// invariant — the tests assert it per tool).

import type {
  Vec2,
  SketchEntity,
  SketchConstraint,
  SketchDimension,
} from '../types'
import type { ToolState } from './toolMachine'
import { trimHighlight, type SketchDoc } from './trimTool'
import { extendPreview } from './extendTool'
import { filletChainPreview } from './filletTool'
import { chamferChainPreview } from './chamferTool'
import { offsetPreview } from './offsetTool'
import { mirrorAxisCandidate, mirrorEntities } from './mirrorTool'
import {
  linearPatternPreview, circularPatternPreview, pathPatternPreview,
} from './patternTools'
import { transformPreviewEntities } from './transformTools'
import { resolveDimPlacement, type DimPlacementResult } from './dimPlacement'
import {
  arcSamplePoints,
  circleSamplePoints,
  GHOST_ARC_DENSITY,
  GHOST_CIRCLE_DENSITY,
} from '../sketcher/geometry/arcTessellation'
import { tessellateEllipse, tessellateEllipticalArc } from '../ellipse'
import { tessellateSpline, SPLINE_TESS_STEP_MM } from '../spline'
import { splineControlPolygonPreview, bezierHandlePreview, conicConstructionPreview } from './splineTools'

export interface ToolOverlay {
  /** Spans a click/swipe would REMOVE (removal color, solid). */
  removal?: Vec2[][]
  /** Polylines the flow WILL create (ghost style: dimmed + dashed). */
  ghosts?: Vec2[][]
  /** Warning marker positions (corners that cannot resolve). */
  warnings?: Vec2[]
  /** STAGED/selected point positions (fillet corners accumulated for the
   *  batch apply) — rendered as selection rings so the user can see
   *  exactly which corners are in the set before Apply. */
  markers?: Vec2[]
  /** Dimension guide polylines (solid, dimension color) — the live
   *  angle ARC + its extension lines while a two-line angle dimension is
   *  being placed. Drawn like a committed dimension's leader so the
   *  preview matches the placed result. */
  dimGuides?: Vec2[][]
  /** Retain semantic placement for camera-sized painting. Pure callers can
   *  still inspect dimGuides; only the painter knows the current screen scale. */
  dimPlacement?: { entities: readonly SketchEntity[]; placement: DimPlacementResult }
}

/** Document + parameter context the overlay may need (superset across
 *  tools; each case reads only what it uses). */
export interface ToolOverlayCtx {
  entities: readonly SketchEntity[]
  constraints?: readonly SketchConstraint[]
  dimensions?: readonly SketchDimension[]
  selectedIds?: readonly string[]
  filletRadius?: number
  chamferSetback?: number
  offsetDistance?: number
  linearPatternCount?: number
  circularPatternCount?: number
  circularPatternStepRad?: number
  /** Ortho-lock (Shift) anchor for the in-progress DRAW chain. Set only
   *  while Shift is held over a lockable tool; null/undefined = free
   *  drawing. When present the overlay draws a guide line along the locked
   *  direction as the "direction is locked" cue. */
  orthoLockAnchor?: Vec2 | null
}

/** Guide RAY along the locked ortho direction. It starts AT the anchor (the
 *  kept start point) and runs through the locked cursor, with a small stub
 *  past the cursor so it reads as a direction axis. It never extends BEHIND
 *  the anchor — extending both ways made the start point look like it would
 *  not be kept (the reported T2 bug). Null when there is no direction yet. */
function orthoLockGuide(anchor: Vec2, cursor: Vec2): Vec2[] | null {
  const dx = cursor.x - anchor.x
  const dy = cursor.y - anchor.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  const ux = dx / len
  const uy = dy / len
  const fwd = 0.25 * len // a small stub past the cursor
  return [
    { x: anchor.x, y: anchor.y },
    { x: cursor.x + ux * fwd, y: cursor.y + uy * fwd },
  ]
}

function docOf(ctx: ToolOverlayCtx): SketchDoc {
  return {
    entities: [...ctx.entities],
    constraints: [...(ctx.constraints ?? [])],
    dimensions: [...(ctx.dimensions ?? [])],
  }
}

// ---- Entity outlines (ghost tessellation) -----------------------------------------

/** Tessellated outline of an entity for ghost rendering, or null for
 *  kinds with no outline. */
export function entityOutline(e: SketchEntity): Vec2[] | null {
  switch (e.kind) {
    case 'line':
      return [{ ...e.start }, { ...e.end }]
    // WO SKC-14 (BK-88): ghost outlines no longer walk their own sweep -- the one
    // tessellator (sketcher/geometry/arcTessellation.ts) does it, under the same
    // chord-length density these private loops used.
    case 'circle':
      return circleSamplePoints(e.center, e.radius, GHOST_CIRCLE_DENSITY)
    case 'arc':
      return arcSamplePoints(e, GHOST_ARC_DENSITY)
    case 'point': {
      // Tiny diamond so a mirrored/patterned point still ghosts.
      const r = 0.6
      const { x, y } = e.at
      return [
        { x: x + r, y }, { x, y: y + r }, { x: x - r, y }, { x, y: y - r }, { x: x + r, y },
      ]
    }
    case 'ellipse':
      return tessellateEllipse(e)
    case 'elliptical-arc':
      return tessellateEllipticalArc(e, e.startParam, e.endParam)
    case 'spline':
      return tessellateSpline(e.points, e.closed, SPLINE_TESS_STEP_MM, e.form)
    case 'text':
      // Multi-stroke geometry has no single outline; mirror/pattern ghosts of
      // text are skipped in v1 (returning null leaves them un-previewed).
      return null
    case 'block':
      // A block has no single outline (it is many member curves); its ghost is
      // skipped in v1 (mirror/pattern of a block is out of scope).
      return null
  }
}

function outlinesOf(entities: readonly SketchEntity[]): Vec2[][] {
  const out: Vec2[][] = []
  for (const e of entities) {
    const o = entityOutline(e)
    if (o && o.length >= 2) out.push(o)
  }
  return out
}

/**
 * Overlay for the armed tool at the cursor, or null when there is
 * nothing to show. `tol` is the pick tolerance in world mm (same value
 * the click uses).
 */
export function toolOverlay(
  state: ToolState, cursor: Vec2, tol: number, ctx: ToolOverlayCtx,
): ToolOverlay | null {
  // Ortho-lock cue (Shift while drawing): a guide RAY from the anchor along
  // the locked direction. The cursor is ALREADY the locked point (the
  // viewport locks before snap), so the guide passes through it. The store
  // feeds orthoLockAnchor only when the CURRENT step is a direction step
  // (orthoAnchor non-null) for ANY draw tool — line, rect, ellipse, slot,
  // arc-slot, polygon — so every locked tool shows the same cue. The rubber
  // band still shows the shape; this guide makes the LOCK explicit. Preview
  // === commit: both use the locked cursor.
  if (ctx.orthoLockAnchor) {
    const guide = orthoLockGuide(ctx.orthoLockAnchor, cursor)
    if (guide) return { dimGuides: [guide] }
  }
  switch (state.tool) {
    case 'smart-dimension': {
      // Live leader/witness preview for the accumulated operand set as the
      // cursor moves: the SAME resolveDimPlacement the click commits, so
      // the dropped dimension matches the preview (orientation auto-pick
      // included). Linear two-point/line sets follow the drag into
      // aligned / horizontal / vertical; point+line and parallel lines
      // preview their point-to-line witness; two lines the angle arc;
      // circle/arc the radius/diameter leader. Incomplete sets show no
      // witness (only the cursor TEXT via dimPreview / SketchDimensionOverlay).
      if (state.chain?.kind !== 'dim') return null
      const placement = resolveDimPlacement(
        ctx.entities, state.chain.operandIds, cursor,
        { forceOrientation: state.chain.forceMode ?? null, clampInitial: true },
      )
      return placement && placement.guides.length > 0
        ? { dimGuides: placement.guides, dimPlacement: { entities: ctx.entities, placement } }
        : null
    }
    case 'trim': {
      // Hovering with trim armed highlights the EXACT span the click
      // would remove (swipe highlights route through trimSwipeHighlights
      // via the store's swipe-overlay action, not this cursor path).
      const removal = trimHighlight(docOf(ctx), cursor, tol)
      return removal ? { removal } : null
    }
    case 'extend': {
      // Step 2 ghost: the extension the cursor direction selects — the
      // SAME resolveExtend the click commits through.
      if (state.chain?.kind !== 'extend') return null
      const ghost = extendPreview(state.chain, docOf(ctx), cursor)
      return ghost ? { ghosts: [ghost] } : null
    }
    case 'fillet': {
      // Every staged corner previews its arc at the CURRENT radius
      // (same filletLines construction Apply uses); corners the radius
      // does not fit show a warning marker instead. Every staged corner
      // ALSO gets a selection-ring marker at the corner point itself so
      // the accumulated set reads at a glance.
      if (state.chain?.kind !== 'fillet' || state.chain.corners.length === 0) return null
      const pv = filletChainPreview(state.chain, docOf(ctx), ctx.filletRadius ?? 2)
      if (pv.arcs.length === 0 && pv.warnings.length === 0 && pv.corners.length === 0) return null
      return { ghosts: pv.arcs, warnings: pv.warnings, markers: pv.corners }
    }
    case 'chamfer': {
      // Every staged corner previews its chamfer line at the CURRENT
      // setback (same chamferLines construction Apply uses); corners the
      // setback does not fit show a warning marker instead. Every staged
      // corner ALSO gets a selection-ring marker at the corner point
      // itself so the accumulated set reads at a glance (same treatment
      // as fillet — SKC-50).
      if (state.chain?.kind !== 'chamfer' || state.chain.corners.length === 0) return null
      const pv = chamferChainPreview(state.chain, docOf(ctx), ctx.chamferSetback ?? 2)
      if (pv.lines.length === 0 && pv.warnings.length === 0 && pv.corners.length === 0) return null
      return { ghosts: pv.lines, warnings: pv.warnings, markers: pv.corners }
    }
    case 'offset': {
      // Unlocked: the ghost follows the cursor's side live. Locked: the
      // ghost shows the locked side at the CURRENT distance (overlay
      // edits re-render it). Same computeOffset the OK commits through.
      if (state.chain?.kind !== 'offset') return null
      const ghost = offsetPreview(state.chain, cursor, ctx.offsetDistance ?? 2)
      return ghost ? { ghosts: [ghost] } : null
    }
    case 'mirror': {
      // Hovering a candidate axis line previews the mirrored copies —
      // the SAME mirrorEntities the click commits through.
      const chain = state.chain?.kind === 'mirror' ? state.chain : null
      const cand = mirrorAxisCandidate(
        chain, ctx.entities, ctx.selectedIds ?? [], cursor, tol)
      if (!cand) return null
      let id = 0
      const r = mirrorEntities(ctx.entities, cand.ids, cand.axisId, () => `__mg${id++}__`)
      if (typeof r === 'string') return null
      const ghosts = outlinesOf(r.entities)
      return ghosts.length > 0 ? { ghosts } : null
    }
    case 'pattern-linear': {
      // Confirmed set + anchor: ghost instances from the anchor toward
      // the cursor (or along the locked vector) at the live count.
      if (state.chain?.kind !== 'linpat') return null
      const ghostEnts = linearPatternPreview(
        state.chain, ctx.entities, cursor, ctx.linearPatternCount ?? 3)
      if (!ghostEnts) return null
      const ghosts = outlinesOf(ghostEnts)
      return ghosts.length > 0 ? { ghosts } : null
    }
    case 'pattern-circular': {
      // Confirmed set: a live ghost ring about the cursor until the
      // center locks, then about the locked center at the live
      // count/angle.
      if (state.chain?.kind !== 'circpat') return null
      const ghostEnts = circularPatternPreview(
        state.chain, ctx.entities, cursor,
        ctx.circularPatternCount ?? 4,
        ctx.circularPatternStepRad ?? (2 * Math.PI) / (ctx.circularPatternCount ?? 4),
      )
      if (!ghostEnts) return null
      const ghosts = outlinesOf(ghostEnts)
      return ghosts.length > 0 ? { ghosts } : null
    }
    case 'pattern-path': {
      // Path locked (or being re-picked): the ghost shows all `count`
      // instances at the live spacing/orientation — the SAME
      // pathPatternTransformAt the OK commits through.
      if (state.chain?.kind !== 'pathpat') return null
      const ghostEnts = pathPatternPreview(state.chain, ctx.entities)
      if (!ghostEnts) return null
      const ghosts = outlinesOf(ghostEnts)
      return ghosts.length > 0 ? { ghosts } : null
    }
    case 'move':
    case 'rotate':
    case 'scale': {
      // Placement pending: the ghost follows the cursor; placed: the ghost
      // sits at the overlay values (same transformEntity the OK commits).
      if (state.chain?.kind !== 'transform') return null
      const ghostEnts = transformPreviewEntities(state.chain, ctx.entities, cursor)
      if (!ghostEnts) return null
      const ghosts = outlinesOf(ghostEnts)
      return ghosts.length > 0 ? { ghosts } : null
    }
    case 'spline-control': {
      // WO-1861: while placing control points, the control polygon (placed
      // points + the cursor as the provisional next one) is the ghost and the
      // placed points are markers -- the rubber band itself (toolPreview) is
      // the curve those points pull into shape.
      if (state.chain?.kind !== 'spline') return null
      const polygon = splineControlPolygonPreview(state.chain, cursor, false, tol)
      if (!polygon) return null
      return { ghosts: [polygon], markers: state.chain.points.map((p) => ({ x: p.x, y: p.y })) }
    }
    case 'bezier': {
      // WO-1862: every placed anchor's handle legs plus the handle being
      // dragged right now are the ghosts; anchors and handle tips are the
      // markers. The rubber band (toolPreview) is the curve they shape.
      if (state.chain?.kind !== 'spline') return null
      const h = bezierHandlePreview(state.chain, cursor, false, tol)
      if (h.legs.length === 0 && h.markers.length === 0) return null
      return { ghosts: h.legs, markers: h.markers }
    }
    case 'conic': {
      // WO-1863: once the end is placed, the cursor is the apex -- the two
      // apex legs and the median the shoulder sits on are the ghosts; start,
      // shoulder and end are the markers. The rubber band (toolPreview) is
      // the arc itself.
      if (state.chain?.kind !== 'conic') return null
      const c = conicConstructionPreview(state.chain, cursor)
      return c ? { ghosts: c.legs, markers: c.markers } : null
    }
    // NOTE 'text' deliberately has NO overlay case: the WYSIWYG workflow
    // (click places an EMPTY entity and the user types in place) has no
    // string to preview -- the old toolbox-string ghost followed the cursor
    // and read as a floating duplicate of the live-typed text. The armed
    // tool's crosshair cursor is the placement affordance.
    default:
      return null
  }
}
