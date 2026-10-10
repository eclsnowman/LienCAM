// Shared direct-manipulation math for staged sketch sizes. Fillet and
// chamfer supply the exact preview paths their Apply operations already
// consume; this module owns the one hit-test and scalar-projection path.

import type { Vec2 } from '../types'

const MIN_SIZE = 0.01
const EPS_REFERENCE = 1e-6

export interface StagedSizeDragRegion {
  /** The theoretical sharp corner from which the size is measured. */
  corner: Vec2
  /** Exact rendered preview path that accepts hover/drag. */
  path: readonly Vec2[]
}

export interface StagedSizeDrag {
  corner: Vec2
  /** Pointer position at pointerdown, retained so grabbing near the path
   *  never makes the preview jump onto the pointer. */
  grab: Vec2
  /** Unit direction from the sharp corner to the nearest preview point. */
  direction: Vec2
  startValue: number
  /** Size change per world-mm of travel along direction. */
  valuePerWorld: number
}

function finitePoint(point: Vec2): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function nearestPointOnSegment(
  point: Vec2,
  start: Vec2,
  end: Vec2,
): { point: Vec2; distance: number } | null {
  if (!finitePoint(point) || !finitePoint(start) || !finitePoint(end)) return null
  const vx = end.x - start.x
  const vy = end.y - start.y
  const denominator = vx * vx + vy * vy
  if (!Number.isFinite(denominator)) return null
  const t = denominator > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * vx + (point.y - start.y) * vy) / denominator))
    : 0
  const nearest = { x: start.x + t * vx, y: start.y + t * vy }
  const d = distance(point, nearest)
  return Number.isFinite(d) ? { point: nearest, distance: d } : null
}

/**
 * Hit-test exact staged preview paths and calibrate one scalar drag. Invalid
 * regions are non-candidates; the gesture starts only from a finite path,
 * finite sharp corner, positive finite value, and non-degenerate reference.
 */
export function startStagedSizeDrag(
  regions: readonly StagedSizeDragRegion[],
  value: number,
  world: Vec2,
  tolerance: number,
): StagedSizeDrag | null {
  if (
    !Number.isFinite(value) || value <= 0 ||
    !finitePoint(world) ||
    !Number.isFinite(tolerance) || tolerance < 0
  ) return null

  let best: { corner: Vec2; point: Vec2; distance: number } | null = null
  for (const region of regions) {
    if (!finitePoint(region.corner)) continue
    for (let i = 1; i < region.path.length; i++) {
      const nearest = nearestPointOnSegment(world, region.path[i - 1], region.path[i])
      if (!nearest || nearest.distance > tolerance) continue
      if (best && nearest.distance >= best.distance) continue
      best = { corner: region.corner, point: nearest.point, distance: nearest.distance }
    }
  }
  if (!best) return null

  const referenceDistance = distance(best.corner, best.point)
  if (!Number.isFinite(referenceDistance) || referenceDistance <= EPS_REFERENCE) return null
  return {
    corner: { x: best.corner.x, y: best.corner.y },
    grab: { x: world.x, y: world.y },
    direction: {
      x: (best.point.x - best.corner.x) / referenceDistance,
      y: (best.point.y - best.corner.y) / referenceDistance,
    },
    startValue: value,
    valuePerWorld: value / referenceDistance,
  }
}

/** Resolve one live sample. Both tools use the same 0.01 mm floor as the
 * staged confirm fields, keeping their shared store scalars in-domain. */
export function stagedSizeFromDrag(drag: StagedSizeDrag, world: Vec2): number | null {
  if (!finitePoint(world)) return null
  const travel =
    (world.x - drag.grab.x) * drag.direction.x +
    (world.y - drag.grab.y) * drag.direction.y
  const value = drag.startValue + travel * drag.valuePerWorld
  return Number.isFinite(value) ? Math.max(MIN_SIZE, value) : null
}

// ---- SKC-46: grabbable default + remembered-size seeding ---------------------------------------
//
// Operator's ask (T-SKC44-FILLETDRAG): the staged size no longer defaults to a fixed 2mm that reads as
// unclickable unless the part is small or the view is zoomed way in. The chosen rule is GEOMETRY-
// relative rather than view-scale-relative: a fraction of the corner's own MAX USABLE size (the
// same ceiling `filletChainMaxRadius`/`chamferChainMaxSetback` compute for the fit-clamp below).
// This is a deliberate choice over deriving from `worldPerPixel`: a corner the user can see and
// click is, by construction, already rendered at a scale the current zoom can resolve, so a size
// relative to ITS OWN geometry reads as "comfortably grabbable" at whatever zoom the corner is
// visible at, without threading view-scale through the arm-time pre-selection path (which has no
// cursor/zoom context at all). Clamped to a sane absolute mm band so a huge corner does not derive
// an absurdly large default and a tiny corner does not derive an unusable speck.
const GRAB_FRACTION = 0.35
const SANE_MIN_MM = 0.5
const SANE_MAX_MM = 25

