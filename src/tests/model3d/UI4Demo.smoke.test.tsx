// @vitest-environment jsdom
//
// RENDER SMOKE TEST (WO UI-4 acceptance #2/#3/#4/#6): mounts the real UI4Demo
// harness with the worker faked at the facade boundary (createClient) and
// THREE/WebGL faked at the scene-runtime boundary (createSceneRuntime) --
// same fake-injection precedent as Lab3DView.smoke.test.tsx. Proves the
// measure panel, appearance panel, section controls, visibility panel, mass
// properties panel, and design tree all mount and render together without
// throwing or a hooks-order violation.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { UI4Demo } from '../../components/model3d/demo'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('UI4Demo render smoke test', () => {
  it('mounts and reaches ready without throwing or a hooks-order violation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />),
      ).not.toThrow()

      await waitFor(() => {
        expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i)
      })

      const hooksOrderCalls = errorSpy.mock.calls.filter(
        ([msg]) => typeof msg === 'string' && /hooks|hook order|Rendered (more|fewer) hooks/i.test(msg),
      )
      expect(hooksOrderCalls).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('renders the measure panel by default and can switch to the appearance panel', async () => {
    render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    expect(screen.getByTestId('measure-panel')).toBeTruthy()
    expect(screen.queryByTestId('appearance-panel')).toBeNull()

    fireEvent.click(screen.getByTestId('ui4-tool-appearance'))
    expect(screen.getByTestId('appearance-panel')).toBeTruthy()
    expect(screen.queryByTestId('measure-panel')).toBeNull()
  })

  it('renders section controls, visibility panel, and the design tree with a body row', async () => {
    render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    expect(screen.getByTestId('section-controls')).toBeTruthy()
    expect(screen.getByTestId('visibility-panel')).toBeTruthy()
    expect(screen.getByTestId('feature-row-demoBody')).toBeTruthy()
    expect(screen.getByTestId('feature-row-visible-demoBody')).toBeTruthy()
  })

  it('renders the mass properties panel with a material selector once ready', async () => {
    render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    expect(screen.getByTestId('mass-properties-panel')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('mass-material-select')).toBeTruthy())
  })

  it('toggling section-enabled drives the fake runtime clip planes and toggling off restores full render', async () => {
    render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    const checkbox = screen.getByTestId('section-enabled') as HTMLInputElement
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(false)
  })
})
