// CAM-13-R1 MAJOR 2 + MAJOR 3 real-path gates.
//
// MAJOR 2 (parity test fake): the audit found the checked-in cross-workspace
// equivalence test never drove either real workspace entry point - it called
// GeomClient.importStep directly for "Part Studio" and readStepDisplayAttributes
// directly for "CAM", comparing only names. This file drives the ACTUAL entry
// points instead: GeomBridgeSession.importStepFile (the real Part Studio import
// path, viewport3d/geomBridgeSession.ts) and useCamStore.importBrepGeometry (the
// real CAM import path, store/index.ts), on the SAME committed bytes, and
// compares both names AND colors after mapping each workspace's own display
// schema.
//
// MAJOR 3 (no clean fixture): drives the committed no-attributes.step fixture
// (neither a PRODUCT name nor COLOUR_RGB - see its derivation note in
// coordination/reports/CAM-13-R1.report.json) through the REAL store path,
// proving the filename/default-color fallback with no synthetic id/translator
// label invented - not a mocked readStepDisplayAttributes stand-in (that
// existed already in importBrepAttributes.test.ts and stays as the store-logic
// unit test).
//
// Only genuinely browser-only boundaries are mocked: the IndexedDB step cache
// and the CAM model kernel's readStep/setBrepPayload (every store test mocks
// these - see brepRetessellate.test.ts - there is no Node equivalent of
// IndexedDB or the CAM IndexedDB-backed model worker). The shared attribute
// reader itself is NOT mocked: '../../geom's createGeomService is swapped for
// createLocalGeomService (the real occt-wasm kernel on the calling thread,
// same one Part Studio's own Node integration tests use - see
// geomBridgeSession.integration.test.ts) purely because Node has no Web Worker
// transport; the reader logic and kernel calls underneath are 100% real.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  removeCachedStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
}))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()
  return typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...actual,
    readStep: vi.fn(async (): Promise<BrepModelPayload> => ({
      mesh: {
        positions: new Float32Array(0), normals: new Float32Array(0),
        indices: new Uint32Array(0), faceRanges: new Uint32Array(0),
      },
      edges: { positions: new Float32Array(0), edgeRanges: new Uint32Array(0) },
      faceTypes: new Uint8Array(0), faceCount: 0, edgeCount: 0, solidCount: 1,
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    })),
    setBrepPayload: vi.fn(),
  })
})
// The ONLY substitution for the shared reader: swap the Web-Worker transport
// (unavailable in Node) for the same-engine local transport. Every method
// (including createLocalGeomService itself) is the real, unmocked implementation.
vi.mock('../../geom', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../geom')>()
  return typedMock<typeof import('../../geom')>({ ...orig, createGeomService: orig.createLocalGeomService })
})

import { useCamStore } from '../../store'
import { createLocalGeomService } from '../../geom'
import { GeomBridgeSession } from '../../viewport3d/geomBridgeSession'
import { resolveEmbeddedColorOutcome, rgb01ToHex } from '../../lib/import/stepAttributes'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'geom', 'fixtures')
const BREP_DEFAULT_COLOR = '#8ab4cc'
// Part Studio keeps the raw kernel value (undefined = no color read) all the
// way to GeomBridgeSession's return -- its own no-color default ('#cccccc',
// BodyListPanel.tsx/AppearancePanel.tsx) is painted later, at render time, so
// there is no baked-in default to unmask here.
const PART_STUDIO_NO_COLOR_DEFAULT = undefined

function readFixture(name: string): { bytes: ArrayBuffer; file: File } {
  const buf = readFileSync(join(FIXTURES, name))
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const file = { name, arrayBuffer: async () => bytes.slice(0) } as unknown as File
  return { bytes, file }
}
function newestGeometry(filename: string) {
  return useCamStore.getState().project.geometry.filter((g) => g.filename === filename).at(-1)
}

describe('CAM-13-R1 real cross-workspace + real no-attribute-fixture gates', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {})
    useCamStore.setState({ consoleEvents: [], brepImportError: null })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('MAJOR 2: tray.step through the REAL Part Studio path and the REAL CAM path agree on name+color', async () => {
    const { bytes, file } = readFixture('tray.step')

    // Part Studio's real entry point.
    const session = new GeomBridgeSession(createLocalGeomService())
    await session.init()
    const partStudio = await session.importStepFile('R1-PS', bytes)

    // CAM's real entry point (store), same bytes.
    await useCamStore.getState().importBrepGeometry(file)
    const cam = newestGeometry('tray.step')

    expect(partStudio.bodies.length).toBeGreaterThanOrEqual(1)
    expect(cam).toBeDefined()

    // Names: both surface the embedded PRODUCT name 'Part 1' (never a raw bodyId
    // on the Part Studio side, since a real name was present).
    expect(partStudio.bodies[0]?.name).toBe('Part 1')
    expect(cam!.name).toBe('Part 1')

    // Colors (CAM-13-R2 MAJOR 1, amended contract - GEO-19 owns the color
    // rebuild, this WO owns an HONEST comparison of today's kernel ceiling):
    // Part Studio's raw display value (undefined) and CAM's raw display value
    // (its baked-in '#8ab4cc' default) are NOT directly comparable - they
    // encode "no embedded color" differently. Map each through its OWN
    // workspace's no-color default (resolveEmbeddedColorOutcome, the one
    // function this assertion and any future product code share) and compare
    // THAT: both mapped outcomes agree the file carried no embedded color, per
    // the shared kernel's proven read-side gap (occtWasmColorGap.test.ts) -
    // this is real embedded-color parity, not two independently-accepted raw
    // values (the MAJOR 1 defect). tray.step's own bytes DO carry COLOUR_RGB
    // (#9dcfed, docs/3d-modeling-plan.md), so once GEO-19 lands a patched
    // occt-wasm build, both raw values above flip to '#9dcfed' and both mapped
    // outcomes below become {hasEmbeddedColor:true,color:'#9dcfed'} - equal,
    // with zero change to the comparison itself.
    // Part Studio's raw color is an rgb01 triple (GeomBridgeSession/CachedBody's
    // native shape), not a hex string -- map it through the SAME rgb01ToHex the
    // CAM reader itself uses (stepAttributes.ts) so the comparison is apples to
    // apples, not an incidental type mismatch.
    const partStudioColorHex = partStudio.bodies[0]?.color ? rgb01ToHex(partStudio.bodies[0].color) : undefined
    const psColorOutcome = resolveEmbeddedColorOutcome(partStudioColorHex, PART_STUDIO_NO_COLOR_DEFAULT)
    const camColorOutcome = resolveEmbeddedColorOutcome(cam!.color, BREP_DEFAULT_COLOR)
    expect(psColorOutcome).toEqual(camColorOutcome)
  }, 60_000)

  it('MAJOR 3: no-attributes.step through the REAL CAM store path -> filename + default color, no invented label', async () => {
    const { file } = readFixture('no-attributes.step')
    await useCamStore.getState().importBrepGeometry(file)

    const geo = newestGeometry('no-attributes.step')
    expect(geo).toBeDefined()
    expect(geo!.name).toBe('no-attributes') // filename fallback, not a synthetic body id or OCCT stamp
    expect(geo!.color).toBe(BREP_DEFAULT_COLOR)
    expect(useCamStore.getState().brepImportError).toBeNull()
    // A genuine absence of embedded attributes is not a read FAILURE - no warning.
    expect(useCamStore.getState().consoleEvents.some((e) => e.severity === 'warning')).toBe(false)
  }, 60_000)
})
