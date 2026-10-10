// @vitest-environment jsdom
//
// WO UI-10 (BK-60) acceptance #3: Lab3DView's "Defeature holes" affordance
// used to display its healed result by exportStep -> re-import through
// openStepFile -- leaking the intermediate defeatured worker handle and
// discarding the engine's stable-id lineage (re-import mints fresh ids).
// This drives the REAL component boundary (render Lab3DView, click the real
// defeature button, real handlers) with the worker faked at the facade
// boundary, and asserts the healed body appears WITHOUT exportStep/
// openStepFile's own importStep being called again, the old body is
// removed, and the status message contract (healed/failed/refused/delta) is
// unchanged.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { Lab3DView } from '../../components/model3d/Lab3DView'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import type { BodyHandle, DefeatureRequest, DefeatureResult, FeatureVerdict } from '../../geom/geom-service'

afterEach(cleanup)

function stepFile(name = 'Plate.step'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'application/octet-stream' })
}

const HOLE_VERDICT: FeatureVerdict = {
  featureKey: 'H1',
  featureClass: 'blindHole',
  removable: true,
  effect: 'add',
  faceIds: ['F1'],
  neighbourIds: [],
  params: { diameter: 6, depth: 5 },
}

describe('Lab3DView defeature-holes flow (WO UI-10, BK-60: adoptBody, no export/re-import)', () => {
  it('adopts the healed body directly -- no exportStep/re-import round trip, old body removed, status contract unchanged', async () => {
    const defeatureBatchImpl = (_req: DefeatureRequest, mintHandle: () => BodyHandle): DefeatureResult => ({
      ok: true,
      body: mintHandle(),
      diagnostics: [],
      report: { requested: 1, healed: 1, failed: 0, refused: 0, totalVolumeDelta: 12.34, items: [] },
    })
    const client = createFakeGeomClient({
      importedBodies: [{ name: 'Plate Body' }],
      recognizeFeaturesResult: [HOLE_VERDICT],
      defeatureBatchImpl,
    })
    render(<Lab3DView createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)

    // Boot, then a real "Open STEP" so a lastStepBodyIdRef target exists.
    await screen.findByTestId('body-visible-demoBody')
    fireEvent.change(screen.getByTestId('lab3d-open-step') as HTMLInputElement, {
      target: { files: [stepFile()] },
    })
    await screen.findByText('Plate Body')
    expect(client.importStepCalls.length).toBe(1)

    fireEvent.click(screen.getByTestId('lab3d-defeature-holes'))

    await waitFor(() => {
      const status = screen.getByTestId('lab3d-defeature-status').textContent ?? ''
      expect(status).toMatch(/1 healed \/ 0 failed \/ 0 refused; delta 12\.34 mm\^3/)
    })

    // BK-60's fix: NO exportStep, and openStepFile's own importStep never
    // fires again (both spied via the fake client's call-tracking).
    expect(client.exportStepCallCount).toBe(0)
    expect(client.importStepCalls.length).toBe(1)

    // old (pre-defeature) body removed from the list; healed body present
    // under the adopted display name, pickable/visible like an imported one.
    expect(screen.queryByText('Plate Body')).toBeNull()
    await screen.findByText('Plate Body (defeatured)')
    const oldBodyId = 'IMP1:body#0'
    const newBodyId = `${oldBodyId}:defeatured#1`
    expect(screen.queryByTestId(`body-visible-${oldBodyId}`)).toBeNull()
    expect(screen.getByTestId(`body-visible-${newBodyId}`)).toBeTruthy()
  })
})
