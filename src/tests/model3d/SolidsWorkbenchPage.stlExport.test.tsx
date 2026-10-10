// @vitest-environment jsdom
//
// WO MODEL-WORKSPACE-STL-EXPORT: page-level tests for the one-click Document-
// rail STL export. The pure merge/rebase/refusal/encode behavior is covered by
// modelStlExport.test.ts (no page mount); this file covers the UI action and
// the page-owned live-kernel contract:
//  - the STL button is wired in the Document rail (testId/label/title);
//  - the UI action uses the SAME hidden + structural-supersession eligibility
//    as STEP (the shared effectiveExportIds resolver) -- proven on the real
//    kernel with the identical F1-hidden + F2-superseded-by-fillet scenario
//    SolidsWorkbenchPage.bodyHiddenPersist.test.tsx uses for STEP;
//  - missing visible handles refuse by name rather than silently dropping a
//    body (the shared resolveExportBodyHandles fail-loud resolver);
//  - download filename (the project name, WO-2424; was 'workbench-export.stl') and MIME ('model/stl') are
//    exact;
//  - all-hidden produces the existing workbench-export-error surface and no
//    download.
//
// fakeGeomClient is used for every case that does not need the real kernel's
// dress-up supersession (so URL/Blob can be stubbed safely -- no occt-wasm
// binary-locator to break, per the bodyHiddenPersist STEP test's own note).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import type { BodyHandle } from '../../geom/geom-service'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

/** Builds one independent box body from a fresh rectangle sketch + extrude
 *  (mirrors SolidsWorkbenchPage.bodyHiddenPersist.test.tsx's own buildBox,
 *  duplicated per this suite's small-helper convention). */
async function buildBox(sketchId: string, bodyId: string, offset: string): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset, id: sketchId })
  await waitFor(() => expect(screen.getByTestId(`feature-row-${sketchId}`)).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sketchId } })
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle(bodyId)).not.toBeUndefined(), { timeout: 20_000 })
}

async function applyTopEdgeFillet(runtime: ReturnType<typeof createFakeSceneRuntime>, bodyId: string, rayX: number): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-fillet'))
  runtime.rayOverride = { origin: { x: rayX, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
  commitField('fillet-radius', '2')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle(bodyId)).not.toBeUndefined(), { timeout: 20_000 })
}

function meshFor(runtime: ReturnType<typeof createFakeSceneRuntime>, featureId: string): THREE.Mesh | undefined {
  return runtime.scene.children.find(
    (object): object is THREE.Mesh => object instanceof THREE.Mesh && object.userData.workbenchFeatureId === featureId,
  )
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
}

