// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function pickProfile(
  runtime: ReturnType<typeof createFakeSceneRuntime>,
  ray: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } },
  sketchId: string,
): void {
  runtime.rayOverride = ray
  const canvas = screen.getByTestId('solids-workbench-canvas')
  fireEvent.pointerMove(canvas, { clientX: 400, clientY: 300 })
  expect(screen.getByTestId('workbench-profile-hover-readout').textContent).toContain(sketchId)
  fireEvent.click(canvas, { clientX: 400, clientY: 300 })
}

describe('Sweep and Loft nonblocking profile palettes', () => {
  it('keeps Sweep mounted and completes automatically from one shared-controller viewport click', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch({ id: 'SK1', plane: 'xy' })
    await mintRectangleSketch({ id: 'SK2', plane: 'xz' })
    await waitFor(() => expect((screen.getByTestId('workbench-sweep') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK1')
    fireEvent.click(screen.getByTestId('sweep-pick-profile'))
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('solids-workbench-profile-pick-hint')).toBeTruthy()
    expect(screen.queryByTestId('workbench-done-profile-pick')).toBeNull()
    expect(screen.getByTestId('sweep-pick-profile').getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)

    pickProfile(
      runtime,
      { origin: { x: 20, y: -100, z: 10 }, direction: { x: 0, y: 1, z: 0 } },
      'SK2',
    )

    expect(screen.queryByTestId('solids-workbench-profile-pick-hint')).toBeNull()
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK2')
    expect(screen.getByTestId('sweep-pick-profile').getAttribute('aria-pressed')).toBe('false')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps Loft mounted while the shared controller advances 0/2 -> 1/2 -> 2/2 and commits click order on Done', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch({ id: 'SK1', plane: 'xy' })
    await mintRectangleSketch({ id: 'SK2', plane: 'xz' })
    await waitFor(() => expect((screen.getByTestId('workbench-loft') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByTestId('workbench-loft'))
    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    const initialFirst = (screen.getByTestId('loft-section1-select') as HTMLSelectElement).value
    const initialSecond = (screen.getByTestId('loft-section2-select') as HTMLSelectElement).value

    fireEvent.click(screen.getByTestId('loft-pick-profiles'))
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('solids-workbench-profile-pick-hint').textContent).toMatch(/0\/2 selected/i)
    expect(screen.queryByTestId('workbench-done-profile-pick')).toBeNull()
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)

    pickProfile(
      runtime,
      { origin: { x: 20, y: -100, z: 10 }, direction: { x: 0, y: 1, z: 0 } },
      'SK2',
    )
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('solids-workbench-profile-pick-hint').textContent).toMatch(/1\/2 selected/i)
    expect(screen.queryByTestId('workbench-done-profile-pick')).toBeNull()
    expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe(initialFirst)
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe(initialSecond)

    pickProfile(
      runtime,
      { origin: { x: 20, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
      'SK1',
    )
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(screen.getByTestId('solids-workbench-profile-pick-hint').textContent).toMatch(/2\/2 selected/i)
    expect(screen.getByTestId('workbench-done-profile-pick')).toBeTruthy()
    expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe(initialFirst)
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe(initialSecond)

    fireEvent.click(screen.getByTestId('workbench-done-profile-pick'))
    expect(screen.queryByTestId('solids-workbench-profile-pick-hint')).toBeNull()
    const firstSelect = screen.getByTestId('loft-section1-select') as HTMLSelectElement
    const secondSelect = screen.getByTestId('loft-section2-select') as HTMLSelectElement
    expect(firstSelect.value).toBe('SK2')
    expect(secondSelect.value).toBe('SK1')
    expect(screen.getByTestId('loft-section1-label').textContent).toContain(firstSelect.selectedOptions[0]?.textContent ?? '')
    expect(screen.getByTestId('loft-section2-label').textContent).toContain(secondSelect.selectedOptions[0]?.textContent ?? '')
    expect(screen.getByTestId('loft-pick-profiles').getAttribute('aria-pressed')).toBe('false')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
  })
})
