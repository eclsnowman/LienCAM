/**
 * Copyright 2026 Franja (Frank) Povazanj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * Modified by LienCAM, 2026: module-driven Y-up involutes, adaptive curve
 * fitting, exact circular tips/roots and tangent root fillets, native tools.
 */
import type { Loop2D, LoopSegment, Vec2 } from '../../../types'
import { optimizeLoops, sampleArc } from '../../geometry/loopOptimizer'
import { liftLoops } from '../lift'
import { wrapLiftedAsBlock } from '../blocks'
import type { SketchEntity } from '../types'
import type { ToolCommit } from './toolMachine'

export interface GearParams {
  teeth: number
  module: number
  pressureAngle: 14.5 | 20 | 25
  rootFillet: number
}
export interface GearChainState { kind: 'gear'; center: Vec2 }
export const DEFAULT_GEAR_PARAMS: GearParams = { teeth: 20, module: 2, pressureAngle: 20, rootFillet: 0.3 }
const TAU = 2 * Math.PI
const FIT_TOL = 0.002
const origin = { x: 0, y: 0 }
const polar = (r: number, a: number): Vec2 => ({ x: r * Math.cos(a), y: r * Math.sin(a) })
const roll = (t: number): number => t - Math.atan(t)
const param = (base: number, r: number): number => Math.sqrt(Math.max(0, (r / base) ** 2 - 1))
const reflect = (p: Vec2): Vec2 => ({ x: p.x, y: -p.y })

function rootContact(base: number, baseAngle: number, root: number, f: number, tTip: number) {
  const at = (t: number) => polar(base * Math.sqrt(1 + t * t), baseAngle + roll(t))
  const offset = (pt: Vec2, tangent: number): Vec2 => ({ x: pt.x + f * Math.sin(tangent), y: pt.y - f * Math.cos(tangent) })
  const radialContact = Math.sqrt(root * root + 2 * root * f)
  let tStart = 0, contact = polar(radialContact, baseAngle), filletCenter = offset(contact, baseAngle)
  if (radialContact > base) {
    let lo = 0, hi = tTip
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2, c = offset(at(mid), baseAngle + mid)
      if (Math.hypot(c.x, c.y) > root + f) hi = mid; else lo = mid
    }
    tStart = (lo + hi) / 2
    contact = at(tStart)
    filletCenter = offset(contact, baseAngle + tStart)
  }
  const rootAt = f > 0 ? polar(root, Math.atan2(filletCenter.y, filletCenter.x)) : contact
  return { tStart, contact, filletCenter, rootAt }
}

export function maxGearRootFillet(p: Pick<GearParams, 'teeth' | 'module'> & Partial<Pick<GearParams, 'pressureAngle'>>): number {
  const pitch = p.module * p.teeth / 2, root = pitch - 1.25 * p.module
  const base = pitch * Math.cos((p.pressureAngle ?? 20) * Math.PI / 180)
  const baseAngle = -Math.PI / (2 * p.teeth) - roll(param(base, pitch))
  let lo = 0, hi = Math.min(1.0125 * p.module, TAU * root / p.teeth * 0.2)
  // Preserve a real root arc between adjacent fillets. A negative gap
  // would turn that CCW arc into a nearly full circle. Also leave enough
  // gap for the shared bake endpoint tolerance, instead of a tiny loop.
  const minGap = Math.min(0.12 / root, TAU / p.teeth * 0.05)
  for (let i = 0; i < 40; i++) {
    const f = (lo + hi) / 2
    const c = rootContact(base, baseAngle, root, f, param(base, pitch + p.module))
    const gap = TAU / p.teeth + 2 * Math.atan2(c.rootAt.y, c.rootAt.x)
    if (gap < minGap) hi = f; else lo = f
  }
  return lo
}
export function normalizeGearParams(p: GearParams): GearParams {
  const teeth = Number.isFinite(p.teeth) ? Math.max(6, Math.min(200, Math.round(p.teeth))) : 20
  const module = Number.isFinite(p.module) ? Math.max(0.01, Math.min(100, p.module)) : 2
  const pressureAngle = [14.5, 20, 25].includes(p.pressureAngle) ? p.pressureAngle : 20
  return {
    teeth, module, pressureAngle,
    rootFillet: Math.max(0, Math.min(maxGearRootFillet({ teeth, module, pressureAngle }), Number.isFinite(p.rootFillet) ? p.rootFillet : 0.3)),
  }
}