describe('WO MODEL-WORKSPACE-STL-EXPORT: Document-rail STL export (fakeGeomClient)', () => {
  it('renders the STL button in the Document rail with the exact testId/label/title', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await ready()
    const stlBtn = screen.getByTestId('workbench-export-stl') as HTMLButtonElement
    expect(stlBtn.getAttribute('data-tooltip')).toBe('Export STL')
    expect(stlBtn.textContent).toMatch(/STL/)
    // the STEP button is present too (shared Document rail group)
    expect(screen.getByTestId('workbench-export-step')).toBeTruthy()
  })

  it('missing visible handles refuse rather than silently dropping a body', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await ready()
    // F99 has no handle -> the shared resolveExportBodyHandles fails LOUD with
    // the missing feature id, never silently exporting a subset.
    await expect(hooks().exportStl(['F99'])).rejects.toThrow(/missing body handle.*F99/)
  })

  it('download filename and MIME are exact', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await ready()
    await buildBox('SK1', 'F1', '10')

    let capturedBlob: Blob | undefined
    let capturedDownload: string | undefined
    // jsdom does not always define URL.createObjectURL; follow the
    // save/restore convention used by SolidsWorkbenchPage.documentPersist and
    // sibling model3d tests rather than vi.spyOn (which refuses an undefined
    // property).
    const savedCreateObjectURL = URL.createObjectURL
    const savedRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = ((blob: Blob) => { capturedBlob = blob; return 'blob:stl-test' }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
    // HTMLElement.prototype.click is what the download handler's `a.click()`
    // resolves to in jsdom; fireEvent.click dispatches events instead, so
    // mocking it does not interfere with the toolbar button click itself.
    const clickSpy = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      const el = this as HTMLAnchorElement
      if (typeof el.download === 'string') capturedDownload = el.download
    })
    try {
      fireEvent.click(screen.getByTestId('workbench-export-stl'))
      await waitFor(() => expect(capturedBlob).toBeDefined())
      expect(capturedBlob!.type).toBe('model/stl')
      expect(capturedDownload).toBe('Untitled Project.stl') // WO-2424: default name is the project name
    } finally {
      URL.createObjectURL = savedCreateObjectURL
      URL.revokeObjectURL = savedRevokeObjectURL
      clickSpy.mockRestore()
    }
  })

  it('all-hidden produces the existing visible error surface and no download', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await ready()
    await buildBox('SK1', 'F1', '10')

    let createCalls = 0
    const savedCreateObjectURL = URL.createObjectURL
    const savedRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = (() => { createCalls++; return 'blob:stl-noop' }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
    try {
      // Persisted user-hidden: node.hidden = true (the eye-icon toggle).
      fireEvent.click(screen.getByTestId('body-visible-F1'))
      await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))
      expect(hooks().dag.getNode('F1')?.hidden).toBe(true)

      // effectiveExportIds is now empty -> exportStl([]) refuses 'no body to
      // export' -> the existing workbench-export-error surface shows, and the
      // download plumbing (Blob/anchor) never runs.
      fireEvent.click(screen.getByTestId('workbench-export-stl'))
      await waitFor(() => expect(screen.getByTestId('workbench-export-error').textContent).toMatch(/no body to export/))
      expect(createCalls).toBe(0)
    } finally {
      URL.createObjectURL = savedCreateObjectURL
      URL.revokeObjectURL = savedRevokeObjectURL
    }
  })
})

describe('WO MODEL-WORKSPACE-STL-EXPORT: STL eligibility matches STEP (real kernel)', () => {
  it('exports only the one effectively-visible body (persisted hidden + structural supersession), like STEP', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await ready()
    await buildBox('SK1', 'F1', '10')
    await buildBox('SK2', 'F2', '100')

    // F1: persisted user-hidden (node.hidden = true).
    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))

    // F2 -> F3 fillet: F2 is structurally superseded (visibleRef = false,
    // node.hidden stays false) while F3 is the visible terminal body. This is
    // the source split the shared effectiveExportIds two-gate resolver exists
    // to handle -- identical to the STEP eligibility scenario in
    // SolidsWorkbenchPage.bodyHiddenPersist.test.tsx.
    await applyTopEdgeFillet(runtime, 'F3', 120)
    expect(hooks().dag.getNode('F1')?.hidden).toBe(true)
    expect(hooks().dag.getNode('F2')?.hidden).toBe(false)
    expect(meshFor(runtime, 'F2')?.visible).toBe(false)
    expect(meshFor(runtime, 'F3')?.visible).toBe(true)

    // Intercept the STL export's re-tessellation boundary (the page calls
    // client.tessellate(handle, DISPLAY_TESS_QUALITY) per effectively-visible
    // body). The export must re-tessellate F3 ONLY -- F1 (persisted hidden) and
    // F2 (structurally superseded) are excluded by the SAME effectiveExportIds
    // resolver STEP uses.
    const tessellated: BodyHandle[] = []
    const tessSpy = vi.spyOn(hooks().client, 'tessellate').mockImplementation(async (h: BodyHandle) => {
      tessellated.push(h)
      return makeBoxTessBuffers({ featureId: 'STLEXPORT' })
    })
    try {
      fireEvent.click(screen.getByTestId('workbench-export-stl'))
      await waitFor(() => expect(tessellated.length).toBeGreaterThan(0))
      const f1 = hooks().getBodyHandle('F1')!
      const f2 = hooks().getBodyHandle('F2')!
      const f3 = hooks().getBodyHandle('F3')!
      expect(tessellated).toContain(f3)
      expect(tessellated).not.toContain(f1)
      expect(tessellated).not.toContain(f2)
    } finally {
      tessSpy.mockRestore()
    }
  }, 60_000)
})
