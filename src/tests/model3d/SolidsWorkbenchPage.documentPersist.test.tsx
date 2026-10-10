// @vitest-environment jsdom
//
// WO INT-14 AC8 + AC9: the save/load round trip through the REAL workbench, in
// BOTH of its mounts.
//
// P3's claim is "one document, two mounts": the Part document mounts through
// SolidsWorkbenchPage in the standalone `?lab3d=1&workbench=1` route
// (mountLab3DPage.ts:76 -- `createElement(SolidsWorkbenchPage, { initialDebugScene })`)
// and as the embedded INT-13 child (App.tsx:283 -- `<SolidsWorkbenchPage embedded />`).
// Both render the SAME exported symbol, which is exactly why the document
// lifecycle wrapper lives at that export. These tests render both call shapes and
// round-trip through each.
//
// Drives the REAL page against the real local kernel + the fake scene runtime --
// the same seam every other workbench test in this suite uses (jsdom has no WebGL;
// see fakeSceneRuntime.ts's header). The model is built through the actual UI
// affordances (New sketch -> rectangle -> Extrude), saved through the actual store
// action, and restored into a fresh mount, because the wiring between those three
// IS what this WO delivers.

import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

// The store persists through zustand's persist middleware, which loadProjectFromFile
// reaches via pushTransientFooterNotice. jsdom's own localStorage is not usable here,
// so back it with an in-memory Storage -- the exact shim
// ProjectOpenToolImportFailureConsole.smoke.test.tsx uses to drive this same load
// path. Environment gap only; nothing below asserts on it.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

// Imported dynamically, AFTER the storage shim above: static ESM imports hoist, so
// a static `import { useCamStore }` would initialize the store's persist middleware
// against the unusable jsdom storage before the line above ever ran. Same ordering
// discipline (and same reason) as ProjectOpenToolImportFailureConsole.smoke.test.tsx.
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { useCamStore } = await import('../../store')
const { resetDocumentHolder, hasLiveDocument } = await import('../../doc/documentHolder')
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { GeomClient } from '../../geom'
import type { FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { Project } from '../../types'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
let savedBlobs: Blob[] = []
let alertSpy: ReturnType<typeof vi.fn>
let savedCreateObjectURL: typeof URL.createObjectURL
let savedRevokeObjectURL: typeof URL.revokeObjectURL

beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  resetDocumentHolder()
  savedBlobs = []
  alertSpy = vi.fn()
  vi.stubGlobal('alert', alertSpy)
  // saveProjectToFile hands its Blob to URL.createObjectURL -- capturing there is
  // how these tests read the exact bytes the browser would have downloaded.
  //
  // Patch the two METHODS, never the URL global itself: the OCCT wasm loader calls
  // `new URL(...)` to find its binary (occt-wasm's findWasmBinary), so replacing
  // the global with an object literal takes the kernel down with it and every body
  // assertion here silently becomes untestable.
  savedCreateObjectURL = URL.createObjectURL
  savedRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:int14' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
})
afterEach(() => {
  restoreCanvas2d?.()
  restoreCanvas2d = null
  URL.createObjectURL = savedCreateObjectURL
  URL.revokeObjectURL = savedRevokeObjectURL
  vi.unstubAllGlobals()
  resetDocumentHolder()
})

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

function makeSceneRuntimeCapture(): { create: CreateSceneRuntime; get: () => FakeSceneRuntime } {
  let captured: FakeSceneRuntime | null = null
  return {
    create: () => { const rt = createFakeSceneRuntime(); captured = rt; return rt },
    get: () => captured as unknown as FakeSceneRuntime,
  }
}

/**
 * A real local kernel with ONE lie: makeExtrude refuses. Everything else --
 * init, tessellation, disposal -- is the genuine service, so the page boots and
 * reaches its restore path normally and only the body rebuild fails. That is the
 * real failure seam: a kernel op returning ok:false with diagnostics is exactly
 * what the executor already handles (OpResult, geom-service.ts:110), so nothing
 * about the refusal is invented for the test.
 *
 * A Proxy rather than a spread copy because GeomClient's methods live on a class
 * prototype -- spreading would produce an object missing most of them, and the
 * page would fail for the wrong reason.
 */
