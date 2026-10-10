// @vitest-environment jsdom
//
// WO-362: "the boss pick still refuses on Operator's real project" -- WO-355
// landed a better message for the resolved-but-uncaptured-item branch and
// left the legacy branch untouched; Operator's screenshot showed the identical
// `body "F3": this project has no 3D model to read.` refusal after that
// landed. Measured directly from his own checked-in project file
// (src/tests/evidence/WO-362/operator-boss-pick-refuses.camproject): the model
// document IS in the file (a 30KB inline `document` blob) and the row
// resolves to the legacy item correctly (modelOrigin.ts's fallback) -- this
// was never a resolution bug or a message bug.
//
// THE ACTUAL BUG (reproduced below against Operator's real file, before naming a
// fix): `collectDocumentArchive()` (documentHolder.ts) only ever answers from
// THIS PAGE LOAD's in-memory `liveCollectors`/`passThroughArchives` maps. A
// real File > Open populates them (proven by the first describe block below
// -- that path was never broken). But an ORDINARY BROWSER REFRESH rehydrates
// `project` (including `modelItems[].documentStorageKey`, the durable
// checkpoint reference) via Zustand's `persistMerge` -- a WHOLLY SEPARATE
// boundary from `loadProjectFromFile` that never touches documentHolder at
// all. The in-memory maps come back empty on the fresh page load, and
// NOTHING re-hydrates them from the durable checkpoint unless the user
// explicitly re-visits the Model tab (`openModelItem`, store/index.ts, the
// ONLY caller of `hydrateDocumentCheckpoint` before this WO). SetupModal's
// bore pick never visits that tab, so `collectDocumentArchive('legacy')`
// answers `undefined` on a project whose model is plainly loaded (its mesh
// still renders in CAM from the separate IndexedDB display cache -- see
// docs/research/model-edit-refresh-gap.md section 3c -- which is exactly why
// it looks, to Operator, like "the model is right there" while the pick refuses).
//
// THE FIX: `ensureDocumentArchiveHydrated` (documentHolder.ts) factors
// `openModelItem`'s own authored/documentStorageKey recovery step out so a
// READ path (SetupModal's bore pick) can self-heal the same way the
// Model-tab NAVIGATION path already does. SetupModal.tsx's bore-pick click
// handler calls it before asking for face facts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { typedMock } from '../support/typedMock'

// No real IndexedDB in this env; loadProjectFromFile's binary-cache hydrate
// reads through these. "Not found" is fine - this fixture's one STL binary
// just re-derives from the row's own bytes if ever needed (same pattern
// int14ProjectDocument.test.ts and stlContourPick.wo251.test.tsx use).
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

// jsdom's built-in localStorage is broken under vitest's node launch flags;
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store (mirrors
// boreZeroOwnerResolution.wo355.test.ts's own precedent).
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
const {
  resetDocumentHolder, setDocumentStorage, collectDocumentArchive,
} = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { resolveOwningModelItemId } = await import('../../lib/cam/modelOrigin')
const { __setModelBodyHeadlessClientFactoryForTests } = await import('../../lib/cam/modelBodyHoleRecognition')

const FIXTURE_PATH = path.resolve(
  __dirname, '../evidence/WO-362/operator-boss-pick-refuses.camproject',
)

// Operator's own file this WO was cut from. The modeled body row (DAG "F3")'s
// face 6 is the bore wall (dia 15) and face 7 is the boss wall (dia 17.32) --
// confirmed by direct kernel recognition against this exact fixture.
const BORE_FACE_INDEX = 6

function readFixtureText(): string {
  return fs.readFileSync(FIXTURE_PATH, 'utf8')
}

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

describe('WO-362: opening Operator\'s real project file loads the model correctly (the file-open path was never the bug)', () => {
  it('loadProjectFromFile alone (no simulated refresh) resolves the bore pick', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())

    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!
    expect(collectDocumentArchive(resolveOwningModelItemId(modelGeo))).toBeDefined()

    render(createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    await armBorePickAndClick({ geoId: modelGeo.id, index: BORE_FACE_INDEX })
    await waitFor(() => expect(screen.getByTestId('setup-bore-picked')).toBeTruthy(), { timeout: 15_000 })
    expect(screen.queryByTestId('setup-bore-pick-error')).toBeNull()
  }, 30_000)
})

