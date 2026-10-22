// @vitest-environment jsdom
//
// WO-2994 (WO-2750 Slice C): the production Model entry into technical
// drawings, through the REAL page and the real local kernel
// (docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 3):
//   - "Create drawing" on the selected Model body makes a drawing of THAT body
//     (front/top/right/iso, Letter landscape, third angle) and writes it into
//     the item through the holder (Slice B setDrawingRecords), not React state.
//   - Opening a drawing covers the Model canvas (the canvas stays mounted); the
//     Model/Drawing switch and the breadcrumb return to the part.
//   - Deleting a drawing never touches the part, and can be undone.
//   - With no body there is nothing to draw: the button says so.

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
const { resetDocumentHolder, getDrawingRecords, LEGACY_MODEL_ITEM_ID } = await import('../../doc/documentHolder')
const { resetDrawingSession } = await import('../../components/model3d/drawing/DrawingEntry')
const { resetDrawnViews } = await import('../../components/model3d/drawing/DrawingEditor')
const { createFeatureCommand } = await import('../../components/model3d/dialogs/createFeatureCommand')
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  resetDocumentHolder()
  resetDrawingSession()
  resetDrawnViews()
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => {
  restoreCanvas2d?.()
  restoreCanvas2d = null
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

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
}

/** A new body from a rectangle sketch: `id` is its feature id. */
async function body(id: string, sketch: { width: string; height: string; offset: string }, distance: number): Promise<void> {
  const sketchId = await mintRectangleSketch(sketch)
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id, kind: 'feature', consumes: [sketchId],
    payload: { opType: 'extrude', sketchId, distance, direction: 'up', boolMode: 'newBody', name: `Part ${id}` },
  }))
  await hooks().fullResync([id])
  await waitFor(() => expect(hooks().getBodyHandle(id)).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(screen.getByTestId(`body-row-${id}`)).toBeTruthy())
}

function showDrawings(): void {
  if (screen.queryByTestId('drawing-create') === null) fireEvent.click(screen.getByTestId('workbench-section-drawings-header'))
}

describe('WO-2994 drawing entry in the Model workspace', () => {
  it('with no body, Create drawing is unavailable and says what it needs', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await ready()
    showDrawings()
    const create = screen.getByTestId('drawing-create') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(create.title).toBe('Select a body to make a drawing of it')
    expect(screen.getByTestId('workbench-section-drawings').textContent).toContain('No drawings yet')
  }, 120_000)

  it('creates a drawing of the selected body, saved in the item, and opens it over the canvas', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await ready()
    await body('F1', { width: '40', height: '20', offset: '10' }, 20)
    await body('F2', { width: '30', height: '30', offset: '80' }, 12)
    showDrawings()

    // Two bodies and no selection: which one is meant is unknown.
    fireEvent.click(screen.getByTestId('body-row-F2'))
    const create = screen.getByTestId('drawing-create') as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)

    await waitFor(() => expect(screen.getByTestId('drawing-editor')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
    // The canvas is still mounted under the sheet.
    expect(screen.getByTestId('solids-workbench-canvas')).toBeTruthy()

    const [doc] = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents
    expect(doc.source).toMatchObject({ modelItemId: LEGACY_MODEL_ITEM_ID, lineageId: 'F2', kind: 'model-brep' })
    expect(doc.name).toBe('Drawing of Part F2')
    expect(doc.sheets).toHaveLength(1)
    expect(doc.sheets[0].sizeMm).toEqual([279.4, 215.9])
    expect(doc.sheets[0].projection).toBe('third-angle')
    expect(doc.sheets[0].views.map((v) => v.frame.name)).toEqual(['front', 'top', 'right', 'iso'])
    // Third angle: top above front, right beside front.
    const at = Object.fromEntries(doc.sheets[0].views.map((v) => [v.frame.name, v.sheetOriginMm]))
    expect(at.top[0]).toBeCloseTo(at.front[0], 6)
    expect(at.top[1]).toBeLessThan(at.front[1])
    expect(at.right[1]).toBeCloseTo(at.front[1], 6)
    expect(at.right[0]).toBeGreaterThan(at.front[0])

    // It draws F2 (30 x 30 x 12), not F1: the front view is 30 wide and 12 tall.
    const k = doc.sheets[0].views[0].scale.numerator / doc.sheets[0].views[0].scale.denominator
    const pts: Array<[number, number]> = []
    for (const pl of screen.getByTestId('drawing-view-front').querySelectorAll('polyline')) {
      for (const pair of (pl.getAttribute('points') ?? '').split(' ')) pts.push(pair.split(',').map(Number) as [number, number])
    }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30 * k, 1)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(12 * k, 1)
    expect(screen.getByTestId('drawing-breadcrumb').textContent).toContain('Drawing of Part F2')
  }, 120_000)

  it('the Model switch and breadcrumb return to the part; the drawing stays and reopens', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await ready()
    await body('F1', { width: '40', height: '20', offset: '10' }, 20)
    showDrawings()
    fireEvent.click(screen.getByTestId('drawing-create')) // the only body needs no selection
    await waitFor(() => expect(screen.getByTestId('drawing-editor')).toBeTruthy())
    const id = screen.getByTestId('drawing-editor').getAttribute('data-drawing-id') as string

    fireEvent.click(screen.getByTestId('drawing-switch-model'))
    expect(screen.queryByTestId('drawing-editor')).toBeNull()
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.map((d) => d.id)).toEqual([id])

    fireEvent.click(screen.getByTestId(`drawing-open-${id}`))
    await waitFor(() => expect(screen.getByTestId('drawing-editor')).toBeTruthy())
    fireEvent.click(screen.getByTestId('drawing-breadcrumb').querySelector('button') as HTMLButtonElement)
    expect(screen.queryByTestId('drawing-editor')).toBeNull()
  }, 120_000)

  it('deleting a drawing leaves the part alone and can be undone', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await ready()
    await body('F1', { width: '40', height: '20', offset: '10' }, 20)
    showDrawings()
    fireEvent.click(screen.getByTestId('drawing-create'))
    await waitFor(() => expect(screen.getByTestId('drawing-editor')).toBeTruthy())
    const id = screen.getByTestId('drawing-editor').getAttribute('data-drawing-id') as string
    const dagBefore = hooks().dag.serialize()

    fireEvent.click(screen.getByTestId(`drawing-remove-${id}`))
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents).toEqual([])
    expect(screen.queryByTestId('drawing-editor')).toBeNull()
    expect(hooks().dag.serialize()).toBe(dagBefore)
    expect(hooks().getBodyHandle('F1')).not.toBeUndefined()
    expect(screen.getByTestId('drawing-removed-notice').textContent).toContain('was deleted')

    fireEvent.click(screen.getByTestId('drawing-undo-remove'))
    expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.map((d) => d.id)).toEqual([id])
    expect(screen.getByTestId(`drawing-row-${id}`)).toBeTruthy()
  }, 120_000)
})
