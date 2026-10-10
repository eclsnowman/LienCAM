// Independent contact oracle for the prismatic engagement-pocket fixture.
// Its walls are vertical and capped by horizontal faces: the closest point
// on each horizontal triangle determines the highest admissible tool tip.
// No BVH, production drop-cutter, or production cutter mapping is used here.
import type { PartMesh } from '../../cam3d/kernel/types'
import type { ToolpathMove } from '../../types'
import { samplePath } from '../benchmark/metrics'

type XY = readonly [number, number]

function edgeDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

function triangleDistance(p: XY, a: XY, b: XY, c: XY): number {
  const cross = (u: XY, v: XY) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0])
  const signs = [cross(a, b), cross(b, c), cross(c, a)]
  if (signs.every(s => s >= -1e-10) || signs.every(s => s <= 1e-10)) return 0
  return Math.min(edgeDistance(p, a, b), edgeDistance(p, b, c), edgeDistance(p, c, a))
}

export function prismaticTipHeight(mesh: PartMesh, radius: number, cornerRadius: number) {
  const faces: { a: XY; b: XY; c: XY; z: number }[] = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = Array.from(mesh.indices.slice(i, i + 3), v => v * 3)
    const [a, b, c] = ids
    const z = mesh.positions[a + 2]
    if (z !== mesh.positions[b + 2] || z !== mesh.positions[c + 2]) continue
    faces.push({ a: [mesh.positions[a], mesh.positions[a + 1]], b: [mesh.positions[b], mesh.positions[b + 1]],
      c: [mesh.positions[c], mesh.positions[c + 1]], z })
  }
  if (!faces.length) throw new Error('prismatic oracle needs horizontal caps')
  return (x: number, y: number): number => {
    let tip = -Infinity
    for (const face of faces) {
      const d = triangleDistance([x, y], face.a, face.b, face.c)
      if (d > radius + 1e-9) continue
      const s = Math.max(0, Math.min(cornerRadius, d - (radius - cornerRadius)))
      const underside = cornerRadius - Math.sqrt(Math.max(0, cornerRadius * cornerRadius - s * s))
      tip = Math.max(tip, face.z - underside)
    }
    return tip
  }
}

export function measureBullPencil(mesh: PartMesh, moves: readonly ToolpathMove[]) {
  const bull = prismaticTipHeight(mesh, 3, 1)
  const ball = prismaticTipHeight(mesh, 3, 3)
  const flat = prismaticTipHeight(mesh, 3, 0)
  const samples = samplePath(moves, 0.1)
  let minMarginMm = Infinity, cutSamples = 0, contactSamples = 0, differsFromBall = 0, differsFromFlat = 0
  let worst: { x: number; y: number; z: number; requiredZ: number } | undefined
  for (const p of samples) {
    const requiredZ = bull(p.x, p.y)
    if (!Number.isFinite(requiredZ)) continue
    const margin = p.z - requiredZ
    if (margin < minMarginMm) { minMarginMm = margin; worst = { x: p.x, y: p.y, z: p.z, requiredZ } }
    if (!p.cutting) continue
    cutSamples++
    if (Math.abs(margin) <= 0.05) contactSamples++
    if (Math.abs(requiredZ - ball(p.x, p.y)) > 0.1) differsFromBall++
    if (Math.abs(requiredZ - flat(p.x, p.y)) > 0.1) differsFromFlat++
  }
  return { spacingMm: 0.1, totalSamples: samples.length, cutSamples, contactSamples,
    minMarginMm, differsFromBall, differsFromFlat, worst }
}
