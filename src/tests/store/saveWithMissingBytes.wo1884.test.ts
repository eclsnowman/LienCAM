// WO-1884 (Rule 11): Save always writes the project.
//
// Before this WO, one part whose cached source bytes had been evicted made
// `collectProjectBinaries` throw and Save wrote NOTHING - Operator lost every other
// edit. Now the missing part is skipped, the file is written with every other
// part/operation/setting, and the console names the part to re-import.
//
// Rule 6: every claim about what the application does runs through the
// application's own entry points. The save/load proofs below drive the store's
// real `saveProjectToFile` / `loadProjectFromFile`; the re-import message proof
// drives `restoreGeometryToViewport`, the restore path the loader uses.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Operation, Project, Setup } from '../../types'

const { stlBytesById, stepBytesById } = vi.hoisted(() => ({
  stlBytesById: new Map<string, ArrayBuffer>(),
  stepBytesById: new Map<string, ArrayBuffer>(),
}))

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytesById.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytesById.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytesById.delete(id) }),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  STEP_DISPLAY_CONTRACT_VERSION: 1,
  STEP_DISPLAY_AO_VERSION: 1,
  computeStepSha256: vi.fn(async () => 'ab'.repeat(32)),
  cacheStep: vi.fn(async (id: string, buffer: ArrayBuffer) => { stepBytesById.set(id, buffer) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytesById.get(id) ?? null),
  cacheStepDisplay: vi.fn(async () => {}),
  loadCachedStepDisplay: vi.fn(async () => null),
  removeCachedStepDisplay: vi.fn(async () => {}),
  removeCachedStep: vi.fn(async (id: string) => { stepBytesById.delete(id) }),
}))

const { useCamStore } = await import('../../store')
const { restoreGeometryToViewport } = await import('../../lib/viewport/restoreScene')
const { arrayBufferToBase64 } = await import('../../lib/projectBinaries')
const { exportBinaryStl } = await import('../../mesh/stl')
const { unitCube } = await import('../mesh/fixtures')

const STL_ID = 'g-stl-1884'
const STEP_ID = 'g-step-1884'
const OP_ID = 'op-1884'
const SETUP_ID = 'setup-1884'
const STEP_NAME = 'Bracket'
const STEP_FILE = 'bracket.step'

function fixtureBytes(): ArrayBuffer {
  return exportBinaryStl(unitCube(20)).bytes
}

function geoRow(over: Partial<ImportedGeometry> & Pick<ImportedGeometry, 'id' | 'format'>): ImportedGeometry {
  return {
    name: over.id, filename: `${over.id}.${over.format}`,
    type: over.format === 'stl' ? 'mesh' : 'brep',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  } as ImportedGeometry
}

function readyOp(): Operation {
  return {
    id: OP_ID, name: 'Parallel 3D', type: 'parallel_3d', status: 'ready',
    params: { geometryId: STL_ID }, geometrySelections: [STL_ID],
    toolId: null, enabled: true,
  } as unknown as Operation
}

function project(geometry: ImportedGeometry[]): Project {
  return {
    id: 'p-1884', name: 'Save always writes', version: '1.0.0',
    createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry,
    setups: [{
      id: SETUP_ID, name: 'Setup 1', operations: [readyOp()], stock: null, notes: '',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      },
    } as unknown as Setup],
    activeSetupId: SETUP_ID, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
    },
    notes: '',
  } as unknown as Project
}

const PRESENT_STL = (): ImportedGeometry => geoRow({ id: STL_ID, name: 'Plate', format: 'stl' })
const MISSING_STEP = (): ImportedGeometry[] => [
  geoRow({ id: STEP_ID, name: STEP_NAME, filename: STEP_FILE, format: 'step' }),
]

let savedBlobs: Blob[] = []
async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

beforeEach(() => {
  stlBytesById.clear()
  stepBytesById.clear()
  stlBytesById.set(STL_ID, fixtureBytes())
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo1884' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  useCamStore.setState({ project: project([PRESENT_STL(), ...MISSING_STEP()]) })
})

