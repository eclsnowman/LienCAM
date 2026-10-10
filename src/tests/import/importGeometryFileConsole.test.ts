// @vitest-environment jsdom
//
// WO UI-11B IMPORT lane (acceptance #1b): importGeometryFile's success/failure
// events, and the named silent-catch sites (cache write, :93/:101 in the WO's
// premise inventory) now landing a warning event instead of a swallowed
// rejection. Drives the REAL DXF importer (a hand-built minimal fixture, same
// convention as dxfEmptyLayers.test.ts) — only the IndexedDB-backed cache
// modules are mocked (no real IndexedDB in this env), mirroring
// projectBinaries.test.ts's vi.mock pattern.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

// Harness copied from BottomConsole.smoke.test.tsx: jsdom's default
// localStorage trips zustand's persist middleware here; a plain in-memory
// shim sidesteps it (this file only cares about the consoleEvents slice).
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

const { useCamStore } = await import('../../store')

const cache2DStore = vi.hoisted(() => ({ reject: null as Error | null }))

vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {
    if (cache2DStore.reject) throw cache2DStore.reject
  }),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
}))

const dxfImporterActual = await vi.importActual<typeof import('../../lib/import/dxfImporter')>(
  '../../lib/import/dxfImporter',
)
const importDXFSpy = vi.fn(dxfImporterActual.importDXF)
vi.mock('../../lib/import/dxfImporter', () => typedMock<typeof import('../../lib/import/dxfImporter')>({
  importDXF: (...args: Parameters<typeof dxfImporterActual.importDXF>) => importDXFSpy(...args),
}))

const { importGeometryFile } = await import('../../lib/import/importGeometryFile')

// A minimal single-circle DXF (same hand-built convention as dxfEmptyLayers.test.ts).
function dxf(pairs: Array<[number | string, string]>): string {
  return pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}
const MINIMAL_DXF = dxf([
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'CIRCLE'], [8, 'Cut'], [10, '5.0'], [20, '5.0'], [40, '2.5'],
  [0, 'ENDSEC'],
  [0, 'EOF'],
])

function dxfFile(name = 'part.dxf', text = MINIMAL_DXF): File {
  return new File([text], name, { type: 'application/dxf' })
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function makeDeps() {
  return {
    importBrepGeometry: vi.fn(),
    addGeometry: vi.fn(),
  }
}

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  cache2DStore.reject = null
  importDXFSpy.mockClear()
  importDXFSpy.mockImplementation(dxfImporterActual.importDXF)
})

describe('importGeometryFile console writer: success', () => {
  it('lands exactly one success/import event naming the file, with an entityRef to the new geometry', async () => {
    const deps = makeDeps()
    await importGeometryFile(dxfFile('bracket.dxf'), deps)

    expect(deps.addGeometry).toHaveBeenCalledTimes(1)
    const geo = deps.addGeometry.mock.calls[0][0]

    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      severity: 'success', source: 'import',
      entityRef: { kind: 'geometry', id: geo.id },
    })
    expect(events[0].message).toContain('bracket.dxf'.replace('.dxf', ''))
  })
})

describe('importGeometryFile console writer: cache-write failure (named silent catch)', () => {
  it('still imports (addGeometry called, success event lands) AND lands a warning event for the failed cache write', async () => {
    cache2DStore.reject = new Error('quota exceeded')
    const deps = makeDeps()
    await importGeometryFile(dxfFile(), deps)
    await flush() // the cache write is fire-and-forget (.catch, not awaited)

    expect(deps.addGeometry).toHaveBeenCalledTimes(1) // import behavior unchanged
    const events = useCamStore.getState().consoleEvents
    expect(events.map((e) => e.severity)).toEqual(['success', 'warning'])
    expect(events[1].source).toBe('import')
    expect(events[1].message).toContain('quota exceeded')
  })
})

describe('importGeometryFile console writer: import failure', () => {
  it('lands exactly one error/import event and does NOT call addGeometry; rethrows (behavior unchanged)', async () => {
    importDXFSpy.mockImplementationOnce(() => { throw new Error('malformed DXF') })
    const deps = makeDeps()

    await expect(importGeometryFile(dxfFile('bad.dxf'), deps)).rejects.toThrow('malformed DXF')

    expect(deps.addGeometry).not.toHaveBeenCalled()
    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ severity: 'error', source: 'import' })
    expect(events[0].message).toContain('bad.dxf')
    expect(events[0].message).toContain('malformed DXF')
  })
})
