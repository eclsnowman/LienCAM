// @vitest-environment jsdom
//
// WO UI-18 (D3): end-to-end proof that the real workbench wires the tree
// context menu's "Edit..." item through editEntryFor -- the SAME resolver
// the rail's own Edit... button now calls (SolidsWorkbenchPage.tsx). Real
// in-process kernel (createLocalGeomService), same box+fillet fixture
// SolidsWorkbenchPage.dressUp.test.tsx uses.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

// WO UI-18-R1 (Finding 1): the face-plane-datum test below drives Sketch on
// face, which opens the same Sketcher package session SolidsWorkbenchPage.
// sketchOnFace.test.tsx documents needs this stub -- see that file's header
// and stubCanvas2d.ts's own doc comment (jsdom has no 2D canvas context).
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

async function buildBoxWithFillet(runtime: ReturnType<typeof createFakeSceneRuntime>): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

  fireEvent.click(screen.getByTestId('workbench-fillet'))
  runtime.rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
  commitField('fillet-radius', '2')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
}

describe('SolidsWorkbenchPage tree Edit... (WO UI-18 D3, real occt-wasm kernel)', () => {
  it('extrude (editable): tree-menu Edit... opens the SAME extrude-edit dialog the rail Edit... button opens (pre-filled with the live distance)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxWithFillet(runtime)

    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)

    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
    const input = screen.getByTestId('extrude-distance').querySelector('input') as HTMLInputElement
    expect(input.value).toMatch(/^20(\.0*)?$/)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    // The rail's own Edit... button (selecting F1 first) reaches the exact same dialog.
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
  }, 60_000)

  it('UI-38 fillet: tree-menu Edit... opens the original dialog prefilled from the feature payload', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxWithFillet(runtime)

    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)
    const input = screen.getByTestId('fillet-radius').querySelector('input') as HTMLInputElement
    expect(input.value).toMatch(/^2(\.0*)?$/)
    expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/i)
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready'))
    // FILLET-EDIT-PREAPPLY-REPLAY: editing must resume the one active
    // pre-Apply preview, never retain the already-applied F2 alongside it.
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    expect(hooks().getBodyPresentationVisible('__fillet-preview__')).toBe(true)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(hooks().getBodyPresentationVisible('__fillet-preview__')).toBeUndefined())
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
  }, 60_000)

  // BK-174: sweep/loft joined the dialog-backed edit set (SweepDialog/
  // LoftDialog reopen in edit mode, prefilled from the stored payload, Apply
  // rewrites the SAME node) -- parity with extrude/revolve/fillet above.
  it('BK-174 sweep: tree-menu Edit... reopens the SAME sweep dialog, prefilled from the stored payload', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '10', height: '10', offset: '5' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    fireEvent.change(screen.getByTestId('sweep-profile-select'), { target: { value: 'SK1' } })
    fireEvent.change(screen.getByTestId('sweep-path-axis-select'), { target: { value: 'z' } })
    commitField('sweep-length', '30')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)

    await waitFor(() => expect(screen.getByTestId('sweep-length')).toBeTruthy())
    expect((screen.getByTestId('sweep-length').querySelector('input') as HTMLInputElement).value).toMatch(/^30(\.0*)?$/)

    commitField('sweep-length', '45')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.length).toBe(45))
    // Editing rewrites the SAME node -- no new feature row is inserted.
    expect(screen.queryByTestId('feature-row-F2')).toBeNull()
  }, 60_000)

  it('BK-174 loft: tree-menu Edit... reopens the SAME loft dialog, prefilled from the stored payload', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '10', height: '10', offset: '5' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    await mintRectangleSketch({ width: '8', height: '8', offset: '5' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-loft'))
    fireEvent.change(screen.getByTestId('loft-section1-select'), { target: { value: 'SK1' } })
    fireEvent.change(screen.getByTestId('loft-section2-select'), { target: { value: 'SK2' } })
    commitField('loft-spacing', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)

    await waitFor(() => expect(screen.getByTestId('loft-spacing')).toBeTruthy())
    expect((screen.getByTestId('loft-spacing').querySelector('input') as HTMLInputElement).value).toMatch(/^12(\.0*)?$/)

    commitField('loft-spacing', '18')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.spacing).toBe(18))
    // Editing rewrites the SAME node -- no new feature row is inserted.
    expect(screen.queryByTestId('feature-row-F2')).toBeNull()
  }, 60_000)

  // RECT-DIALOG-REMOVAL (Operator Q-69): the dialog BK-175 reopened is deleted --
  // a rectangle-payload sketch node (only ever mintable today by the test-only
  // mintRectangleSketch.ts helper) now gets a named disabled reason, matching
  // the sibling "no edit dialog yet" kinds below.
  it('a rectangle-payload sketch: tree-menu Edit... is disabled with a named reason (legacy, no editor)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.contextMenu(screen.getByTestId('feature-row-SK1'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(true)
    expect(editItem.getAttribute('data-tooltip')).toMatch(/legacy rectangle sketch/i)

    fireEvent.click(editItem)
    expect(screen.queryByTestId('dialog-shell')).toBeNull()
  }, 30_000)

  it('a genesis row (Origin) has no Edit... item at all', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    fireEvent.contextMenu(screen.getByTestId('feature-row-origin'))
    expect(screen.queryByTestId('tree-context-menu-edit')).toBeNull()
  }, 30_000)

  // WO UI-18-R1 (Finding 1, audit major): editEntryFor previously fell
  // through to `undefined` (silent Edit omission, indistinguishable from a
  // genesis row) for every DagNodeKind besides 'feature'/'sketch'. These two
  // tests drive REAL non-genesis 'parameter' and 'datum' rows through the
  // actual UI affordances that create them (the Params panel; sketch-on-face)
  // and assert the tree-menu Edit... item renders disabled WITH a named
  // reason, per the audit's required fix.
  it('a real parameter row (non-genesis, kind "parameter"): Edit... is disabled with a named reason', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    expect(screen.getByTestId('params-table')).toBeTruthy()
    const nameInput = screen.getByTestId('param-new-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'len' } })
    fireEvent.blur(nameInput)
    const exprInput = screen.getByTestId('param-new-expression') as HTMLInputElement
    fireEvent.change(exprInput, { target: { value: '20' } })
    fireEvent.blur(exprInput)
    fireEvent.click(screen.getByTestId('param-add'))
    await waitFor(() => expect(screen.getByTestId('feature-row-param:len')).toBeTruthy())

    fireEvent.contextMenu(screen.getByTestId('feature-row-param:len'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(true)
    expect(editItem.getAttribute('data-tooltip')).toMatch(/parameters have no edit dialog/i)

    fireEvent.click(editItem)
    expect(screen.queryByTestId('dialog-shell')).toBeNull()
  }, 30_000)

  it('a real face-plane datum row (non-genesis, kind "datum", auto-created by sketch-on-face): Edit... is disabled with a named reason', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // Rectangle spans x:[10,50] y:[0,20] -- a downward ray through its center
    // hits the top face first regardless of which end the kernel calls "top".
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })

    fireEvent.contextMenu(screen.getByTestId('feature-row-datum:SK2'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(true)
    expect(editItem.getAttribute('data-tooltip')).toMatch(/support datum is managed by its consuming feature/i)

    fireEvent.click(editItem)
    expect(screen.queryByTestId('dialog-shell')).toBeNull()
  }, 60_000)
})
