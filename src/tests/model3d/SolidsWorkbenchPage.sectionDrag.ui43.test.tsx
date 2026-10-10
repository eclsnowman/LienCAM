// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

describe('UI-43 viewport section interaction', () => {
  it('enters section mode, drags the existing clipping plane, and clears it', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
      { timeout: 20_000 },
    )

    const dragMode = screen.getByTestId('section-drag-mode') as HTMLButtonElement
    expect(dragMode.disabled).toBe(true)

    await mintRectangleSketch({ width: '40', height: '20' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(
      () => expect(window.__solidsWorkbenchHooks?.getBodyHandle('F1')).not.toBeUndefined(),
      { timeout: 20_000 },
    )
    await waitFor(() => expect(dragMode.disabled).toBe(false))

    const canvas = screen.getByTestId('solids-workbench-canvas') as HTMLCanvasElement
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 400,
        bottom: 200,
        width: 400,
        height: 200,
        toJSON: () => undefined,
      }) as DOMRect

    fireEvent.click(dragMode)
    await waitFor(() => {
      expect((screen.getByTestId('section-enabled') as HTMLInputElement).checked).toBe(true)
      expect(dragMode.getAttribute('aria-pressed')).toBe('true')
      expect(runtime.clipPlaneCalls.at(-1)?.length).toBe(1)
    })

    const slider = screen.getByTestId('section-slider') as HTMLInputElement
    expect(Number(slider.value)).toBe(50)
    fireEvent.pointerDown(canvas, { pointerId: 7, clientY: 100 })
    fireEvent.pointerMove(canvas, { pointerId: 7, clientY: 150 })
    fireEvent.pointerUp(canvas, { pointerId: 7, clientY: 150 })

    await waitFor(() => {
      expect(Number(slider.value)).toBeCloseTo(25, 6)
      expect(runtime.clipPlaneCalls.at(-1)?.[0].constant).toBeCloseTo(25, 6)
    })

    fireEvent.click(screen.getByTestId('section-clear'))
    await waitFor(() => {
      expect((screen.getByTestId('section-enabled') as HTMLInputElement).checked).toBe(false)
      expect(dragMode.getAttribute('aria-pressed')).toBe('false')
      expect(runtime.clipPlaneCalls.at(-1)).toEqual([])
    })
  }, 60_000)
})
