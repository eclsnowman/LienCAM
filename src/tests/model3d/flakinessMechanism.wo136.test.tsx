// @vitest-environment jsdom
//
// WO-136 proves a diagnosis; it does not change product behavior.
//
// SolidsWorkbenchPage.rollback.test.tsx waits for a body handle stored in a
// useRef Map and then immediately reads a DOM row. Those signals settle at
// different points in fullResync: the handle is written during scheduler work,
// while the row is published later by refreshBodiesList and a React commit.
// Delaying tessellation opens that existing window on demand without CPU load.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

const TEST_TIMEOUT_MS = 60_000
const TESSELLATE_DELAY_MS = 80

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function delayedTessellateClient(armed: () => boolean): ReturnType<typeof createFakeGeomClient> {
  const base = createFakeGeomClient()
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || prop !== 'tessellate') return value
      return async (...args: unknown[]): Promise<unknown> => {
        const result = await (value as (...values: unknown[]) => unknown).apply(target, args)
        if (armed()) {
          await new Promise((resolve) => { setTimeout(resolve, TESSELLATE_DELAY_MS) })
        }
        return result
      }
    },
  }) as ReturnType<typeof createFakeGeomClient>
}

async function buildAndRollBack(armed: () => boolean): Promise<void> {
  const client = delayedTessellateClient(armed)
  render(
    <SolidsWorkbenchPage
      createClient={() => client}
      createSceneRuntime={fakeCreateSceneRuntime}
    />,
  )
  await waitFor(() => {
    expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i)
  })
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

  fireEvent.click(screen.getByTestId('rollback-marker-up'))
  await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())
}

describe('WO-136 rollback flakiness mechanism', () => {
  it('reproduces the bare DOM miss on demand without CPU load', async () => {
    let armed = false
    await buildAndRollBack(() => armed)

    armed = true
    fireEvent.click(screen.getByTestId('rollback-marker-down'))

    // These are the model-state waits from the flaky test. Neither establishes
    // that React has committed the body-list row asserted immediately after.
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    expect(() => screen.getByTestId('body-visible-F1')).toThrow(
      /Unable to find an element by: \[data-testid="body-visible-F1"\]/,
    )

    // The row is late rather than missing; it arrives after the delayed tail.
    await waitFor(() => expect(screen.getByTestId('body-visible-F1')).toBeTruthy())
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
  }, TEST_TIMEOUT_MS)

  it('passes under the same delay when the wait observes the asserted DOM signal', async () => {
    let armed = false
    await buildAndRollBack(() => armed)

    armed = true
    fireEvent.click(screen.getByTestId('rollback-marker-down'))

    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(false))
    await waitFor(() => expect(screen.getByTestId('body-visible-F1')).toBeTruthy())

    expect(hooks().getBodyHandle('F1')).not.toBeUndefined()
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
  }, TEST_TIMEOUT_MS)
})
