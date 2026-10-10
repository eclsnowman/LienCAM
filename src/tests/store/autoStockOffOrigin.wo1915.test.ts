// @vitest-environment jsdom
//
// WO-1915: Auto Stock hugs a part that sits away from the work origin.
// A DXF imported with "Keep drawing origin" on (WO-1900/1904) puts a 20 x 10 mm
// part at X100..120 Y50..60. Auto Stock must be that footprint plus padding,
// never a box stretched back to the origin. A centred part is unchanged.
//
// Goes through the production path: importGeometryFile -> the REAL store
// addGeometry -> the store's own derived stock bounds, and also the pure
// deriveAutoStockBounds the viewport reads.

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

vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { deriveAutoStockBounds } = await import('../../store/dispatchGeo')
const { deriveStockBounds } = await import('../../store/stockAssignment')
const { importGeometryFile } = await import('../../lib/import/importGeometryFile')

const pristine = useCamStore.getState().project
type Pairs = Array<[number | string, string]>
function dxf(pairs: Pairs): string {
  return [[0, 'SECTION'], [2, 'ENTITIES'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']]
    .map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}
function line(x0: number, y0: number, x1: number, y1: number): Pairs {
  return [[0, 'LINE'], [8, 'Cut'], [10, `${x0}`], [20, `${y0}`], [11, `${x1}`], [21, `${y1}`]]
}
const RECT_AT_100_50 = dxf([
  ...line(100, 50, 120, 50), ...line(120, 50, 120, 60),
  ...line(120, 60, 100, 60), ...line(100, 60, 100, 50),
])
const file = () => new File([RECT_AT_100_50], 'rect-100-50.dxf', { type: 'application/dxf' })

async function importPart(keepOrigin: boolean) {
  useCamStore.setState({ project: structuredClone(pristine) })
  await importGeometryFile(
    file(),
    { importBrepGeometry: vi.fn(), addGeometry: useCamStore.getState().addGeometry },
    { keepOrigin },
  )
  return useCamStore.getState().project
}

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})

describe('WO-1915 auto stock hugs the part', () => {
  it('off-origin part (X100..120 Y50..60): stock = part + padding on every route', async () => {
    const project = await importPart(true)
    const ss = { ...project.sceneStock, mode: 'auto' as const }
    const pad = ss.autoOffsetXY
    const want = { minX: 100 - pad, minY: 50 - pad, maxX: 120 + pad, maxY: 60 + pad }

    const box = deriveAutoStockBounds(project.geometry, ss)
    expect(box).not.toBeNull()
    expect([box!.min.x, box!.min.y, box!.max.x, box!.max.y])
      .toEqual([want.minX, want.minY, want.maxX, want.maxY])

    const stocks = project.stocks ?? []
    const derived = stocks.filter((s) => s.mode === 'derived')
    expect(derived.length).toBeGreaterThan(0)
    for (const stock of derived) {
      const b = deriveStockBounds(stock, project.geometry, ss, undefined, stocks)
      if (!b) continue
      expect([b.min.x, b.min.y, b.max.x, b.max.y])
        .toEqual([want.minX, want.minY, want.maxX, want.maxY])
    }
  })

  it('centred part: bounds are the same padded footprint around the origin', async () => {
    const project = await importPart(false)
    const ss = { ...project.sceneStock, mode: 'auto' as const }
    const pad = ss.autoOffsetXY
    const box = deriveAutoStockBounds(project.geometry, ss)!
    expect([box.min.x, box.min.y, box.max.x, box.max.y])
      .toEqual([-10 - pad, -5 - pad, 10 + pad, 5 + pad])
  })
})