/** Fit each flank separately so the shared import fitter cannot round a tooth
 * corner or merge across a root. Samples bound chord sag before fitting. */
function fittedFlank(at: (t: number) => Vec2, t0: number, t1: number): { start: Vec2; segments: LoopSegment[] } {
  const points: Vec2[] = [at(t0)]
  const subdivide = (a: number, b: number, depth: number): void => {
    const pa = at(a), pb = at(b), mid = at((a + b) / 2)
    const dx = pb.x - pa.x, dy = pb.y - pa.y
    const l2 = dx * dx + dy * dy
    const u = l2 > 0 ? ((mid.x - pa.x) * dx + (mid.y - pa.y) * dy) / l2 : 0
    const sag = Math.hypot(mid.x - pa.x - u * dx, mid.y - pa.y - u * dy)
    if (depth < 20 && (sag > FIT_TOL / 4 || b - a > 0.025)) {
      subdivide(a, (a + b) / 2, depth + 1)
      subdivide((a + b) / 2, b, depth + 1)
    } else points.push(pb)
  }
  subdivide(t0, t1, 0)
  const loop: Loop2D = { id: 'gear-flank', points, closed: false, layerId: '', type: 'open', area: 0 }
  const fitted = optimizeLoops([loop], { tolerance: FIT_TOL, projectionTolerance: FIT_TOL / 4, resampleStep: 0.1 })[0]
  let from = points[0]
  const segments = (fitted.segments ?? points.slice(1).map((to): LoopSegment => ({ type: 'line', to }))).map((s): LoopSegment => {
    let exact = s
    if (s.type === 'arc') {
      // The import fitter's extended circle can miss its final sample by
      // tolerance. Put the center on the endpoints' bisector before lift,
      // so adjacent arcs share EXACT joints without solver deformation.
      const dx = s.to.x - from.x, dy = s.to.y - from.y
      const mx = (s.to.x + from.x) / 2, my = (s.to.y + from.y) / 2
      const d2 = dx * dx + dy * dy
      const correction = d2 > 0 ? ((s.center.x - mx) * dx + (s.center.y - my) * dy) / d2 : 0
      const center = { x: s.center.x - correction * dx, y: s.center.y - correction * dy }
      exact = { ...s, center, radius: Math.hypot(from.x - center.x, from.y - center.y) }
    }
    from = s.to
    return exact
  })
  return { start: points[0], segments }
}

/** One tooth at angle zero, traversed CCW. Below the base circle the
 * involute has a radial continuation; above it the fillet is tangent to
 * the actual involute, found by offsetting its normal onto root + fillet. */
function tooth(p: GearParams): { start: Vec2; segments: LoopSegment[]; root: number } {
  const pitch = p.module * p.teeth / 2, root = pitch - 1.25 * p.module
  const base = pitch * Math.cos(p.pressureAngle * Math.PI / 180)
  const baseAngle = -Math.PI / (2 * p.teeth) - roll(param(base, pitch))
  const at = (t: number): Vec2 => polar(base * Math.sqrt(1 + t * t), baseAngle + roll(t))
  let tTip = param(base, pitch + p.module)
  // Small tooth counts can meet before the nominal addendum. Keep the true
  // involute and a pointed crest instead of crossing flanks or refusing.
  if (baseAngle + roll(tTip) > 0) {
    let lo = 0, hi = tTip
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (baseAngle + roll(mid) > 0) hi = mid; else lo = mid }
    tTip = (lo + hi) / 2
  }
  const f = p.rootFillet
  const { tStart, contact, filletCenter, rootAt } = rootContact(base, baseAngle, root, f, tTip)
  const segments: LoopSegment[] = []
  const line = (to: Vec2): void => { segments.push({ type: 'line', to }) }
  if (f > 0) segments.push({ type: 'arc', center: filletCenter, radius: f, clockwise: true, to: contact })
  // A microscopic fitted arc at the involute cusp becomes a spurious
  // closed circle under bake's 0.05 mm endpoint chaining tolerance. Span
  // the cusp with one short chord (sag < 0.01 mm) before fitting the flank.
  const fitStart = tStart === 0 ? Math.min(tTip, param(base, base + 0.08)) : tStart
  const left = fittedFlank(at, fitStart, tTip)
  if (Math.hypot(contact.x - left.start.x, contact.y - left.start.y) > 1e-9) line(left.start)
  segments.push(...left.segments)
  const tip = at(tTip), rightTip = reflect(tip)
  if (Math.hypot(tip.x - rightTip.x, tip.y - rightTip.y) > 1e-9) {
    segments.push({ type: 'arc', center: origin, radius: Math.hypot(tip.x, tip.y), clockwise: false, to: rightTip })
  }
  const froms = [left.start, ...left.segments.map((s) => s.to)]
  for (let i = left.segments.length - 1; i >= 0; i--) {
    const s = left.segments[i]
    // Reversing AND reflecting preserves the circular traversal direction.
    segments.push(s.type === 'line' ? { type: 'line', to: reflect(froms[i]) }
      : { ...s, center: reflect(s.center), to: reflect(froms[i]) })
  }
  if (Math.hypot(contact.x - left.start.x, contact.y - left.start.y) > 1e-9) line(reflect(contact))
  if (f > 0) segments.push({ type: 'arc', center: reflect(filletCenter), radius: f, clockwise: true, to: reflect(rootAt) })
  return { start: rootAt, segments, root }
}

