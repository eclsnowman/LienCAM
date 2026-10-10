// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { BodyHandle } from '../../geom/geom-service'

afterEach(cleanup)
const hooks = () => window.__solidsWorkbenchHooks!

async function setup(previewCoversOwner = false) {
  const owners = new Map<BodyHandle, string>()
  const client = createFakeGeomClient({
    makeExtrudeImpl: (request, mint) => {
      const body = mint()
      owners.set(body, request.featureId)
      return { ok: true, body, diagnostics: [] }
    },
    applyFilletImpl: (_request, mint) => ({ ok: true, body: mint(), diagnostics: [] }),
    applyChamferImpl: (_request, mint) => ({ ok: true, body: mint(), diagnostics: [] }),
  })
  client.tessellate = async handle => makeBoxTessBuffers((owners.get(handle) === 'F2' || (previewCoversOwner && !owners.has(handle)))
    ? { featureId: 'front', size: { x: 40, y: 40, z: 10 }, center: { x: 0, y: 0, z: 30 } }
    : { featureId: 'rear', size: { x: 20, y: 20, z: 10 } })
  const runtime = createFakeSceneRuntime()
  render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  for (const id of ['F1', 'F2']) {
    const sketchId = await mintRectangleSketch()
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id, kind: 'feature', consumes: [sketchId],
      payload: { opType: 'extrude', sketchId, distance: 10, direction: 'up', boolMode: 'newBody', name: id },
    }))
    await hooks().fullResync([id])
    await waitFor(() => expect(hooks().getBodyHandle(id)).toBeDefined())
  }
  runtime.rayOverride = { origin: { x: 10, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  return runtime
}

async function toggleFront() {
  fireEvent.click(screen.getByTestId('body-visible-F2'))
  await waitFor(() => expect(hooks().getBodyPresentationVisible('F2')).toBe(
    (screen.getByTestId('body-visible-F2') as HTMLInputElement).checked))
}

function hover() { fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas')) }
function click() { fireEvent.click(screen.getByTestId('solids-workbench-canvas')) }

describe('WO-2077 Model rendered occluders, independent of selectable owners', () => {
  it.each(['hover', 'click'])('an unarmed Fillet %s ignores a hidden live body and accepts it when visible', async route => {
    const runtime = await setup()
    // Aim at the front body's boundary, outside the rear body's footprint.
    runtime.rayOverride = { origin: { x: 20, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    await toggleFront()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    if (route === 'hover') {
      hover()
      expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()
    } else {
      click()
      expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/0 edges/)
    }
    await toggleFront()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    hover()
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout').textContent).toContain('front'))
    click()
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
  }, 60_000)

  it.each(['fillet', 'chamfer'])('%s hover/click ignores hidden front, then blocks the locked rear behind visible front', async feature => {
    const runtime = await setup()
    await toggleFront()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    fireEvent.click(screen.getByTestId(`workbench-${feature}`))
    hover()
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout').textContent).toContain('rear'))
    click()
    await waitFor(() => expect(screen.getByTestId(`${feature}-edge-count`).textContent).toMatch(/1 edge/))
    await waitFor(() => expect(screen.getByTestId(`${feature}-preview-status`).getAttribute('data-status')).toBe('ready'))
    expect(hooks().getBodyPresentationVisible(`__${feature}-preview__`)).toBe(true)
    // Owner source is now hidden behind its rendered preview. Its coincident
    // boundary is still visible/selectable; the old cached source is no occluder.
    hover()
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout').textContent).toContain('rear'))
    // Audit 3: a second CREATE click on the owner, now hidden behind its own
    // preview, still adds the edge under the cursor (the opposite rear edge).
    runtime.rayOverride = { origin: { x: -10, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    click()
    await waitFor(() => expect(screen.getByTestId(`${feature}-edge-count`).textContent).toMatch(/2 edges/))
    runtime.rayOverride = { origin: { x: 10, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    await toggleFront()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    hover()
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull())
    click()
    expect(screen.getByTestId(`${feature}-edge-count`).textContent).toMatch(/2 edges/)
  }, 60_000)

  it.each(['unshaded', 'translucent'])('%s display: no face hides an edge, so the rear edge behind the front body picks', async mode => {
    await setup()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    fireEvent.click(screen.getByTestId(`workbench-shading-${mode}`))
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    hover()
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout').textContent).toContain('rear'))
    click()
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
  }, 60_000)

  it.each(['fillet', 'chamfer'])('%s uses its rendered preview as an occluder even though it is not selectable', async feature => {
    await setup(true)
    await toggleFront()
    fireEvent.click(screen.getByTestId(`workbench-${feature}`))
    click()
    await waitFor(() => expect(screen.getByTestId(`${feature}-preview-status`).getAttribute('data-status')).toBe('ready'))
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)
    expect(hooks().getBodyPresentationVisible(`__${feature}-preview__`)).toBe(true)
    hover()
    expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()
    click()
    expect(screen.getByTestId(`${feature}-edge-count`).textContent).toMatch(/1 edge/)
  }, 60_000)

  it('edit-existing picks see visible non-candidate bodies and restore after they are hidden', async () => {
    const runtime = await setup()
    const edge = hooks().getBodyEdgeIds('F1')![0]
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F3', kind: 'feature', consumes: ['F1'], refs: [],
      payload: { opType: 'fillet', ownerId: 'F1', edges: [edge], radius: 2, propagateTangent: true },
    }))
    await hooks().fullResync(['F3'])
    await waitFor(() => expect(hooks().getBodyHandle('F3')).toBeDefined())
    fireEvent.contextMenu(screen.getByTestId('feature-row-F3'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
    hover()
    expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()
    click()
    expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/)
    await toggleFront()
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready'))
    expect(hooks().getBodyPresentationVisible('__fillet-preview__')).toBe(true)
    // Edit normally forces the owner visible while hiding the edited result.
    // Exercise the explicitly supported hidden-owner presentation state through
    // the scene seam, with the real preview, page handlers and picker retained.
    const ownerMesh = runtime.addedObjects.find(object => object.type === 'Mesh' && object.userData.workbenchFeatureId === 'F1')!
    expect(ownerMesh).toBeDefined()
    ownerMesh.visible = false
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)
    hover()
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout').textContent).toContain('rear'))
    expect(hooks().getBodyPresentationVisible('F3')).toBe(false)
    ownerMesh.visible = false
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)
    click()
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/2 edges/))
  }, 60_000)
})
