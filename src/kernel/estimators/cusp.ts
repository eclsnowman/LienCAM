// WO-3034 (alpha.3 A3-21): the one cusp (scallop) estimate kernel operations use.
//
// The relation is alpha3-17 A.4.1, h = r - sqrt(r^2 - (s/2)^2), r the effective
// radius and s the spacing between adjacent passes (the A.3 worked value: a 3 mm
// ball at 1 mm stepover leaves 0.086 mm on a flat). The draft places the relation
// in a kernel surface/ module that does not exist yet; it lives here until then and
// is the only copy in src/kernel/.
//
// Post-plan, the spacing is read from the planned moves themselves: collinear
// cutting moves are merged first (mergeCollinearFeeds), every cutting segment is
// cut into equal pieces no longer than r, each sample is weighted in the mean by
// the length of path it stands for (so cutting a pass into more moves changes
// nothing, WO-3034 fix round 3), and each piece's midpoint takes the
// 3D distance to the nearest piece of ANOTHER pass that lies across it (within
// 60 deg of square to its direction) on EACH side of it: the gap to either
// neighbour bounds a ridge, so a wider gap beside a narrow one is not hidden
// (passes at 0, 1, 3, 4 mm leave the 2 mm ridge). A 3D distance makes steep-wall
// growth visible (parallel passes s apart on a wall of slope t sit s / cos(t)
// apart), as the stick's section collector does. A spatial hash keeps it linear.
import type { ToolpathMove } from '../../types'
import { effectiveMoveRole } from '../../lib/cam/stockCuttingRoles'
import type { SweepShape } from '../material'
import { available, degraded, unavailable, type CuspValue, type Estimate } from './contracts'
import { forEachSegment, mergeCollinearFeeds, type Segment } from './segments'

/** A.4.1: cusp height for radius r and pass spacing s; undefined where the relation has no value. */
export function cuspHeight(radius: number, spacing: number): number | undefined {
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(spacing) || spacing < 0 || spacing > 2 * radius) return undefined
  return radius - Math.sqrt(radius * radius - (spacing / 2) ** 2)
}

/** Roles whose passes leave the finished surface (the stick's M-GEOM-2 set). */
const FINISHING_ROLES = new Set(['cut', 'finish', 'wall_follow'])
/** Pass spacings closer than this are the same pass revisited (the stick's 0.03 mm dedupe). */
const SAME_PASS_MM = 0.03
/** A neighbour counts as across the pass when the separation is within 60 deg of square to it. */
const ACROSS_COS = 0.5
/**
 * The far-side neighbour counts when it lies within 60 deg of straight opposite the
 * near one; a pass off at a step (the floor below a plateau's last pass) is no
 * neighbour on the surface between them.
 */
const OPPOSITE_COS = 0.5

interface CuspModel { radius: number; flatRadius: number; note?: string }

/** Effective radius per tool family; flats have no relation yet (Q-81). */
function cuspModel(shape: SweepShape): CuspModel | string {
  switch (shape.kind) {
    case 'ball': return { radius: shape.radius, flatRadius: 0 }
    case 'bull':
      if (!(shape.cornerRadius > 0)) return 'a bull nose with no corner radius cuts as a flat end mill: the flat-cutter cusp model is not settled (Q-81)'
      return { radius: shape.cornerRadius, flatRadius: shape.radius - shape.cornerRadius,
        note: 'bull nose: corner-radius relation on the spacing beyond the flat bottom; exact on flat floors only' }
    case 'flat': return 'flat end mill: the flat-cutter cusp model is not settled (Q-81, alpha3-02 Part II s5)'
    default: return `${shape.kind} cutter: no cusp relation is defined for this profile`
  }
}

/** The returned max's status until it is validated (WO-3034 audit, fix round 2). */
export const CUSP_MAX_UNVALIDATED = 'max not yet validated against a dense geometric reference on production moves (WO-3034 audit)'

function heightFor(model: CuspModel, spacing: number): number | undefined {
  return cuspHeight(model.radius, Math.max(0, spacing - 2 * model.flatRadius))
}

/** Pre-plan: the programmed stepover on a flat floor. Degraded: slope growth is not known before planning. */
export function estimateCuspFromStepover(shape: SweepShape, stepoverMm: number): Estimate<CuspValue> {
  const model = cuspModel(shape)
  if (typeof model === 'string') return unavailable(model)
  const h = heightFor(model, stepoverMm)
  if (h === undefined) return unavailable(`stepover ${stepoverMm} mm is not a spacing the cusp relation covers for radius ${model.radius} mm`)
  return degraded({ maxMm: h, maxStatus: 'unvalidated', maxReason: CUSP_MAX_UNVALIDATED, meanMm: h, effectiveRadiusMm: model.radius, samples: 0 },
    'programmed stepover on a flat floor: slope-dependent growth is unknown before the moves exist',
    model.note ? [model.note] : [])
}

