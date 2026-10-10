// CAM-13 last-mile: the store's importBrepGeometry writes the file's embedded
// part name/color (from the shared reader) into the ImportedGeometry the CAM
// tree renders - name into `.name` (the rename field), color into `.color` (the
// swatch field the color picker writes), so "the user can change them after"
// (Operator Q-33) works with zero extra UI. Degrade path keeps filename + default
// swatch and emits a named console warning.
//
// The occt seams (IndexedDB cache, model worker) and the geom reader are mocked;
// the reader's real behavior is covered by stepAttributes*.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { StepDisplayAttributes } from '../../lib/import/stepAttributes'
import { typedMock } from '../support/typedMock'

const readStepDisplayAttributes = vi.fn<() => Promise<StepDisplayAttributes>>()

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  removeCachedStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
}))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (orig) => {
  const actual = await orig<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()
  return typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...actual,
    readStep: vi.fn(async (): Promise<BrepModelPayload> => ({
      mesh: {
        positions: new Float32Array(0), normals: new Float32Array(0),
        indices: new Uint32Array(0), faceRanges: new Uint32Array(0),
      },
      edges: { positions: new Float32Array(0), edgeRanges: new Uint32Array(0) },
      faceTypes: new Uint8Array(0), faceCount: 0, edgeCount: 0, solidCount: 1,
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    })),
    setBrepPayload: vi.fn(),
  })
})
vi.mock('../../lib/import/stepAttributes', () => typedMock<typeof import('../../lib/import/stepAttributes')>({
  readStepDisplayAttributes: () => readStepDisplayAttributes(),
}))

import { useCamStore } from '../../store'

const BREP_DEFAULT_COLOR = '#8ab4cc'

function fakeStepFile(name: string): File {
  return { name, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File
}
function newestGeometry(filename: string) {
  return useCamStore.getState().project.geometry.filter((g) => g.filename === filename).at(-1)
}

describe('CAM-13 store: importBrepGeometry applies embedded name/color', () => {
  beforeEach(() => {
    readStepDisplayAttributes.mockReset()
    // importBrepGeometry reads window.__cncViewport (the viewport bridge) after
    // adding the geometry; provide an empty window so that access is a no-op
    // instead of a ReferenceError in the node test env.
    vi.stubGlobal('window', {})
    useCamStore.setState({ consoleEvents: [], brepImportError: null })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('embedded name + color land in the geometry the tree renders', async () => {
    readStepDisplayAttributes.mockResolvedValue({ name: 'Bracket', color: '#d93326', partCount: 1 })
    await useCamStore.getState().importBrepGeometry(fakeStepFile('assembly-part.step'))

    const geo = newestGeometry('assembly-part.step')
    expect(geo).toBeDefined()
    expect(geo!.name).toBe('Bracket')            // NOT the filename 'assembly-part'
    expect(geo!.color).toBe('#d93326')           // NOT BREP_DEFAULT_COLOR
    expect(useCamStore.getState().brepImportError).toBeNull()
    // No degrade warning when the read succeeded.
    expect(useCamStore.getState().consoleEvents.some((e) => e.severity === 'warning')).toBe(false)
  })

  it('no embedded name/color -> filename + default swatch (unchanged behavior)', async () => {
    readStepDisplayAttributes.mockResolvedValue({ name: undefined, color: undefined, partCount: 1 })
    await useCamStore.getState().importBrepGeometry(fakeStepFile('widget.step'))

    const geo = newestGeometry('widget.step')
    expect(geo!.name).toBe('widget')             // filename fallback
    expect(geo!.color).toBe(BREP_DEFAULT_COLOR)
  })

  it('a failed attribute read degrades to defaults AND emits a named console warning', async () => {
    readStepDisplayAttributes.mockResolvedValue({ partCount: 0, warning: 'kernel init failed' })
    await useCamStore.getState().importBrepGeometry(fakeStepFile('vendor.step'))

    const geo = newestGeometry('vendor.step')
    expect(geo!.name).toBe('vendor')
    expect(geo!.color).toBe(BREP_DEFAULT_COLOR)
    const warn = useCamStore.getState().consoleEvents.find((e) => e.severity === 'warning' && e.source === 'import')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('vendor.step')
    expect(warn!.message).toContain('kernel init failed')
  })
})
