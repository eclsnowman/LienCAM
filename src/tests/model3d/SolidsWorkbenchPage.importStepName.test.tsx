// @vitest-environment jsdom
//
// WO CAM-13B: Operator's T-CAM13-STEP-NAMES modify verdict (step 2, verbatim: "It
// does not. It calls it IMP1") -- the workbench's OWN "Import STEP" action
// (SolidsWorkbenchPage.handleImportStepFileChange) never read the file's
// embedded STEP name; the Design Tree row fell back to featureLabel's raw
// DAG-id fallback ("IMP1"). CAM-13 shipped the shared reader
// (src/lib/import/stepAttributes.ts) for the CAM side only; this WO wires
// the SAME reader into this surface -- same call site shape as store/index.ts's
// importBrepGeometry (readStepDisplayAttributes(bytes, importId), embedded
// name wins, else the filename with extension stripped).
//
// CAM-13B-R1 (audit BLOCKER): ANY fallback to the filename -- a genuine reader
// failure/degradation OR a clean read that legitimately found no embedded
// name -- gets a named workbench console warning; ADR-0003 treats a silent
// reasonable-looking fallback as a defect regardless of the reason. The two
// causes get separate, honest wording (never the same message), proven by
// the two distinct tests below.
//
// The reader itself is mocked here (same seam as
// src/tests/store/importBrepAttributes.test.ts's CAM-side unit test) -- its
// REAL behavior against real fixtures is covered by
// SolidsWorkbenchPage.importStepNameReal.test.ts. This file proves the
// WORKBENCH call site: the payload.name it writes, the fallback text, and
// that both a genuine read failure and a legitimate absence each get their
// own honestly-worded warning.

import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest'
import type { StepDisplayAttributes } from '../../lib/import/stepAttributes'
import { typedMock } from '../support/typedMock'

const readStepDisplayAttributes = vi.fn<(bytes: ArrayBuffer, importId: string) => Promise<StepDisplayAttributes>>()
vi.mock('../../lib/import/stepAttributes', () => typedMock<typeof import('../../lib/import/stepAttributes')>({
  readStepDisplayAttributes: (bytes: ArrayBuffer, importId: string) => readStepDisplayAttributes(bytes, importId),
}))

const { stepStore } = vi.hoisted(() => ({ stepStore: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, buf: ArrayBuffer) => { stepStore.set(id, buf) }),
  loadCachedStep: vi.fn(async (id: string) => stepStore.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepStore.delete(id) }),
}))

// SKC-46 / cameraProjection.test.tsx precedent: jsdom's own localStorage
// throws out of the zustand persist middleware's wrapped setItem in this
// project's test setup -- installed BEFORE the store module loads so
// addConsoleEvent's warning-path assertions below observe a genuinely
// persisted (not swallowed) console event.
const localStorageValues = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return localStorageValues.size },
  clear: () => localStorageValues.clear(),
  getItem: (key) => localStorageValues.get(key) ?? null,
  key: (index) => [...localStorageValues.keys()][index] ?? null,
  removeItem: (key) => { localStorageValues.delete(key) },
  setItem: (key, value) => { localStorageValues.set(key, String(value)) },
}
const priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { render, cleanup, fireEvent, within } = await import('@testing-library/react')
const { waitForLoadedModel3d: waitFor } = await import('./loadTolerantWaitFor')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { fakeCreateSceneRuntime } = await import('./fakeSceneRuntime')
const { useCamStore } = await import('../../store')

