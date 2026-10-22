// WO-3020 (alpha.3 A3-11, parity): the ONE depth-level builder. Today four
// ladders exist and they differ (that is why each is a named schedule here, not
// one formula; unifying them changes tool Z and is the MD-58 card):
//
//   'fixed_step'   pocket2d.ts:53, contour2d.ts:2092, face2d/index.ts:67,
//                  bore2d.ts:37, engrave2d/index.ts:38 (five identical private
//                  copies): one stepdown below Top, then every stepdown, the
//                  last level exactly Bottom. Stepdown unset (0) -> 1 mm.
//                  Top = Bottom gives one level, at Bottom.
//   'adaptive_2d'  adaptiveClearing2d/engine/index.ts:469 (scheduledDepths):
//                  stepdown floored at 0.1 mm, levels clamp to the rough
//                  bottom, the floor-finish depth appended below it.
//                  Top = Bottom gives no level.
//   'even_3d'      cam3d/rough/levels.ts:36 (planLevels): even spacing per
//                  segment, a level pinned on every required depth. Throws on
//                  Bottom >= Top.
//   'waterline'    cam3d/strategies/waterline/levels.ts:91: fixed stepdown, flat
//                  heights inserted, levels on a flat lifted. Throws on an empty
//                  band.
//
// `floor_allowance_rough_only` (MD-58) is a CARD and stays off: whatever floor
// the caller resolved (allowance included) is the last level, as today.

export type DepthSchedule =
  | { kind: 'fixed_step'; topZ: number; bottomZ: number; stepdown: number }
  | { kind: 'adaptive_2d'; topZ: number; roughBottomZ: number; stepdown: number; floorFinishDepth?: number }
  | { kind: 'even_3d'; topZ: number; bottomZ: number; stepdown: number; requiredDepths?: readonly number[] }
  | {
      kind: 'waterline'
      topZ: number
      bottomZ: number
      stepdown: number
      flatHeights?: readonly number[]
      liftOffFlats?: readonly number[]
      flatLiftMm?: number
    }

export interface DepthLevels {
  /** Cutting Z of each level, top down. */
  levels: number[]
  /** adaptive_2d: the floor-finish depth was appended below the rough bottom. */
  floorAppended?: boolean
}

/** Two depths closer than this (mm) are the same plane (planLevels' PIN_MERGE_EPS). */
const PIN_MERGE_EPS = 1e-6
/** Two waterline levels closer than this (mm) are the same level (LEVEL_MERGE_EPS). */
export const WATERLINE_LEVEL_MERGE_EPS = 1e-3
/** More waterline levels than this is a stepdown typo (MAX_LEVELS). */
export const WATERLINE_MAX_LEVELS = 5000

function fixedStep(topZ: number, bottomZ: number, stepdown: number): number[] {
  const sd = Math.abs(stepdown) || 1
  const depths: number[] = []
  let z = topZ - sd
  while (z > bottomZ + 0.001) {
    depths.push(z)
    z -= sd
  }
  depths.push(bottomZ)
  return depths
}

function adaptive2d(schedule: Extract<DepthSchedule, { kind: 'adaptive_2d' }>): DepthLevels {
  const stepdown = Math.max(schedule.stepdown, 0.1)
  const depths: number[] = []
  let z = schedule.topZ
  let guard = 0
  while (z > schedule.roughBottomZ + 1e-6 && guard++ < 2000) {
    z = Math.max(z - stepdown, schedule.roughBottomZ)
    depths.push(z)
  }
  const floor = schedule.floorFinishDepth
  const floorAppended = floor !== undefined && depths.length > 0 && floor < schedule.roughBottomZ - 1e-6
  if (floorAppended) depths.push(floor)
  return { levels: depths, floorAppended }
}

