// CAM-13 real-kernel gate: the embedded part NAME actually reaches the CAM-side
// display resolution through the ONE shared reader (createLocalGeomService = the
// real occt-wasm kernel on the calling thread, the same importStep Part Studio
// uses). Injected via readStepDisplayAttributes' factory param so no Web Worker
// is needed in Node.
//
// COLOR: every committed fixture returns color=undefined here - occt-wasm's
// compiled xcafImportSTEP binding does not surface XCAF color across a STEP
// round-trip, even for its OWN self-authored export (measured directly against
// the dependency, not inferred - see src/tests/geom/occtWasmColorGap.test.ts,
// a committed pin of that exact probe, and stepAttributes.ts's module comment
// for the full disposition). Part Studio has the identical gap since both
// workspaces call this exact function. The color PLUMBING is proven
// non-vacuously with an injected colored body in stepAttributes.test.ts; this
// file asserts the real-fixture reality (names in, colors default) so the gate
// can never silently "pass" a color it never read.
//
// CAM-13-R1 MAJOR 2: the cross-workspace parity gate that used to live here
// (comparing GeomClient.importStep's name against readStepDisplayAttributes'
// name - a helper-only comparison that never drove either real workspace path)
// moved to src/tests/store/importBrepAttributesReal.test.ts, which drives the
// ACTUAL GeomBridgeSession.importStepFile (Part Studio) and
// useCamStore.importBrepGeometry (CAM) entry points against the same bytes and
// compares both names AND colors through each workspace's own display schema.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { createLocalGeomService } from '../../geom'
import { readStepDisplayAttributes } from '../../lib/import/stepAttributes'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'geom', 'fixtures')
function bytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURES, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
const factory = () => createLocalGeomService()

// Mirrors the store's resolution: embedded name wins, else the filename.
function resolveName(embedded: string | undefined, filename: string): string {
  return embedded ?? filename.replace(/\.[^.]+$/, '')
}

describe('CAM-13 real-kernel embedded-attribute read', () => {
  it('WITH embedded name: tray.step surfaces "Part 1" and it beats the filename', async () => {
    const out = await readStepDisplayAttributes(bytes('tray.step'), 'IMP1', factory)
    expect(out.partCount).toBeGreaterThanOrEqual(1)
    expect(out.name).toBe('Part 1')                       // embedded XCAF/PRODUCT name
    expect(resolveName(out.name, 'tray.step')).toBe('Part 1') // not the filename 'tray'
    // The reader does not surface this fixture's color today -> default swatch.
    // tray.step's own text carries COLOUR_RGB(#9dcfed) (see occtWasmColorGap.test.ts
    // for why the reader can't reach it) - this is the honest, pinned reality,
    // not a silently-accepted "nothing to see here" default.
    expect(out.color).toBeUndefined()
  }, 60_000)

  it('WITHOUT color attributes: plate-holes.step -> color defaults (undefined)', async () => {
    const out = await readStepDisplayAttributes(bytes('plate-holes.step'), 'IMP2', factory)
    expect(out.partCount).toBeGreaterThanOrEqual(1)
    expect(out.color).toBeUndefined()                     // caller keeps BREP_DEFAULT_COLOR
  }, 60_000)

  it('WITHOUT any embedded attributes: no-attributes.step -> name AND color default (MAJOR 3)', async () => {
    // Unlike plate-holes.step (which still carries a PRODUCT stamp the app
    // deliberately shows as a real name - Part Studio parity, Operator Q-33), this
    // fixture's PRODUCT name/id/description fields are blanked (derivation:
    // coordination/reports/CAM-13-R1.report.json), so the reader returns a
    // genuinely empty name - the true "nothing embedded at all" case.
    const out = await readStepDisplayAttributes(bytes('no-attributes.step'), 'IMP2b', factory)
    expect(out.partCount).toBeGreaterThanOrEqual(1)
    expect(out.name).toBeUndefined()
    expect(out.color).toBeUndefined()
    expect(out.warning).toBeUndefined() // legitimate absence, not a read failure - no warning
  }, 60_000)
})
