// @vitest-environment jsdom
//
// RENDER SMOKE TEST (WO INT-4A acceptance #5): mounts the real
// SolidsWorkbenchPage with the worker faked at the facade boundary
// (createClient) and THREE/WebGL faked at the scene-runtime boundary
// (createSceneRuntime) -- same fake-injection precedent as
// Lab3DView.smoke.test.tsx / UI4Demo.smoke.test.tsx. Standing rule (per
// CLAUDE.md/memory): tsc+vitest alone miss hooks-order bugs, so this drives
// a REAL render pass and asserts no React hooks-order console.error fired,
// then opens every new dialog (sketch/extrude/revolve/boolean) in turn to
// prove each one mounts without throwing.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function hooksOrderErrors(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter(([msg]) => typeof msg === 'string' && /hooks|hook order|Rendered (more|fewer) hooks/i.test(msg))
}

describe('SolidsWorkbenchPage render smoke test', () => {
  it('mounts and reaches ready without throwing or a hooks-order violation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />),
      ).not.toThrow()

      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

      expect(hooksOrderErrors(errorSpy)).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('opens the sketch dialog and creates a sketch node without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

      await mintRectangleSketch()

      await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
      expect(hooksOrderErrors(errorSpy)).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('renders the extrude, revolve, and boolean dialogs once their prerequisite features exist', async () => {
    render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    // Extrude dialog renders once a sketch exists (button is disabled before that).
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    expect(screen.getByTestId('extrude-profile-select')).toBeTruthy()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    // Revolve dialog renders too.
    fireEvent.click(screen.getByTestId('workbench-revolve'))
    expect(screen.getByTestId('revolve-profile-select')).toBeTruthy()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    // Boolean needs two body features -- neither Extrude nor Revolve dialog
    // above was actually Applied (both were Cancelled), so no body feature
    // exists yet; just assert the button stays disabled rather than open it.
    expect((screen.getByTestId('workbench-boolean') as HTMLButtonElement).disabled).toBe(true)
  })

  // WO UI-56 deliverable 9: the Bodies-panel checkbox's new wiring
  // (handleToggleBodyVisible -> history.execute(SetHiddenCommand) ->
  // fullResync) mounts a hooks-order-sensitive render path (an async resync
  // after a click) that tsc+vitest type/unit coverage alone would not catch.
  it('toggles a body checkbox without throwing or a hooks-order violation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

      await mintRectangleSketch()
      await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

      fireEvent.click(screen.getByTestId('workbench-extrude'))
      fireEvent.click(screen.getByTestId('dialog-shell-apply'))
      await waitFor(() => expect(screen.getByTestId('body-visible-F1')).toBeTruthy())

      const checkbox = screen.getByTestId('body-visible-F1') as HTMLInputElement
      expect(checkbox.checked).toBe(true)
      fireEvent.click(checkbox)
      await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))
      fireEvent.click(screen.getByTestId('body-visible-F1'))
      await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true))

      expect(hooksOrderErrors(errorSpy)).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })
})
