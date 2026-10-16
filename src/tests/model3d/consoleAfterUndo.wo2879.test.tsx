// @vitest-environment jsdom
//
// WO-2879 (final sweep 10-16, 1/1): after Shell was applied and then undone,
// the Model console's collapsed line still read "Shell F2 applied". After Undo
// the latest line says what was undone; Redo likewise; older lines stay.
//
// Driven through the REAL SolidsWorkbenchPage and the REAL in-process kernel:
// its rail buttons, viewport pick, Shell dialog, Undo/Redo buttons, and the
// console strip it renders (BottomConsole's collapsed line, what the operator
// reads). Only the scene runtime is faked - jsdom has no WebGL.
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCamStore } from '../../store'
import { SolidsWorkbenchPage } from '../../components/model3d/SolidsWorkbenchPage'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

function hooks() {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}
function commitTextField(testId: string, raw: string): void {
  const el = screen.getByTestId(testId) as HTMLInputElement
  fireEvent.change(el, { target: { value: raw } })
  fireEvent.blur(el)
}
/** What the operator reads: the collapsed console strip's latest line. */
const strip = (): string => screen.getByTestId('console-strip').textContent ?? ''
const messages = (): string[] => useCamStore.getState().consoleEvents.map((e) => e.message)

/** Apply Shell 2 mm on the box's top face -> F2. */
async function applyShell(runtime: FakeSceneRuntime): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-shell'))
  commitField('shell-thickness', '2')
  runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/i))
  await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 30_000 })
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(strip()).toMatch(/Shell F2 applied/), { timeout: 20_000 })
}

// Box x:[10,50] y:[0,20] z:[0,20], extruded as F1.
async function modelPageWithBox(): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
  return runtime
}

