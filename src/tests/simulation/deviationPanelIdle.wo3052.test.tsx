// @vitest-environment jsdom
// WO-3052: a second REGEN ALL crashed the page with "Maximum update depth
// exceeded". The Final Part Deviation panel is always mounted in the viewport;
// its comparison effect is keyed on `project` and cleared its result first
// thing, so every store write (each toolpath progress tick) made the idle panel
// schedule a re-render of its own. While writes keep landing before React gets
// a quiet turn to render that update, every commit leaves it pending, React's
// nested-update counter climbs, and at 50 the next store write throws.
//
// This drives the real store through the real progress write (updateOperation)
// with the real panel mounted, letting only microtasks run between writes - the
// shape of a busy main thread during REGEN ALL, where the worker's messages keep
// arriving before the scheduler's next task.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Project } from '../../types'
import { useCamStore } from '../../store'
import { DeviationPanel } from '../../components/simulation/DeviationPanel'

const WRITES = 60
const reactActEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

describe('WO-3052 the idle deviation panel does not re-render itself on every store write', () => {
  let setupId = ''
  let opId = ''
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const project = JSON.parse(readFileSync('src/tests/evidence/WO-2694/journey-1009-scratch.camproject', 'utf8')) as Project
    setupId = project.setups[0].id
    opId = project.setups[0].operations[0].id
    act(() => useCamStore.setState({ project,
      viewer: { ...useCamStore.getState().viewer, mode: 'toolpath', selectedStockId: null } }))
  })
  afterEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    cleanup(); vi.unstubAllGlobals()
  })

  it('60 progress writes in a busy turn: no nested-update error, one panel render per write', async () => {
    let panelCommits = 0
    render(<Profiler id="deviation" onRender={() => { panelCommits++ }}>
      <div><DeviationPanel onOverlay={() => {}} /></div>
    </Profiler>)
    // Let the mount settle (its own effects) before counting.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    panelCommits = 0

    // Outside act: React schedules as it does in the browser.
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    const thrown: string[] = []
    for (let i = 1; i <= WRITES; i++) {
      try {
        useCamStore.getState().updateOperation(setupId, opId, { progress: i / (WRITES + 1), progressPhase: 'WO-3052' })
      } catch (error) {
        thrown.push(String((error as Error).message ?? error))
      }
      // Microtasks only: React's sync work flushes, its next scheduler task does not.
      for (let k = 0; k < 5; k++) await Promise.resolve()
    }
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(thrown.filter((message) => /Maximum update depth/.test(message))).toEqual([])
    // One commit per store write; the idle panel adds none of its own.
    expect(panelCommits).toBeLessThanOrEqual(WRITES)
    expect(useCamStore.getState().project.setups[0].operations[0].progress).toBeCloseTo(WRITES / (WRITES + 1))
  })
  it('the open panel in Simulate: 60 progress writes in a busy turn raise no nested-update error', async () => {
    const project = useCamStore.getState().project
    act(() => useCamStore.setState({ viewer: { ...useCamStore.getState().viewer, mode: 'simulation',
      selectedStockId: project.stocks?.[0]?.id ?? null } }))
    render(<div>
      <input className="sim-scrubber" type="range" max={1000} defaultValue={1000} />
      <DeviationPanel onOverlay={() => {}} />
    </div>)
    fireEvent.click(await screen.findByRole('checkbox'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    const thrown: string[] = []
    for (let i = 1; i <= WRITES; i++) {
      try {
        useCamStore.getState().updateOperation(setupId, opId, { progress: i / (WRITES + 1), progressPhase: 'WO-3052' })
      } catch (error) {
        thrown.push(String((error as Error).message ?? error))
      }
      for (let k = 0; k < 5; k++) await Promise.resolve()
    }
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(thrown.filter((message) => /Maximum update depth/.test(message))).toEqual([])
  })
})
