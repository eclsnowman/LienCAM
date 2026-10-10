import { describe, expect, it } from 'vitest'
import { featureBlock, FEATURE_BLOCK, FEATURE_BLOCK_REMOVED_VOLUME, FEATURE_BLOCK_SOLID_VOLUME } from '../../cam3d/fixtures'
import type { PartMesh } from '../../cam3d/kernel/types'
import { PARTS } from '../benchmark/registry'

function signedVolume(mesh: PartMesh) {
  let volume = 0
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3, b = mesh.indices[i + 1] * 3, c = mesh.indices[i + 2] * 3
    volume += (mesh.positions[a] * (mesh.positions[b + 1] * mesh.positions[c + 2] - mesh.positions[b + 2] * mesh.positions[c + 1]) -
      mesh.positions[a + 1] * (mesh.positions[b] * mesh.positions[c + 2] - mesh.positions[b + 2] * mesh.positions[c]) +
      mesh.positions[a + 2] * (mesh.positions[b] * mesh.positions[c + 1] - mesh.positions[b + 1] * mesh.positions[c])) / 6
  }
  return volume
}

function nonManifoldEdges(mesh: PartMesh): string[] {
  const edges = new Map<string, number>()
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const triangle = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]]
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge], b = triangle[(edge + 1) % 3]
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  return [...edges.entries()].filter(([, count]) => count !== 2).map(([edge, count]) => {
    const [a, b] = edge.split(':').map(Number)
    const point = (index: number) => Array.from(mesh.positions.slice(index * 3, index * 3 + 3)).join('/')
    return `${point(a)}:${point(b)}=${count}`
  })
}

function minimumDoubleArea(mesh: PartMesh): number {
  let minimum = Infinity
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3, b = mesh.indices[i + 1] * 3, c = mesh.indices[i + 2] * 3
    const ux = mesh.positions[b] - mesh.positions[a], uy = mesh.positions[b + 1] - mesh.positions[a + 1], uz = mesh.positions[b + 2] - mesh.positions[a + 2]
    const vx = mesh.positions[c] - mesh.positions[a], vy = mesh.positions[c + 1] - mesh.positions[a + 1], vz = mesh.positions[c + 2] - mesh.positions[a + 2]
    minimum = Math.min(minimum, Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx))
  }
  return minimum
}

describe('WO-1218 feature block fixture', () => {
  it('is deterministic, watertight, outward-wound, non-degenerate, and analytically bounded', () => {
    const a = featureBlock(), b = featureBlock()
    expect(a.positions).toEqual(b.positions)
    expect(a.indices).toEqual(b.indices)
    const badEdges = nonManifoldEdges(a)
    expect(badEdges.length, badEdges.join(', ')).toBe(0)
    expect(minimumDoubleArea(a)).toBeGreaterThan(1e-9)
    expect(a.bounds.min).toEqual([0, 0, 0])
    expect(a.bounds.max[0]).toBe(FEATURE_BLOCK.x)
    expect(a.bounds.max[1]).toBe(FEATURE_BLOCK.y)
    expect(a.bounds.max[2]).toBe(FEATURE_BLOCK.z)
    expect(signedVolume(a)).toBeGreaterThan(0)
    // This formula is deliberately independent of featureBlock() and its triangles.
    // Pocket: floor rectangle 28 x 24 x 12, plus the draft wedge added by the
    // 15-degree far wall (opening grows ~3.2154 mm over the 12 mm depth).
    const draftGrow = 12 * Math.tan((15 * Math.PI) / 180)
    const pocket = 28 * 24 * 12 + 0.5 * draftGrow * 12 * 24
    const boss = 8 * 10 * 5
    const analytic = 60 * 40 * 20 - pocket - Math.PI * 3 ** 2 * 20 - Math.PI * 3 ** 2 * 10 + (2 / 3) * Math.PI * 7 ** 3 + boss
    expect(FEATURE_BLOCK_SOLID_VOLUME).toBeCloseTo(analytic, 10)
    expect(FEATURE_BLOCK_REMOVED_VOLUME).toBeCloseTo(60 * 40 * 27 - analytic, 10)
    // The 56 x 14 analytic cap tessellation is an approximation of the exact
    // hemisphere, but it must stay within 0.2% of the independently known solid.
    expect(Math.abs(signedVolume(a) - FEATURE_BLOCK_SOLID_VOLUME)).toBeLessThan(FEATURE_BLOCK_SOLID_VOLUME * 0.002)
    expect(a.indices.length / 3).toBeGreaterThan(2_000)
  })

  it('uses the same analytic bounds as its imported STEP twin', async () => {
    const step = await PARTS.find((part) => part.id === 'feature-block-step')!.mesh()
    expect(step.bounds).toEqual(featureBlock().bounds)
  })
})
