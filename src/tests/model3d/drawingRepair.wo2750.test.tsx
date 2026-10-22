// @vitest-environment jsdom
//
// WO-3006 (WO-2750 Slice E): dimensions, repair, detail views, balloons and the
// title block through the REAL Model page, the real local kernel and the real
// store - docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 8 rows owned
// by this file:
//   - "Edit native box 100 to 120 mm": the length dimension reads 120, keeps
//     its place and its +0.1/-0.05; the unrelated hole dimension is unchanged.
//   - "Delete dimensioned hole beside identical hole": the dimension shows its
//     last-good value and says why; it never moves to the neighbour. The
//     dimensions of the faces that stayed are still current.
//   - "Reassociate one endpoint; cancel; undo": Cancel changes nothing; Accept
//     relinks only that end of that dimension and keeps its tolerance and
//     place; the drawing's Undo puts back the old face and its state.
//   - "Aligned, float, detail, balloon" (detail and balloon parts): a detail's
//     magnification changes paper geometry, never the value; balloon numbers
//     persist through save and reopen.
//   - "Template edit and units/precision": explicit limits and a pinned
//     general tolerance survive save/reopen and a table edit; drawn-by and the
//     edit-date rules hold.
//
// Every pick is a click on the sheet at the paper point of a model location in
// that view (modelToSheet), with the sheet's box set to 1 px = 1 sheet mm.

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
const { useCamStore } = await import('../../store')
const { resetDocumentHolder, getDrawingRecords, LEGACY_MODEL_ITEM_ID } = await import('../../doc/documentHolder')
const { resetDrawingSession } = await import('../../components/model3d/drawing/DrawingEntry')
const { resetDrawnViews } = await import('../../components/model3d/drawing/DrawingEditor')
const { createFeatureCommand } = await import('../../components/model3d/dialogs/createFeatureCommand')
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { mintRectangleSketch } from './mintRectangleSketch'
import { modelToSheet } from '../../lib/drawing/annotations'
import type { DrawingDimension, DrawingDocument, DrawingView } from '../../lib/drawing/document'

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
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:wo3006' }) as typeof URL.createObjectURL
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

/** Type into one of the drawing panel's commit-on-blur inputs. */
function typeInto(testId: string, raw: string): void {
  const input = screen.getByTestId(testId) as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
}

/**
 * A 60 x 40 block extruded `depth` mm (X 0..60, Y 0..40, Z 0..depth) with two
 * 8 mm blind holes up from the bottom face (12 deep unless `holeDepths` says
 * otherwise): F2 at X 15 and F3 at X 45. The holes sit on the bottom face, so
 * a depth edit leaves them.
 */
async function buildBlockWithHoles(depth = '100', holeDepths: readonly [number, number] = [12, 12]): Promise<void> {
  await ready()
  await mintRectangleSketch({ width: '60', height: '40', offset: '0' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', depth)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
  const bottom = 'F1:XTR:SK1:capStart'
  for (const [id, x, owner, holeDepth] of [['F2', 15, 'F1', holeDepths[0]], ['F3', 45, 'F2', holeDepths[1]]] as const) {
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id,
      kind: 'feature',
      consumes: [owner],
      payload: {
        opType: 'hole', ownerId: owner, faceId: bottom, points: [{ x, y: 20, z: 0 }],
        style: { kind: 'simple', diameter: 8 }, depth: { kind: 'blind', distance: holeDepth },
        seed: { x, y: 20, z: 0 }, normal: { x: 0, y: 0, z: -1 }, placement: { kind: 'single' }, name: `Hole ${id}`,
      },
    }))
    await hooks().fullResync([id])
    await waitFor(() => expect(hooks().getBodyHandle(id)).not.toBeUndefined(), { timeout: 30_000 })
  }
  await waitFor(() => expect(screen.getByTestId('feature-row-F3')).toBeTruthy())
}

async function editDepth(depth: string): Promise<void> {
  const before = hooks().getBodyHandle('F3')
  fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
  fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
  await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
  commitField('extrude-distance', depth)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => {
    const now = hooks().getBodyHandle('F3')
    expect(now).not.toBeUndefined()
    expect(now).not.toBe(before)
  }, { timeout: 30_000 })
}

