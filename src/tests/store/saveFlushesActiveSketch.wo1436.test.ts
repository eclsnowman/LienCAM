// WO-1436 (BUG-390): Save while a 2D sketch is open must not silently omit the
// sketch. Drives the REAL saveProjectToFile and reads back the exact JSON the
// browser would have downloaded (URL.createObjectURL is where the Blob lands),
// the same capture int14ProjectDocument.test.ts uses.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { SketchEntity } from '../../lib/sketch/types'
import type { Project } from '../../types'
import { stripSketchAnchors } from '../../lib/sketch/sketchAnchors'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

let savedBlobs: Blob[] = []

beforeEach(() => {
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  // Spy on the real URL (not a stubbed global): the sketch solver worker is
  // built with `new URL(...)` when Save reopens the sketch.
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    savedBlobs.push(blob as Blob)
    return 'blob:wo1436'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('document', {
    createElement: () => ({ href: '', download: '', click: () => {} }),
  })
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchTool: 'select',
    sketchToolChain: null,
    sketchNotice: null,
    sketchEntrySnapshot: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    project: { ...s.project, geometry: [], setups: [], modelItems: [] },
    projectHistory: [],
    projectFuture: [],
    sketchHistory: [],
    sketchFuture: [],
  }))
})

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

async function saveAndRead(): Promise<Project> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return JSON.parse(await savedBlobs[0].text()) as Project
}

/** Open a new sketch and draw a closed 10x10 rectangle WITHOUT clicking Finish. */
function drawRectangleWithoutFinish(): string {
  useCamStore.getState().setViewerMode('sketch')
  const layerId = useCamStore.getState().activeSketch!.layerId
  useCamStore.getState().addEntity(line('b', 0, 0, 10, 0))
  useCamStore.getState().addEntity(line('r', 10, 0, 10, 10))
  useCamStore.getState().addEntity(line('t', 10, 10, 0, 10))
  useCamStore.getState().addEntity(line('l', 0, 10, 0, 0))
  return layerId
}

describe('WO-1436: Save flushes the open sketch draft', () => {
  it('the saved file contains the sketch drawn but not yet finished', async () => {
    const layerId = drawRectangleWithoutFinish()
    const file = await saveAndRead()

    const geo = file.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))
    expect(geo).toBeDefined()
    const loops = (geo!.loops ?? []).filter((l) => l.layerId === layerId)
    expect(loops).toHaveLength(1)
    expect(loops[0].closed).toBe(true)
    expect(loops[0].area).toBeCloseTo(100, 6)
    const doc = geo!.sketches?.find((sk) => sk.layerId === layerId)
    expect(doc).toBeDefined()
    expect(doc!.entities).toHaveLength(4)
  })

  it('Save keeps the operator in the same sketch with the same content', async () => {
    const layerId = drawRectangleWithoutFinish()
    await saveAndRead()

    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('sketch')
    expect(st.activeSketch).not.toBeNull()
    expect(st.activeSketch!.layerId).toBe(layerId)
    expect(stripSketchAnchors(st.activeSketch!).entities).toHaveLength(4)
    expect(st.lastNonSketchMode).toBe('setup')
  })

  it('saving twice replaces the layer loops, it does not duplicate them', async () => {
    const layerId = drawRectangleWithoutFinish()
    await saveAndRead()
    const file = await saveAndRead()
    const geo = file.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))!
    expect((geo.loops ?? []).filter((l) => l.layerId === layerId)).toHaveLength(1)
    expect((geo.sketches ?? []).filter((sk) => sk.layerId === layerId)).toHaveLength(1)
  })

  it('an open sketch with nothing drawn writes no stray document', async () => {
    useCamStore.getState().setViewerMode('sketch')
    // WO-2189: every new sketch is its own part - find it through its layer's owner.
    const layerId = useCamStore.getState().activeSketch!.layerId
    const file = await saveAndRead()
    const geo = file.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))
    expect(geo?.sketches ?? []).toHaveLength(0)
    expect(geo?.loops ?? []).toHaveLength(0)
    expect(useCamStore.getState().viewer.mode).toBe('sketch')
  })
})