export function gearLoop(center: Vec2, cursor: Vec2, input: GearParams): Loop2D {
  const p = normalizeGearParams(input), template = tooth(p)
  const rotation = Math.atan2(cursor.y - center.y, cursor.x - center.x)
  const transform = (pt: Vec2, angle: number): Vec2 => ({
    x: center.x + pt.x * Math.cos(angle) - pt.y * Math.sin(angle),
    y: center.y + pt.x * Math.sin(angle) + pt.y * Math.cos(angle),
  })
  const start = transform(template.start, rotation), segments: LoopSegment[] = []
  for (let i = 0; i < p.teeth; i++) {
    const angle = rotation + TAU * i / p.teeth
    for (const s of template.segments) segments.push(s.type === 'line'
      ? { ...s, to: transform(s.to, angle) }
      : { ...s, to: transform(s.to, angle), center: transform(s.center, angle) })
    segments.push({ type: 'arc', center, radius: template.root, clockwise: false,
      to: i === p.teeth - 1 ? start : transform(template.start, rotation + TAU * (i + 1) / p.teeth) })
  }
  return { id: 'gear', layerId: '', closed: true, type: 'contour', area: 0, points: [start], segments }
}

export function gearPreview(chain: GearChainState, cursor: Vec2, params: GearParams): Vec2[] {
  const loop = gearLoop(chain.center, cursor, params), points = [loop.points[0]]
  let from = points[0]
  for (const s of loop.segments!) {
    if (s.type === 'line') points.push(s.to)
    else {
      const a = Math.atan2(from.y - s.center.y, from.x - s.center.x)
      const b = Math.atan2(s.to.y - s.center.y, s.to.x - s.center.x)
      const sweep = s.clockwise ? -((a - b + TAU) % TAU) : (b - a + TAU) % TAU
      points.push(...sampleArc(s.center.x, s.center.y, s.radius, a, sweep, 0.1))
      points[points.length - 1] = s.to
    }
    from = s.to
  }
  return points
}

export function gearClick(chain: GearChainState | null, world: Vec2, params: GearParams, construction: boolean, newId: () => string): { chain: GearChainState | null; commit: ToolCommit | null } {
  if (!chain) return { chain: { kind: 'gear', center: { ...world } }, commit: null }
  const p = normalizeGearParams(params)
  const lifted = liftLoops([gearLoop(chain.center, world, p)], { newId })
  // Land as ONE locked block, the way an imported curve layer does: the whole
  // outline chained loose is one solver component of hundreds of entities and
  // aborts the fixed-heap planegcs (Aborted(OOM)); the block is one entity
  // plus one fix. Bake and the Model profile read its member lines/arcs.
  const wrapped = wrapLiftedAsBlock(lifted.entities.map((e) => ({ ...e, construction })), lifted.constraints, { name: 'Gear', newId })
  if (!wrapped.ok) throw new Error(wrapped.message) // a non-empty lift always groups
  // The existing circle-center snap gives the Circle tool a bore anchor. It
  // goes FIRST: a centre click snapped to a point ties that point to this
  // circle's centre, never to the already-fixed block origin (redundant).
  const entities: SketchEntity[] = [
    { id: newId(), kind: 'circle', construction: true, center: { ...chain.center }, radius: p.teeth * p.module / 2 },
    { ...wrapped.block, construction },
  ]
  return { chain: null, commit: { entities, constraints: [wrapped.fix] } }
}
