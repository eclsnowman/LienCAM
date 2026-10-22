import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import { GeomEngine, type GeomEngineOptions } from '../../geom/worker/geom-engine'
import { StepImportCache, type StepImportKey } from '../../geom/stepImportCache'
import type { ImportedBody } from '../../geom/geom-service'

const bytes = (path: string) => new Uint8Array(readFileSync(path)).buffer
const engine = new GeomEngine()
const uncached = new GeomEngine({ stepImportCache: false } as GeomEngineOptions)
const parse = vi.spyOn(OcctKernel.prototype, 'importXCAFFromSTEP')
const plainParse = vi.spyOn(OcctKernel.prototype, 'importStep')
const parseCount = () => parse.mock.calls.length + plainParse.mock.calls.length
const quality = { deflection: 0.5 }
const evidence: unknown[] = []
async function witness(e: GeomEngine, bodies: ImportedBody[]) {
  return Promise.all(bodies.map(async b => {
    const mesh = await e.tessellate(b.handle, quality)
    const hash = createHash('sha256')
    for (const value of Object.values(mesh)) hash.update(JSON.stringify(value))
    return { name: b.name, color: b.color, elementMap: b.elementMap,
      snapshots: e.snapshotsFor(b.handle), volume: await e.measure(b.handle, 'volume'),
      resolved: await e.resolve(b.handle, b.elementMap.generated), mesh: hash.digest('hex') }
  }))
}
async function release(e: GeomEngine, bodies: ImportedBody[]) {
  for (const b of bodies) await e.dispose(b.handle)
}
beforeAll(async () => { await engine.init(); await uncached.init() }, 60_000)
afterAll(async () => {
  await engine.disposeKernel(); await uncached.disposeKernel()
  vi.restoreAllMocks()
  if (process.env.WO2927_RECORD === '1') {
    mkdirSync('src/tests/evidence/WO-2927', { recursive: true })
    writeFileSync('src/tests/evidence/WO-2927/equivalence.json', JSON.stringify(evidence, null, 2) + '\n')
  }
})

