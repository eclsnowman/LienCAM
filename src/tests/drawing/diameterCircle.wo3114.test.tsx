// @vitest-environment jsdom
//
// WO-3114: the reported Drawing -> Diameter -> Top-view circle route. This
// drives the real sheet pointer handler, current face read, document archive,
// and resolver against the same 8 mm hole fixture the production drawing
// journey uses. The click is on the displayed circular wall, not a helper
// picker or a hand-built annotation.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { resetDocumentHolder, getDrawingRecords, LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
import { resetDrawingSession } from '../../components/model3d/drawing/DrawingEntry'
import { resetDrawnViews } from '../../components/model3d/drawing/DrawingEditor'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { mintRectangleSketch } from '../model3d/mintRectangleSketch'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'
import { modelToSheet } from '../../lib/drawing/annotations'
import type { DrawingDimension, DrawingDocument, DrawingView } from '../../lib/drawing/document'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { stubCanvas2d } from '../model3d/stubCanvas2d'

let restoreCanvas2d: (() => void) | null = null

beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  resetDocumentHolder()
  resetDrawingSession()
  resetDrawnViews()
  vi.stubGlobal('alert', vi.fn())
})

afterEach(() => {
  cleanup()
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

async function buildBlockWithHole(): Promise<void> {
  await ready()
  await mintRectangleSketch({ width: '60', height: '40', offset: '0' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  const distance = screen.getByTestId('extrude-distance').querySelector('input') as HTMLInputElement
  fireEvent.change(distance, { target: { value: '100' } })
  fireEvent.blur(distance)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id: 'F2', kind: 'feature', consumes: ['F1'],
    payload: {
      opType: 'hole', ownerId: 'F1', faceId: 'F1:XTR:SK1:capStart', points: [{ x: 15, y: 20, z: 0 }],
      style: { kind: 'simple', diameter: 8 }, depth: { kind: 'blind', distance: 12 },
      seed: { x: 15, y: 20, z: 0 }, normal: { x: 0, y: 0, z: -1 }, placement: { kind: 'single' }, name: '8 mm hole',
    },
  }))
  await hooks().fullResync(['F2'])
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
}

async function createDrawing(): Promise<string> {
  if (screen.queryByTestId('drawing-create') === null) fireEvent.click(screen.getByTestId('workbench-section-drawings-header'))
  await waitFor(() => expect((screen.getByTestId('drawing-create') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByTestId('drawing-create'))
  await waitFor(() => expect(screen.getByTestId('drawing-editor')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
  return screen.getByTestId('drawing-editor').getAttribute('data-drawing-id') as string
}

function drawing(id: string): DrawingDocument {
  const doc = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((x) => x.id === id)
  if (doc === undefined) throw new Error(`no drawing ${id}`)
  return doc
}

function topView(id: string): DrawingView {
  const view = drawing(id).sheets[0].views.find((x) => x.id === 'view-top')
  if (view === undefined) throw new Error('no Top view')
  return view
}

function clickSheet(id: string, at: [number, number]): void {
  const svg = screen.getByTestId('drawing-sheet')
  const [width, height] = drawing(id).sheets[0].sizeMm
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  fireEvent.click(svg, { clientX: at[0], clientY: at[1] })
}

describe('WO-3114 Drawing diameter on a Top-view circle', () => {
  it('persists and resolves the known 8 mm circle after its visible wall is clicked', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await buildBlockWithHole()
    const id = await createDrawing()
    const before = drawing(id)

    fireEvent.click(screen.getByTestId('drawing-tool-diameter'))
    // The top view looks down the hole axis; x=19 is the visible 8 mm circle wall.
    clickSheet(id, modelToSheet(topView(id), [19, 20, 50]))

    await waitFor(() => {
      const dimensions = drawing(id).annotations.filter((a): a is DrawingDimension => a.kind === 'dimension')
      expect(dimensions).toHaveLength(1)
      const dim = dimensions[0]
      expect(dim.measurement).toBe('diameter')
      expect(dim.viewId).toBe('view-top')
      expect(dim.referenceIds).toHaveLength(1)
      expect(drawing(id).references.find((r) => r.id === dim.referenceIds[0])?.selector.kind).toBe('face')
      expect(dim.lastGood).toMatchObject({ unit: 'mm' })
      expect(dim.lastGood?.value).toBeCloseTo(8, 4)
      expect(screen.getByTestId(`drawing-dim-${dim.id}`).getAttribute('data-state')).toBe('current')
      expect(screen.getByTestId(`drawing-dim-${dim.id}`).getAttribute('data-value')).toBeTruthy()
    })
    expect(before.annotations).toHaveLength(0)
  }, 120_000)
})