/** The view/geometry-derived default when there is no remembered size: `GRAB_FRACTION` of the
 *  corner's own max-usable size, clamped to [SANE_MIN_MM, SANE_MAX_MM] and never past `maxUsable`
 *  itself. `maxUsable` null (no resolvable corner yet) falls back to the sane floor. */
export function derivedGrabbableDefault(maxUsable: number | null): number {
  if (maxUsable === null || !Number.isFinite(maxUsable) || maxUsable <= 0) return SANE_MIN_MM
  const scaled = GRAB_FRACTION * maxUsable
  return Math.min(maxUsable, Math.max(SANE_MIN_MM, Math.min(SANE_MAX_MM, scaled)))
}

// ---- SKC-46-R2: discriminated chain-max domain -------------------------------------------------
//
// R2 root-cause ruling (coordination/DECISIONS.md, "SKC-46 two-bounce STOP"): both R0 and R1
// guarded the max-states the AUDITOR named and missed the states nobody named. The fix is to
// DERIVE the accept/refuse domain from the type contract instead of patching named repros: a
// per-corner geometric ceiling is `number | null` (null = geometrically unresolvable: collinear,
// degenerate leg, missing entity), but the raw number itself can ALSO be NaN or +/-Infinity (a
// poisoned coordinate sails through every guard in filletTool.ts/chamferTool.ts silently, since
// every comparison with NaN is false). `classifyChainMax` is the SINGLE function that turns a list
// of raw per-corner ceilings into one of exactly five named states -- no other function in this
// tree is allowed to construct a `ChainMaxResult` by hand.
export const CHAIN_MAX_KINDS = [
  'no-corner', 'unresolvable', 'non-finite', 'sub-floor', 'finite-legal',
] as const
export type ChainMaxKind = (typeof CHAIN_MAX_KINDS)[number]

export type ChainMaxResult =
  /** The chain has no corners at all (only the chain-level function -- the one place that knows
   *  `corners.length` -- can produce this). Seeding is not applicable: nothing constrains the
   *  scalar yet, so this is NOT a refusal. */
  | { kind: 'no-corner' }
  /** One or more corners are staged, but EVERY one is geometrically unresolvable (collinear,
   *  degenerate leg, missing/non-line entity) -- `continue`d out of the aggregate min today. A
   *  chain that is all-unresolvable must never be conflated with `no-corner`: R1's BLOCKER 1 was
   *  exactly that conflation (both collapsed to `null`, and `null` was treated as an accept). */
  | { kind: 'unresolvable' }
  /** The aggregate ceiling is NaN or +/-Infinity: a poisoned (non-finite) coordinate reached a
   *  resolved corner and passed every existing guard. Never a legal size, never `finite-legal`. */
  | { kind: 'non-finite' }
  /** The aggregate ceiling is a real, finite, non-negative number, but strictly below the shared
   *  `MIN_SIZE` field floor: no field-legal value exists for this batch. `value` is the ceiling
   *  itself (floored at 0), kept for the refusal notice's "max usable X mm" text. A zero ceiling
   *  (the constructor's own `Math.max(0, ...)` floor) folds in here rather than getting a sixth
   *  state -- it is still "no legal value", just the degenerate case of sub-floor. */
  | { kind: 'sub-floor'; value: number }
  /** The aggregate ceiling is finite and >= `MIN_SIZE`: a legal size exists and staging at or
   *  below `value` previews (>=1 fit) and applies (non-null transform). */
  | { kind: 'finite-legal'; value: number }

// Two-way compile-time bridge (WO SKC-46-R2 edit 1): every literal in the union must appear in the
// registry, AND every registry entry must appear in the union. A one-directional drift (add a kind
// to one but not the other) fails ONE of these two assignments -- `never` cannot receive `true`.
type _ChainMaxKindCoversUnion = ChainMaxResult['kind'] extends ChainMaxKind ? true : never
type _RegistryCoversChainMaxKind = ChainMaxKind extends ChainMaxResult['kind'] ? true : never
// Exported (not merely declared) so `noUnusedLocals` cannot mask a broken bridge by treating it as
// dead code; the census test imports both to prove the bridge is live, not just present.
export const CHAIN_MAX_KIND_BRIDGE_UNION_TO_REGISTRY: _ChainMaxKindCoversUnion = true
export const CHAIN_MAX_KIND_BRIDGE_REGISTRY_TO_UNION: _RegistryCoversChainMaxKind = true

/** Exhaustiveness guard: a `never` argument means every named kind was handled above this call.
 *  Throwing here is the fail-CLOSED behavior for an out-of-registry kind forged at runtime (a
 *  `default:` arm that instead accepted would be exactly the gap R0/R1 shipped twice). */
export function assertNeverChainMaxKind(x: never): never {
  throw new Error(`SKC-46-R2: unhandled chain-max kind ${JSON.stringify(x)}`)
}