describe('WO-2927 unchanged STEP evaluation', () => {
  it('does not parse again after the previous imported bodies are disposed', async () => {
    const source = bytes('src/tests/geom/fixtures/plate-holes.step')
    const first = await engine.importStep(source, 'REUSE')
    expect(first.bodies.length).toBeGreaterThan(0)
    await release(engine, first.bodies)
    const before = parseCount()
    const second = await engine.importStep(source.slice(0), 'REUSE')
    await release(engine, second.bodies)
    expect(parseCount() - before).toBe(0)
  })

  for (const [name, path] of [
    ['tiny', 'src/tests/geom/fixtures/no-attributes.step'],
    ['medium', 'src/tests/geom/fixtures/plate-holes.step'],
    ['real', 'Sample Parts/Step Test With Holes.step'],
  ]) it(`preserves ${name} meshes, volume, ids, lineage and ownership with reuse on and off`, async () => {
    const source = bytes(path)
    const first = await engine.importStep(source, 'EQUIV')
    expect(first.bodies.length).toBeGreaterThan(0)
    const original = await witness(engine, first.bodies)
    await release(engine, first.bodies)
    const cached = await engine.importStep(source, 'EQUIV')
    const fresh = await uncached.importStep(source, 'EQUIV')
    const actual = await witness(engine, cached.bodies)
    expect(actual).toEqual(original)
    expect(actual).toEqual(await witness(uncached, fresh.bodies))
    expect(cached.diagnostics).toEqual(fresh.diagnostics)
    evidence.push({ name, witness: actual })
    // Mutating returned metadata and editing a body must not poison the cache.
    const body = cached.bodies[0]
    body.elementMap.generated.length = 0
    const tool = await engine.makeBox('TOOL', { x: 1, y: 1, z: 1 })
    const edit = await engine.applyBoolean({ featureId: 'CUT', op: 'cut', target: body.handle, tools: [tool.body!] })
    expect(edit.ok).toBe(true)
    if (edit.body !== undefined) await engine.dispose(edit.body)
    await engine.dispose(tool.body!)
    await release(engine, cached.bodies); await release(uncached, fresh.bodies)
    const again = await engine.importStep(source, 'EQUIV')
    expect(await witness(engine, again.bodies)).toEqual(original)
    await release(engine, again.bodies)
  }, 60_000)

  it('reparses changed bytes or import identity and clears on disposeAll and reset', async () => {
    const source = bytes('src/tests/geom/fixtures/plate-holes.step')
    const changed = new TextEncoder().encode(new TextDecoder().decode(source).replace('ISO-10303-21;', 'ISO-10303-21;\n')).buffer
    for (const [data, id] of [[source, 'KEY'], [changed, 'KEY'], [changed, 'OTHER']] as const) {
      const count = parseCount()
      const result = await engine.importStep(data, id)
      expect(result.bodies.length).toBeGreaterThan(0)
      expect(parseCount()).toBeGreaterThan(count)
      await release(engine, result.bodies)
    }
    await engine.disposeAll()
    expect(engine.debugKernelShapeCount()).toBe(0)
    const count = parseCount()
    const result = await engine.importStep(changed, 'OTHER')
    expect(parseCount()).toBeGreaterThan(count)
    await release(engine, result.bodies)
    await engine.disposeKernel(); await engine.init()
    const countReset = parseCount()
    await release(engine, (await engine.importStep(changed, 'OTHER')).bodies)
    expect(parseCount()).toBeGreaterThan(countReset)
  }, 60_000)

  it('releases every plain-reader shape when reuse is disabled', async () => {
    await uncached.disposeAll()
    parse.mockImplementationOnce(() => { throw new Error('WO-2927 force plain STEP route') })
    const result = await uncached.importStep(bytes('src/tests/geom/fixtures/plate-holes.step'), 'PLAIN')
    expect(result.bodies.length).toBeGreaterThan(0)
    await release(uncached, result.bodies)
    expect(uncached.debugKernelShapeCount()).toBe(0)
  })

  it('preserves fallback diagnostics and releases the plain-reader root', async () => {
    await engine.disposeAll()
    parse.mockImplementationOnce(() => { throw new Error('WO-2927 force plain STEP route') })
    const source = bytes('src/tests/geom/fixtures/plate-holes.step')
    const first = await engine.importStep(source, 'FALLBACK')
    expect(first.bodies.length).toBeGreaterThan(0)
    expect(first.diagnostics.some(d => d.severity === 'warning')).toBe(true)
    const expected = await witness(engine, first.bodies)
    await release(engine, first.bodies)
    const count = parseCount()
    const reused = await engine.importStep(source, 'FALLBACK')
    expect(reused.diagnostics).toEqual(first.diagnostics)
    expect(await witness(engine, reused.bodies)).toEqual(expected)
    expect(parseCount()).toBe(count)
    await release(engine, reused.bodies)
    await engine.disposeAll()
    expect(engine.debugKernelShapeCount()).toBe(0)
  })

  it('keeps kernel shape count stable over twenty recalculations', async () => {
    const source = bytes('Sample Parts/Step Test With Holes.step')
    await release(engine, (await engine.importStep(source, 'SOAK')).bodies)
    const baseline = engine.debugKernelShapeCount()
    const count = parseCount()
    const counts: number[] = []
    for (let i = 0; i < 20; i++) {
      const result = await engine.importStep(source, 'SOAK')
      await engine.tessellate(result.bodies[0].handle, quality)
      await release(engine, result.bodies)
      counts.push(engine.debugKernelShapeCount())
    }
    expect(counts).toEqual(Array(20).fill(baseline))
    expect(parseCount() - count).toBe(0)
    evidence.push({ recalculations: 20, baseline, counts })
  }, 60_000)
})


describe('WO-2927 complete cache key and ownership', () => {
  const key: StepImportKey = { importId: 'IMP', options: 'reader-defaults',
    placement: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], kernelVersion: 'kernel', engineVersion: 'engine' }
  it('misses for every changed key part and every incomplete key', () => {
    const source = new Uint8Array([1, 2, 3]).buffer
    const cache = new StepImportCache<number>(() => {})
    cache.set(source, key, 42)
    expect(cache.get(source.slice(0), key)).toBe(42)
    expect(cache.get(new Uint8Array([1, 2, 4]).buffer, key)).toBeUndefined()
    for (const field of ['importId', 'options', 'kernelVersion', 'engineVersion', 'placement'] as const) {
      const changed = { ...key, [field]: field === 'placement' ? [1, 0, 0, 4, 0, 1, 0, 0, 0, 0, 1, 0] : 'changed' }
      expect(cache.get(source, changed)).toBeUndefined()
      expect(cache.get(source, { ...key, [field]: undefined } as unknown as StepImportKey)).toBeUndefined()
    }
    new Uint8Array(source)[0] = 9
    expect(cache.get(source, key)).toBeUndefined()
    cache.clear()
  })
  it('releases replaced, evicted and cleared entries exactly once', () => {
    const released: number[] = []
    const cache = new StepImportCache<number>(value => released.push(value))
    const source = new Uint8Array([0]).buffer
    cache.set(source, key, 0)
    cache.set(source, key, 1)
    expect(released).toEqual([0])
    for (let i = 2; i <= 9; i++) cache.set(source, { ...key, importId: `IMP${i}` }, i)
    expect(released).toEqual([0, 1])
    cache.clear(); cache.clear()
    expect(released).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