async function createAndOpenDrawing(): Promise<string> {
  if (screen.queryByTestId('drawing-create') === null) fireEvent.click(screen.getByTestId('workbench-section-drawings-header'))
  await waitFor(() => expect((screen.getByTestId('drawing-create') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByTestId('drawing-create'))
  await waitFor(() => expect(screen.getByTestId('drawing-editor')).toBeTruthy())
  await viewsCurrent()
  return screen.getByTestId('drawing-editor').getAttribute('data-drawing-id') as string
}

async function viewsCurrent(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
}

function drawing(id: string): DrawingDocument {
  const d = getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.find((x) => x.id === id)
  if (d === undefined) throw new Error(`no drawing ${id}`)
  return d
}

function view(id: string, viewId: string): DrawingView {
  const v = drawing(id).sheets[0].views.find((x) => x.id === viewId)
  if (v === undefined) throw new Error(`no view ${viewId}`)
  return v
}

/** The sheet's box is its size in px, so a client point IS a sheet mm point. */
function clickSheet(id: string, at: [number, number]): void {
  const svg = screen.getByTestId('drawing-sheet')
  const [w, h] = drawing(id).sheets[0].sizeMm
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  fireEvent.click(svg, { clientX: at[0], clientY: at[1] })
}

function pickModel(id: string, viewId: string, p: [number, number, number]): void {
  clickSheet(id, modelToSheet(view(id, viewId), p))
}

function dims(id: string): DrawingDimension[] {
  return drawing(id).annotations.filter((a): a is DrawingDimension => a.kind === 'dimension')
}

function dimEl(dimId: string): HTMLElement {
  return screen.getByTestId(`drawing-dim-${dimId}`)
}

async function dimState(dimId: string, state: string): Promise<void> {
  await waitFor(() => expect(dimEl(dimId).getAttribute('data-state')).toBe(state), { timeout: 30_000 })
}

/** Linear between the bottom (Z 0) and top (Z depth) faces, picked in the front view. */
async function addHeightDimension(id: string, depth: number): Promise<string> {
  const before = new Set(dims(id).map((d) => d.id))
  fireEvent.click(screen.getByTestId('drawing-tool-linear'))
  pickModel(id, 'view-front', [30, 0, 0])
  pickModel(id, 'view-front', [30, 0, depth])
  fireEvent.click(screen.getByTestId('drawing-tool-linear'))
  const made = dims(id).find((d) => !before.has(d.id))
  expect(made, screen.queryByTestId('drawing-notice')?.textContent ?? 'no dimension made').toBeDefined()
  return made!.id
}

/** Diameter of the hole at X `x`, picked on its wall seen end-on in the top view. */
async function addHoleDiameter(id: string, x: number): Promise<string> {
  const before = new Set(dims(id).map((d) => d.id))
  fireEvent.click(screen.getByTestId('drawing-tool-diameter'))
  pickModel(id, 'view-top', [x + 4, 20, 50])
  fireEvent.click(screen.getByTestId('drawing-tool-diameter'))
  const made = dims(id).find((d) => !before.has(d.id))
  expect(made, screen.queryByTestId('drawing-notice')?.textContent ?? 'no dimension made').toBeDefined()
  return made!.id
}

function faceOf(id: string, dimId: string, index = 0): string {
  const d = dims(id).find((x) => x.id === dimId)!
  const ref = drawing(id).references.find((r) => r.id === d.referenceIds[index])!
  return ref.selector.kind === 'face' ? ref.selector.stableId : ''
}

describe('WO-3006 drawing dimensions through the Model page (WO-2750 section 8)', () => {
  it('edit the block 100 -> 120: the length reads 120, keeps its place and +0.1/-0.05; the hole diameter is unchanged', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await buildBlockWithHoles('100')
    const id = await createAndOpenDrawing()

    const height = await addHeightDimension(id, 100)
    await dimState(height, 'current')
    expect(Number(dimEl(height).getAttribute('data-value'))).toBeCloseTo(100, 6)
    expect(faceOf(id, height, 0)).toBe('F1:XTR:SK1:capStart')
    expect(faceOf(id, height, 1)).toBe('F1:XTR:SK1:capEnd')
    const hole = await addHoleDiameter(id, 15)
    await dimState(hole, 'current')
    expect(Number(dimEl(hole).getAttribute('data-value'))).toBeCloseTo(8, 3)
    expect(faceOf(id, hole)).toBe('F2:HOL:i0:wall')
    expect(dimEl(hole).getAttribute('data-text')).toBe('⌀8.00')

    // Explicit +0.1 / -0.05 on the length, through the panel.
    fireEvent.click(screen.getByTestId(`drawing-dim-row-${height}`))
    fireEvent.change(screen.getByTestId('drawing-tol-kind'), { target: { value: 'bilateral' } })
    typeInto('drawing-tol-upper', '0.1')
    typeInto('drawing-tol-lower', '-0.05')
    const placed = dims(id).find((d) => d.id === height)!
    expect(placed.tolerance).toEqual({ kind: 'bilateral', upper: 0.1, lower: -0.05 })
    expect(dimEl(height).getAttribute('data-text')).toBe('100.00 +0.10 -0.05')
    const label = placed.labelSheetMm

    await editDepth('120')
    await viewsCurrent()
    await waitFor(() => expect(Number(dimEl(height).getAttribute('data-value'))).toBeCloseTo(120, 6), { timeout: 30_000 })
    expect(dimEl(height).getAttribute('data-state')).toBe('current')
    expect(dimEl(height).getAttribute('data-text')).toBe('120.00 +0.10 -0.05')
    const after = dims(id).find((d) => d.id === height)!
    expect(after.labelSheetMm).toEqual(label)
    expect(after.tolerance).toEqual({ kind: 'bilateral', upper: 0.1, lower: -0.05 })
    expect(after.lastGood?.value).toBeCloseTo(120, 6)
    // The unrelated hole: same face, same 8.
    expect(dimEl(hole).getAttribute('data-state')).toBe('current')
    expect(Number(dimEl(hole).getAttribute('data-value'))).toBeCloseTo(8, 3)
    expect(faceOf(id, hole)).toBe('F2:HOL:i0:wall')
  }, 300_000)

  it('delete the dimensioned hole beside an identical hole: last value and a sentence, never the neighbour; reassociate with cancel, accept and undo', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await buildBlockWithHoles('100')
    const id = await createAndOpenDrawing()
    const height = await addHeightDimension(id, 100)
    const holeA = await addHoleDiameter(id, 15)
    const holeB = await addHoleDiameter(id, 45)
    for (const d of [height, holeA, holeB]) await dimState(d, 'current')
    expect(faceOf(id, holeB)).toBe('F3:HOL:i0:wall')
    // A tolerance and a place to keep through the repair.
    fireEvent.click(screen.getByTestId(`drawing-dim-row-${holeB}`))
    fireEvent.change(screen.getByTestId('drawing-tol-kind'), { target: { value: 'limits' } })
    typeInto('drawing-tol-upper', '8.05')
    typeInto('drawing-tol-lower', '7.98')
    const beforeDelete = dims(id).find((d) => d.id === holeB)!

    // Delete hole F3 (the one holeB measures). F2, identical and 30 mm away, stays.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F3'))
    fireEvent.click(screen.getByTestId('tree-context-menu-delete'))
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F3')).toBeNull())
    await viewsCurrent()
    await dimState(holeB, 'missing')
    // Never the neighbour: no value, no face of F2, the last value shown.
    expect(dimEl(holeB).getAttribute('data-value')).toBe('')
    expect(dimEl(holeB).getAttribute('data-text')).toBe('\u2300 8.05 7.98')
    expect(faceOf(id, holeB)).toBe('F3:HOL:i0:wall')
    expect(dims(id).find((d) => d.id === holeB)!.lastGood?.value).toBeCloseTo(8, 3)
    // The faces that stayed are still current (deleting an unrelated feature leaves them).
    expect(dimEl(holeA).getAttribute('data-state')).toBe('current')
    expect(dimEl(height).getAttribute('data-state')).toBe('current')
    fireEvent.click(screen.getByTestId(`drawing-dim-row-${holeB}`))
    const sentence = screen.getByTestId('drawing-dim-status').textContent ?? ''
    expect(sentence).toMatch(/is gone from the part/)
    expect(sentence).toMatch(/Pick a new face/)
    expect(sentence).toMatch(/Last value: 8\.00 mm/)
    expect(sentence).not.toMatch(/undefined|Error|deleted|not-found/)

    // Reassociate: a flat face is refused at the pick with a sentence.
    const snapshot = JSON.stringify(drawing(id))
    fireEvent.click(screen.getByTestId('drawing-repair-0'))
    pickModel(id, 'view-front', [30, 0, 0])
    expect(screen.getByTestId('drawing-notice').textContent).toMatch(/not round/)
    // Pick the other hole's wall: old and new values side by side. Cancel keeps everything.
    pickModel(id, 'view-top', [19, 20, 50])
    expect(screen.getByTestId('drawing-repair-old').textContent).toBe('⌀8.00')
    expect(screen.getByTestId('drawing-repair-new').textContent).toBe('⌀8.00')
    fireEvent.click(screen.getByTestId('drawing-repair-cancel'))
    expect(screen.queryByTestId('drawing-repair')).toBeNull()
    expect(JSON.stringify(drawing(id))).toBe(snapshot)

    // Accept: only holeB's end changes; tolerance and place kept; the repair recorded.
    fireEvent.click(screen.getByTestId('drawing-repair-0'))
    pickModel(id, 'view-top', [19, 20, 50])
    fireEvent.click(screen.getByTestId('drawing-repair-accept'))
    await dimState(holeB, 'current')
    const repaired = dims(id).find((d) => d.id === holeB)!
    expect(faceOf(id, holeB)).toBe('F2:HOL:i0:wall')
    expect(repaired.tolerance).toEqual(beforeDelete.tolerance)
    expect(repaired.labelSheetMm).toEqual(beforeDelete.labelSheetMm)
    expect(repaired.repairs).toHaveLength(1)
    expect(repaired.repairs![0]).toMatchObject({ referenceIndex: 0, oldSelector: { kind: 'face', stableId: 'F3:HOL:i0:wall' }, newSelector: { kind: 'face', stableId: 'F2:HOL:i0:wall' } })
    expect(faceOf(id, holeA)).toBe('F2:HOL:i0:wall')
    expect(faceOf(id, height, 0)).toBe('F1:XTR:SK1:capStart')

    // The drawing's Undo restores the old face and its missing state; Redo the repair.
    fireEvent.click(screen.getByTestId('drawing-undo'))
    await dimState(holeB, 'missing')
    expect(faceOf(id, holeB)).toBe('F3:HOL:i0:wall')
    expect(dims(id).find((d) => d.id === holeB)!.repairs ?? []).toHaveLength(0)
    expect(dims(id).find((d) => d.id === holeB)!.lastGood?.value).toBeCloseTo(8, 3)
    fireEvent.click(screen.getByTestId('drawing-redo'))
    await dimState(holeB, 'current')
    expect(faceOf(id, holeB)).toBe('F2:HOL:i0:wall')
  }, 300_000)

  it('detail view magnifies paper geometry, never the value; balloons, limits, general tolerance and the title block survive save and reopen', async () => {
    const first = render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await buildBlockWithHoles('100')
    const id = await createAndOpenDrawing()
    const createdAt = drawing(id).createdAt

    // A round detail of the front view's bottom-left corner, 2:1.
    fireEvent.click(screen.getByTestId('drawing-tool-detail'))
    const front = view(id, 'view-front')
    const centre = modelToSheet(front, [5, 0, 5])
    clickSheet(id, centre)
    clickSheet(id, [centre[0] + 6, centre[1]])
    clickSheet(id, [200, 60])
    const detail = drawing(id).sheets[0].views.find((v) => v.detail !== undefined)!
    expect(detail.label).toBe('A')
    const k = (s: { numerator: number; denominator: number }) => s.numerator / s.denominator
    expect(k(detail.scale)).toBeCloseTo(2 * k(front.scale), 9)
    expect(detail.detail!.radiusMm).toBeCloseTo(6 / k(front.scale), 6)
    expect(screen.getByTestId(`drawing-detail-label-${detail.id}`).textContent).toBe('DETAIL A (2:1)')
    expect(screen.getByTestId(`drawing-detail-crop-${detail.id}`)).toBeTruthy()

    // A height dimension in the main view and one in the detail read the same value.
    const height = await addHeightDimension(id, 100)
    await dimState(height, 'current')
    // In the detail, dimension the hole floor (Z 12) to the bottom (Z 0) near X 15.
    fireEvent.click(screen.getByTestId('drawing-tool-linear'))
    pickModel(id, detail.id, [5, 0, 0])
    pickModel(id, detail.id, [13, 0, 12])
    fireEvent.click(screen.getByTestId('drawing-tool-linear'))
    const inDetail = dims(id).find((d) => d.viewId === detail.id)
    expect(inDetail, screen.queryByTestId('drawing-notice')?.textContent ?? '').toBeDefined()
    await dimState(inDetail!.id, 'current')
    expect(Number(dimEl(inDetail!.id).getAttribute('data-value'))).toBeCloseTo(12, 6)
    const lineLength = (dimId: string): number => {
      const ls = [...dimEl(dimId).querySelectorAll('line')].map((l) => Math.hypot(Number(l.getAttribute('x2')) - Number(l.getAttribute('x1')), Number(l.getAttribute('y2')) - Number(l.getAttribute('y1'))))
      return ls[2]
    }
    const at2 = lineLength(inDetail!.id)
    expect(at2).toBeCloseTo(12 * k(detail.scale), 3)
    // 4:1: twice the paper length, the same 12.
    fireEvent.click(screen.getByTestId(`drawing-detail-label-${detail.id}`))
    fireEvent.change(screen.getByTestId('drawing-detail-mag'), { target: { value: '4:1' } })
    expect(screen.getByTestId(`drawing-detail-label-${detail.id}`).textContent).toBe('DETAIL A (4:1)')
    await dimState(inDetail!.id, 'current')
    expect(Number(dimEl(inDetail!.id).getAttribute('data-value'))).toBeCloseTo(12, 6)
    expect(lineLength(inDetail!.id)).toBeCloseTo(2 * at2, 3)
    expect(Number(dimEl(height).getAttribute('data-value'))).toBeCloseTo(100, 6)

    // Two manual balloons, numbered 1 and 2; the second renumbered to 5.
    fireEvent.click(screen.getByTestId('drawing-tool-balloon'))
    clickSheet(id, modelToSheet(front, [60, 0, 50]))
    clickSheet(id, modelToSheet(view(id, 'view-top'), [15, 20, 100]))
    fireEvent.click(screen.getByTestId('drawing-tool-balloon'))
    const balloons = () => drawing(id).annotations.filter((a) => a.kind === 'balloon')
    expect(balloons().map((b) => (b.kind === 'balloon' ? b.number : 0))).toEqual([1, 2])
    typeInto('drawing-balloon-number', '5')
    expect(balloons().map((b) => (b.kind === 'balloon' ? b.number : 0))).toEqual([1, 5])

    // Limits on the height; general tolerance (pinned 0.05 at 2 decimals) on the detail dimension.
    fireEvent.click(screen.getByTestId(`drawing-dim-row-${height}`))
    fireEvent.change(screen.getByTestId('drawing-tol-kind'), { target: { value: 'limits' } })
    typeInto('drawing-tol-upper', '100.1')
    typeInto('drawing-tol-lower', '99.95')
    fireEvent.click(screen.getByTestId(`drawing-dim-row-${inDetail!.id}`))
    fireEvent.change(screen.getByTestId('drawing-tol-kind'), { target: { value: 'general' } })
    expect(dims(id).find((d) => d.id === inDetail!.id)!.tolerance).toMatchObject({ kind: 'general', tableKey: '2', value: 0.05 })
    // Editing the table does not change the pinned value; the panel offers the update.
    typeInto('drawing-gt-2', '0.02')
    expect(dims(id).find((d) => d.id === inDetail!.id)!.tolerance).toMatchObject({ kind: 'general', value: 0.05 })
    expect(screen.getByTestId('drawing-tol-update').textContent).toMatch(/0\.02/)
    expect(screen.getByTestId('drawing-tolerance-row-2').textContent).toMatch(/0\.02/)

    // Title block: typed fields, an override, the date rules.
    const editedBefore = drawing(id).editedAt
    typeInto('drawing-field-drawnBy', 'A. Machinist')
    typeInto('drawing-field-partNumber', 'BLK-100')
    typeInto('drawing-override-title', 'Test block')
    expect(screen.getByTestId('drawing-title-drawnBy').getAttribute('data-text')).toBe('A. Machinist')
    expect(screen.getByTestId('drawing-title-title').getAttribute('data-text')).toBe('Test block')
    expect(screen.getByTestId('drawing-title-title').getAttribute('data-overridden')).toBe('true')
    const editedAfter = drawing(id).editedAt
    expect(editedAfter).toBeDefined()
    expect(editedAfter! >= (editedBefore ?? '')).toBe(true)
    expect(drawing(id).createdAt).toBe(createdAt)
    expect(drawing(id).sourceEditedAt).toBeUndefined()

    // Inches: the text converts; the stored limits do not move.
    fireEvent.change(screen.getByTestId('drawing-sheet-unit'), { target: { value: 'inch' } })
    expect(dimEl(height).getAttribute('data-text')).toBe('3.9409 3.9350')
    expect(dims(id).find((d) => d.id === height)!.tolerance).toEqual({ kind: 'limits', lower: 99.95, upper: 100.1 })
    // Fix round 1, finding 2: the general table's numbers and its heading are in one unit.
    expect(screen.getByTestId('drawing-tolerance-block').textContent).toContain('(in; degrees)')
    expect(screen.getByTestId('drawing-tolerance-row-2').textContent).toMatch(/0\.0008/)
    fireEvent.change(screen.getByTestId('drawing-sheet-unit'), { target: { value: 'mm' } })
    expect(screen.getByTestId('drawing-tolerance-block').textContent).toContain('(mm; degrees)')
    // Finding 1: the table now says +/-0.02 for two decimals, so the dimension pinned at
    // +/-0.05 prints its own tolerance instead of implying the table's.
    expect(dimEl(inDetail!.id).getAttribute('data-text')).toBe('12.00 ±0.05')

    // A model edit moves "model edited", not "drawing edited".
    const editedBeforeModel = drawing(id).editedAt
    await editDepth('110')
    await viewsCurrent()
    await waitFor(() => expect(drawing(id).sourceEditedAt).toBeDefined(), { timeout: 30_000 })
    expect(drawing(id).editedAt).toBe(editedBeforeModel)
    expect(screen.getByTestId('drawing-title-modelEdited').getAttribute('data-text')).not.toBe('')

    // Save, reopen without the Model, save again, then open the Model.
    savedBlobs = []
    await useCamStore.getState().saveProjectToFile()
    const fileOne = await savedBlobs[0].text()
    // As saved: JSON writes -0 as 0 (a standard view frame's cross product has -0 components).
    const kept = JSON.parse(JSON.stringify(drawing(id))) as DrawingDocument
    first.unmount()
    cleanup()
    resetDocumentHolder()
    resetDrawingSession()
    resetDrawnViews()
    useCamStore.getState().loadProjectFromFile(fileOne)
    await waitFor(() => expect(getDrawingRecords(LEGACY_MODEL_ITEM_ID).documents.map((d) => d.id)).toEqual([id]))
    const reopened = drawing(id)
    expect(reopened.annotations).toEqual(kept.annotations)
    expect(reopened.template).toEqual(kept.template)
    expect(reopened.sheets).toEqual(kept.sheets)
    expect(reopened.sourceEditedAt).toBe(kept.sourceEditedAt)
    expect(reopened.editedAt).toBe(kept.editedAt)

    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await ready()
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 60_000 })
    if (screen.queryByTestId(`drawing-open-${id}`) === null) fireEvent.click(screen.getByTestId('workbench-section-drawings-header'))
    fireEvent.click(screen.getByTestId(`drawing-open-${id}`))
    await viewsCurrent()
    await dimState(height, 'current')
    expect(Number(dimEl(height).getAttribute('data-value'))).toBeCloseTo(110, 6)
    expect(dimEl(height).getAttribute('data-text')).toBe('100.10 99.95')
    expect(screen.getByTestId(`drawing-balloon-${balloons()[1].id}`).getAttribute('data-number')).toBe('5')
    expect(screen.getByTestId('drawing-title-drawnBy').getAttribute('data-text')).toBe('A. Machinist')
    expect(dims(id).find((d) => d.id === inDetail!.id)!.tolerance).toMatchObject({ kind: 'general', value: 0.05 })
    // Opening changed neither date.
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    expect(drawing(id).editedAt).toBe(kept.editedAt)
    expect(drawing(id).sourceEditedAt).toBe(kept.sourceEditedAt)
  }, 400_000)

  // Fix round 1, finding 3: a two-face dimension whose faces are both gone. Each end is
  // relinked and saved on its own; the dimension stays missing until both ends are good.
  it('two broken ends of one dimension: each end is relinked on its own, the dimension stays missing until both are good', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await buildBlockWithHoles('100', [12, 20])
    const id = await createAndOpenDrawing()
    // Linear between the two hole floors (Z 12 and Z 20), seen edge-on in the front view.
    const before = new Set(dims(id).map((d) => d.id))
    fireEvent.click(screen.getByTestId('drawing-tool-linear'))
    pickModel(id, 'view-front', [15, 0, 12])
    pickModel(id, 'view-front', [45, 0, 20])
    fireEvent.click(screen.getByTestId('drawing-tool-linear'))
    const made = dims(id).find((d) => !before.has(d.id))
    expect(made, screen.queryByTestId('drawing-notice')?.textContent ?? 'no dimension made').toBeDefined()
    const floors = made!.id
    await dimState(floors, 'current')
    expect(Number(dimEl(floors).getAttribute('data-value'))).toBeCloseTo(8, 6)
    expect(faceOf(id, floors, 0)).toMatch(/^F2:/)
    expect(faceOf(id, floors, 1)).toMatch(/^F3:/)

    // Delete both holes: neither end of the dimension has a face any more.
    for (const feature of ['F3', 'F2']) {
      fireEvent.contextMenu(screen.getByTestId(`feature-row-${feature}`))
      fireEvent.click(screen.getByTestId('tree-context-menu-delete'))
      fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
      await waitFor(() => expect(screen.queryByTestId(`feature-row-${feature}`)).toBeNull())
    }
    await viewsCurrent()
    await dimState(floors, 'missing')

    // End 1 -> the bottom face. End 2 is still broken, and Accept saves end 1 on its own.
    fireEvent.click(screen.getByTestId(`drawing-dim-row-${floors}`))
    fireEvent.click(screen.getByTestId('drawing-repair-0'))
    pickModel(id, 'view-front', [30, 0, 0])
    expect((screen.getByTestId('drawing-repair-accept') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('drawing-repair-accept'))
    expect(faceOf(id, floors, 0)).toBe('F1:XTR:SK1:capStart')
    expect(faceOf(id, floors, 1)).toMatch(/^F3:/)
    await dimState(floors, 'missing')

    // End 2 -> the top face: now both ends are good and the dimension reads 100.
    fireEvent.click(screen.getByTestId(`drawing-dim-row-${floors}`))
    fireEvent.click(screen.getByTestId('drawing-repair-1'))
    pickModel(id, 'view-front', [30, 0, 100])
    expect(screen.getByTestId('drawing-repair-new').textContent).toBe('100.00')
    fireEvent.click(screen.getByTestId('drawing-repair-accept'))
    await dimState(floors, 'current')
    expect(Number(dimEl(floors).getAttribute('data-value'))).toBeCloseTo(100, 6)
    expect(dims(id).find((d) => d.id === floors)!.repairs).toHaveLength(2)

    // Drawing Undo takes the repairs back one end at a time.
    fireEvent.click(screen.getByTestId('drawing-undo'))
    expect(faceOf(id, floors, 1)).toMatch(/^F3:/)
    expect(faceOf(id, floors, 0)).toBe('F1:XTR:SK1:capStart')
    fireEvent.click(screen.getByTestId('drawing-undo'))
    expect(faceOf(id, floors, 0)).toMatch(/^F2:/)
  }, 300_000)

  // Fix round 1, finding 4: a small crop is a normal detail-view use, not a refusal.
  it('a detail circle 0.5 mm across on the sheet is made, and the editor says what it made', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createFakeSceneRuntime} />)
    await buildBlockWithHoles('100')
    const id = await createAndOpenDrawing()
    const front = view(id, 'view-front')
    const k = (s: { numerator: number; denominator: number }) => s.numerator / s.denominator
    const centre = modelToSheet(front, [15, 0, 0])
    fireEvent.click(screen.getByTestId('drawing-tool-detail'))
    clickSheet(id, centre)
    clickSheet(id, [centre[0] + 0.5, centre[1]])
    clickSheet(id, [140, 98])
    const detail = drawing(id).sheets[0].views.find((v) => v.detail !== undefined)
    expect(detail, screen.queryByTestId('drawing-notice')?.textContent ?? 'no detail made').toBeDefined()
    expect(detail!.detail!.radiusMm).toBeCloseTo(0.5 / k(front.scale), 6)
    expect(screen.getByTestId('drawing-notice').textContent).toMatch(/DETAIL A \(2:1\)/)
  }, 300_000)
})
