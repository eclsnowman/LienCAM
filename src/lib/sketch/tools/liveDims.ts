// Live draw dimensions: while a rubber-band shape tool is
// mid-draw, small DISPLAY-ONLY numeric labels sit just OUTSIDE the dragged
// shape, centered on their edge — a rectangle shows W outside its top edge
// and H outside its left edge, an ellipse shows its live major/minor radii
// outside the axis vertices. They are
// never inputs (the typed-value flow stays SketchDrawValueInput) and they
// vanish the moment the chain commits or cancels (chain -> null).
//
// PURE module (no store, no DOM, no three.js): the overlay component
// (SketchLiveDimsOverlay) calls liveDrawLabels per frame with the live chain
// + cursor and renders/positions the results. Built from the SAME geometry
// helpers the click commit uses (rectCorners / rotatedRectCorners /
// ellipseFromClicks), so the shown numbers always match what the next click
// commits.

import type { Vec2 } from '../types'
import type { ToolChainState } from './toolMachine'
import { rectCorners, rotatedRectCorners } from './rectTools'
import { ellipseFromClicks } from './ellipseTools'
import { ellipsePointAt } from '../ellipse'
import { toDisplay, type Units } from '../../ui/unitFormat'

/** One live label: world anchor (a point ON the shape edge, at the edge
 *  midpoint / axis vertex) + formatted text + `out`, a world-space UNIT
 *  vector pointing OUTWARD — away from the shape interior. The overlay maps
 *  `out` through worldToScreen and steps a constant screen-pixel gap along
 *  it, so the label sits just outside the shape, centered on its edge, no
 *  matter how the sketch view is rotated, flipped, or zoomed.
 *  `key` is a stable slot id ('w' | 'h' | 'l' | 'a' | 'b') the overlay uses
 *  to mutate the matching DOM node per frame without a React re-render. */
export interface LiveDimLabel {
  key: 'w' | 'h' | 'l' | 'a' | 'b'
  at: Vec2
  text: string
  out: Vec2
}

/** Every slot key a chain kind can produce (the overlay renders one DOM node
 *  per slot and toggles visibility per frame). */
export function liveDimSlots(kind: 'rect' | 'ellipse' | 'ellipse-arc'): LiveDimLabel['key'][] {
  return kind === 'rect' ? ['w', 'h', 'l'] : ['a', 'b']
}

/** mm -> display-units text, same precision family as the committed dimension
 *  labels (formatDimensionValue: 2dp mm / 4dp inch) but with trailing-zero
 *  noise trimmed — these labels flicker per frame, brevity wins. */
export function formatLiveDim(valueMm: number, units: Units): string {
  return String(+toDisplay(valueMm, units).toFixed(units === 'inch' ? 4 : 2))
}

const mid = (p: Vec2, q: Vec2): Vec2 => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })

/** Unit-length copy of v (fallback = world +y for a degenerate zero vector,
 *  so a label never loses its offset entirely). */
const unit = (v: Vec2): Vec2 => {
  const m = Math.hypot(v.x, v.y)
  return m > 0 ? { x: v.x / m, y: v.y / m } : { x: 0, y: 1 }
}

/** Unit perpendicular of the segment p->q (left side). Used for bare
 *  rubber-band SEGMENTS (rotated-rect first edge, ellipse major axis) where
 *  no interior exists yet — either side is "outside", we pick one stably. */
const perpOf = (p: Vec2, q: Vec2): Vec2 => unit({ x: -(q.y - p.y), y: q.x - p.x })

/** Outward direction for a label anchored at edge-midpoint `at` of a shape
 *  with the given centroid: straight away from the centroid. For a rectangle
 *  the edge midpoint minus the centroid IS the edge's outward perpendicular.
 *  Falls back to `fallback` when the anchor sits ON the centroid (degenerate
 *  zero-width phase). */
function awayFromCentroid(at: Vec2, centroid: Vec2, fallback: Vec2): Vec2 {
  const v = { x: at.x - centroid.x, y: at.y - centroid.y }
  return Math.hypot(v.x, v.y) > 1e-9 ? unit(v) : fallback
}

/** Drop any label whose anchor or value went non-finite (a degenerate frame
 *  mid-gesture must never paint "NaN" — ADR-0003 spirit: handle explicitly,
 *  show nothing rather than garbage). */
function finiteOnly(labels: LiveDimLabel[]): LiveDimLabel[] {
  return labels.filter(
    (l) => Number.isFinite(l.at.x) && Number.isFinite(l.at.y) && !l.text.includes('NaN'),
  )
}

