// GEO-2 acceptance #1/#2 — STEP import: face/edge stable IDs, determinism,
// XCAF names/colors (with documented fallback), and the import->export->
// reimport round-trip fixture. Real occt-wasm kernel in Node (same pattern as
// GEO-1's geom-engine.integration.test.ts).
//
// ENVIRONMENT GAP (see coordination/reports/GEO-2.report.json): the WO's own
// acceptance text names `Sample Parts/Tray.step` (696 faces) as the reference
// part. That file does not exist anywhere in this worktree/environment (git
// history + filesystem search both confirm it was never committed — it was
// benched on Operator's workstation directly per coordination/board.json's log,
// not checked into git). The largest real STEP file actually available here
// is `Sample Parts/Step Test With Holes.step` (87 faces via ADVANCED_FACE
// count), used below as the closest available substitute. The import logic
// itself is generic (not hardcoded to any specific file), so it is expected
// to behave identically on Tray.step once that file is supplied.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { EDGE_JOIN } from '../../doc/stable-id.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function loadFixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURES, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe('STEP import (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('imports a real vendor STEP file to >=1 body with every face given an import-rooted stable ID', async () => {
    const bytes = loadFixtureBytes('step-test-with-holes.step')
    const { bodies, diagnostics } = await engine.importStep(bytes, 'IMP1')
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(false)
    expect(bodies.length).toBeGreaterThanOrEqual(1)

    const totalFaces = bodies.reduce((n, b) => n + b.elementMap.generated.length, 0)
    // ADVANCED_FACE count in the source file (measured: 87).
    expect(totalFaces).toBe(87)
    for (const b of bodies) {
      for (const id of b.elementMap.generated) {
        expect(id).toMatch(/^IMP1:step:face#\d+$/)
      }
      // ICR-1 inline geometry rides every generated id.
      expect(b.elementMap.geometry).toBeDefined()
      for (const id of b.elementMap.generated) {
        expect(b.elementMap.geometry?.[id]).toBeDefined()
      }
    }
    await engine.disposeAll()
  }, 60_000)

  it('every face AND edge gets a stable ID (edges derive from face adjacency via tessellate)', async () => {
    const bytes = loadFixtureBytes('step-test-with-holes.step')
    const { bodies } = await engine.importStep(bytes, 'IMP2')
    for (const b of bodies) {
      const tess = await engine.tessellate(b.handle, { deflection: 0.5 })
      expect(tess.faceIds.length).toBeGreaterThan(0)
      expect(tess.faceIds.every((id) => id.startsWith('IMP2:step:face#'))).toBe(true)
      expect(tess.edgeIds.length).toBeGreaterThan(0)
      // Every edge ID is either a face-pair wedge or a seam, never UNMAPPED.
      for (const id of tess.edgeIds) {
        expect(id.startsWith('(')).toBe(true)
        expect(id.includes(EDGE_JOIN) || id.includes('seam#')).toBe(true)
      }
    }
    await engine.disposeAll()
  }, 60_000)

  it('names/colors: populated from XCAF when present, else deterministic IMPn:step:body#k fallback', async () => {
    const bytes = loadFixtureBytes('step-test-with-holes.step')
    const { bodies } = await engine.importStep(bytes, 'IMP3')
    for (const b of bodies) {
      expect(typeof b.name).toBe('string')
      expect(b.name!.length).toBeGreaterThan(0)
      // color is optional (this fixture carries no XCAF color) but must never
      // be an undocumented crash/undefined-vs-missing ambiguity: either a
      // well-formed RGB triple or entirely absent.
      if (b.color !== undefined) {
        expect(b.color).toHaveLength(3)
      }
    }
    await engine.disposeAll()
  }, 60_000)

  it('deterministic across two imports in one session: byte-identical face-id sets', async () => {
    const bytes = loadFixtureBytes('step-test-with-holes.step')
    async function importIds(importId: string): Promise<string[]> {
      const { bodies } = await engine.importStep(bytes, importId)
      const ids = bodies.flatMap((b) => b.elementMap.generated)
      await engine.disposeAll()
      return ids.map((id) => id.replace(importId, 'IMP')).sort()
    }
    const run1 = await importIds('IMPA')
    const run2 = await importIds('IMPB')
    expect(run2).toEqual(run1)
    expect(run1.length).toBe(87)
  }, 60_000)

  it('GEO-2-R1.5: emission ORDER of generated[] per body is stable across two imports (not just the id SET)', async () => {
    // The prior test normalizes+SORTS before comparing, which proves the
    // face-id set is identical but would not catch a nondeterministic
    // ordering in #collectXCAFLeaves / getRoots-getChildren traversal (the
    // XCAF walk order). Compare the per-body generated[] arrays UNSORTED
    // (normalized to the import prefix only) so an order regression fails.
    const bytes = loadFixtureBytes('step-test-with-holes.step')
    async function importOrdered(importId: string): Promise<string[][]> {
      const { bodies } = await engine.importStep(bytes, importId)
      const perBody = bodies.map((b) => b.elementMap.generated.map((id) => id.replace(importId, 'IMP')))
      await engine.disposeAll()
      return perBody
    }
    const run1 = await importOrdered('IMPC')
    const run2 = await importOrdered('IMPD')
    expect(run2.length).toBe(run1.length) // same body count, in the same order
    for (let i = 0; i < run1.length; i++) {
      expect(run2[i]).toEqual(run1[i]) // same per-body face-id ORDER, unsorted
    }
  }, 60_000)

  it('fixture STEP round-trips: import -> exportStep -> reimport preserves body count, face count, volume within 0.1%', async () => {
    const bytes = loadFixtureBytes('plate-holes.step')
    const first = await engine.importStep(bytes, 'PH1')
    expect(first.bodies.length).toBeGreaterThanOrEqual(1)
    const firstFaceCount = first.bodies.reduce((n, b) => n + b.elementMap.generated.length, 0)
    let firstVolume = 0
    for (const b of first.bodies) firstVolume += (await engine.measure(b.handle, 'volume')).value

    const handles = first.bodies.map((b) => b.handle)
    const exported = await engine.exportStep(handles)
    expect(exported.byteLength).toBeGreaterThan(0)
    await engine.disposeAll()

    const second = await engine.importStep(exported, 'PH2')
    expect(second.bodies.length).toBe(first.bodies.length)
    const secondFaceCount = second.bodies.reduce((n, b) => n + b.elementMap.generated.length, 0)
    expect(secondFaceCount).toBe(firstFaceCount)
    let secondVolume = 0
    for (const b of second.bodies) secondVolume += (await engine.measure(b.handle, 'volume')).value
    expect(Math.abs(secondVolume - firstVolume) / firstVolume).toBeLessThan(0.001)
    await engine.disposeAll()
  }, 60_000)
})
