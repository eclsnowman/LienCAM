// @vitest-environment jsdom
//
// WO CAM-13B acceptance #1/#2, REAL-FIXTURE half: SolidsWorkbenchPage.importStepName.test.tsx
// proves the workbench call site's wiring with a mocked reader; this file drives the REAL
// committed STEP fixtures through the REAL shared reader (readStepDisplayAttributes' default
// factory, only its Web-Worker transport swapped for createLocalGeomService -- the same
// same-engine, Node-only substitution src/tests/store/importBrepAttributesReal.test.ts and
// src/tests/import/stepAttributesReadReal.test.ts already establish; no attribute-reading logic
// is mocked).
//
// tray.step's embedded PRODUCT name "Part 1" is pinned by stepAttributesReadReal.test.ts;
// no-attributes.step's genuine "nothing embedded, reader-level warning undefined" is pinned by
// that same file's MAJOR-3 case -- that is the FROZEN reader's own contract and is unchanged
// here. CAM-13B-R1 (audit BLOCKER): this WORKBENCH surface itself now names the fallback with its
// own console warning whenever no embedded name is available, regardless of whether the frozen
// reader's own warning field is set -- see the "no-attributes.step" case below. The
// geometry/tessellation half (client.importStep in the executor) stays a fast fake -- irrelevant
// to the name-display bug this WO fixes.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))
// The ONLY substitution: swap the Web-Worker transport (unavailable in this Node/jsdom test)
// for the same-engine local transport, exactly as importBrepAttributesReal.test.ts does. Every
// method (including createLocalGeomService itself) is the real, unmocked occt-wasm kernel.
vi.mock('../../geom', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../geom')>()
  return typedMock<typeof import('../../geom')>({ ...orig, createGeomService: orig.createLocalGeomService })
})

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

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'geom', 'fixtures')
function fixtureFile(fixtureName: string, uploadName: string): File {
  const buf = readFileSync(join(FIXTURES, fixtureName))
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new File([bytes], uploadName, { type: 'application/octet-stream' })
}

async function importStepFile(container: HTMLElement, file: File): Promise<void> {
  const input = container.querySelector('[data-testid="workbench-import-step-input"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(within(container).getByTestId('feature-row-IMP1')).toBeTruthy(), { timeout: 30_000 })
}

describe('CAM-13B real-kernel: workbench Import STEP against real committed fixtures', () => {
  it('acceptance #1 real fixture: tray.step surfaces its embedded "Part 1" name in the tree row', async () => {
    const client = createFakeGeomClient({ importedBodies: [{ name: 'Part 1' }] })
    const { container } = render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await importStepFile(container, fixtureFile('tray.step', 'tray.step'))

    const row = within(container).getByTestId('feature-row-IMP1')
    expect(row.textContent).toContain('Part 1')
    expect(row.textContent).not.toContain('IMP1')
  }, 60_000)

  it('CAM-13B-R1 BLOCKER (audit) real negative fixture: no-attributes.step falls back to the filename WITH a named "no embedded part name" console warning -- legitimate absence is still named, never silent', async () => {
    useCamStore.setState({ consoleEvents: [] })
    const client = createFakeGeomClient({ importedBodies: [{ name: undefined }] })
    const { container } = render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await importStepFile(container, fixtureFile('no-attributes.step', 'no-attributes.step'))

    const row = within(container).getByTestId('feature-row-IMP1')
    expect(row.textContent).toContain('no-attributes')
    expect(row.textContent).not.toContain('IMP1')

    const warn = useCamStore.getState().consoleEvents.find((e) => e.severity === 'warning' && e.source === 'workbench')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('no-attributes.step')
    expect(warn!.message).toContain('no embedded part name')
    expect(warn!.message).not.toContain('could not be read')
  }, 60_000)
})