function even3d(stockTopZ: number, floorZ: number, maxStepdown: number, requiredDepths: readonly number[]): number[] {
  if (!Number.isFinite(stockTopZ) || !Number.isFinite(floorZ)) {
    throw new Error(`planLevels: stockTopZ/floorZ must be finite (got ${stockTopZ}, ${floorZ}).`)
  }
  if (!Number.isFinite(maxStepdown) || maxStepdown <= 0) {
    throw new Error(`planLevels: maxStepdown must be positive and finite, got ${maxStepdown}.`)
  }
  if (floorZ >= stockTopZ) {
    throw new Error(`planLevels: floorZ (${floorZ}) must be below stockTopZ (${stockTopZ}).`)
  }
  for (const d of requiredDepths) {
    if (!Number.isFinite(d)) {
      throw new Error(`planLevels: requiredDepths must all be finite, got ${d}.`)
    }
  }
  const stops: number[] = [stockTopZ]
  const pins = requiredDepths.filter((d) => d > floorZ && d < stockTopZ).sort((a, b) => b - a)
  for (const d of pins) {
    if (stops[stops.length - 1] - d > PIN_MERGE_EPS) stops.push(d)
  }
  if (stops.length === 1 || stops[stops.length - 1] - floorZ > PIN_MERGE_EPS) stops.push(floorZ)
  else stops[stops.length - 1] = floorZ

  const levels: number[] = []
  for (let s = 0; s + 1 < stops.length; s++) {
    const upper = stops[s]
    const lower = stops[s + 1]
    const span = upper - lower
    const n = Math.max(1, Math.ceil(span / maxStepdown - 1e-9))
    const step = span / n
    for (let k = 1; k <= n; k++) levels.push(upper - k * step)
    levels[levels.length - 1] = lower
  }
  return levels
}

function waterline(input: Extract<DepthSchedule, { kind: 'waterline' }>): number[] {
  const { topZ, bottomZ, stepdown } = input
  const eps = WATERLINE_LEVEL_MERGE_EPS
  if (!Number.isFinite(topZ) || !Number.isFinite(bottomZ)) {
    throw new Error(`waterline: non-finite band top=${topZ} bottom=${bottomZ}.`)
  }
  if (!(stepdown > 0) || !Number.isFinite(stepdown)) {
    throw new Error(`waterline: stepdown must be a positive finite number (got ${stepdown}).`)
  }
  if (topZ - bottomZ <= eps) {
    throw new Error(
      `waterline: the finishing band is empty (Material Start ${topZ} mm, Cutter End ${bottomZ} mm); ` +
        'nothing lies between them to cut.',
    )
  }
  const count = Math.ceil((topZ - bottomZ) / stepdown)
  if (count > WATERLINE_MAX_LEVELS) {
    throw new Error(
      `waterline: a ${stepdown} mm stepdown over ${(topZ - bottomZ).toFixed(3)} mm is ${count} levels; ` +
        `the limit is ${WATERLINE_MAX_LEVELS}. Use a larger stepdown.`,
    )
  }
  const levels: number[] = []
  for (let k = 1; ; k++) {
    const z = topZ - k * stepdown
    if (z <= bottomZ + eps) break
    levels.push(z)
  }
  levels.push(bottomZ)
  for (const h of input.flatHeights ?? []) {
    if (!Number.isFinite(h)) continue
    if (h >= topZ - eps || h <= bottomZ + eps) continue
    levels.push(h)
  }
  const lift = input.flatLiftMm ?? 0
  const flats = input.liftOffFlats ?? []
  const lifted = lift > 0 && flats.length > 0
    ? levels.map((z) => {
        const onFlat = flats.some((h) => Math.abs(h - z) <= eps)
        return onFlat && z + lift < topZ - eps ? z + lift : z
      })
    : levels
  lifted.sort((p, q) => q - p)
  const out: number[] = []
  for (const z of lifted) {
    const last = out[out.length - 1]
    if (last === undefined || last - z > eps) out.push(z)
  }
  return out
}

/** The depth levels a schedule cuts, top down. Deterministic; throws exactly where today's ladder throws. */
export function buildDepthLevels(schedule: DepthSchedule): DepthLevels {
  switch (schedule.kind) {
    case 'fixed_step': return { levels: fixedStep(schedule.topZ, schedule.bottomZ, schedule.stepdown) }
    case 'adaptive_2d': return adaptive2d(schedule)
    case 'even_3d':
      return { levels: even3d(schedule.topZ, schedule.bottomZ, schedule.stepdown, schedule.requiredDepths ?? []) }
    case 'waterline': return { levels: waterline(schedule) }
  }
}
