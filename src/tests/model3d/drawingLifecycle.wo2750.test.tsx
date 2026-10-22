// @vitest-environment jsdom
//
// WO-2994 (WO-2750 Slice C): the drawing lifecycle through the REAL Model page,
// the real local kernel and the real store - docs/design/ASSOCIATIVE-TECHNICAL-
// DRAWINGS.md section 8 rows owned by this file:
//   - "Add unrelated feature; change source placement" / edit the part: the
//     views follow the part, the drawing keeps its layout, the edit is dirty.
//   - "Split/merge/reorder/suppress/rollback" + undo/redo: the same path decides
//     the drawing's state forward and back (here: suppress, delete, undo, redo).
//   - "Save/reopen; never open Model before next save": the drawing survives a
//     save made while the Model was never mounted, and opens again after.
//   - "Delete source; undo": the drawing stays, says in words that its part was
//     deleted (rule 11), keeps its last views; undo links it again.
//   - "Async edit A, then B; switch item during A": a late A never publishes
//     over B, and never into another item.
//
// The one staged thing is TIMING: a proxy around the real kernel holds the
// drawing's own tessellation reads (DRAWING_TESS_QUALITY, a separate tier from
// the viewport's) until the test releases them. Geometry is the kernel's.

import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { useCamStore, liveProjectSaveState } = await import('../../store')
const { resetDocumentHolder, getDrawingRecords, LEGACY_MODEL_ITEM_ID } = await import('../../doc/documentHolder')
const { DRAWING_TESS_QUALITY, resetDrawingSession } = await import('../../components/model3d/drawing/DrawingEntry')
const { resetDrawnViews } = await import('../../components/model3d/drawing/DrawingEditor')
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { GeomClient } from '../../geom'
import type { BodyHandle, TessBuffers, TessQuality } from '../../geom/geom-service'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
let savedBlobs: Blob[] = []
let savedCreateObjectURL: typeof URL.createObjectURL
let savedRevokeObjectURL: typeof URL.revokeObjectURL

beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  resetDocumentHolder()
  resetDrawingSession()
  resetDrawnViews()
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  savedCreateObjectURL = URL.createObjectURL
  savedRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:wo2994' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
})
afterEach(() => {
  restoreCanvas2d?.()
  restoreCanvas2d = null
  URL.createObjectURL = savedCreateObjectURL
  URL.revokeObjectURL = savedRevokeObjectURL
  vi.unstubAllGlobals()
  resetDocumentHolder()
  resetDrawingSession()
  resetDrawnViews()
})

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

/**
 * The real local kernel with one seam: while `hold` is on, the drawing's own
 * tessellation reads (DRAWING_TESS_QUALITY) compute their real result at once
 * and then wait for `release()`. The viewport's tiers are never held.
 */
interface GatedClient {
  create: () => GeomClient
  hold: boolean
  held: Array<{ handle: BodyHandle; release: () => void; result: TessBuffers }>
}
function gatedKernel(): GatedClient {
  const gate: GatedClient = {
    hold: false,
    held: [],
    create: () => {
      const real = createLocalGeomService()
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'tessellate') {
            return async (h: BodyHandle, q: TessQuality) => {
              const result = await target.tessellate(h, q)
              if (q !== DRAWING_TESS_QUALITY || !gate.hold) return result
              return await new Promise<TessBuffers>((resolve) => {
                gate.held.push({ handle: h, result, release: () => resolve(result) })
              })
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
  return gate
}

/**
 * Give a released (late) projection time to run to its end: four views, each
 * followed by a yield, take well under this on a loaded box. A guard that
 * works publishes nothing however long this is; one that is missing has
 * published by the end of it.
 */
async function settleLateWork(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500))
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
}

/** A 40x20 rectangle extruded `depth` mm: F1 is the body. */
async function buildPart(depth = '20'): Promise<void> {
  await ready()
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', depth)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(screen.getByTestId('body-row-F1')).toBeTruthy())
}

/** Edit F1's extrude distance through the tree's Edit and the real dialog. */
async function editDepth(depth: string): Promise<void> {
  const before = hooks().getBodyHandle('F1')
  fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
  fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
  await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
  commitField('extrude-distance', depth)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => {
    const now = hooks().getBodyHandle('F1')
    expect(now).not.toBeUndefined()
    expect(now).not.toBe(before)
  }, { timeout: 30_000 })
}