describe('WO-362: a page load that never (re-)opened the Model tab -- the real browser-refresh shape', () => {
  it('REPRODUCES the false refusal at the reachability boundary: the durable checkpoint is real, but nothing in this page load has hydrated it', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!
    const modelItemId = resolveOwningModelItemId(modelGeo)!

    // Simulate a browser refresh: documentHolder's in-memory maps are wiped
    // (a fresh JS module on the new page load) but durable storage and the
    // rehydrated project state (modelItems incl. documentStorageKey) survive
    // -- exactly what persistMerge (store/index.ts), a wholly separate
    // boundary from loadProjectFromFile, actually restores.
    resetDocumentHolder()
    setDocumentStorage(storage)

    // The gap, captured: the checkpoint this item names is genuinely durable
    // (session 1 above wrote it) but this fresh page load has not read it.
    expect(collectDocumentArchive(modelItemId)).toBeUndefined()
    const item = useCamStore.getState().project.modelItems?.find((m) => m.id === modelItemId)
    expect(item?.documentState).toBe('authored')
    expect(item?.documentStorageKey).toBeTruthy()
  })

  it('the bore pick self-heals from the durable checkpoint and Create Setup is never a dead end', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!

    resetDocumentHolder()
    setDocumentStorage(storage)
    expect(collectDocumentArchive(resolveOwningModelItemId(modelGeo))).toBeUndefined()

    render(createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    await armBorePickAndClick({ geoId: modelGeo.id, index: BORE_FACE_INDEX })
    await waitFor(() => expect(screen.getByTestId('setup-bore-picked')).toBeTruthy(), { timeout: 15_000 })

    // The exact false refusal Operator's screenshot showed must never appear here.
    expect(screen.queryByTestId('setup-bore-pick-error')).toBeNull()
    const createBtn = screen.getByRole('button', { name: /create setup/i }) as HTMLButtonElement
    expect(createBtn.disabled).toBe(false)

    fireEvent.click(createBtn)
    // The fixture's own file already carries 2 saved setups; the one this
    // pick just created is appended, never [0].
    const setup = useCamStore.getState().project.setups.at(-1)
    expect(setup).toBeTruthy()
    expect(setup!.wcs.originBinding?.kind).toBe('part_feature')
  }, 30_000)

  it('when the checkpoint is genuinely gone (not merely un-hydrated), the pick refuses with a stated reason -- never a silent dead end', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!

    // A DIFFERENT (empty) durable backend this time: the item is still
    // marked 'authored' with a documentStorageKey in the rehydrated project
    // (persisted state believes a checkpoint exists), but nothing durable is
    // actually reachable under it -- e.g. the browser's storage was cleared.
    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())

    render(createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    await armBorePickAndClick({ geoId: modelGeo.id, index: BORE_FACE_INDEX })
    await waitFor(() => expect(screen.getByTestId('setup-bore-pick-error')).toBeTruthy(), { timeout: 15_000 })

    // Audit fix (attempt 2): the old assertion here only checked
    // `message.length > 0`, which the internal-jargon, no-way-forward message
    // ("Durable checkpoint is missing for Model Item \"legacy\".") also
    // satisfied - exactly the dead end this order exists to remove. Assert the
    // STATED, ACTIONABLE reason itself, in Operator's words, not just that some
    // text is present.
    const message = screen.getByTestId('setup-bore-pick-error').textContent ?? ''
    expect(message).toBe(
      "This project's 3D model isn't available in this browser session and could not be "
        + 'recovered automatically - use Open to reload your project file, which restores the model directly.',
    )
    // Never this module's internal vocabulary, verbatim to the user.
    expect(message).not.toMatch(/durable checkpoint/i)
    expect(message).not.toMatch(/model item/i)
    expect(screen.queryByTestId('setup-bore-picked')).toBeNull()
    const createBtn = screen.getByRole('button', { name: /create setup/i }) as HTMLButtonElement
    expect(createBtn.disabled).toBe(true)
  }, 30_000)
})