/**
 * THE single classifier: turns the raw per-corner ceilings (each `number | null`, where `null` is
 * a geometrically-unresolvable corner and the number can be NaN/+-Infinity/negative/finite) into
 * exactly one `ChainMaxResult`. Unresolvable corners are skipped (`continue`d) when at least one
 * OTHER corner resolves -- the existing MIXED-chain aggregate behavior (a dead corner is invisible
 * to the shared ceiling, see the R2 mixed-chain ruling in toolController.ts for the PER-ADDITION
 * check this does not replace). A NaN corner is NOT skipped: `Math.min(finite, NaN) === NaN`
 * poisons the whole aggregate, which is the point -- an addition that resolves to NaN must never
 * silently vanish behind a finite sibling.
 */
export function classifyChainMax(perCorner: readonly (number | null)[]): ChainMaxResult {
  if (perCorner.length === 0) return { kind: 'no-corner' }
  let min: number | null = null
  let sawResolved = false
  for (const m of perCorner) {
    if (m === null) continue
    sawResolved = true
    min = min === null ? m : Math.min(min, m)
  }
  if (!sawResolved || min === null) return { kind: 'unresolvable' }
  if (!Number.isFinite(min)) return { kind: 'non-finite' }
  if (min < MIN_SIZE) return { kind: 'sub-floor', value: Math.max(0, min) }
  return { kind: 'finite-legal', value: min }
}

/** The 3 kinds `seedStagedSize` ever refuses on -- narrowed so refusal-notice formatting is
 *  exhaustive without a `default` arm (there is nothing left to default to). */
export type ChainMaxRefusalKind = Extract<ChainMaxResult, { kind: 'unresolvable' | 'non-finite' | 'sub-floor' }>

/**
 * Result of seeding the staged size scalar: either a legal `value` to stage, or a `refused`
 * signal meaning no legal value exists (SKC-46-R1, BLOCKER 1 close-out; SKC-46-R2, discriminated).
 */
export interface StagedSizeSeed {
  /** Legal only when `refused` is false. When refused, this is the best available number for the
   *  caller's notice text (the sub-floor ceiling, or 0 for unresolvable/non-finite) and must NEVER
   *  be staged as a preview value. */
  value: number
  /** True when no legal field value exists for this corner/batch (ADR-0003: no silent fallback --
   *  the caller must refuse staging BY NAME instead of presenting an impossible preview). */
  refused: boolean
  /** Present only when `refused`: which of the 3 refusal kinds fired (drives the notice text). */
  reasonKind?: ChainMaxRefusalKind['kind']
}

/**
 * Seed the staged size scalar for a freshly-staged corner set (SKC-46 deliverables 1+2).
 *
 * `remembered` is the last COMMITTED size for this tool kind (null when the user has never
 * applied one, or when the caller wants the derived default). It WINS over the derived default
 * when present, but is still clamped to the `finite-legal` ceiling — a remembered 10mm on a 4mm
 * corner must stage the corner's own applicable ceiling, not an impossible preview past it.
 *
 * SKC-46-R2: `chainMax` is now the DISCRIMINATED result (`classifyChainMax`), not a bare
 * `number | null` -- the exhaustive switch below is the only producer of accept/refuse decisions,
 * and the `default` arm is unreachable (asserted via `assertNeverChainMaxKind`, never an accept).
 *   no-corner:     no corner geometry constrains the value yet (arm-time pre-selection has no
 *                  cursor/zoom context) -- accept the derived/remembered default, unconstrained.
 *   unresolvable:  every corner is geometrically dead (collinear/degenerate/missing) -- REFUSE.
 *   non-finite:    the ceiling is NaN/+-Infinity -- REFUSE (never silently treated as unconstrained
 *                  or as a legal ceiling -- this closes the NaN-costume hole).
 *   sub-floor:     a real, finite ceiling exists but is below the 0.01mm field floor -- REFUSE
 *                  (the old bug: raising a 0.001mm corner's seed up to 0.01mm staged an impossible
 *                  preview every time; refusing by name is the only fail-closed option here).
 *   finite-legal:  clamp remembered/derived to the ceiling -- always previews and applies.
 */
export function seedStagedSize(remembered: number | null, chainMax: ChainMaxResult): StagedSizeSeed {
  switch (chainMax.kind) {
    case 'no-corner': {
      const base =
        remembered !== null && Number.isFinite(remembered) && remembered > 0
          ? remembered
          : derivedGrabbableDefault(null)
      return { value: Math.max(MIN_SIZE, base), refused: false }
    }
    case 'unresolvable':
    case 'non-finite':
      return { value: 0, refused: true, reasonKind: chainMax.kind }
    case 'sub-floor':
      return { value: Math.max(0, chainMax.value), refused: true, reasonKind: 'sub-floor' }
    case 'finite-legal': {
      const base =
        remembered !== null && Number.isFinite(remembered) && remembered > 0
          ? remembered
          : derivedGrabbableDefault(chainMax.value)
      return { value: Math.min(Math.max(MIN_SIZE, base), chainMax.value), refused: false }
    }
    default:
      return assertNeverChainMaxKind(chainMax)
  }
}
