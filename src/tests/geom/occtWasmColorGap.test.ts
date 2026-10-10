// CAM-13-R1 (BLOCKER 1 disposition): pins the exact occt-wasm dependency defect
// that makes embedded STEP colors unreachable through the app's ONE shared XCAF
// reader (src/geom/worker/geom-engine.ts importStep -> importXCAFFromSTEP ->
// getLabelInfo). This is NOT a vendor-file-format ambiguity: OCCT's own
// self-authored XCAF export, re-imported by the SAME kernel that just wrote it,
// still loses the color it just set. That rules out "maybe this vendor's STEP
// style just isn't supported" - the read-side color transfer is broken for
// occt-wasm's own round trip, full stop (also reproduced directly against the
// real committed src/tests/geom/fixtures/tray.step, whose text carries
// COLOUR_RGB(...,0.615686...,0.811764...,0.929411...) i.e. #9dcfed - see
// coordination/reports/CAM-13-R1.report.json for that fixture-level evidence).
//
// occt-wasm is a prebuilt vendored wasm binary (vendor/occt-wasm/*.tgz,
// node_modules/occt-wasm/NOTICE-GEO9.md); rebuilding it requires the
// Docker+emsdk+cargo toolchain that notice documents, which is NOT available in
// this work order's environment (verified: no docker/cargo/emcc on PATH). There
// is also no TS-level workaround: node_modules/occt-wasm/dist/raw-types.d.ts
// exposes exactly one xcafImportSTEP/xcafGetLabelInfo pair with no color-mode
// parameter, so nothing on the app side can ask the kernel to try harder without
// re-implementing STEP color-style parsing as a second, parallel STEP-attribute
// truth path - the exact anti-pattern this WO family's standing rule forbids.
//
// This test is a DELIBERATE fail-loud pin, not a silent "expect the gap
// forever" comfort check: if a future occt-wasm build ever fixes this,
// `hasColor` below flips to `true` and this test starts FAILING - the correct,
// visible signal to go wire up real color support. stepAttributes.ts's color
// path is already fully plumbed and unit-proven for the day that happens (see
// stepAttributes.test.ts's injected-colored-body cases).
import { describe, it, expect, beforeAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'

describe('occt-wasm dependency: XCAF color read-side gap (tracked, not a CAM-13 defect)', () => {
  let kernel: OcctKernel

  beforeAll(async () => {
    kernel = await OcctKernel.init()
  }, 60_000)

  it('loses a color it JUST wrote itself across its own export -> import round trip', () => {
    const box = kernel.makeBox(10, 10, 10)
    const doc = kernel.createXCAFDocument()
    const label = doc.addShape(box, { name: 'probe-box', color: [0.9, 0.1, 0.1] })

    const before = doc.getLabelInfo(label)
    expect(before.hasColor).toBe(true) // in-memory: the color IS set

    const stepText = doc.exportSTEP()
    expect(stepText).toContain('COLOUR_RGB') // OCCT wrote the color into the STEP text
    doc.close()

    const reimported = kernel.importXCAFFromSTEP(stepText)
    try {
      const roots = reimported.getRoots()
      expect(roots.length).toBe(1)
      const after = reimported.getLabelInfo(roots[0])
      expect(after.name).toBe('probe-box') // the NAME survives the round trip...
      expect(after.hasColor).toBe(false)   // ...the COLOR does not (THE GAP, pinned).
    } finally {
      reimported.close()
    }
  })
})