/**
 * The live dimension labels for the in-progress chain at the current cursor,
 * or [] when the active tool phase has nothing to show. Covered:
 *   - rect (corner + center): live W centered on and OUTSIDE the top edge,
 *     H centered on and outside the left edge
 *   - rect ROTATED (Tab mode): first-edge length while rubber-banding it,
 *     then edge length + width once the edge is fixed
 *   - ellipse / elliptical-arc: major radius while rubber-banding the major
 *     axis, then live a (major vertex) + b (minor co-vertex) labels while the
 *     minor radius follows the cursor; the arc's param-pick phases show
 *     nothing (the ellipse is already fixed)
 */
export function liveDrawLabels(
  chain: ToolChainState | null, cursor: Vec2, units: Units,
): LiveDimLabel[] {
  if (!chain) return []
  const f = (v: number) => formatLiveDim(v, units)

  switch (chain.kind) {
    case 'rect': {
      if (!chain.anchor) return [] // Tab-staged rotated chain, pre-click1
      if (chain.rotated) {
        if (!chain.edgeEnd) {
          // Rubber-banding the first edge: its live length at the midpoint,
          // offset perpendicular to the segment (no interior exists yet).
          const len = Math.hypot(cursor.x - chain.anchor.x, cursor.y - chain.anchor.y)
          if (len <= 0) return []
          return finiteOnly([
            {
              key: 'l', at: mid(chain.anchor, cursor), text: f(len),
              out: perpOf(chain.anchor, cursor),
            },
          ])
        }
        // Width phase: first-edge length + live width, each centered on its
        // edge and offset along the OUTWARD perpendicular (edge midpoint ->
        // away from the rect centroid).
        const c = rotatedRectCorners(chain.anchor, chain.edgeEnd, cursor)
        const len = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y)
        const wid = Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)
        const centroid = {
          x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
          y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
        }
        const lMid = mid(c[0], c[1])
        const out: LiveDimLabel[] = [
          {
            key: 'l', at: lMid, text: f(len),
            out: awayFromCentroid(lMid, centroid, perpOf(c[0], c[1])),
          },
        ]
        if (wid > 0) {
          const wMid = mid(c[1], c[2])
          out.push({
            key: 'w', at: wMid, text: f(wid),
            out: awayFromCentroid(wMid, centroid, perpOf(c[1], c[2])),
          })
        }
        return finiteOnly(out)
      }
      // Axis-aligned (corner + center variants reduce to the same corner pair).
      const { a, b } = rectCorners(chain, cursor)
      const w = Math.abs(b.x - a.x)
      const h = Math.abs(b.y - a.y)
      if (w <= 0 && h <= 0) return []
      const top = Math.max(a.y, b.y)
      const left = Math.min(a.x, b.x)
      return finiteOnly([
        // W centered on the TOP edge (max-Y), pushed outward = world +y;
        // H centered on the LEFT edge (min-X), pushed outward = world -x.
        // min/max make this hold for ANY drag direction (up-left included).
        { key: 'w', at: { x: (a.x + b.x) / 2, y: top }, text: f(w), out: { x: 0, y: 1 } },
        { key: 'h', at: { x: left, y: (a.y + b.y) / 2 }, text: f(h), out: { x: -1, y: 0 } },
      ])
    }
    case 'ellipse':
    case 'ellipse-arc': {
      // Param-pick phases of the arc: the ellipse is fixed, nothing live.
      if (chain.kind === 'ellipse-arc' && chain.minor) return []
      if (!chain.major) {
        // Rubber-banding the major axis: its live radius at the midpoint,
        // offset perpendicular to the segment (no outline exists yet).
        const a = Math.hypot(cursor.x - chain.center.x, cursor.y - chain.center.y)
        if (a <= 0) return []
        return finiteOnly([
          {
            key: 'a', at: mid(chain.center, cursor), text: f(a),
            out: perpOf(chain.center, cursor),
          },
        ])
      }
      // Minor phase: the EXACT shape the next click commits. Each radius
      // label anchors at its axis VERTEX and pushes radially outward
      // (vertex - center), which is exactly OUTSIDE the outline there.
      const shape = ellipseFromClicks(chain.center, chain.major, cursor)
      if (shape.majorRadius <= 0) return []
      const aVert = ellipsePointAt(shape, 0)
      const labels: LiveDimLabel[] = [
        {
          key: 'a', at: aVert, text: f(shape.majorRadius),
          out: unit({ x: aVert.x - shape.center.x, y: aVert.y - shape.center.y }),
        },
      ]
      if (shape.minorRadius > 0) {
        const bVert = ellipsePointAt(shape, Math.PI / 2)
        labels.push({
          key: 'b', at: bVert, text: f(shape.minorRadius),
          out: unit({ x: bVert.x - shape.center.x, y: bVert.y - shape.center.y }),
        })
      }
      return finiteOnly(labels)
    }
    default:
      return []
  }
}