function createRefusingExtrudeClient(): GeomClient {
  const real = createLocalGeomService()
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'makeExtrude') {
        return async (req: { featureId: string }) => ({
          ok: false as const,
          diagnostics: [
            { code: 'KERNEL_FAILURE' as const, severity: 'error' as const, params: { featureId: req.featureId } },
          ],
        })
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Build a real model through the real UI: a 40x20 rectangle sketch extruded 20mm. */
async function buildModel(): Promise<void> {
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    { timeout: 20_000 },
  )
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

/** A GEOMETRIC fingerprint of the rebuilt body (preflight amendment 5: "identical"
 *  means dag-serialization equality AND a geometric assertion on the real body --
 *  never a byte-hash of exported brep). getBodyTopPoint reads the live mesh's
 *  bounding box, so it is a fact about the rendered solid, not about the file. */
function bodyFingerprint(featureId = 'F1'): { x: number; y: number; z: number } {
  const p = hooks().getBodyTopPoint(featureId)
  if (p === undefined) throw new Error(`no body geometry for ${featureId}`)
  return p
}

async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

describe('INT-14 AC8/AC9: save -> load round trip through the REAL workbench, both mounts', () => {
  // AC8: the STANDALONE mount (mountLab3DPage.ts:76 renders SolidsWorkbenchPage
  // with no `embedded` prop). AC9: the EMBEDDED mount (App.tsx:283 renders it with
  // `embedded`). The model is SAVED from the standalone mount and RESTORED into the
  // embedded one -- so a single test proves both entry points reach the same
  // document, which is P3's "one document, two mounts" stated as a behavior rather
  // than as a code-reading.
  it('a model built in the standalone mount restores -- tree AND body -- into the embedded mount', async () => {
    const runtimeA = makeSceneRuntimeCapture()
    // AC8: the standalone route's exact call shape.
    const standalone = render(
      <SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={runtimeA.create} />,
    )
    await buildModel()
    expect(hasLiveDocument()).toBe(true)

    const dagBefore = hooks().dag.serialize()
    const bodyBefore = bodyFingerprint('F1')
    // The body is real geometry, not an empty shell: the 40x20x20 extrude at
    // offset 10 has a top face 20mm up. (Guards the fingerprint itself from
    // being a vacuous "undefined === undefined" comparison below.)
    expect(bodyBefore.z).toBeGreaterThan(0)

    // SAVE through the REAL store action.
    const fileText = await saveAndCaptureFile()
    const parsed = JSON.parse(fileText) as Project
    expect(typeof parsed.document).toBe('string')

    // ---- the model workspace goes away entirely (page unmount) ----
    standalone.unmount()
    cleanup()
    expect(hasLiveDocument()).toBe(false)

    // LOAD through the REAL store action. This publishes a new document
    // generation; the fresh mount below seeds from the holder.
    useCamStore.getState().loadProjectFromFile(fileText)
    expect(alertSpy).not.toHaveBeenCalled()

    // AC9: the embedded (INT-13 child) call shape.
    const runtimeB = makeSceneRuntimeCapture()
    render(
      <SolidsWorkbenchPage embedded createClient={createLocalGeomService} createSceneRuntime={runtimeB.create} />,
    )

    // The feature tree is back...
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy(), { timeout: 20_000 })
    // ...the restore reported success rather than quietly refusing...
    await waitFor(
      () => expect(screen.getByTestId('workbench-document-load-status').textContent).toContain('ok'),
      { timeout: 20_000 },
    )
    // ...the document is identical (AC1's dag-serialization half). Direct
    // STRING equality, NOT JSON-parse-then-compare: serialize() is canonical
    // (dag.ts recursively sorts payload/diagnostics keys), so it survives the
    // archive's canonicalization (format.ts:97) byte-for-byte. .toBe() catches
    // an archive-canonicalization mismatch a parse-compare would mask
    // (INT-14-R1 audit item 4).
    expect(hooks().dag.serialize()).toBe(dagBefore)
    // ...and the BODY actually rebuilt and rendered (AC1's geometric half): the
    // kernel re-derived the same solid, not just the tree describing it.
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    const bodyAfter = bodyFingerprint('F1')
    expect(bodyAfter.x).toBeCloseTo(bodyBefore.x, 6)
    expect(bodyAfter.y).toBeCloseTo(bodyBefore.y, 6)
    expect(bodyAfter.z).toBeCloseTo(bodyBefore.z, 6)
  }, 120_000)

  // The interleave amendment 1 calls "load while the workbench is mounted": the
  // page must not keep showing the PREVIOUS project's model.
  it('opening a project while the workbench is mounted replaces the model in place', async () => {
    const runtimeA = makeSceneRuntimeCapture()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={runtimeA.create} />)
    await buildModel()
    const fileText = await saveAndCaptureFile()

    // A SECOND, different model is now live in the mounted page...
    cleanup()
    const runtimeB = makeSceneRuntimeCapture()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={runtimeB.create} />)
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
      { timeout: 20_000 },
    )
    expect(screen.queryByTestId('feature-row-F1')).toBeNull()

    // ...and the user opens the saved project WITHOUT leaving the workspace.
    useCamStore.getState().loadProjectFromFile(fileText)
    expect(alertSpy).not.toHaveBeenCalled()

    // The mounted page rebuilds from the opened file rather than showing stale
    // state: this is the remount the document generation drives.
    await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    expect(bodyFingerprint('F1').z).toBeGreaterThan(0)
  }, 120_000)

  // WO INT-14-R1, BLOCKER 1 -- THE LINEAGE GATE. This is the can-fail test the
  // audit demanded: it REDDENS against the old hard-coded `elementMapDeltas: []`
  // and passes only once the real delta history is persisted.
  //
  // What it stages, stated plainly so nobody mistakes its reach. REAL: the page,
  // the store's save/load, the holder, the archive, and F1's own kernel-emitted
  // deltas. STAGED: the historical lineage edge itself -- F_HIST is an op that
  // ran once and evolved the face TOP into FRAG. It is applied through the live
  // map's ordinary applyDelta seam (the same call RegenScheduler makes at
  // regen/scheduler.ts:272), because provoking the real kernel into a split whose
  // parent id dies and whose feature is then gone takes a model far larger than
  // this gate needs. The DEFECT it catches is not staged at all.
  //
  // Why the historical id must belong to a feature with no dag node: F1's own
  // face ids are REGENERATED byte-identically when the restore re-executes it
  // (stable ids are derived, element-map.ts's "derived, never random"), so a
  // reference to one of those resolves at step 1 (exact/live) and would pass
  // even with the history thrown away. Only an id whose sole route to its
  // survivor is a PERSISTED lineage edge tests persistence.
  it('a reference to a HISTORICAL id still resolves through lineage after save/load (deltas are not erased)', async () => {
    const TOP = 'hist:face:top'
    const FRAG = 'hist:face:frag'

    const runtimeA = makeSceneRuntimeCapture()
    const standalone = render(
      <SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={runtimeA.create} />,
    )
    await buildModel()

    // A past op evolved TOP into FRAG. TOP stops existing; FRAG lives on, and the
    // ONLY thing connecting them from here on is this delta.
    hooks().map.applyDelta({ featureId: 'F_HIST', generated: [], modified: { [TOP]: [FRAG] }, deleted: [] })
    // ...and F1 -- a real, healthy, kernel-built feature -- references the old id,
    // which is the ordinary state of affairs for any feature built against a face
    // that later evolved (docs/stable-id-spec.md's whole reason to exist).
    hooks().dag.setRefs('F1', [{ id: TOP, kind: 'single-face' }])

    // BEFORE the save the reference is healthy, and healthy VIA LINEAGE -- not
    // via a live exact hit. If this ever reported 'exact' the test below would be
    // vacuous, so it is asserted, not assumed.
    const before = hooks().map.resolve(TOP)
    expect(before.status).toBe('exact')
    expect(before.via).toBe('lineage')
    expect(before.boundTo).toEqual([FRAG])

    const fileText = await saveAndCaptureFile()

    standalone.unmount()
    cleanup()
    resetDocumentHolder()
    expect(hasLiveDocument()).toBe(false)

    useCamStore.getState().loadProjectFromFile(fileText)
    expect(alertSpy).not.toHaveBeenCalled()

    const runtimeB = makeSceneRuntimeCapture()
    render(
      <SolidsWorkbenchPage embedded createClient={createLocalGeomService} createSceneRuntime={runtimeB.create} />,
    )
    await waitFor(
      () => expect(screen.getByTestId('workbench-document-load-status').textContent).toContain('ok'),
      { timeout: 20_000 },
    )

    // THE ASSERTION. The reopened document can still walk TOP to its survivor.
    // With the deltas erased, TOP is an id the restored map has never heard of:
    // resolve falls through to step 4 and returns lost/none/[].
    const after = hooks().map.resolve(TOP)
    expect(after.status).toBe('exact')
    expect(after.via).toBe('lineage')
    expect(after.boundTo).toEqual([FRAG])

    // ...and the consequence the user would actually see: F1 was healthy when
    // they saved, so it must not reopen degraded with REFERENCE_UNRESOLVED.
    await waitFor(() => expect(hooks().dag.getNode('F1')).not.toBeUndefined(), { timeout: 20_000 })
    const f1 = hooks().dag.getNode('F1')
    expect(f1).toBeDefined()
    expect(f1?.degraded).toBe(false)
    expect((f1?.diagnostics ?? []).map((d) => d.code)).not.toContain('REFERENCE_UNRESOLVED')
  }, 120_000)

  // WO INT-14-R1: the fail-loud matrix cell (v) -- "body kernel fails to rebuild
  // after load". The binding matrix named this cell; the previous round shipped
  // only successful rebuilds and claimed the cell was covered, so the 104-test
  // run never executed it.
  //
  // The refusal is injected at the KERNEL CLIENT, the real seam a genuine kernel
  // failure arrives through, and only on the RESTORE mount -- the model is built
  // by a real kernel and only its rebuild refuses, which is exactly the shape of
  // the real complaint (a file that opened fine yesterday and cannot rebuild
  // today, e.g. after a kernel upgrade).
  it('a restored body the kernel REFUSES to rebuild is named in the status and the console, never a silent empty body', async () => {
    const runtimeA = makeSceneRuntimeCapture()
    const standalone = render(
      <SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={runtimeA.create} />,
    )
    await buildModel()
    const fileText = await saveAndCaptureFile()

    standalone.unmount()
    cleanup()
    resetDocumentHolder()

    useCamStore.setState({ consoleEvents: [] })
    useCamStore.getState().loadProjectFromFile(fileText)
    expect(alertSpy).not.toHaveBeenCalled()

    const runtimeB = makeSceneRuntimeCapture()
    render(
      <SolidsWorkbenchPage
        embedded
        createClient={createRefusingExtrudeClient}
        createSceneRuntime={runtimeB.create}
      />,
    )

    // The status NAMES the feature that refused -- not a bare "failed", and not
    // the "ok" a silent drop would have shown.
    await waitFor(
      () => expect(screen.getByTestId('workbench-document-load-status').textContent).toMatch(/refusals.*F1/),
      { timeout: 20_000 },
    )

    // The CONSOLE carries the same refusal, with the feature id and a cause.
    const errors = useCamStore.getState().consoleEvents.filter((e) => e.severity === 'error')
    const named = errors.filter((e) => e.message.includes('F1'))
    expect(named.length).toBeGreaterThan(0)
    expect(named.some((e) => /could not be rebuilt/i.test(e.message))).toBe(true)

    // ...and NO body is presented as success. The tree still lists F1 (the
    // feature exists and the user must see why it is broken), but nothing
    // pretends a solid came back.
    expect(screen.getByTestId('feature-row-F1')).toBeTruthy()
    expect(hooks().getBodyHandle('F1')).toBeUndefined()
  }, 120_000)

  it('a workbench mounted but never modelled leaves a 2D-only project unperturbed', async () => {
    const runtime = makeSceneRuntimeCapture()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={runtime.create} />)
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
      { timeout: 20_000 },
    )
    // The page holds Origin + XY/XZ/YZ and nothing else -- the user opened the
    // Model workspace and did nothing. AC3 must still hold for their save.
    expect(hasLiveDocument()).toBe(true)
    const parsed = JSON.parse(await saveAndCaptureFile()) as Record<string, unknown>
    expect('document' in parsed).toBe(false)
  }, 60_000)
})
