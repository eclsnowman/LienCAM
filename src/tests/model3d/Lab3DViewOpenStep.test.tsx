// @vitest-environment jsdom
//
// WO INT-1 acceptance #1 ("Open STEP") + #2 (BK-15 progressive-at-scale
// stats) + #3's body-panel-volume half: drives the real Lab3DView file input
// with the worker faked at the facade boundary (same seam UI-2's render
// smoke test established) and asserts the imported body lands in the list
// with its name, the body-panel volume renders, and the BK-15 coarse-tier
// stats get recorded on window.__lab3dImportStats.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { Lab3DView } from '../../components/model3d/Lab3DView'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

afterEach(() => {
  cleanup()
  delete window.__lab3dImportStats
})

function stepFile(name = 'Tray.step'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'application/octet-stream' })
}

describe('Lab3DView Open STEP flow', () => {
  it('importing a STEP file with a named/colored body adds it to the body list and shows its volume', async () => {
    const client = createFakeGeomClient({
      importedBodies: [{ name: 'Tray Body', color: [0.2, 0.4, 0.9] }],
      measureResult: { kind: 'volume', value: 12345.678 },
    })
    render(<Lab3DView createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)

    // Wait for the demo body first (mount-time boot), then drive the file input.
    await screen.findByTestId('body-visible-demoBody')

    const input = screen.getByTestId('lab3d-open-step') as HTMLInputElement
    fireEvent.change(input, { target: { files: [stepFile()] } })

    await screen.findByText('Tray Body')
    expect(client.importStepCalls.length).toBe(1)
    expect(client.importStepCalls[0].importId).toBe('IMP1')

    await waitFor(() => {
      const bodyId = 'IMP1:body#0'
      const volumeEl = screen.getByTestId(`body-volume-${bodyId}`)
      expect(volumeEl.textContent).toContain('12345.68')
    })
  })

  it('records BK-15 coarse-tier stats on window.__lab3dImportStats, never for the demo box', async () => {
    const client = createFakeGeomClient({ importedBodies: [{ name: 'Part A' }] })
    render(<Lab3DView createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)

    await screen.findByTestId('body-visible-demoBody')
    expect(window.__lab3dImportStats).toBeUndefined()

    fireEvent.change(screen.getByTestId('lab3d-open-step') as HTMLInputElement, {
      target: { files: [stepFile()] },
    })

    await waitFor(() => {
      expect(window.__lab3dImportStats?.some((s) => s.phase === 'coarse')).toBe(true)
    })
    const stat = window.__lab3dImportStats?.find((s) => s.phase === 'coarse')
    expect(stat?.bodyId).toBe('IMP1:body#0')
    expect(stat?.triangles).toBeGreaterThan(0)
    expect(stat?.ms).toBeGreaterThanOrEqual(0)
  })

  it('surfaces an import error instead of silently failing', async () => {
    const client = createFakeGeomClient()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    client.importStep = async () => {
      throw new Error('kernel exploded')
    }
    try {
      render(<Lab3DView createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
      await screen.findByTestId('body-visible-demoBody')

      fireEvent.change(screen.getByTestId('lab3d-open-step') as HTMLInputElement, {
        target: { files: [stepFile()] },
      })

      await screen.findByTestId('lab3d-import-error')
      expect(screen.getByTestId('lab3d-import-error').textContent).toMatch(/kernel exploded/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
