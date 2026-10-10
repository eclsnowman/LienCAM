// @vitest-environment jsdom
//
// WO-1824: .igs/.iges opens like a STEP, on the same OCCT kernel.
//
// The kernel half runs on the REAL occt-wasm kernel (createLocalGeomService,
// the same real-kernel harness stepAttributesReadReal.test.ts uses) against
// fixtures this repo generated itself from a known solid - a 40 x 20 x 10 mm box
// with a 6 mm through hole - so every assertion is checkable against what was
// written. See src/tests/evidence/WO-1824/make-fixtures.mjs.
//
// THE PIN THAT MATTERS: the surface-only fixture. IGES is not a solid format,
// and a surface/wireframe file is the common real-world case; LIENCAM.md rule 11
// says the software refuses only what it cannot do. It imports, and it is
// LABELLED for what it is. If someone later "hardens" the importer into
// requiring a solid, that test goes red.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../evidence/WO-1824/fixtures')
const readFixture = (name: string): ArrayBuffer => {
  const b = readFileSync(join(FIXTURES, name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { createLocalGeomService } = await import('../../geom')
// importActual, NOT a plain import: the dispatch section further down mocks
// './igesImporter', and vi.mock is hoisted to the top of the file. These first
// tests must drive the real module on the real kernel.
const { importIGES, describeIgesContent } =
  await vi.importActual<typeof import('../../lib/import/igesImporter')>(
    '../../lib/import/igesImporter',
  )

describe('WO-1824 IGES import on the same kernel as STEP', () => {
  it('reads a solid IGES: one solid, and STEP bytes the shared B-rep path can take', async () => {
    const result = await importIGES(
      readFixture('box-with-hole.solid.igs'), 'IMP1', () => createLocalGeomService(),
    )

    expect(result.content.solids).toBe(1)
    expect(result.label).toBe('1 solid')
    // The kernel re-emits what it read as STEP; that is what makes an IGES part
    // the same kind of part a STEP part is, not a second geometry path.
    const head = new TextDecoder().decode(result.stepBytes.slice(0, 20))
    expect(head.startsWith('ISO-10303-21')).toBe(true)
    expect(result.stepBytes.byteLength).toBeGreaterThan(1000)
  }, 60_000)

  it('imports a surface-only IGES instead of refusing it, and labels it honestly', async () => {
    const result = await importIGES(
      readFixture('box-with-hole.surfaces.igs'), 'IMP2', () => createLocalGeomService(),
    )

    // Same geometry, written as trimmed surfaces (IGES entity 144) rather than
    // an MSBO solid (186). The reader finds no solid...
    expect(result.content.solids).toBe(0)
    expect(result.content.faces).toBeGreaterThan(0)
    // ...and the import still SUCCEEDS (rule 11), saying what it actually is.
    expect(result.label).toContain('surfaces only')
    expect(result.label).toContain('no solid')
    expect(result.stepBytes.byteLength).toBeGreaterThan(0)
  }, 60_000)

  it('refuses a truncated IGES by name, without blaming the operator', async () => {
    await expect(importIGES(
      readFixture('truncated.igs'), 'IMP3', () => createLocalGeomService(),
    )).rejects.toThrow()

    const err = await importIGES(
      readFixture('truncated.igs'), 'IMP4', () => createLocalGeomService(),
    ).then(() => new Error('expected a refusal, got a result'), (e: unknown) => e as Error)

    // Names the kernel's own reason. Never a remedy that hands our problem back
    // to the operator (LIENCAM.md rule 11).
    expect(err.message).toMatch(/iges/i)
    expect(err.message).not.toMatch(/re-?export|re-?post|re-?save|try again|another format/i)
  }, 60_000)

  it('describeIgesContent names wireframe as wireframe, never as a solid', () => {
    expect(describeIgesContent({ solids: 2, shells: 0, faces: 12, wires: 0, edges: 0 }))
      .toBe('2 solids')
    expect(describeIgesContent({ solids: 0, shells: 0, faces: 0, wires: 4, edges: 9 }))
      .toBe('wireframe only -- 9 curves, no surfaces')
    expect(describeIgesContent({ solids: 0, shells: 0, faces: 0, wires: 0, edges: 0 }))
      .toBe('no geometry')
  })
})

// ---------------------------------------------------------------------------
// Dispatch. importGeometryFile is the one place the app decides what an
// extension means; these pin that .igs/.iges reach the IGES reader and the
// shared B-rep import, and that nothing re-parses the bytes as STEP.
// ---------------------------------------------------------------------------

const igesImporterStub = vi.hoisted(() => ({
  calls: [] as Array<{ bytes: ArrayBuffer; importId: string }>,
  solids: 1,
  throwWith: null as Error | null,
}))

vi.mock('../../lib/import/igesImporter', async () => {
  const actual = await vi.importActual<typeof import('../../lib/import/igesImporter')>(
    '../../lib/import/igesImporter',
  )
  return typedMock<typeof import('../../lib/import/igesImporter')>({
    describeIgesContent: actual.describeIgesContent,
    importIGES: vi.fn(async (bytes: ArrayBuffer, importId: string) => {
      igesImporterStub.calls.push({ bytes, importId })
      if (igesImporterStub.throwWith) throw igesImporterStub.throwWith
      const content = {
        solids: igesImporterStub.solids,
        shells: 0,
        faces: igesImporterStub.solids > 0 ? 6 : 6,
        wires: 0,
        edges: 12,
      }
      return {
        stepBytes: new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;\n').buffer as ArrayBuffer,
        content,
        label: actual.describeIgesContent(content),
      }
    }),
  })
})
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { importGeometryFile } = await import('../../lib/import/importGeometryFile')

describe('WO-1824 importGeometryFile dispatch', () => {
  beforeEach(() => {
    igesImporterStub.calls.length = 0
    igesImporterStub.solids = 1
    igesImporterStub.throwWith = null
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  })

  const events = () => useCamStore.getState().consoleEvents

  for (const ext of ['igs', 'iges', 'IGES']) {
    it(`routes .${ext} to the IGES reader and then the shared B-rep import`, async () => {
      const importBrepGeometry = vi.fn(async () => {})
      const addGeometry = vi.fn()
      await importGeometryFile(
        new File([readFixture('box-with-hole.solid.igs')], `widget.${ext}`),
        { importBrepGeometry, addGeometry },
      )

      expect(igesImporterStub.calls).toHaveLength(1)
      expect(importBrepGeometry).toHaveBeenCalledTimes(1)
      // The B-rep path receives the KERNEL's STEP re-emission, under the
      // operator's own filename - not the original IGES bytes retried as STEP.
      const handed = (importBrepGeometry.mock.calls[0] as unknown[])[0] as File
      expect(handed.name).toBe(`widget.${ext}`)
      expect(new TextDecoder().decode(await handed.arrayBuffer())).toContain('ISO-10303-21')
      // The non-B-rep branch (addGeometry) must not also fire: one part, one path.
      expect(addGeometry).not.toHaveBeenCalled()

      const msg = events().find((e) => e.source === 'import')?.message ?? ''
      expect(msg).toContain('IGES')
      expect(msg).toContain('1 solid')
    })
  }

  it('says "surfaces only" as a warning when the file carried no solid', async () => {
    igesImporterStub.solids = 0
    await importGeometryFile(
      new File([readFixture('box-with-hole.surfaces.igs')], 'panel.iges'),
      { importBrepGeometry: vi.fn(async () => {}), addGeometry: vi.fn() },
    )
    const ev = events().find((e) => e.source === 'import')
    expect(ev?.severity).toBe('warning')
    expect(ev?.message).toContain('surfaces only')
  })

  it('reports a kernel refusal as an import error and never retries the file as STEP', async () => {
    igesImporterStub.throwWith = new Error('importIges: failed to read IGES data')
    const importBrepGeometry = vi.fn(async () => {})
    await expect(importGeometryFile(
      new File([readFixture('truncated.igs')], 'broken.igs'),
      { importBrepGeometry, addGeometry: vi.fn() },
    )).rejects.toThrow(/failed to read IGES data/)

    expect(importBrepGeometry).not.toHaveBeenCalled()
    const ev = events().find((e) => e.source === 'import')
    expect(ev?.severity).toBe('error')
    expect(ev?.message).toContain('failed to read IGES data')
  })
})
