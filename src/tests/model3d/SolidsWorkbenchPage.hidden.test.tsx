// @vitest-environment jsdom
//
// WO UI-53: persisted sketch Hide is display-only. These tests drive the
// REAL row handler and workbench Undo/Redo controls; no test mutates hidden
// directly before the viewport assertion and no test calls fullResync to
// make the real button work.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { useUiPrefs } from '../../store/uiPrefs'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  } as Storage
}

let priorLocalStorage: PropertyDescriptor | undefined

beforeEach(() => {
  priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [], workbenchCameraProjection: 'perspective' })
})

afterEach(() => {
  cleanup()
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [], workbenchCameraProjection: 'perspective' })
  if (priorLocalStorage !== undefined) Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
  priorLocalStorage = undefined
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function extrudeCallCount(client: ReturnType<typeof createFakeGeomClient>): number {
  return client.opCalls.filter((call) => call.op === 'makeExtrude' && call.featureId === 'F1').length
}

async function buildSketchAndExtrude(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(true))

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeDefined())
}

describe('SolidsWorkbenchPage persisted sketch Hide (WO UI-53)', () => {
  it('real eye Hide removes an already-painted outline, preserves the extrude, and Undo redraws without regeneration', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={createFakeSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await buildSketchAndExtrude()

    // A successfully-created sketch-consuming feature hides its source
    // sketch automatically. The ordinary eye control remains authoritative:
    // one click turns it back on, after which the existing manual-hide
    // contract below proceeds unchanged.
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(true))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(false))
    await waitFor(() => expect(screen.getByTestId('feature-row-hide-SK1').getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('feature-row-hide-SK1').getAttribute('aria-label')).toBe('Show')
    fireEvent.click(screen.getByTestId('feature-row-hide-SK1'))
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(false))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(true))
    await waitFor(() => expect(screen.getByTestId('feature-row-hide-SK1').getAttribute('aria-pressed')).toBe('false'))
    expect(screen.getByTestId('feature-row-hide-SK1').getAttribute('aria-label')).toBe('Hide')

    const bodyHandle = hooks().getBodyHandle('F1')
    const bodyGeometryHash = hooks().getBodyGeometryHash('F1')
    expect(bodyHandle).toBeDefined()
    expect(bodyGeometryHash).toBeDefined()
    expect(hooks().hasSceneMesh('F1')).toBe(true)
    const dispositionBefore = hooks().scheduler.dispositionOf('F1')
    expect(dispositionBefore.kind).toBe('executable')
    // WO-035: the build includes the dialog's live-preview evaluation, so the
    // no-regeneration invariant is counted as a DELTA from here on.
    const callsAfterBuild = extrudeCallCount(client)

    // Real row handler path. If its fullResync([]) call is removed, hidden
    // flips in the DAG but this outline assertion times out.
    fireEvent.click(screen.getByTestId('feature-row-hide-SK1'))
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(true))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(false))

    // Negative controls: hidden is neither root/cascade suppression nor a
    // scheduler/body lifecycle event. The exact live mesh remains visible.
    expect(hooks().dag.isSuppressed('SK1')).toBe(false)
    expect(hooks().dag.isEffectivelySuppressed('SK1')).toBe(false)
    expect(hooks().dag.isSuppressed('F1')).toBe(false)
    expect(hooks().dag.isEffectivelySuppressed('F1')).toBe(false)
    expect(hooks().scheduler.dispositionOf('F1')).toEqual(dispositionBefore)
    expect(hooks().getBodyHandle('F1')).toBe(bodyHandle)
    expect(hooks().getBodyGeometryHash('F1')).toBe(bodyGeometryHash)
    expect(hooks().hasSceneMesh('F1')).toBe(true)
    expect(extrudeCallCount(client)).toBe(callsAfterBuild)

    // Hidden sketches remain valid feature inputs.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    const profile = screen.getByTestId('extrude-profile-select') as HTMLSelectElement
    expect([...profile.options].map((option) => option.value)).toContain('SK1')
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    const snapshot = hooks().buildDebugSceneExport()
    const exportedDag = JSON.parse(snapshot.dag) as { nodes: Array<{ id: string; hidden: boolean }> }
    expect(exportedDag.nodes.find((node) => node.id === 'SK1')?.hidden).toBe(true)
    expect(snapshot.skipped.some((entry) => /hidden.*sketch|sketch.*hidden|SK1/.test(entry))).toBe(false)

    // Empty touched roots make the real Undo/Redo handlers resync only the
    // display surface; neither direction replays the downstream extrude.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(false))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(true))
    expect(extrudeCallCount(client)).toBe(callsAfterBuild)
    expect(hooks().getBodyHandle('F1')).toBe(bodyHandle)
    expect(hooks().getBodyGeometryHash('F1')).toBe(bodyGeometryHash)
    expect(hooks().hasSceneMesh('F1')).toBe(true)

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(true))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(false))
    expect(extrudeCallCount(client)).toBe(callsAfterBuild)
    expect(hooks().getBodyGeometryHash('F1')).toBe(bodyGeometryHash)
    expect(hooks().hasSceneMesh('F1')).toBe(true)

    // Persistence round-trip through the real debug-scene restore path: a
    // fresh page replays F1 but never paints SK1's finished outline.
    cleanup()
    const restoredClient = createFakeGeomClient()
    render(
      <SolidsWorkbenchPage
        createClient={() => restoredClient}
        createSceneRuntime={createFakeSceneRuntime}
        initialDebugScene={snapshot}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await waitFor(
      () => expect(screen.getByTestId('workbench-debug-scene-load-status').textContent).toMatch(/ok/i),
      { timeout: 20_000 },
    )
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeDefined())
    expect(hooks().getBodyGeometryHash('F1')).toBeDefined()
    expect(hooks().dag.getNode('SK1')?.hidden).toBe(true)
    expect(hooks().hasSketchOutline('SK1')).toBe(false)
    expect(hooks().hasSceneMesh('F1')).toBe(true)
  }, 40_000)

  it('a successful create auto-hides the consumed sketch in the same undo step, and redo hides it again', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={createFakeSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await buildSketchAndExtrude()

    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(true))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(false))
    await waitFor(() => expect(screen.getByTestId('feature-row-hide-SK1').getAttribute('aria-label')).toBe('Show'))

    // One undo reverses the feature creation AND its automatic display-only
    // hide. A separate visibility-only history entry would leave F1 behind.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(false))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(true))
    await waitFor(() => expect(screen.getByTestId('feature-row-hide-SK1').getAttribute('aria-label')).toBe('Hide'))

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeDefined())
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(true))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(false))
    await waitFor(() => expect(screen.getByTestId('feature-row-hide-SK1').getAttribute('aria-label')).toBe('Show'))
  }, 40_000)

  it('cancel and kernel refusal leave the source sketch visible', async () => {
    const client = createFakeGeomClient({
      makeExtrudeImpl: () => ({
        ok: false,
        diagnostics: [{
          code: 'KERNEL_OP_FAILED',
          severity: 'error',
          params: { reason: 'forced refusal' },
        }],
      }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={createFakeSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await mintRectangleSketch()
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(true))

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(hooks().dag.getNode('SK1')?.hidden).toBe(false)
    expect(hooks().hasSketchOutline('SK1')).toBe(true)
    expect(hooks().dag.has('F1')).toBe(false)

    // WO-035: the kernel refusal now surfaces in the dialog's live preview
    // BEFORE any commit -- a refused extrude no longer authors a failed F1
    // node at all. The claim under test is unchanged and stronger: a refusal
    // leaves the source sketch visible (and now also leaves history empty).
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.getByTestId('extrude-apply-error').textContent).toMatch(/forced refusal/i))
    expect(hooks().dag.has('F1')).toBe(false)
    expect(hooks().dag.getNode('SK1')?.hidden).toBe(false)
    expect(hooks().hasSketchOutline('SK1')).toBe(true)
    expect(hooks().getBodyHandle('F1')).toBeUndefined()
  }, 40_000)
})
