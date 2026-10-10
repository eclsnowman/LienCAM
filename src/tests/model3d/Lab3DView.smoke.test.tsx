// @vitest-environment jsdom
//
// RENDER SMOKE TEST (WO UI-2 acceptance #5): mounts the real Lab3DView with
// the worker faked at the facade boundary (createClient) and THREE/WebGL
// faked at the scene-runtime boundary (createSceneRuntime) -- jsdom has no
// WebGL context, so this is the only way to mount the component without a
// real THREE.WebGLRenderer construction throwing inside the mount effect.
// Asserts: mounts without throwing, no hooks-order violation, the demo body
// eventually appears in the body list (async: body creation runs through the
// fake client), and all four filter-mode buttons render.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { Lab3DView } from '../../components/model3d/Lab3DView'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('Lab3DView render smoke test', () => {
  it('mounts and renders without throwing or a hooks-order violation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />),
      ).not.toThrow()

      // Let the async boot (init -> createCutBox -> tessellateProgressive)
      // settle so we can assert on its downstream effects too.
      await waitFor(() => {
        expect(screen.getByTestId('lab3d-status').textContent).toMatch(/ready/i)
      })

      const hooksOrderCalls = errorSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && /hooks|hook order|Rendered (more|fewer) hooks/i.test(msg),
      )
      expect(hooksOrderCalls).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('the demo body eventually appears in the body list', async () => {
    render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)

    const visibilityCheckbox = await screen.findByTestId('body-visible-demoBody')
    expect(visibilityCheckbox).toBeTruthy()
    expect(screen.getByText('Cut Box')).toBeTruthy()
  })

  it('renders the canvas and all four filter-mode buttons', () => {
    render(<Lab3DView createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)

    expect(screen.getByTestId('lab3d-canvas')).toBeTruthy()
    for (const mode of ['body', 'face', 'edge', 'vertex']) {
      expect(screen.getByTestId(`lab3d-filter-${mode}`)).toBeTruthy()
    }
  })
})
