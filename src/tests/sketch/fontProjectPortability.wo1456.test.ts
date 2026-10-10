// WO-1456 (Codex audit BUG-502, BUG-504): an imported font was a browser-local
// setting keyed by family NAME. The saved project carried only that name, so a
// fresh browser Finished the sketch with the default face; and importing a
// different file with the same family name re-drew text already authored
// against the first file (in this project, in any other, and even when the
// session that imported it was cancelled).
//
// These drive the real store actions -- importSketchFont, finishSketch,
// saveProjectToFile, loadProjectFromFile, openSketchForLayer, cancelActiveSketch
// -- and compare the manufacturing loops Finish produces. A "fresh context" is a
// fresh module graph (vi.resetModules): a new store and a new, empty font
// registry, with nothing persisted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import helvetikerData from 'three/examples/fonts/helvetiker_regular.typeface.json'
import type { SketchTextEntity } from '../../lib/sketch/types'
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

// TRIAGE 10-09: the stand-in document needs a root element. A fresh module graph
// imports src/i18n (sets documentElement.lang) and uiPrefs -> applyUiTheme
// (set/removeAttribute); without a root both threw after the tests finished
// ("Cannot set properties of undefined (setting 'lang')", src/i18n/index.ts:94).
const STUB_ROOT = { lang: '', setAttribute: () => {}, removeAttribute: () => {} }
class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
vi.stubGlobal('alert', vi.fn())

type Store = typeof import('../../store').useCamStore

const FAMILY = 'WO1456 Sans'
const baseFace = JSON.parse(JSON.stringify(helvetikerData)) as {
  familyName: string
  glyphs: Record<string, { ha: number }>
}
/** File A: helvetiker renamed. */
const faceA = { ...baseFace, familyName: FAMILY }
/** File B: SAME family name, different bytes (every advance widened). */
const faceB = {
  ...baseFace,
  familyName: FAMILY,
  glyphs: Object.fromEntries(Object.entries(baseFace.glyphs).map(([ch, g]) => [ch, { ...g, ha: g.ha * 1.6 }])),
}
const fontFile = (name: string, face: unknown) =>
  new File([JSON.stringify(face)], name, { type: 'application/json' })

async function freshStore(): Promise<Store> {
  vi.resetModules()
  const { useCamStore } = await import('../../store')
  useCamStore.setState((s) => ({
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    lastNonSketchMode: 'setup' as const,
    project: { ...s.project, geometry: [], stocks: [] },
    projectHistory: [],
    sketchHistory: [],
  }))
  return useCamStore
}

const TEXT: SketchTextEntity = {
  id: 'tx', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'HIT', height: 10, rotation: 0,
  fontStyle: 'outline',
}

/** Enter a new sketch, place outline text (optionally with an imported font
 *  applied while editing it), Finish. Returns the text layer id. */
async function authorText(store: Store, font?: File): Promise<string> {
  store.getState().setViewerMode('sketch')
  const sk = store.getState().activeSketch
  expect(sk, 'entering sketch mode opens a document').not.toBeNull()
  store.getState().addEntity({ ...TEXT })
  if (font) {
    store.getState().beginSketchTextEdit('tx')
    await store.getState().importSketchFont(font)
    store.getState().commitSketchTextEdit()
  }
  const layerId = store.getState().activeSketch!.layerId
  store.getState().finishSketch()
  expect(store.getState().activeSketch).toBeNull()
  return layerId
}

function ownerOf(store: Store, layerId: string) {
  return store.getState().project.geometry.find((g) => g.sketches?.some((s) => s.layerId === layerId))!
}

/** The manufacturing geometry on the layer: closed flag + points, id-free. */
function layerLoops(store: Store, layerId: string) {
  return store.getState().project.geometry
    .flatMap((g) => g.loops ?? [])
    .filter((l) => l.layerId === layerId)
    .map((l) => ({ closed: l.closed, points: l.points }))
}

/** Re-open the stored sketch and Finish it again (re-tessellates the text). */
function reopenAndFinish(store: Store, layerId: string): void {
  expect(store.getState().openSketchForLayer(layerId, ownerOf(store, layerId).id)).toBe(true)
  store.getState().setViewerMode('sketch')
  store.getState().finishSketch()
}

async function saveToJson(store: Store): Promise<string> {
  let captured: Blob | null = null
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = ((b: Blob) => { captured = b; return 'blob:wo1456' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  vi.stubGlobal('document', { documentElement: STUB_ROOT, createElement: () => ({ click: () => {} }) })
  try {
    await store.getState().saveProjectToFile()
  } finally {
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
  }
  expect(captured, 'Save produced a file').not.toBeNull()
  return await captured!.text()
}

beforeEach(() => { vi.stubGlobal('document', { documentElement: STUB_ROOT, createElement: () => ({ click: () => {} }) }) })
afterEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('Worker', StubWorker); vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }); vi.stubGlobal('alert', vi.fn()) })

