// WO MSH-4-MESHLAB-PROOF: module-level proof of the lab's own brep-operand builder
// (src/components/meshlab/geomOperand.ts). Runs the REAL occt-wasm kernel via
// createLocalGeomService (no Worker) -- same pattern src/tests/mesh/crossDomainBoolean.test.ts
// already uses for GeomEngine directly, just through this lab's own wrapper.
import { afterEach, describe, expect, it } from 'vitest'
import { createGeomOperandClient, type GeomOperandClient } from '../../components/meshlab/geomOperand'

describe('geomOperand (MSH-4 lab wire)', () => {
  let client: GeomOperandClient | null = null

  afterEach(() => {
    client?.terminate()
    client = null
  })

  it('builds a box primitive and tessellates it into real position/index buffers', async () => {
    client = createGeomOperandClient()
    const built = await client.buildPrimitive({ shape: 'box', box: { x: 10, y: 10, z: 10 }, cylinderRadius: 5, cylinderHeight: 10 }, 0.1)
    expect(built.shape).toBe('box')
    // a box has 6 planar faces -> exactly 12 triangles at any tolerance.
    expect(built.triangleCount).toBe(12)
    expect(built.tess.position.length).toBeGreaterThan(0)
    expect(built.tess.index.length).toBe(built.triangleCount * 3)
    expect(built.ms).toBeGreaterThanOrEqual(0)
  }, 30_000)

  it('a box is tolerance-INVARIANT (planar faces have zero deflection error) -- same triangle count at two very different tolerances', async () => {
    client = createGeomOperandClient()
    const coarse = await client.buildPrimitive({ shape: 'box', box: { x: 8, y: 8, z: 8 }, cylinderRadius: 5, cylinderHeight: 10 }, 1.0)
    const fine = await client.buildPrimitive({ shape: 'box', box: { x: 8, y: 8, z: 8 }, cylinderRadius: 5, cylinderHeight: 10 }, 0.01)
    expect(coarse.triangleCount).toBe(12)
    expect(fine.triangleCount).toBe(12)
  }, 30_000)

  it('a cylinder is tolerance-REAL -- strictly more triangles at a tighter tolerance (curved wall)', async () => {
    client = createGeomOperandClient()
    const coarse = await client.buildPrimitive({ shape: 'cylinder', box: { x: 1, y: 1, z: 1 }, cylinderRadius: 8, cylinderHeight: 20 }, 0.5)
    const fine = await client.buildPrimitive({ shape: 'cylinder', box: { x: 1, y: 1, z: 1 }, cylinderRadius: 8, cylinderHeight: 20 }, 0.02)
    expect(fine.triangleCount).toBeGreaterThan(coarse.triangleCount)
  }, 30_000)

  it('lazy-inits on first buildPrimitive call and is idempotent across repeated builds', async () => {
    client = createGeomOperandClient()
    const first = await client.buildPrimitive({ shape: 'box', box: { x: 5, y: 5, z: 5 }, cylinderRadius: 5, cylinderHeight: 10 }, 0.1)
    const second = await client.buildPrimitive({ shape: 'box', box: { x: 3, y: 3, z: 3 }, cylinderRadius: 5, cylinderHeight: 10 }, 0.1)
    expect(first.triangleCount).toBe(12)
    expect(second.triangleCount).toBe(12)
  }, 30_000)

  it('FAILS-IF: a non-positive tolerance is refused loudly, never silently clamped', async () => {
    client = createGeomOperandClient()
    await expect(client.buildPrimitive({ shape: 'box', box: { x: 5, y: 5, z: 5 }, cylinderRadius: 5, cylinderHeight: 10 }, 0)).rejects.toThrow(/tolerance/i)
    await expect(client.buildPrimitive({ shape: 'box', box: { x: 5, y: 5, z: 5 }, cylinderRadius: 5, cylinderHeight: 10 }, -1)).rejects.toThrow(/tolerance/i)
  }, 30_000)
})