afterEach(() => {
  cleanup()
  localStorageValues.clear()
})
afterAll(() => {
  if (priorLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
  else Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
})
beforeEach(() => {
  readStepDisplayAttributes.mockReset()
  useCamStore.setState({ consoleEvents: [] })
})

function stepFile(name: string): File {
  return new File([new Uint8Array([1, 1, 1, 1])], name, { type: 'application/octet-stream' })
}

async function importStepFile(container: HTMLElement, name: string): Promise<void> {
  const input = container.querySelector('[data-testid="workbench-import-step-input"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [stepFile(name)] } })
  await waitFor(() => expect(within(container).getByTestId('feature-row-IMP1')).toBeTruthy())
}

describe('CAM-13B: workbench Import STEP shows the embedded name (acceptance #1/#2)', () => {
  it('acceptance #1: an embedded PRODUCT name wins over the raw DAG id ("IMP1")', async () => {
    readStepDisplayAttributes.mockResolvedValue({ name: 'Bracket Assembly', partCount: 1 })
    const client = createFakeGeomClient({ importedBodies: [{ name: 'Bracket Assembly' }] })
    const { container } = render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await importStepFile(container, 'plate.step')

    const row = within(container).getByTestId('feature-row-IMP1')
    expect(row.textContent).toContain('Bracket Assembly')
    expect(row.textContent).not.toContain('IMP1') // Operator's exact repro symptom

    expect(readStepDisplayAttributes).toHaveBeenCalledTimes(1)
    const [, importId] = readStepDisplayAttributes.mock.calls[0]
    expect(importId).toBe('IMP1')
  })

  it('acceptance #2 (genuine read failure): degrades to the filename WITH a named console warning -- never silence', async () => {
    readStepDisplayAttributes.mockResolvedValue({ partCount: 0, warning: 'kernel init failed' })
    const client = createFakeGeomClient({ importedBodies: [{ name: 'Body' }] })
    const { container } = render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await importStepFile(container, 'vendor-part.step')

    const row = within(container).getByTestId('feature-row-IMP1')
    expect(row.textContent).toContain('vendor-part') // filename, extension stripped
    expect(row.textContent).not.toContain('IMP1')

    const warn = useCamStore.getState().consoleEvents.find((e) => e.severity === 'warning' && e.source === 'workbench')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('vendor-part.step')
    expect(warn!.message).toContain('kernel init failed')
  })

  it('CAM-13B-R1 BLOCKER (audit): a legitimate absence (no embedded name, no read failure) still falls back to the filename WITH a named console warning -- honestly worded, distinct from the read-failure text above', async () => {
    // Distinct from the genuine-failure case above: stepAttributes.ts's own contract
    // (pickDisplayAttributes/isSyntheticName) treats "file genuinely carries no PRODUCT
    // name" as legitimate, not a failure (see no-attributes.step's real-kernel pin in
    // stepAttributesReadReal.test.ts: warning is undefined). The audit ruled that a SILENT
    // fallback is still the defect ADR-0003 forbids regardless of WHY the name is missing --
    // this surface must warn either way, just with separate, honest wording per cause.
    readStepDisplayAttributes.mockResolvedValue({ name: undefined, partCount: 1 })
    const client = createFakeGeomClient({ importedBodies: [{ name: undefined }] })
    const { container } = render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await importStepFile(container, 'widget.step')

    const row = within(container).getByTestId('feature-row-IMP1')
    expect(row.textContent).toContain('widget')

    const warn = useCamStore.getState().consoleEvents.find((e) => e.severity === 'warning' && e.source === 'workbench')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('widget.step')
    expect(warn!.message).toContain('no embedded part name')
    // Distinct wording from the genuine-failure case: never claims a read "could not be read".
    expect(warn!.message).not.toContain('could not be read')
  })

  it('CAM-13B-R1 MINOR (audit): a file named exactly ".step" (empty stem after stripping the extension) falls back to the FULL filename, never an empty string reaching the IMP<n> tree-id fallback', async () => {
    readStepDisplayAttributes.mockResolvedValue({ name: undefined, partCount: 1 })
    const client = createFakeGeomClient({ importedBodies: [{ name: undefined }] })
    const { container } = render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await importStepFile(container, '.step')

    const row = within(container).getByTestId('feature-row-IMP1')
    expect(row.textContent).toContain('.step') // the full filename, never an empty label
    expect(row.textContent).not.toContain('IMP1') // Operator's exact repro symptom, recreated by this edge pre-fix
  })
})