async function createAndOpenDrawing(): Promise<string> {
  if (screen.queryByTestId('drawing-create') === null) fireEvent.click(screen.getByTestId('workbench-section-drawings-header'))
  await waitFor(() => expect((screen.getByTestId('drawing-create') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByTestId('drawing-create'))
  await waitFor(() => expect(screen.getByTestId('drawing-editor')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
  return screen.getByTestId('drawing-editor').getAttribute('data-drawing-id') as string
}

function sheetGeometry(): string {
  return screen.getByTestId('drawing-sheet').getAttribute('data-geometry') ?? ''
}

function viewLines(name: 'front' | 'top' | 'right' | 'iso'): number {
  return Number(screen.getByTestId(`drawing-view-${name}`).getAttribute('data-lines'))
}

/** The front view's sheet width in mm: the part's X length times the view scale. */
function frontWidthMm(): number {
  const xs: number[] = []
  for (const pl of screen.getByTestId('drawing-view-front').querySelectorAll('polyline')) {
    for (const pair of (pl.getAttribute('points') ?? '').split(' ')) xs.push(Number(pair.split(',')[0]))
  }
  return Math.max(...xs) - Math.min(...xs)
}
function frontHeightMm(): number {
  const ys: number[] = []
  for (const pl of screen.getByTestId('drawing-view-front').querySelectorAll('polyline')) {
    for (const pair of (pl.getAttribute('points') ?? '').split(' ')) ys.push(Number(pair.split(',')[1]))
  }
  return Math.max(...ys) - Math.min(...ys)
}

describe('WO-2994 drawing lifecycle through the Model page (WO-2750 section 8)', () => {
  it('an edit to the part redraws the views, keeps the layout, and an edit to the drawing is unsaved work', async () => {
    const gate = gatedKernel()
    render(<SolidsWorkbenchPage createClient={gate.create} createSceneRuntime={createFakeSceneRuntime} />)
    await buildPart('20')
    const id = await createAndOpenDrawing()

    // Four views of a real 40 x 20 x 20 box.
    for (const v of ['front', 'top', 'right', 'iso'] as const) expect(viewLines(v)).toBeGreaterThan(0)
    const g20 = sheetGeometry()
    expect(g20).not.toBe('')
    const recordsBefore = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((d) => d.id === id)!
    expect(recordsBefore.lastGoodRevision?.geometryFingerprint).toBe(g20)
    const scale = recordsBefore.sheets[0].views[0].scale
    const k = scale.numerator / scale.denominator
    expect(frontHeightMm()).toBeCloseTo(20 * k, 1)

    // The part gets taller: the views follow, the sheet layout does not move.
    await editDepth('35')
    await waitFor(() => expect(sheetGeometry()).not.toBe(g20), { timeout: 30_000 })
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'))
    expect(frontHeightMm()).toBeCloseTo(35 * k, 1)
    expect(frontWidthMm()).toBeCloseTo(40 * k, 1)
    const after = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((d) => d.id === id)!
    expect(after.lastGoodRevision?.geometryFingerprint).toBe(sheetGeometry())
    expect(after.sheets[0].views.map((v) => v.sheetOriginMm)).toEqual(recordsBefore.sheets[0].views.map((v) => v.sheetOriginMm))

    // Undo the edit: the same path draws the 20 mm part again.
    fireEvent.click(screen.getAllByTestId('workbench-undo')[0])
    await waitFor(() => expect(frontHeightMm()).toBeCloseTo(20 * k, 1), { timeout: 30_000 })
    // ...and redo brings 35 back.
    fireEvent.click(screen.getAllByTestId('workbench-redo')[0])
    await waitFor(() => expect(frontHeightMm()).toBeCloseTo(35 * k, 1), { timeout: 30_000 })

    // A drawing-only edit (sheet size) is unsaved work and reaches the holder.
    savedBlobs = []
    await useCamStore.getState().saveProjectToFile()
    expect(liveProjectSaveState()).toBe('clean')
    fireEvent.change(screen.getByTestId('drawing-sheet-size'), { target: { value: 'a4' } })
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((d) => d.id === id)!.sheets[0].sizeMm).toEqual([297, 210])
    expect(screen.getByTestId('drawing-sheet').getAttribute('data-sheet-size')).toBe('a4')
    expect(liveProjectSaveState()).toBe('unsaved')
  }, 240_000)

  it('undo of a deleted drawing after a new one was made restores it beside the new one; neither loses its sheet', async () => {
    // Audit FIX ROUND 1 (PR #38): create, delete, create again, change the new
    // sheet to A4, then click the deletion notice's Undo, which is still shown.
    const gate = gatedKernel()
    render(<SolidsWorkbenchPage createClient={gate.create} createSceneRuntime={createFakeSceneRuntime} />)
    await buildPart('20')
    const originalId = await createAndOpenDrawing()
    const original = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((d) => d.id === originalId)!
    expect(original.sheets[0].sizeMm).toEqual([279.4, 215.9])

    fireEvent.click(screen.getByTestId(`drawing-remove-${originalId}`))
    await waitFor(() => expect(screen.getByTestId('drawing-removed-notice')).toBeTruthy())
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents).toHaveLength(0)

    const newId = await createAndOpenDrawing()
    fireEvent.change(screen.getByTestId('drawing-sheet-size'), { target: { value: 'a4' } })
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((d) => d.id === newId)!.sheets[0].sizeMm).toEqual([297, 210])

    expect(screen.getByTestId('drawing-undo-remove')).toBeTruthy()
    fireEvent.click(screen.getByTestId('drawing-undo-remove'))

    const docs = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents
    expect(docs).toHaveLength(2)
    const restored = docs.find((d) => d.id !== newId)!
    const kept = docs.find((d) => d.id === newId)!
    expect(restored).toBeDefined()
    expect(kept).toBeDefined()
    expect(restored.id).not.toBe(kept.id)
    expect(restored.name).toBe(original.name)
    expect(restored.sheets[0].sizeMm).toEqual([279.4, 215.9])
    expect(restored.source).toEqual(original.source)
    expect(kept.sheets[0].sizeMm).toEqual([297, 210])
    // Both rows show; the new drawing stays open on its A4 sheet.
    expect(screen.getByTestId(`drawing-row-${restored.id}`)).toBeTruthy()
    expect(screen.getByTestId(`drawing-row-${kept.id}`)).toBeTruthy()
    expect(screen.getByTestId('drawing-editor').getAttribute('data-drawing-id')).toBe(newId)
    expect(screen.getByTestId('drawing-sheet').getAttribute('data-sheet-size')).toBe('a4')
  }, 240_000)

  it('deleting the part keeps the drawing with a plain sentence and its last views; undo links it again; suppress says so', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await buildPart('20')
    const id = await createAndOpenDrawing()
    const g = sheetGeometry()
    const lines = viewLines('front')

    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-delete'))
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F1')).toBeNull())

    const status = screen.getByTestId('drawing-status')
    await waitFor(() => expect(status.getAttribute('data-state')).toBe('last-known'))
    expect(status.textContent).toMatch(/was deleted/)
    expect(status.textContent).toMatch(/Undo the delete/)
    expect(status.textContent).not.toMatch(/Error|undefined|at \w+ \(/)
    // The last views stay on the sheet; the drawing stays in the item.
    expect(viewLines('front')).toBe(lines)
    expect(sheetGeometry()).toBe(g)
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.map((d) => d.id)).toEqual([id])
    expect(screen.getByTestId(`drawing-row-${id}`).getAttribute('data-source')).toBe('deleted')

    // Undo the delete: the link comes back and the views are current again.
    fireEvent.click(screen.getAllByTestId('workbench-undo')[0])
    await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
    expect(sheetGeometry()).toBe(g)
    expect(screen.getByTestId(`drawing-row-${id}`).getAttribute('data-source')).toBe('linked')

    // Suppress: a different sentence, the drawing still kept.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-suppress'))
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('last-known'))
    expect(screen.getByTestId('drawing-status').textContent).toMatch(/suppressed or rolled back/)
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.map((d) => d.id)).toEqual([id])
    // Unsuppress (the same undo path): current again.
    fireEvent.click(screen.getAllByTestId('workbench-undo')[0])
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
  }, 240_000)

  it('a late projection of edit A never publishes over edit B', async () => {
    const gate = gatedKernel()
    render(<SolidsWorkbenchPage createClient={gate.create} createSceneRuntime={createFakeSceneRuntime} />)
    await buildPart('20')
    const id = await createAndOpenDrawing()

    gate.hold = true
    await editDepth('30') // A: its drawing read is held
    await waitFor(() => expect(gate.held.length).toBe(1))
    expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('updating')
    const heldA = gate.held[0]

    gate.hold = false
    await editDepth('45') // B: drawn at once
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
    const gB = sheetGeometry()
    const doc = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((d) => d.id === id)!
    const k = doc.sheets[0].views[0].scale.numerator / doc.sheets[0].views[0].scale.denominator
    expect(frontHeightMm()).toBeCloseTo(45 * k, 1)

    // A finishes late. Nothing it read may reach the sheet or the drawing.
    await act(async () => { heldA.release(); await settleLateWork() })
    expect(sheetGeometry()).toBe(gB)
    expect(frontHeightMm()).toBeCloseTo(45 * k, 1)
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((d) => d.id === id)!.lastGoodRevision?.geometryFingerprint).toBe(gB)
  }, 240_000)

  it('switching items during a projection keeps each item\'s drawing apart; a late result lands nowhere', async () => {
    const gate = gatedKernel()
    const view = render(<SolidsWorkbenchPage modelItemId="item-A" createClient={gate.create} createSceneRuntime={createFakeSceneRuntime} />)
    await buildPart('20')
    const idA = await createAndOpenDrawing()
    const gA = sheetGeometry()

    gate.hold = true
    await editDepth('30')
    await waitFor(() => expect(gate.held.length).toBe(1))

    // Switch to another Model Item while A's read is held.
    view.rerender(<SolidsWorkbenchPage modelItemId="item-B" createClient={gate.create} createSceneRuntime={createFakeSceneRuntime} />)
    gate.hold = false
    await ready()
    expect(screen.queryByTestId('drawing-editor')).toBeNull()
    expect(getDrawingRecords('item-B').documents).toEqual([])

    await act(async () => { gate.held[0].release(); await settleLateWork() })
    // Item B is untouched; item A's drawing still names the revision it last showed.
    expect(getDrawingRecords('item-B').documents).toEqual([])
    expect(screen.queryByTestId('drawing-editor')).toBeNull()
    expect(getDrawingRecords('item-A').documents.find((d) => d.id === idA)!.lastGoodRevision?.geometryFingerprint).toBe(gA)
    expect(getDrawingRecords('item-A').documents.every((d) => d.source.modelItemId === 'item-A')).toBe(true)

    // Back to A: its drawing is still open there and still A's.
    view.rerender(<SolidsWorkbenchPage modelItemId="item-A" createClient={gate.create} createSceneRuntime={createFakeSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('drawing-editor').getAttribute('data-drawing-id')).toBe(idA))
    expect(screen.getByTestId('drawing-editor').getAttribute('data-model-item')).toBe('item-A')
  }, 240_000)

  it('a save made while the Model was never mounted keeps the drawing; reopening shows it again', async () => {
    const first = render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await buildPart('20')
    const id = await createAndOpenDrawing()
    const g = sheetGeometry()
    savedBlobs = []
    await useCamStore.getState().saveProjectToFile()
    const fileOne = await savedBlobs[0].text()
    first.unmount()
    cleanup()
    resetDocumentHolder()
    resetDrawingSession()
    resetDrawnViews()

    // Reopen and save again with the Model never mounted.
    // Opening hydrates the item's archive asynchronously.
    useCamStore.getState().loadProjectFromFile(fileOne)
    await waitFor(() => expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.map((d) => d.id)).toEqual([id]))
    savedBlobs = []
    await useCamStore.getState().saveProjectToFile()
    const fileTwo = await savedBlobs[0].text()
    resetDocumentHolder()
    useCamStore.getState().loadProjectFromFile(fileTwo)
    await waitFor(() => expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents).toHaveLength(1))
    const reopened = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents
    expect(reopened.map((d) => d.id)).toEqual([id])
    expect(reopened[0].lastGoodRevision?.geometryFingerprint).toBe(g)

    // Now open the Model: the drawing is listed and draws the same part.
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await ready()
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
    if (screen.queryByTestId(`drawing-open-${id}`) === null) fireEvent.click(screen.getByTestId('workbench-section-drawings-header'))
    fireEvent.click(screen.getByTestId(`drawing-open-${id}`))
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
    expect(sheetGeometry()).toBe(g)
  }, 240_000)
})