describe('WO-1456: an imported font travels with the project', () => {
  it('a saved project reopened in a fresh context Finishes to the exact geometry it saved (BUG-502)', async () => {
    const control = await freshStore()
    const defaultLoops = layerLoops(control, await authorText(control))

    const store = await freshStore()
    const layerId = await authorText(store, fontFile('wo1456-a.json', faceA))
    const saved = layerLoops(store, layerId)
    expect(saved.length).toBeGreaterThan(0)
    expect(saved, 'the imported face is really in use').not.toEqual(defaultLoops)
    const json = await saveToJson(store)

    const fresh = await freshStore()
    const textKey = (JSON.parse(json).geometry as Array<{ sketches?: Array<{ entities: SketchTextEntity[] }> }>)
      .flatMap((g) => g.sketches ?? []).flatMap((s) => s.entities).find((e) => e.id === 'tx')!.fontFamily!
    const { isFontRegistered } = await import('../../lib/sketch/textOutline')
    expect(isFontRegistered(textKey), 'the fresh context has no browser-local copy of the font').toBe(false)

    await fresh.getState().loadProjectFromFile(json)
    expect(layerLoops(fresh, layerId)).toEqual(saved)
    reopenAndFinish(fresh, layerId)
    expect(fresh.getState().activeSketch).toBeNull()
    expect(layerLoops(fresh, layerId)).toEqual(saved)
  })

  it('importing a byte-different file with the same family name never changes text already authored (BUG-504)', async () => {
    const store = await freshStore()
    const layerId = await authorText(store, fontFile('wo1456-a.json', faceA))
    const before = layerLoops(store, layerId)
    const fileA = await saveToJson(store)

    // Another sketch session imports file B (same family, different bytes).
    store.getState().setViewerMode('sketch')
    await store.getState().importSketchFont(fontFile('wo1456-b.json', faceB))
    store.getState().cancelActiveSketch()

    reopenAndFinish(store, layerId)
    expect(layerLoops(store, layerId), 'this project').toEqual(before)

    // ...and in any other project: reopen the file authored against A here.
    await store.getState().loadProjectFromFile(fileA)
    reopenAndFinish(store, layerId)
    expect(layerLoops(store, layerId), 'another project').toEqual(before)
  })

  it('cancelling the sketch session that imported a font leaves existing text exactly as it was (BUG-504)', async () => {
    const store = await freshStore()
    const layerId = await authorText(store, fontFile('wo1456-a.json', faceA))
    const before = layerLoops(store, layerId)

    expect(store.getState().openSketchForLayer(layerId, ownerOf(store, layerId).id)).toBe(true)
    store.getState().setViewerMode('sketch')
    store.getState().beginSketchTextEdit('tx')
    await store.getState().importSketchFont(fontFile('wo1456-b.json', faceB))
    store.getState().commitSketchTextEdit()
    store.getState().cancelActiveSketch()

    expect(layerLoops(store, layerId)).toEqual(before)
    reopenAndFinish(store, layerId)
    expect(layerLoops(store, layerId)).toEqual(before)
  })

  it('font content missing on open keeps the saved geometry until the operator picks a font', async () => {
    const store = await freshStore()
    const layerId = await authorText(store, fontFile('wo1456-a.json', faceA))
    const saved = layerLoops(store, layerId)
    const file = JSON.parse(await saveToJson(store))
    delete file.fonts

    const fresh = await freshStore()
    await fresh.getState().loadProjectFromFile(JSON.stringify(file))
    reopenAndFinish(fresh, layerId)
    expect(fresh.getState().activeSketch, 'Finish is held, the session stays open').not.toBeNull()
    expect(layerLoops(fresh, layerId), 'no silent default-font substitution').toEqual(saved)
    expect(fresh.getState().consoleEvents.some((e) =>
      e.severity === 'error' && e.message.includes(FAMILY))).toBe(true)

    // The explicit action: pick a font for that text, then Finish.
    fresh.getState().beginSketchTextEdit('tx')
    fresh.getState().setSketchTextFont('Helvetiker')
    fresh.getState().commitSketchTextEdit()
    fresh.getState().finishSketch()
    expect(fresh.getState().activeSketch).toBeNull()
    expect(layerLoops(fresh, layerId).length).toBeGreaterThan(0)
  })

  it('a project with default-font text and no embedded fonts opens and edits normally', async () => {
    const store = await freshStore()
    const layerId = await authorText(store)
    const saved = layerLoops(store, layerId)
    const json = await saveToJson(store)
    expect(JSON.parse(json).fonts).toBeUndefined()

    const fresh = await freshStore()
    await fresh.getState().loadProjectFromFile(json)
    reopenAndFinish(fresh, layerId)
    expect(fresh.getState().activeSketch).toBeNull()
    expect(layerLoops(fresh, layerId)).toEqual(saved)
  })
})
