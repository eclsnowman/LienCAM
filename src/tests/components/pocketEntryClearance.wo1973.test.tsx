// @vitest-environment jsdom
//
// WO-1973: "Helix start above material" in the Pocket Entry section, in both places
// that edit the one stored value (the Properties panel and the operation dialog).
// Operator ruling 2026-09-25: "Probably user settable how high above the stock to start the helix."
//
// Runs Example Projects/Full Suite.camproject Pocket 2 (helical entry) through the
// production compute (the store's computeOperationToolpath on the in-process worker).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { URL as NodeURL } from 'node:url'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  },
  configurable: true,
})

const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')
const { ensureClipperReady } = await import('../../lib/cam/face2d/clipperOffset')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')

// The worker runs in-process, exactly as in pocketHelixEntry.wo1972.test.ts.
type Handler = ((event: { data: unknown }) => void) | null
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => unknown) | null }
  Worker: unknown
}
let activeShim: { onmessage: Handler } | null = null
g.window = g.window ?? {}
const viewportStub: Record<string, unknown> = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const setup = project.setups[0]
    return smartHeightStockBounds(project, stockId ?? setupProvenStockId(setup, project)!)
  },
}
// Any other viewport call (scene restore, tab edit modes) is a no-op in this desk test.
g.window.__cncViewport = new Proxy(viewportStub, {
  get: (t, k) => (k in t ? t[k as string] : () => undefined),
})
g.self = { postMessage: (m: unknown) => { activeShim?.onmessage?.({ data: m }) }, onmessage: null }
await import('../../lib/cam/toolpathWorker')
const workerSelf = g.self
g.Worker = class {
  onmessage: Handler = null
  onerror: Handler = null
  postMessage(data: unknown) { activeShim = this; void workerSelf.onmessage?.({ data }) }
  terminate() { activeShim = null }
}

// jsdom's URL rejects the base-less worker specifier the store builds; node's accepts it.
class LenientURL extends NodeURL {
  constructor(input: string | URL, base?: string | URL) {
    try { super(input, base) } catch { super(input, 'file:///worker/') }
  }
}
globalThis.URL = LenientURL as unknown as typeof URL

await ensureClipperReady()

let setupId = ''
let opId = ''

function pocketNow() {
  return useCamStore.getState().project.setups[0].operations.find(o => o.id === opId)!
}
const clearanceOf = (): number | undefined =>
  (pocketNow().params as { entryClearance?: number }).entryClearance

/** Z of the move just before the first helix arc, relative to the setup origin. */
async function firstHelixStartZ(): Promise<number> {
  await useCamStore.getState().computeOperationToolpath(setupId, opId)
  const project = useCamStore.getState().project
  const moves = (pocketNow().toolpathMoves ?? []) as ToolpathMove[]
  const i = moves.findIndex(m => m.role === 'helix')
  expect(i).toBeGreaterThan(0)
  return moves[i - 1].z - project.setups[0].wcs.origin.z
}

async function commitField(input: HTMLElement, value: string): Promise<void> {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeAll(async () => {
  const text = readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8')
  await useCamStore.getState().loadProjectFromFile(text)
  const setup = useCamStore.getState().project.setups[0]
  setupId = setup.id
  const adapt = setup.operations.find(o => o.name === 'Adaptive Clearing 1')!
  opId = setup.operations.find(o => o.name === 'Pocket 2')!.id
  await useCamStore.getState().computeOperationToolpath(setup.id, adapt.id)
}, 120000)

afterEach(cleanup)

describe('WO-1973: Helix start above material', () => {
  it('Properties panel: the field edits params.entryClearance and the recomputed helix start Z follows', async () => {
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, activeSetupId: setupId, activeOperationId: opId } }))
    })
    render(<PropertiesPanel />)
    const group = screen.getByTestId('props-pocket-entry-clearance')
    expect(group.textContent).toContain('Helix start above material')
    const input = group.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('1')

    const zAtOne = await firstHelixStartZ()
    await commitField(input, '4')
    expect(clearanceOf()).toBe(4)
    expect(pocketNow().status).toBe('pending')
    const zAtFour = await firstHelixStartZ()
    expect(zAtFour - zAtOne).toBeCloseTo(3, 6)
  }, 120000)

  it('Properties panel: hidden unless the entry type is helix', () => {
    act(() => {
      useCamStore.getState().updateOperation(setupId, opId, {
        linking: { ...pocketNow().linking!, entryType: 'ramp_linear' },
      })
    })
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('props-pocket-entry-clearance')).toBeNull()
    act(() => {
      useCamStore.getState().updateOperation(setupId, opId, {
        linking: { ...pocketNow().linking!, entryType: 'ramp_helical' },
      })
    })
  })

  it('dialog: the Linking tab shows the field beside Helix diameter and Ramp angle, and saving keeps the edit', async () => {
    act(() => { useCamStore.getState().closeModal() })
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(setupId, opId) })
    fireEvent.click(screen.getByText('Linking'))

    const label = screen.getByText('Helix start above material')
    screen.getByText('Helix diameter')
    screen.getByText('Ramp angle')
    const field = label.closest('.op-field-row')!.querySelector('input') as HTMLInputElement
    expect(field.value).toBe('4')

    await commitField(field, '2')
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    await waitFor(() => expect(clearanceOf()).toBe(2))
  }, 120000)
})