/** Post-plan: the spacing to the adjacent pass on each side, along the planned moves. */
export function estimateCusp(planned: readonly ToolpathMove[], shape: SweepShape): Estimate<CuspValue> {
  const model = cuspModel(shape)
  if (typeof model === 'string') return unavailable(model)
  const moves = mergeCollinearFeeds(planned)
  const { radius } = model
  const reach = 2 * radius + 2 * model.flatRadius
  const pieceMm = radius
  // Pieces as flat columns: endpoints, pass id and path position of the midpoint.
  const ax: number[] = [], ay: number[] = [], az: number[] = [], bx: number[] = [], by: number[] = [], bz: number[] = []
  const passOf: number[] = [], atOf: number[] = []
  let pass = 0, inPass = false, at = 0
  forEachSegment(moves, radius / 100, (segment: Segment, index: number) => {
    const cutting = FINISHING_ROLES.has(effectiveMoveRole(moves[index]))
    if (!cutting) { if (inPass) pass++; inPass = false; return }
    inPass = true
    // A pure vertical segment is a descent, not a surface pass (the stick's sections skip it too).
    if (Math.hypot(segment.x1 - segment.x0, segment.y1 - segment.y0) < 1e-9) return
    const dx = segment.x1 - segment.x0, dy = segment.y1 - segment.y0, dz = segment.z1 - segment.z0
    const length = Math.hypot(dx, dy, dz)
    const n = Math.max(1, Math.ceil(length / pieceMm))
    for (let k = 0; k < n; k++) {
      const a = k / n, b = (k + 1) / n
      ax.push(segment.x0 + a * dx); ay.push(segment.y0 + a * dy); az.push(segment.z0 + a * dz)
      bx.push(segment.x0 + b * dx); by.push(segment.y0 + b * dy); bz.push(segment.z0 + b * dz)
      passOf.push(pass); atOf.push(at + length * (a + b) / 2)
    }
    at += length
  })
  const count = ax.length
  if (count === 0) return unavailable('the moves contain no finishing passes to measure')
  // Uniform grid of piece-length cells, stored compressed (pieces sorted by cell, one
  // offset per cell), searched in growing shells around each sample.
  const cell = pieceMm
  const maxRing = Math.ceil((reach + pieceMm / 2) / cell)
  const mx = new Float64Array(count), my = new Float64Array(count), mz = new Float64Array(count)
  let loX = Infinity, loY = Infinity, loZ = Infinity, hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity
  for (let i = 0; i < count; i++) {
    mx[i] = (ax[i] + bx[i]) / 2; my[i] = (ay[i] + by[i]) / 2; mz[i] = (az[i] + bz[i]) / 2
    loX = Math.min(loX, mx[i]); loY = Math.min(loY, my[i]); loZ = Math.min(loZ, mz[i])
    hiX = Math.max(hiX, mx[i]); hiY = Math.max(hiY, my[i]); hiZ = Math.max(hiZ, mz[i])
  }
  const ni = Math.floor((hiX - loX) / cell) + 1, nj = Math.floor((hiY - loY) / cell) + 1, nk = Math.floor((hiZ - loZ) / cell) + 1
  const cells = new Map<number, number>()
  const cellOf = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const c = Math.floor((mx[i] - loX) / cell) + ni * (Math.floor((my[i] - loY) / cell) + nj * Math.floor((mz[i] - loZ) / cell))
    cellOf[i] = c
    cells.set(c, (cells.get(c) ?? 0) + 1)
  }
  // Compressed buckets: occupied cells only (a sparse box can hold many empty cells).
  const keys = [...cells.keys()].sort((a, b) => a - b)
  const bucketStart = new Map<number, number>()
  let offset = 0
  for (const k of keys) { bucketStart.set(k, offset); offset += cells.get(k)! }
  const fill = new Map(bucketStart)
  const order = new Int32Array(count)
  for (let i = 0; i < count; i++) { const c = cellOf[i]; order[fill.get(c)!] = i; fill.set(c, fill.get(c)! + 1) }
  // Pieces of one pass further apart along the path than this count as another pass (a spiral's next ring).
  const samePassGap = 4 * reach
  // The mean is over path length: each gap sample weighs the length of its piece.
  let max = 0, sum = 0, weight = 0, samples = 0
  const take = (spacing: number, length: number) => {
    const h = heightFor(model, spacing)
    if (h === undefined) return
    if (h > max) max = h
    sum += h * length
    weight += length
    samples++
  }
  for (let index = 0; index < count; index++) {
    const x = mx[index], y = my[index], z = mz[index], ownPass = passOf[index], ownAt = atOf[index]
    const ownLength = Math.hypot(bx[index] - ax[index], by[index] - ay[index], bz[index] - az[index])
    const dirX = (bx[index] - ax[index]) / ownLength, dirY = (by[index] - ay[index]) / ownLength, dirZ = (bz[index] - az[index]) / ownLength
    const ci = Math.floor((x - loX) / cell), cj = Math.floor((y - loY) / cell), ck = Math.floor((z - loZ) / cell)
    // The nearest across-neighbour on each side: sides split by the first neighbour's
    // separation (square to the piece); each side keeps its nearest and that separation.
    let refX = 0, refY = 0, refZ = 0, hasRef = false
    let dA = Infinity, aX = 0, aY = 0, aZ = 0, dB = Infinity, bX = 0, bY = 0, bZ = 0
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dk = -ring; dk <= ring; dk++) {
        const k = ck + dk
        if (k < 0 || k >= nk) continue
        for (let dj = -ring; dj <= ring; dj++) {
          const j = cj + dj
          if (j < 0 || j >= nj) continue
          for (let di = -ring; di <= ring; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== ring) continue
            const i = ci + di
            if (i < 0 || i >= ni) continue
            const c = i + ni * (j + nj * k)
            const start = bucketStart.get(c)
            if (start === undefined) continue
            const end = start + cells.get(c)!
            for (let q = start; q < end; q++) {
              const o = order[q]
              if (passOf[o] === ownPass && Math.abs(atOf[o] - ownAt) <= samePassGap) continue
              // Point-to-segment distance in 3D.
              const ux = bx[o] - ax[o], uy = by[o] - ay[o], uz = bz[o] - az[o]
              const len2 = ux * ux + uy * uy + uz * uz
              let t = len2 > 0 ? ((x - ax[o]) * ux + (y - ay[o]) * uy + (z - az[o]) * uz) / len2 : 0
              t = t < 0 ? 0 : t > 1 ? 1 : t
              const ex = x - ax[o] - t * ux, ey = y - ay[o] - t * uy, ez = z - az[o] - t * uz
              const d = Math.sqrt(ex * ex + ey * ey + ez * ez)
              // Only a neighbour ACROSS the pass bounds a cusp: one ahead or behind (the end
              // of a shorter neighbouring pass, seen obliquely) leaves no ridge between them.
              const along = ex * dirX + ey * dirY + ez * dirZ
              if (d <= SAME_PASS_MM || d >= reach || Math.abs(along) > ACROSS_COS * d) continue
              const px = ex - along * dirX, py = ey - along * dirY, pz = ez - along * dirZ
              if (!hasRef) { refX = px; refY = py; refZ = pz; hasRef = true }
              if (px * refX + py * refY + pz * refZ >= 0) {
                if (d < dA) { dA = d; aX = px; aY = py; aZ = pz }
              } else if (d < dB) { dB = d; bX = px; bY = py; bZ = pz }
            }
          }
        }
      }
      // Every piece not yet visited lies at least this far away.
      if (Math.max(dA, dB) <= ring * cell - pieceMm / 2) break
    }
    const n1 = Math.min(dA, dB)
    // The far side counts when it lies within 60 deg of straight opposite the near one.
    const opposite = dA < Infinity && dB < Infinity &&
      aX * bX + aY * bY + aZ * bZ < -OPPOSITE_COS * Math.hypot(aX, aY, aZ) * Math.hypot(bX, bY, bZ)
    const n2 = opposite ? Math.max(dA, dB) : Infinity
    if (n1 < reach) take(n1, ownLength)
    if (n2 < reach) take(n2, ownLength)
  }
  if (samples === 0) return unavailable('no two passes lie within one cutter diameter of each other')
  // The two-sided per-gap max is computed and returned, but marked unvalidated: the mean is the promised figure.
  const value: CuspValue = { maxMm: max, maxStatus: 'unvalidated', maxReason: CUSP_MAX_UNVALIDATED, meanMm: sum / weight, effectiveRadiusMm: radius, samples }
  const assumptions = [`spacing sampled at most every ${pieceMm} mm of finishing path, mean weighted by path length`]
  return model.note ? degraded(value, model.note, assumptions) : available(value, assumptions)
}
