// @vitest-environment jsdom
//
// IMPORT-STOCK-PROMPT-COMPLETION: focused entrypoint proof that the PRODUCTION
// generic import path (importGeometryFile -> STL/SVG/DXF) RETAINS its call to
// the import-time stock-choice seam. A future refactor that drops the
// `await promptAndApplyImportStockChoice(...)` line would break this test
// regardless of the store's option-building logic. Mirrors the DXF harness in
// importGeometryFileConsole.test.ts (mocked caches + real DXF importer); the
// stock-choice seam is spied so the import completes without a modal.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

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

vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({ cache2DGeometry: vi.fn(async () => {}) }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({ cacheSTL: vi.fn(async () => {}) }))

const { useCamStore } = await import('../../store')
const { importGeometryFile } = await import('../../lib/import/importGeometryFile')

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

function makeDeps() {
  return {
    importBrepGeometry: vi.fn(),
    addGeometry: vi.fn(),
  }
}

describe('importGeometryFile retains the import-time stock-choice call (generic DXF path)', () => {
  beforeEach(() => {
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  })

  it('calls promptAndApplyImportStockChoice with the new geometry id + name', async () => {
    const promptSpy = vi.fn().mockResolvedValue(undefined)
    useCamStore.setState({ promptAndApplyImportStockChoice: promptSpy })

    const deps = makeDeps()
    await importGeometryFile(dxfFile('bracket.dxf'), deps)

    expect(deps.addGeometry).toHaveBeenCalledTimes(1)
    const geo = deps.addGeometry.mock.calls[0][0]
    // The seam is invoked exactly once, naming the just-imported part.
    expect(promptSpy).toHaveBeenCalledTimes(1)
    expect(promptSpy.mock.calls[0][0]).toBe(geo.id)
    expect(promptSpy.mock.calls[0][1]).toBe(geo.name)
  })
})