describe('WO-2879: the Model console does not keep saying an undone feature is applied', () => {
  let restoreCanvas2d: (() => void) | null = null
  beforeEach(() => {
    restoreCanvas2d = stubCanvas2d()
    act(() => { useCamStore.getState().clearConsoleEvents() })
  })
  afterEach(() => {
    cleanup()
    restoreCanvas2d?.()
    restoreCanvas2d = null
  })

  it('apply Shell, Undo -> the strip names the undo; Redo -> the strip names the redo; older lines stay', async () => {
    const runtime = await modelPageWithBox()

    fireEvent.click(screen.getByTestId('workbench-shell'))
    commitField('shell-thickness', '2')
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/i))
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
    await waitFor(() => expect(strip()).toMatch(/Shell F2 applied/), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F2')).toBe(false), { timeout: 20_000 })
    await waitFor(() => expect(strip()).toMatch(/Undid Shell F2/), { timeout: 20_000 })
    expect(strip()).not.toMatch(/Shell F2 applied/)
    // the history keeps the apply line under the new one
    expect(messages()).toContain('Shell F2 applied')
    expect(messages().indexOf('Undid Shell F2')).toBeGreaterThan(messages().indexOf('Shell F2 applied'))

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
    await waitFor(() => expect(strip()).toMatch(/Redid Shell F2/), { timeout: 20_000 })
    expect(messages()).toEqual(expect.arrayContaining(['Shell F2 applied', 'Undid Shell F2', 'Redid Shell F2']))
  }, 120_000)

  // Fix round 1 (astra F1): a parameter delete runs on the page history but pushes no touched
  // entry, so naming the step from that stack said "Undid Shell F2" while restoring the parameter.
  it('the judge\'s sequence: unused parameter, Shell, delete the parameter, Undo -> names the parameter delete, not Shell', async () => {
    const runtime = await modelPageWithBox()
    commitTextField('param-new-name', 'd1')
    commitTextField('param-new-expression', '5')
    fireEvent.click(screen.getByTestId('param-add'))
    await waitFor(() => expect(hooks().dag.has('param:d1')).toBe(true))
    await applyShell(runtime)

    fireEvent.click(screen.getByTestId('param-delete-d1'))
    await waitFor(() => expect(hooks().dag.has('param:d1')).toBe(false))

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('param:d1')).toBe(true))
    await waitFor(() => expect(strip()).toMatch(/Undid delete parameter d1/), { timeout: 20_000 })
    expect(hooks().dag.has('F2')).toBe(true)
    expect(messages()).not.toContain('Undid Shell F2')

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.has('param:d1')).toBe(false))
    await waitFor(() => expect(strip()).toMatch(/Redid delete parameter d1/), { timeout: 20_000 })
    expect(hooks().dag.has('F2')).toBe(true)
    expect(messages()).not.toContain('Redid Shell F2')
  }, 120_000)

  it('Undo/Redo of a rollback-marker move names the marker move', async () => {
    await modelPageWithBox()
    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(false))
    await waitFor(() => expect(strip()).toMatch(/Undid move the rollback marker/), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))
    await waitFor(() => expect(strip()).toMatch(/Redid move the rollback marker/), { timeout: 20_000 })
  }, 120_000)

  // A folder rename is not undo-tracked (WO UI-8: folder CRUD stays out of CommandHistory), so
  // Undo after it undoes the step before it - and the line must name THAT step, never the rename.
  it('Undo after a folder rename names the step it actually undid', async () => {
    await modelPageWithBox()
    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))

    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group 1' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })
    fireEvent.doubleClick(screen.getByTestId('folder-name-FLD1'))
    fireEvent.change(screen.getByTestId('folder-rename-input-FLD1'), { target: { value: 'Renamed' } })
    fireEvent.keyDown(screen.getByTestId('folder-rename-input-FLD1'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('folder-name-FLD1').textContent).toBe('Renamed'))

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(false))
    await waitFor(() => expect(strip()).toMatch(/Undid move the rollback marker/), { timeout: 20_000 })
    expect(screen.getByTestId('folder-name-FLD1').textContent).toBe('Renamed')
  }, 120_000)
  // Fix round 2 (astra F2): the console line was written between history.undo() and the resync,
  // so a synchronous persistence failure (storage full) rejected Undo with the Shell gone from the
  // document but its body never torn down. The write now follows the resync and cannot block it.
  it('a console write that throws (storage full) never blocks Undo/Redo: the model resyncs and the next Undo works', async () => {
    const runtime = await modelPageWithBox()
    await applyShell(runtime)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The store's addConsoleEvent throws exactly as its persisted set() does when setItem hits a
    // full quota. Only the console write fails: a fully failing storage also throws out of
    // fullResync's own syncModelBodies, the same on main (a separate, pre-existing route).
    const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
    act(() => {
      useCamStore.setState({ addConsoleEvent: () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError') } })
    })
    try {
      fireEvent.click(screen.getByTestId('workbench-undo'))
      await waitFor(() => expect(hooks().dag.has('F2')).toBe(false), { timeout: 20_000 })
      // the resync ran: the undone Shell's body is torn down, not left in the viewport
      await waitFor(() => expect(hooks().getBodyHandle('F2')).toBeUndefined(), { timeout: 20_000 })
      await waitFor(() => expect(warn).toHaveBeenCalledWith('WO-2879: Undo/Redo console line not written', expect.anything()))

      fireEvent.click(screen.getByTestId('workbench-redo'))
      await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })

      fireEvent.click(screen.getByTestId('workbench-undo'))
      await waitFor(() => expect(hooks().getBodyHandle('F2')).toBeUndefined(), { timeout: 20_000 })
      // the next Undo still works: the extrude goes too
      fireEvent.click(screen.getByTestId('workbench-undo'))
      await waitFor(() => expect(hooks().dag.has('F1')).toBe(false), { timeout: 20_000 })
      await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined(), { timeout: 20_000 })
    } finally {
      act(() => { useCamStore.setState({ addConsoleEvent: realAddConsoleEvent }) })
      warn.mockRestore()
    }
  }, 120_000)
})
