// @vitest-environment jsdom
//
// WO-355: "a boss pick refuses with 'no 3D model' while the model is on
// screen". WO-335 fixed one door into that false refusal (the headless
// replay's hardcoded LEGACY_MODEL_ITEM_ID); this closes the class it left
// open - an owner that cannot be resolved (resolveOwningModelItemId returns
// undefined) must refuse LOUDLY and ACCURATELY at the boundary where that
// resolution happens (SetupModal's own resolveBoreFaceOwner), rather than
// riding an implicit `undefined` into the headless-replay layer, where a
// silent LEGACY_MODEL_ITEM_ID default would read the wrong (or no) document
// and misreport it as "this project has no 3D model to read" - false and
// unactionable on a project whose model is plainly on screen.
//
// Drives the REAL SetupModal component against the REAL production kernel
// (createLocalGeomService, the same headless-replay path
// boreZeroKernelMount.wo335.test.ts's own tests prove), against Operator's own
// checked-in repro project (test_fixtures/evidence/WO-335). That project
// already carries BOTH a modeled body AND a separately imported STL row
// (confirmed by direct inspection: project.geometry has one 'model' row and
// one 'stl' row) - matching his report ("a project that also has an STL
// loaded, matching his setup") without needing a new fixture. A mocked
// __cncViewport captures the real setBrepPickMode callback SetupModal's
// bore-pick handler installs, then invokes it exactly as a real click would.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ImportedGeometry, ModelItemPlacementRecord, PhysicalStock } from '../../types'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'

// jsdom's built-in localStorage is broken under vitest's node launch flags;
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store (mirrors
// SetupModal.smoke.test.tsx's own precedent).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')
const { createLocalGeomService } = await import('../../geom')
const { resetDocumentHolder, stashLoadedDocument } = await import('../../doc/documentHolder')
const { __setModelBodyHeadlessClientFactoryForTests } = await import('../../lib/cam/modelBodyHoleRecognition')

const FIXTURE_PATH = path.resolve(
  __dirname, '../../../test_fixtures/evidence/WO-335/operator-bore-zero-repro.camproject',
)

interface FixtureProject {
  document: string
  geometry: ImportedGeometry[]
  modelItemPlacements: ModelItemPlacementRecord[]
}

function loadFixture(): FixtureProject {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as FixtureProject
}

/** The project's `document` field is base64-of-zip-bytes; decode it back to
 *  the Uint8Array stashLoadedDocument (and, in production, loadProjectFromFile)
 *  consumes - same helper boreZeroKernelMount.wo335.test.ts uses. */
function fixtureDocumentBytes(fixture: FixtureProject): Uint8Array {
  const buf = Buffer.from(fixture.document, 'base64')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

// The fixture's modeled body row (DAG bodyId "F3", Operator's screenshot's own
// "F3"). Its display.faceIds carries both circular walls this suite drives:
// index 6 is the bore wall (an internal cylinder, dia 15mm); index 7 is the
// boss wall (a full external cylinder, dia 17.32mm) - confirmed by direct
// kernel recognition against this exact fixture file (recognizeModelBodyHoles
// returns a 'throughHole' on face 6 and a 'blindHole' on face 7; the boss
// mis-classification is WO-336's own disclosed, separately-tracked defect -
// out of this WO's lane - but it does not block a pick from resolving, which
// is what "CREATABLE" (Acceptance #1) requires).
const BORE_FACE_INDEX = 6
const BOSS_FACE_INDEX = 7

type PickSelection = { geoId: string; kind: 'face' | 'edge'; index: number; isModelFace?: boolean }
type PickCallback = (sel: PickSelection) => void

function installVpMock(): {
  getCallback: () => PickCallback | null
  getChoice: () => ((id: string) => void) | null
} {
  let callback: PickCallback | null = null
  let choice: ((id: string) => void) | null = null
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 5 } }),
    setBrepPickMode: (kind: 'face' | 'edge' | 'face-or-edge' | null, cb?: PickCallback | null) => {
      callback = kind === null ? null : (cb ?? null)
    },
    // WO-366 (5b1d45ca): the circular-feature picker presents TOP/BOTTOM as
    // workspace choices and waits for one before it confirms the origin.
    setBrepPickHoverCallback: () => {},
    setZeroPointPreview: () => {},
    setZeroPointChoices: (
      choices: readonly { id: string }[] | null,
      cb?: ((id: string) => void) | null,
    ) => { choice = choices ? (cb ?? null) : null },
  }
  return { getCallback: () => callback, getChoice: () => choice }
}

