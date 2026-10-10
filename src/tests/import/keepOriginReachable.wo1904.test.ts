// @vitest-environment jsdom
//
// WO-1904: the WO-1900 `keepOrigin` importer option is reachable from the
// product. BOTH production DXF callers pass the choice through - the shared
// geometry import (importGeometryFile) and the sketcher's DXF import
// (toolController.importFileIntoSketch) - and ONE remembered preference
// (uiPrefs.dxfKeepOrigin, set from Settings > DXF import) is what both read.
//
// Acceptance 1: a part at X100 Y50 imported with the choice on keeps the file
// coordinates; with it off (and the default) it re-centres exactly as today.
//
// Harness convention copied from dxfImportReport.wo1840.test.ts (jsdom,
// localStorage shim, IndexedDB caches mocked) and importIntoSketch.wo1860.test.ts
// (minimal SketchDocumentPort for the sketcher route).

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
const { useUiPrefs } = await import('../../store/uiPrefs')
const { importGeometryFile } = await import('../../lib/import/importGeometryFile')
const { bindSketcherDocument, importFileIntoSketch } = await import(
  '../../lib/sketch/sketcher/toolController'
)
const { createBlankSketch } = await import('../../lib/sketch/blankSketch')
type SketchDocumentPort = import('../../lib/sketch/sketcher/ports').SketchDocumentPort
type Sketch = import('../../lib/sketch/types').Sketch

type Pairs = Array<[number | string, string]>
function dxf(pairs: Pairs): string {
  return [[0, 'SECTION'], [2, 'ENTITIES'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']]
    .map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}
function line(x0: number, y0: number, x1: number, y1: number): Pairs {
  return [[0, 'LINE'], [8, 'Cut'], [10, `${x0}`], [20, `${y0}`], [11, `${x1}`], [21, `${y1}`]]
}

// The WO's acceptance-1 fixture: a 20 x 10 rectangle at X100 Y50 in the file's
// own coordinates (its own datum is the drawing origin).
const RECT_AT_100_50 = dxf([
  ...line(100, 50, 120, 50),
  ...line(120, 50, 120, 60),
  ...line(120, 60, 100, 60),
  ...line(100, 60, 100, 50),
])
function dxfFile(name = 'rect-100-50.dxf'): File {
  return new File([RECT_AT_100_50], name, { type: 'application/dxf' })
}

function makeDeps() {
  return { importBrepGeometry: vi.fn(), addGeometry: vi.fn() }
}

// ── Route 2 harness (sketcher), same shape as importIntoSketch.wo1860.test.ts ──
function sketchFixture(): { getSketch: () => Sketch } {
  let sketch: Sketch = createBlankSketch('layer-under-test')
  const port: SketchDocumentPort = {
    getSketch: () => sketch,
    ensureSketch: () => sketch,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 1,
    getProjectCandidates: () => [],
    getSelection: () => [],
    setSelection: () => {},
    getLastStagedSize: () => null,
    setLastStagedSize: () => {},
    notice: () => {},
    beginStep: () => {},
    append: (commit, inferred) => {
      sketch = {
        ...sketch,
        entities: [...sketch.entities, ...commit.entities],
        constraints: [...sketch.constraints, ...commit.constraints, ...inferred],
        dimensions: [...sketch.dimensions, ...(commit.dimensions ?? [])],
      }
    },
    replace: () => {},
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: () => false,
    dragMove: () => {},
    dragEnd: () => {},
    moveDimLabel: () => {},
    openDimEditor: () => {},
    getTextEditId: () => null,
    getPickPathForTextId: () => null,
    editText: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    cancelPickTextPath: () => {},
    placeText: () => {},
    bindTextPath: () => {},
  }
  bindSketcherDocument(port)
  return { getSketch: () => sketch }
}

/** Bounding box of the REAL imported entities, excluding the sketch's own
 *  synthetic origin/axis pseudo-entities (ids start with "__"). */
function importedBBox(sketch: Sketch): { minX: number; minY: number } {
  const points = sketch.entities
    .filter((e) => !e.id.startsWith('__'))
    .flatMap((e) => (e.kind === 'line' ? [e.start, e.end] : []))
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
  }
}

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  bindSketcherDocument(null)
  // The remembered preference is browser-local: reset it to the shipped default
  // between tests so a stray write cannot leak across cases.
  useUiPrefs.setState({ dxfKeepOrigin: false })
})

describe('WO-1904 route 1 - shared geometry import (importGeometryFile)', () => {
  it('keepOrigin on keeps the file coordinates (part at X100 Y50)', async () => {
    const deps = makeDeps()
    await importGeometryFile(dxfFile(), deps, { keepOrigin: true })
    const geo = deps.addGeometry.mock.calls[0][0]
    expect(geo.loops).toHaveLength(1)
    expect(geo.loops[0].points).toEqual([
      { x: 100, y: 50 }, { x: 120, y: 50 }, { x: 120, y: 60 }, { x: 100, y: 60 },
    ])
    expect(useCamStore.getState().consoleEvents[0].message).toContain('drawing origin kept')
  })

  it('keepOrigin off and absent both re-centre as today, with no origin note', async () => {
    for (const options of [{ keepOrigin: false }, {}]) {
      const deps = makeDeps()
      await importGeometryFile(dxfFile(), deps, options)
      const geo = deps.addGeometry.mock.calls[0][0]
      expect(geo.loops[0].points).toEqual([
        { x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 },
      ])
      expect(useCamStore.getState().consoleEvents[0].message).not.toContain('drawing origin kept')
    }
  })
})

describe('WO-1904 route 2 - sketcher DXF import (importFileIntoSketch)', () => {
  it('keepOrigin on keeps the file coordinates; off re-centres (same part)', async () => {
    const kept = sketchFixture()
    await importFileIntoSketch(dxfFile(), { keepOrigin: true })
    const keptBox = importedBBox(kept.getSketch())
    expect(keptBox.minX).toBeCloseTo(100, 1)
    expect(keptBox.minY).toBeCloseTo(50, 1)

    const centred = sketchFixture()
    await importFileIntoSketch(dxfFile(), { keepOrigin: false })
    const centredBox = importedBBox(centred.getSketch())
    expect(centredBox.minX).toBeCloseTo(-10, 1)
    expect(centredBox.minY).toBeCloseTo(-5, 1)
  })
})

describe('WO-1904 - the ONE remembered preference is what the product reads', () => {
  it('uiPrefs.dxfKeepOrigin defaults to false, is settable, and rejects a non-boolean write', () => {
    expect(useUiPrefs.getState().dxfKeepOrigin).toBe(false)
    useUiPrefs.getState().setDxfKeepOrigin(true)
    expect(useUiPrefs.getState().dxfKeepOrigin).toBe(true)
    useUiPrefs.getState().setDxfKeepOrigin('yes' as unknown as boolean)
    expect(useUiPrefs.getState().dxfKeepOrigin).toBe(true)
    useUiPrefs.getState().setDxfKeepOrigin(false)
    expect(useUiPrefs.getState().dxfKeepOrigin).toBe(false)
  })
})