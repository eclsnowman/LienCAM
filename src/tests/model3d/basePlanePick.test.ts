import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ORIGIN_NODE_ID } from '../../doc'
import type { RayLike } from '../../viewport3d'
import {
  BASE_PLANE_PICK_TIE_EPSILON,
  resolveBasePlanePick,
} from '../../components/model3d/workbench/basePlanePick'
import {
  NODE_ID_BY_BASE_PLANE,
} from '../../components/model3d/workbench/basePlanes'
import type { BasePlaneKind } from '../../sketch3d'
import { buildGenesisGlyph } from '../../components/model3d/workbench/genesisGlyphs'

// The closed XY/XZ/YZ domain comes from the production mapping. Adding or
// removing a canonical base plane changes this table automatically.
const PLANE_CASES = (Object.entries(NODE_ID_BY_BASE_PLANE) as Array<[BasePlaneKind, string]>).map(
  ([kind, nodeId]) => ({ kind, nodeId }),
)

const UNIQUE_RAYS: Readonly<Record<BasePlaneKind, RayLike>> = {
  xy: { origin: { x: 20, y: 30, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
  xz: { origin: { x: 20, y: 100, z: 30 }, direction: { x: 0, y: -1, z: 0 } },
  yz: { origin: { x: 100, y: 20, z: 30 }, direction: { x: -1, y: 0, z: 0 } },
}

function glyph(nodeId: string, variant: 'ambient' | 'emphasis' = 'ambient'): THREE.Object3D {
  const result = buildGenesisGlyph(nodeId, variant)
  if (result === null) throw new Error(`expected genesis glyph for ${nodeId}`)
  result.updateMatrixWorld(true)
  return result
}

function ambientCandidates(): Map<string, THREE.Object3D> {
  return new Map(PLANE_CASES.map(({ nodeId }) => [nodeId, glyph(nodeId)]))
}

function expectFiniteSurface(result: ReturnType<typeof resolveBasePlanePick>): void {
  if (result.kind !== 'plane' && result.kind !== 'blocked') throw new Error(`expected surface hit, got ${result.kind}`)
  expect(Number.isFinite(result.distance)).toBe(true)
  expect(result.distance).toBeGreaterThanOrEqual(0)
  for (const value of [
    result.point.x,
    result.point.y,
    result.point.z,
    result.normal.x,
    result.normal.y,
    result.normal.z,
  ]) expect(Number.isFinite(value)).toBe(true)
}

describe('base-plane glyph ray resolver', () => {
  it.each(PLANE_CASES)('$kind resolves to its exact canonical node id', ({ kind, nodeId }) => {
    const result = resolveBasePlanePick(UNIQUE_RAYS[kind], ambientCandidates(), [])

    expect(result.kind).toBe('plane')
    if (result.kind !== 'plane') return
    expect(result.nodeId).toBe(nodeId)
    expectFiniteSurface(result)
  })

  it('excludes Origin and emphasis duplicates by ambient candidate construction', () => {
    const candidates = ambientCandidates()
    const origin = glyph(ORIGIN_NODE_ID)
    const emphasisDuplicate = glyph(NODE_ID_BY_BASE_PLANE.xy, 'emphasis')

    expect([...candidates.keys()]).toEqual(PLANE_CASES.map(({ nodeId }) => nodeId))
    expect([...candidates.values()]).not.toContain(origin)
    expect([...candidates.values()]).not.toContain(emphasisDuplicate)

    const result = resolveBasePlanePick(UNIQUE_RAYS.xy, candidates, [])
    expect(result.kind).toBe('plane')
    if (result.kind === 'plane') expect(result.nodeId).toBe(NODE_ID_BY_BASE_PLANE.xy)
  })

  it('collapses same-root fill triangle hits to one plane identity', () => {
    const ray: RayLike = { origin: { x: 20, y: 20, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    const result = resolveBasePlanePick(ray, ambientCandidates(), [])

    expect(result.kind).toBe('plane')
    if (result.kind === 'plane') expect(result.nodeId).toBe(NODE_ID_BY_BASE_PLANE.xy)
  })

  it('returns a named miss outside every bounded plane glyph', () => {
    const result = resolveBasePlanePick(
      { origin: { x: 5000, y: 5000, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
      ambientCandidates(),
      [],
    )

    expect(result).toEqual({ kind: 'miss', reason: 'no-hit' })
  })

  it.each([
    ['origin.x', { origin: { x: Number.NaN, y: 0, z: 1 }, direction: { x: 0, y: 0, z: -1 } }],
    ['direction.z', { origin: { x: 0, y: 0, z: 1 }, direction: { x: 0, y: 0, z: Number.POSITIVE_INFINITY } }],
  ] as const)('refuses non-finite %s by name', (_field, ray) => {
    expect(resolveBasePlanePick(ray, ambientCandidates(), [])).toEqual({
      kind: 'miss',
      reason: 'non-finite-ray',
    })
  })

  it('refuses a zero-length direction by name', () => {
    expect(resolveBasePlanePick(
      { origin: { x: 0, y: 0, z: 1 }, direction: { x: 0, y: 0, z: 0 } },
      ambientCandidates(),
      [],
    )).toEqual({ kind: 'miss', reason: 'zero-direction' })
  })

  it('a visible body in front blocks the plane and returns finite surface data', () => {
    const blocker = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    blocker.position.z = 10
    blocker.updateMatrixWorld(true)

    const result = resolveBasePlanePick(UNIQUE_RAYS.xy, ambientCandidates(), [blocker])
    expect(result.kind).toBe('blocked')
    expectFiniteSurface(result)
    if (result.kind === 'blocked') expect(result.point.z).toBeCloseTo(10, 8)
  })

  it('the same hidden body does not block the plane', () => {
    const blocker = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    blocker.position.z = 10
    blocker.visible = false
    blocker.updateMatrixWorld(true)

    const result = resolveBasePlanePick(UNIQUE_RAYS.xy, ambientCandidates(), [blocker])
    expect(result.kind).toBe('plane')
    if (result.kind === 'plane') expect(result.nodeId).toBe(NODE_ID_BY_BASE_PLANE.xy)
  })

  it('refuses distinct planes tied within the named epsilon as ambiguous', () => {
    const result = resolveBasePlanePick(
      { origin: { x: 10, y: 10, z: 10 }, direction: { x: -1, y: -1, z: -1 } },
      ambientCandidates(),
      [],
    )

    expect(result.kind).toBe('ambiguous')
    if (result.kind !== 'ambiguous') return
    expect(result.nodeIds).toEqual(PLANE_CASES.map(({ nodeId }) => nodeId).sort())
    expect(Number.isFinite(result.distance)).toBe(true)
    expect(BASE_PLANE_PICK_TIE_EPSILON).toBeGreaterThan(0)
  })
})