// A setup machines exactly one stock (451ce95a, "retain feature origin
// stock"): a bore-origin setup must name it or Create stays disabled with
// "This feature has no confirmed stock". Every real project carries the auto
// stock its modeled bodies sit on, so the fixture does too.
const AUTO_STOCK = {
  id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived' as const,
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 5 },
    size: { x: 50, y: 50, z: 5 }, center: { x: 25, y: 25, z: 2.5 },
  },
  position: { x: 0, y: 0, z: 0 },
} as unknown as PhysicalStock

function withAutoStock<T extends { stockId?: string }>(geometry: T[]): T[] {
  return geometry.map((g) => (g.stockId ? g : { ...g, stockId: DERIVED_STOCK_ID }))
}

function installFixtureProject(fixture: FixtureProject): void {
  act(() => {
    useCamStore.setState((s) => ({
      activeModal: null,
      editingSetupId: null,
      project: {
        ...s.project,
        geometry: withAutoStock(fixture.geometry),
        modelItemPlacements: fixture.modelItemPlacements,
        stocks: [AUTO_STOCK],
        setups: [],
      },
    }))
  })
}

beforeEach(() => {
  resetDocumentHolder()
  __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  act(() => { useCamStore.getState().closeModal() })
})

afterEach(() => {
  cleanup()
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

/** Arms the real bore-pick UI (origin-mode tab + "Pick Bore Wall" button),
 *  waits for SetupModal's handleStartBorePick to install its real
 *  setBrepPickMode callback, then invokes it with `sel` exactly as a real
 *  viewport click would. */
async function armBorePickAndClick(sel: { geoId: string; index: number; isModelFace?: boolean }): Promise<void> {
  const vp = installVpMock()
  fireEvent.click(screen.getByTestId('setup-origin-mode-bore'))
  fireEvent.click(screen.getByRole('button', { name: /pick circle \/ cylinder/i })) // 5b1d45ca renamed the bore-wall pick
  await waitFor(() => expect(vp.getCallback()).not.toBeNull())
  act(() => {
    vp.getCallback()!({ geoId: sel.geoId, kind: 'face', index: sel.index, isModelFace: sel.isModelFace ?? true })
  })
  // A resolvable pick asks the workspace to choose TOP or BOTTOM; confirm TOP
  // the way a real click would. A refused pick never presents choices, so the
  // refusal cases fall straight through to their own assertions.
  await waitFor(() => {
    if (vp.getChoice() === null && screen.queryByTestId('setup-bore-pick-error') === null) {
      throw new Error('waiting for the workspace choice or a refusal')
    }
  }, { timeout: 15_000 }).catch(() => {})
  const choose = vp.getChoice()
  if (choose) act(() => { choose('top') })
}

describe('WO-355: a legacy-owned modeled body still creates a setup end to end (must not regress)', () => {
  it('a bore-wall pick enables Create Setup - the button, not merely a computed origin', async () => {
    const fixture = loadFixture()
    stashLoadedDocument(fixtureDocumentBytes(fixture))
    installFixtureProject(fixture)
    const modelGeo = fixture.geometry.find((g) => g.format === 'model')!

    render(createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    await armBorePickAndClick({ geoId: modelGeo.id, index: BORE_FACE_INDEX })
    await waitFor(() => expect(screen.getByTestId('setup-bore-picked')).toBeTruthy(), { timeout: 15_000 })

    expect(screen.queryByTestId('setup-bore-pick-error')).toBeNull()
    const createBtn = screen.getByRole('button', { name: /create setup/i }) as HTMLButtonElement
    expect(createBtn.disabled).toBe(false)

    fireEvent.click(createBtn)
    const setup = useCamStore.getState().project.setups[0]
    expect(setup).toBeTruthy()
    expect(setup.wcs.originBinding?.kind).toBe('part_feature')
  }, 30_000)

  it('a boss-wall pick ALSO enables Create Setup (WO-355 Acceptance #1)', async () => {
    const fixture = loadFixture()
    stashLoadedDocument(fixtureDocumentBytes(fixture))
    installFixtureProject(fixture)
    const modelGeo = fixture.geometry.find((g) => g.format === 'model')!

    render(createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    await armBorePickAndClick({ geoId: modelGeo.id, index: BOSS_FACE_INDEX })
    await waitFor(
      () => expect(
        screen.queryByTestId('setup-bore-picked') ?? screen.queryByTestId('setup-bore-pick-error'),
      ).toBeTruthy(),
      { timeout: 15_000 },
    )

    // The false refusal WO-355 exists to close would show HERE if it were
    // still reachable - never on a project this test just proved has a live,
    // loaded, on-screen model.
    const error = screen.queryByTestId('setup-bore-pick-error')
    expect(error?.textContent ?? '').not.toMatch(/no 3D model to read/i)
    expect(screen.getByTestId('setup-bore-picked')).toBeTruthy()

    const createBtn = screen.getByRole('button', { name: /create setup/i }) as HTMLButtonElement
    expect(createBtn.disabled).toBe(false)
  }, 30_000)
})

describe('WO-355: an unresolved owner is a distinct, accurate refusal - never the false "no 3D model" text', () => {
  // Fix round (audit FAIL, Finding 2 + 3): this is Acceptance #2's ACTUAL
  // named condition - "an owner that cannot be resolved to a readable
  // model" - not the STL test below (that row is not model-origin at all,
  // a different condition). Here the row genuinely resolves to a SPECIFIC,
  // non-legacy Model Item id (geo.modelItemId = 'mi-second', set by the row
  // itself, exactly as a real "New model" body carries it) - the resolution
  // succeeds. What is missing is that item's OWN document: only the legacy
  // slot is stashed, mirroring the audit's own repro ("the model row tagged
  // modelItemId: 'mi-second' and the archive stashed under legacy"). Before
  // the fix round, `regenerateModelBodyHeadless` silently reused the legacy
  // default's message for this too, reporting "this project has no 3D model
  // to read" on a project whose model is plainly loaded (just under a
  // different id) - Operator's exact symptom. The fix names the real cause
  // instead.
  it('an owner resolved to a specific, non-legacy Model Item whose document was never captured refuses distinctly - never "no 3D model to read"', async () => {
    const fixture = loadFixture()
    stashLoadedDocument(fixtureDocumentBytes(fixture)) // stashed under the LEGACY slot only
    const modelGeo = fixture.geometry.find((g) => g.format === 'model')!
    const nonLegacyItemId = 'mi-second'
    const ownedGeo: ImportedGeometry = { ...modelGeo, modelItemId: nonLegacyItemId }
    const geometry = fixture.geometry.map((g) => (g.id === modelGeo.id ? ownedGeo : g))
    act(() => {
      useCamStore.setState((s) => ({
        activeModal: null,
        editingSetupId: null,
        project: {
          ...s.project,
          geometry: withAutoStock(geometry),
          modelItemPlacements: fixture.modelItemPlacements,
          stocks: [AUTO_STOCK],
          setups: [],
        },
      }))
    })

    render(createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    await armBorePickAndClick({ geoId: ownedGeo.id, index: BORE_FACE_INDEX })

    await waitFor(() => expect(screen.getByTestId('setup-bore-pick-error')).toBeTruthy())
    const message = screen.getByTestId('setup-bore-pick-error').textContent ?? ''
    expect(message).not.toMatch(/no 3D model to read/i)
    expect(message).toMatch(/mi-second/)

    expect(screen.queryByTestId('setup-bore-picked')).toBeNull()
    const createBtn = screen.getByRole('button', { name: /create setup/i }) as HTMLButtonElement
    expect(createBtn.disabled).toBe(true)
  }, 30_000)

  it('a picked face on a non-modeled geometry row (the project\'s own STL) refuses by name, Create stays disabled, and the message is never "no 3D model to read"', async () => {
    const fixture = loadFixture()
    stashLoadedDocument(fixtureDocumentBytes(fixture))
    installFixtureProject(fixture)
    const stlGeo = fixture.geometry.find((g) => g.format === 'stl')!
    expect(stlGeo).toBeTruthy() // the project's own second, non-model row

    render(createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    // Simulates a viewport hit reporting isModelFace on a row that is NOT
    // model-origin - the exact class WO-355 names: resolveOwningModelItemId
    // returns undefined for this row, and that must be caught HERE (at
    // resolveBoreFaceOwner) rather than riding through to the headless-replay
    // boundary, whose "no 3D model to read" text is reserved for a
    // genuinely-resolved item with nothing held for it (a different,
    // narrower condition WO-335's own suite already pins).
    await armBorePickAndClick({ geoId: stlGeo.id, index: 0, isModelFace: true })

    await waitFor(() => expect(screen.getByTestId('setup-bore-pick-error')).toBeTruthy())
    const message = screen.getByTestId('setup-bore-pick-error').textContent ?? ''
    expect(message).not.toMatch(/no 3D model to read/i)
    expect(message).toMatch(/not a modeled body/i)

    expect(screen.queryByTestId('setup-bore-picked')).toBeNull()
    const createBtn = screen.getByRole('button', { name: /create setup/i }) as HTMLButtonElement
    expect(createBtn.disabled).toBe(true)
  }, 30_000)
})
