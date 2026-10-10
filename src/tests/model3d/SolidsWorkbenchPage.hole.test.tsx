// @vitest-environment jsdom
//
// WO UI-13A (INT-5 gate-premise catch): drives the REAL SolidsWorkbenchPage
// against the REAL in-process kernel (createLocalGeomService) through the
// actual Hole toolbar toggle -- a single-shot face pick (mirrors push-pull's
// own arm->pick->mount shape) followed by HoleDialog, which also owns the
// linear/circular PLACEMENT options this WO folds into the same feature (see
// HoleDialog.tsx's header for why there is no separate "pattern" op).
//
// Body under test: same box fixture as SolidsWorkbenchPage.dressUp.test.tsx
// (sketch 40x20 offset 10, extrude 20 -> box x:[10,50] y:[0,20] z:[0,20]).

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'
import type { PlaneFrame } from '../../sketch3d/planeMath'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

describe('SolidsWorkbenchPage Hole wiring (WO UI-13A, real occt-wasm kernel)', () => {
  it('Hole: simple blind hole at a picked point, apply, body updates, one undo removes it', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    const f1Mesh = runtime.scene.children.find(
      (object): object is THREE.Mesh => object instanceof THREE.Mesh && object.userData.workbenchFeatureId === 'F1',
    )
    expect(f1Mesh).toBeDefined()
    // Recreate the pre-UI-35 latent state. The Hole success path must clear
    // this flag when it hides the superseded owner body.
    f1Mesh!.castShadow = true

    fireEvent.click(screen.getByTestId('workbench-hole'))
    // top face z=20, point (20,5,20) -- well inside x:[10,50] y:[0,20].
    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    commitField('hole-diameter', '6')
    commitField('hole-blind-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const vol1 = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    const expected = 16000 - Math.PI * 9 * 5
    expect(Math.abs(vol1.value - expected) / expected).toBeLessThan(1e-3)

    await waitFor(() => expect(screen.queryByTestId('body-row-F1')).toBeNull())
    expect(screen.getByTestId('body-row-F2')).toBeTruthy()
    expect(f1Mesh!.visible).toBe(false)
    expect(f1Mesh!.castShadow).toBe(false)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true))
  }, 60_000)

  it('Hole: linear placement drills two non-overlapping holes from one pick', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-hole'))
    // top face z=20, point (20,15,20) -- linear placement below walks -Y
    // (perpBasis's derived in-plane u for a +Z face normal), staying inside
    // y:[0,20] for both instances (15, then 15-10=5).
    runtime.rayOverride = { origin: { x: 20, y: 15, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    commitField('hole-diameter', '6')
    commitField('hole-blind-distance', '5')
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'linear' } })
    commitField('hole-pattern-count', '2')
    commitField('hole-pattern-spacing', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const vol1 = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    const expected = 16000 - 2 * Math.PI * 9 * 5
    expect(Math.abs(vol1.value - expected) / expected).toBeLessThan(1e-3)
  }, 60_000)

  // WO UI-13B (folded from the UI-13A audit, codex finding: "one real-page
  // Hole test with CIRCULAR placement"): the two existing cases above cover
  // single + linear; this is the missing third placement kind. Picked at the
  // top face's own center (30,10,20) with a small bolt-circle radius (5mm)
  // so all 4 holes (diameter 4mm, well inside the 40x20 top face) stay
  // clear of the body's edges regardless of perpBasis's chosen in-plane axes.
  it('Hole: circular placement drills a 4-hole bolt circle from one pick, apply, verify body volume/feature node, one undo removes it', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-hole'))
    // top face z=20, center point (30,10,20) -- dead center of the
    // x:[10,50] y:[0,20] top face.
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    commitField('hole-diameter', '4')
    commitField('hole-blind-distance', '5')
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'circular' } })
    commitField('hole-pattern-count', '4')
    commitField('hole-pattern-radius', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.getByTestId('feature-row-F2')).toBeTruthy())
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const vol1 = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    // 4 blind holes, diameter 4 (r=2), depth 5, no overlap (5mm bolt-circle
    // radius >> 2mm hole radius): 16000 - 4 * pi * r^2 * depth.
    const expected = 16000 - 4 * Math.PI * 4 * 5
    expect(Math.abs(vol1.value - expected) / expected).toBeLessThan(1e-3)

    // The owner body (F1) is superseded and absent from the one-live-body
    // panel, same contract every other Hole case proves.
    await waitFor(() => expect(screen.queryByTestId('body-row-F1')).toBeNull())
    expect(screen.getByTestId('body-row-F2')).toBeTruthy()

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true))
  }, 60_000)

  // WO UI-16 (C4 acceptance #4, first case): "typed seed overrides the click point in the executed
  // request".
  it('Hole: typed X/Y/Z seed overrides the click point in the executed request (WO UI-16 C4)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-hole'))
    // top face z=20, click point (20,5,20).
    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    // Untouched default reproduces the click point exactly.
    expect((screen.getByTestId('hole-seed-x').querySelector('input') as HTMLInputElement).value).toBe('20')
    expect((screen.getByTestId('hole-seed-y').querySelector('input') as HTMLInputElement).value).toBe('5')
    expect((screen.getByTestId('hole-seed-z').querySelector('input') as HTMLInputElement).value).toBe('20')

    // Type a DIFFERENT seed, well away from the click point but still inside the top face.
    commitField('hole-seed-x', '35')
    commitField('hole-seed-y', '15')
    commitField('hole-diameter', '6')
    commitField('hole-blind-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const payload = hooks().dag.getNode('F2')?.payload as { points?: Array<{ x: number; y: number; z: number }> } | undefined
    expect(payload?.points).toHaveLength(1)
    expect(payload!.points![0]).toEqual({ x: 35, y: 15, z: 20 })
  }, 60_000)

  // WO UI-16 (C4 acceptance #4, second + third cases): "snap candidate fills the fields (fixture:
  // sketch with a known point on the target plane); projection math asserted against a
  // hand-computed world point."
  it('Hole: a dialog-side snap list appears for a sketch on the picked face; selecting a candidate fills the typed fields with a hand-verified world point (WO UI-16 C4)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    // --- Fixture: a sketch-on-face on the SAME top face the Hole pick below targets, with ONE
    // known point entity, injected directly into the DAG (config-only 2D data, no kernel round trip
    // needed) so its local coordinate is exact and independent of any drawing-tool interaction. ---
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK2')).toBeTruthy())

    // Inject the known point AFTER the session has torn down (Finish above) -- so nothing live
    // (the package session's own exit/dispose) can flush a stale blank document over it.
    const KNOWN_LOCAL = { x: 5, y: -3 }
    const sketchNodeId = 'sketch3d:SK2'
    const sketchBefore = hooks().dag.getNode(sketchNodeId)?.payload.sketch as CamSketch | undefined
    expect(sketchBefore).toBeDefined()
    const knownSketch: CamSketch = {
      ...sketchBefore!,
      entities: [{ id: 'known-pt', kind: 'point', construction: false, at: KNOWN_LOCAL }],
    }
    hooks().dag.setPayload(sketchNodeId, { ...hooks().dag.getNode(sketchNodeId)!.payload, sketch: knownSketch })

    // Hand-compute the expected world point from the datum's OWN resolved frame (read, not
    // re-derived via the app's projection helper -- an independent check).
    const frame = (hooks().dag.getNode('datum:SK2')?.payload as { lastGoodFrame?: PlaneFrame } | undefined)?.lastGoodFrame
    expect(frame).toBeDefined()
    const { origin, normal, xDir } = frame!
    const yDir = { x: normal.y * xDir.z - normal.z * xDir.y, y: normal.z * xDir.x - normal.x * xDir.z, z: normal.x * xDir.y - normal.y * xDir.x }
    const expectedWorld = {
      x: origin.x + xDir.x * KNOWN_LOCAL.x + yDir.x * KNOWN_LOCAL.y,
      y: origin.y + xDir.y * KNOWN_LOCAL.x + yDir.y * KNOWN_LOCAL.y,
      z: origin.z + xDir.z * KNOWN_LOCAL.x + yDir.z * KNOWN_LOCAL.y,
    }

    // --- Now arm Hole and pick a DIFFERENT point on the SAME top face. ---
    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-hole'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    const snapSelect = screen.getByTestId('hole-snap-select') as HTMLSelectElement
    const knownOption = [...snapSelect.options].find((o) => o.value.includes('known-pt'))
    expect(knownOption).toBeDefined()
    fireEvent.change(snapSelect, { target: { value: knownOption!.value } })

    const readX = Number((screen.getByTestId('hole-seed-x').querySelector('input') as HTMLInputElement).value)
    const readY = Number((screen.getByTestId('hole-seed-y').querySelector('input') as HTMLInputElement).value)
    const readZ = Number((screen.getByTestId('hole-seed-z').querySelector('input') as HTMLInputElement).value)
    expect(readX).toBeCloseTo(expectedWorld.x, 6)
    expect(readY).toBeCloseTo(expectedWorld.y, 6)
    expect(readZ).toBeCloseTo(expectedWorld.z, 6)
  }, 60_000)

  it('Hole: a canvas hover and nearby click select the projected sketch point (UI-67/UI-93)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    // Put one sketch point on the top face. The fixture follows the real
    // Sketch-on-face lifecycle before supplying its deterministic test point.
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK2')).toBeTruthy())
    const sketchNodeId = 'sketch3d:SK2'
    const sketchBefore = hooks().dag.getNode(sketchNodeId)?.payload.sketch as CamSketch | undefined
    expect(sketchBefore).toBeDefined()
    hooks().dag.setPayload(sketchNodeId, {
      ...hooks().dag.getNode(sketchNodeId)!.payload,
      sketch: {
        ...sketchBefore!,
        entities: [{ id: 'pickable-pt', kind: 'point', construction: false, at: { x: 5, y: -3 } }],
      },
    })

    // The fake projects the candidate at (200,200).  Clicking twelve pixels
    // away is outside the old 14px marker, but inside the shared projected
    // picker tolerance used by the live workbench canvas path.
    runtime.projectToCanvasResult = { x: 200, y: 200 }
    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-hole'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    const candidateId = [...(screen.getByTestId('hole-snap-select') as HTMLSelectElement).options]
      .find((option) => option.value.includes('pickable-pt'))?.value
    expect(candidateId).toBeDefined()
    const canvas = screen.getByTestId('solids-workbench-canvas')
    fireEvent.pointerMove(canvas, { clientX: 212, clientY: 200 })
    await waitFor(() => expect(screen.getByTestId('hole-point-pick-layer').dataset.hoveredId).toBe(candidateId))
    expect((canvas as HTMLCanvasElement).style.cursor).toBe('crosshair')

    fireEvent.click(canvas, { clientX: 212, clientY: 200 })
    const frame = (hooks().dag.getNode('datum:SK2')?.payload as { lastGoodFrame?: PlaneFrame } | undefined)?.lastGoodFrame
    expect(frame).toBeDefined()
    const { origin, normal, xDir } = frame!
    const yDir = { x: normal.y * xDir.z - normal.z * xDir.y, y: normal.z * xDir.x - normal.x * xDir.z, z: normal.x * xDir.y - normal.y * xDir.x }
    const expectedWorld = {
      x: origin.x + xDir.x * 5 + yDir.x * -3,
      y: origin.y + xDir.y * 5 + yDir.y * -3,
      z: origin.z + xDir.z * 5 + yDir.z * -3,
    }
    expect(Number((screen.getByTestId('hole-seed-x').querySelector('input') as HTMLInputElement).value)).toBeCloseTo(expectedWorld.x, 6)
    expect(Number((screen.getByTestId('hole-seed-y').querySelector('input') as HTMLInputElement).value)).toBeCloseTo(expectedWorld.y, 6)
    expect(Number((screen.getByTestId('hole-seed-z').querySelector('input') as HTMLInputElement).value)).toBeCloseTo(expectedWorld.z, 6)
    expect((screen.getByTestId('hole-snap-select') as HTMLSelectElement).value).toBe(candidateId)
  }, 60_000)

  // UI-16 audit major 1 regression: each Sketch-on-face action mints its OWN face datum,
  // and the original computeSnapCandidates find() saw only the FIRST matching datum --
  // every later sketch on the same picked face was silently absent from the snap list.
  it('Hole: snap list includes points from EVERY sketch on the picked face, across separate datums (UI-16 audit major 1)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    // TWO separate sketch-on-face sessions on the SAME top face -> two datums.
    const sketchIds: string[] = []
    for (const [n, pointId] of [
      [2, 'first-pt'],
      [3, 'second-pt'],
    ] as const) {
      runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
      fireEvent.click(screen.getByTestId('workbench-new-sketch'))
      fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
      await waitFor(() => expect(screen.getByTestId(`feature-row-datum:SK${n}`)).toBeTruthy(), { timeout: 20_000 })
      fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
      await waitFor(() => expect(screen.getByTestId(`feature-row-sketch3d:SK${n}`)).toBeTruthy())
      const sketchNodeId = `sketch3d:SK${n}`
      const before = hooks().dag.getNode(sketchNodeId)?.payload.sketch as CamSketch | undefined
      expect(before).toBeDefined()
      hooks().dag.setPayload(sketchNodeId, {
        ...hooks().dag.getNode(sketchNodeId)!.payload,
        sketch: { ...before!, entities: [{ id: pointId, kind: 'point', construction: false, at: { x: n, y: -n } }] },
      })
      sketchIds.push(sketchNodeId)
    }
    // Two DISTINCT datums must exist for the same face.
    expect(hooks().dag.getNode('datum:SK2')).toBeDefined()
    expect(hooks().dag.getNode('datum:SK3')).toBeDefined()

    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-hole'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    const snapSelect = screen.getByTestId('hole-snap-select') as HTMLSelectElement
    const values = [...snapSelect.options].map((o) => o.value)
    // BOTH sketches' points present -- the second one is what the find() bug dropped.
    expect(values.some((v) => v.includes('first-pt'))).toBe(true)
    expect(values.some((v) => v.includes('second-pt'))).toBe(true)
  }, 90_000)
})