describe('WO-1884: one missing part never costs the whole project', () => {
  it('acceptance 1: Save writes the file, keeps the present part bytes + operations, names the missing part', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fileText = await saveAndCaptureFile()

    const saved = JSON.parse(fileText) as Project & { binaries?: Record<string, unknown> }
    // The file is written and carries the present part's bytes.
    expect(saved.binaries).toBeDefined()
    expect(saved.binaries![STL_ID]).toEqual({ stl: arrayBufferToBase64(stlBytesById.get(STL_ID)!) })
    // The missing part is simply absent from binaries - not a refusal.
    expect(saved.binaries![STEP_ID]).toBeUndefined()
    // Every operation/setting is still saved as usual.
    expect(saved.setups).toHaveLength(1)
    expect(saved.setups[0].operations.map((o) => o.id)).toEqual([OP_ID])

    // The console line names the part and the source file to re-import.
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages).toContain(
      `${STEP_NAME}: source file not in this browser's cache - saved without it; ` +
        `re-import ${STEP_FILE} to restore it`,
    )
    warn.mockRestore()
  })

  it('acceptance 2: opening the file loads it, hydrates the present part, and the existing restore path names the missing part', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fileText = await saveAndCaptureFile()
    warn.mockRestore()

    // Everything in-memory is gone; all that survives is the file.
    stlBytesById.clear()
    stepBytesById.clear()
    useCamStore.setState({ project: project([]) })

    await useCamStore.getState().loadProjectFromFile(fileText)

    const loaded = useCamStore.getState().project.geometry
    expect(loaded.map((g) => g.id).sort()).toEqual([STEP_ID, STL_ID].sort())
    // The present part's bytes came back from the file...
    expect(stlBytesById.get(STL_ID)).toBeTruthy()
    expect(new Uint8Array(stlBytesById.get(STL_ID)!).length).toBe(fixtureBytes().byteLength)
    // ...the missing part's bytes did not (nothing to embed), so it re-imports.
    expect(stepBytesById.get(STEP_ID)).toBeUndefined()

    // The EXISTING restore re-import path (no new dialog) names the part.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const setBrepImportError = vi.fn()
    const fakeVp = {
      addSTL: vi.fn(async () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } })),
      addBrepModel: vi.fn(),
      setSTLVisible: vi.fn(),
      setPartLoopsOnFacePlane: vi.fn(),
      setPartProjectedLoops: vi.fn(),
    }
    await restoreGeometryToViewport(
      fakeVp as never,
      loaded,
      { patchGeometry: vi.fn(), setBrepImportError } as never,
      [], new Set(), undefined, () => true,
    )
    // The present STL restored; the missing STEP was named for re-import.
    expect(fakeVp.addSTL).toHaveBeenCalledTimes(1)
    expect(setBrepImportError).toHaveBeenCalledTimes(1)
    const msg = String(setBrepImportError.mock.calls[0][0])
    expect(msg).toContain(STEP_NAME)
    expect(msg).toMatch(/cached STEP bytes are missing from IndexedDB\. Re-import the file\./)
    expect(consoleError.mock.calls.map((c) => String(c[0])).some((m) => m.includes(STEP_NAME))).toBe(true)
    consoleError.mockRestore()
  })

  it('acceptance 3: with all bytes present the output is unchanged (no warning, same binaries)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stepBytesById.set(STEP_ID, new Uint8Array([1, 2, 3, 4]).buffer)
    useCamStore.setState({ project: project([PRESENT_STL(), ...MISSING_STEP()]) })

    const fileText = await saveAndCaptureFile()
    const saved = JSON.parse(fileText) as Project & { binaries?: Record<string, unknown> }

    expect(Object.keys(saved.binaries!).sort()).toEqual([STEP_ID, STL_ID].sort())
    expect(saved.binaries![STL_ID]).toEqual({ stl: arrayBufferToBase64(stlBytesById.get(STL_ID)!) })
    expect(saved.binaries![STEP_ID]).toEqual({
      step: arrayBufferToBase64(stepBytesById.get(STEP_ID)!),
    })
    const missingWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('not in this browser'))
    expect(missingWarnings).toHaveLength(0)
    warn.mockRestore()
  })

  it('acceptance 4 negative control: the removed throw contract is gone (collect does not reject)', async () => {
    // OLD behavior (restore `throw new MissingGeometryBinaryError`): this call
    // rejected and Save wrote nothing. Recorded in the WO result as the mutation
    // proof; here we pin the new contract so the old one cannot quietly return.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { collectProjectBinaries } = await import('../../lib/projectBinaries')
    const binaries = await collectProjectBinaries(MISSING_STEP())
    expect(binaries).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
