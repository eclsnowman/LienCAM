// @vitest-environment jsdom
//
// WO UI-51A: executor-level proof that a Remove (cut) extrude built in the
// real dialog reaches the kernel op UNMANGLED through the page's regen
// executor -- the captured ExtrudeRequest carries op='cut', a downward blind
// end (negative magnitude), and the picked target handle; the consumed target
// gains the `consumes` edge and is hidden on success (consumed-body lineage,
// mirroring the Boolean branch). Drives the REAL SolidsWorkbenchPage with the
// worker faked at the facade boundary (fakeGeomClient precedent).
//
// This complements the pure enumeration in extrudeParams.test.ts (which proves
// EVERY cell/refusal of the mapping): here we prove the live wiring -- dialog
// payload -> executor -> buildExtrudeRequest -> client.makeExtrude -- does not
// mangle it. FAILS-IF: the executor stops passing build.req.target/op through
// (e.g. reverts to the pre-UI-51A hardcoded newBody/blind), and the op/end/
// target assertions below break.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import type { ExtrudeRequest } from '../../geom/geom-service'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

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

async function newRectangleSketch(): Promise<void> {
  await mintRectangleSketch()
}

describe('SolidsWorkbenchPage extrude boolean wiring (WO UI-51A)', () => {
  it('a down + Remove extrude reaches makeExtrude as op=cut / negative blind / with target, and folds the target', async () => {
    const reqs: ExtrudeRequest[] = []
    const client = createFakeGeomClient({
      makeExtrudeImpl: (req, mintHandle) => {
        reqs.push(req)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })

    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    // Sketch SK1, then a plain New-body extrude -> body F1 (the future target).
    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // Second extrude on the same sketch: Direction=Down, Result=Remove, target
    // auto-selects the only body (F1).
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-direction-select'), { target: { value: 'down' } })
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    expect((screen.getByTestId('extrude-target-select') as HTMLSelectElement).value).toBe('F1')
    commitField('extrude-distance', '8')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    // The dialog wrote the consumed-target edge.
    expect(hooks().dag.getNode('F2')?.consumes.slice().sort()).toEqual(['F1', 'SK1'])

    // The request that reached the kernel for F2 is UNMANGLED: cut, downward
    // blind (negative magnitude), against the live F1 handle. WO-035: the live
    // preview session issues earlier F2 requests against its scratch-restored
    // target handle, so the COMMITTED replay's request is the LAST one.
    const f2Req = [...reqs].reverse().find((r) => r.featureId === 'F2')
    expect(f2Req).toBeDefined()
    expect(f2Req!.op).toBe('cut')
    expect(f2Req!.end).toEqual({ kind: 'blind', distance: -8 })
    expect(f2Req!.target).toBe(hooks().getBodyHandle('F1'))

    // The target F1 is folded: hidden on success (its handle is kept for undo,
    // so the checkbox -- if present -- is unchecked, and the body list no
    // longer offers it as a live row).
    await waitFor(() => {
      const cb = screen.queryByTestId('body-visible-F1') as HTMLInputElement | null
      expect(cb === null || cb.checked === false).toBe(true)
    })
  })

  // WO UI-51A-R1 (audit MAJOR 1): a consumed target must be BOTH unselectable
  // in the dialog AND refused by name at the executor if a payload names it
  // anyway (defense in depth -- the dialog filter is UX, the executor
  // validation is the contract). FAILS-IF: revert liveBodyOptions back to the
  // raw availableBodies superset (dialog assertion breaks) or revert the
  // executor's lookupTarget back to a bare bodyHandlesRef.current.get (the
  // forced-payload refusal assertion breaks -- F3 would silently succeed
  // against F1's retained-for-undo handle).
  it('a consumed target stays visible in its own edit, is excluded from a new picker, and a forced payload naming it refuses BY NAME with no kernel call', async () => {
    const reqs: ExtrudeRequest[] = []
    const client = createFakeGeomClient({
      makeExtrudeImpl: (req, mintHandle) => {
        reqs.push(req)
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })

    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    // Body A (F1): a plain new-body extrude.
    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // Body B (F2): Remove-extrude that consumes F1 -- A is now superseded.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    commitField('extrude-distance', '8')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    reqs.length = 0

    // F2 owns a historical target reference to consumed F1. Its own edit
    // must display that stored value even though a fresh picker must not offer
    // F1 as a new choice.
    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Extrude edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-target-select')).toBeTruthy())
    const storedTargetSelect = screen.getByTestId('extrude-target-select') as HTMLSelectElement
    expect(storedTargetSelect.value).toBe('F1')
    expect([...storedTargetSelect.options].map((option) => option.value)).toContain('F1')
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    // Open a THIRD extrude dialog: F1 (consumed) must be ABSENT from the
    // target picker; only the live body F2 is offered.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    const targetSelect = screen.getByTestId('extrude-target-select') as HTMLSelectElement
    const offeredIds = [...targetSelect.options].map((o) => o.value).filter((v) => v !== '')
    expect(offeredIds).not.toContain('F1')
    expect(offeredIds).toEqual(['F2'])
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    // Force a payload naming the consumed F1 directly (bypassing the dialog's
    // live-filtered picker entirely) and regen it -- the executor must refuse
    // BY NAME, never resolve F1's retained-for-undo handle as if it were live.
    hooks().history.execute(
      createFeatureCommand(hooks().dag, {
        id: 'F3',
        kind: 'feature',
        consumes: ['SK1', 'F1'],
        payload: { opType: 'extrude', sketchId: 'SK1', distance: 5, direction: 'down', boolMode: 'remove', targetFeatureId: 'F1', name: 'Extrude F3' },
      }),
    )
    await hooks().fullResync(['F3'])
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).toBe('failed'))

    expect(hooks().getBodyHandle('F3')).toBeUndefined()
    const diagText = JSON.stringify(hooks().scheduler.diagnosticsOf('F3'))
    expect(diagText).toMatch(/no live body/)
    // No kernel call was ever made for the forced F3 request.
    expect(reqs.some((r) => r.featureId === 'F3')).toBe(false)
  })

  // WO UI-51A-R2 (audit MAJOR): the SAME consumed-target defense-in-depth the
  // test above proves for extrude, now for the standalone Boolean picker --
  // the audit's own bypass verbatim: BooleanDialog fed raw availableBodies,
  // so after F2 consumed F1, F1's retained-for-undo handle stayed selectable
  // as a Boolean target OR tool, and the executor's raw bodyHandlesRef.get
  // let a forced payload reach applyBoolean against it. FAILS-IF: BooleanDialog
  // reverts to bodyOptions={availableBodies} (the offered-ids assertions
  // break), the toolbar reverts to availableBodies.length < 2 (the disabled
  // assertion breaks), or the executor's target/tool revert to a bare
  // bodyHandlesRef.current.get (either forced-payload refusal breaks -- F4/F5
  // would silently succeed against F1's retained handle and reach
  // applyBoolean).
  it('a consumed body is excluded from BOTH Boolean selects, the toolbar counts only live bodies, and a forced payload naming it as target or tool refuses BY NAME with no applyBoolean call', async () => {
    const client = createFakeGeomClient()

    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    // Body A (F1): a plain new-body extrude.
    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // Body B (F2): Remove-extrude that consumes F1 -- F1 is now superseded,
    // its handle retained-for-undo. Exactly one live body (F2) exists now, so
    // the Boolean toolbar button (needs >= 2 LIVE bodies) must stay disabled
    // even though 2 RAW bodies (F1, F2) exist.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    commitField('extrude-distance', '8')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    expect((screen.getByTestId('workbench-boolean') as HTMLButtonElement).disabled).toBe(true)

    // Body C (F3): a second plain new-body extrude on the same sketch --
    // now F2 and F3 are both live (2 live bodies), so the toolbar re-enables.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '6')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined())
    expect((screen.getByTestId('workbench-boolean') as HTMLButtonElement).disabled).toBe(false)

    // Open Boolean: F1 (consumed) must be ABSENT from BOTH selects; only the
    // live bodies F2/F3 are offered.
    fireEvent.click(screen.getByTestId('workbench-boolean'))
    const targetSelect = screen.getByTestId('boolean-target-select') as HTMLSelectElement
    const toolSelect = screen.getByTestId('boolean-tool-select') as HTMLSelectElement
    const targetIds = [...targetSelect.options].map((o) => o.value)
    const toolIds = [...toolSelect.options].map((o) => o.value)
    expect(targetIds).not.toContain('F1')
    expect(toolIds).not.toContain('F1')
    expect(targetIds.slice().sort()).toEqual(['F2', 'F3'])
    expect(toolIds.slice().sort()).toEqual(['F2', 'F3'])
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    // Force a raw Boolean payload naming the consumed F1 as TARGET -- the
    // executor must refuse BY NAME, never resolve F1's retained handle.
    hooks().history.execute(
      createFeatureCommand(hooks().dag, {
        id: 'F4',
        kind: 'feature',
        consumes: ['F1', 'F2'],
        payload: { opType: 'boolean', targetFeatureId: 'F1', toolFeatureId: 'F2', boolOp: 'cut', name: 'Boolean F4' },
      }),
    )
    await hooks().fullResync(['F4'])
    await waitFor(() => expect(hooks().scheduler.statusOf('F4')).toBe('failed'))
    expect(hooks().getBodyHandle('F4')).toBeUndefined()
    const f4DiagText = JSON.stringify(hooks().scheduler.diagnosticsOf('F4'))
    expect(f4DiagText).toMatch(/no live body/)
    expect(client.opCalls.some((c) => c.op === 'applyBoolean' && c.featureId === 'F4')).toBe(false)

    // ALSO refuse when the consumed body is named as TOOL instead of target.
    hooks().history.execute(
      createFeatureCommand(hooks().dag, {
        id: 'F5',
        kind: 'feature',
        consumes: ['F2', 'F1'],
        payload: { opType: 'boolean', targetFeatureId: 'F2', toolFeatureId: 'F1', boolOp: 'cut', name: 'Boolean F5' },
      }),
    )
    await hooks().fullResync(['F5'])
    await waitFor(() => expect(hooks().scheduler.statusOf('F5')).toBe('failed'))
    expect(hooks().getBodyHandle('F5')).toBeUndefined()
    const f5DiagText = JSON.stringify(hooks().scheduler.diagnosticsOf('F5'))
    expect(f5DiagText).toMatch(/no live body/)
    expect(client.opCalls.some((c) => c.op === 'applyBoolean' && c.featureId === 'F5')).toBe(false)
  })
})
