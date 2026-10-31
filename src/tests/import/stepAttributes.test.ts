// CAM-13 (+ CAM-13-R1) unit tests for the shared embedded-attribute picker +
// reader glue. WO-3093 (23585bb2e6) preserves per-part colours and treats
// mixed names as ordinary assembly metadata. These do NOT touch a kernel - they prove the pure name/color
// collapse logic (incl. the "every part agrees" rule, MAJOR 5), the reader's
// diagnostics-to-warning consumption (MAJOR 4), and its single bounded
// lifecycle deadline (MAJOR 6), all with an injected fake service. The
// real-kernel proof (names actually reach the CAM model, both real workspace
// paths) lives in stepAttributesReadReal.test.ts and
// src/tests/store/importBrepAttributesReal.test.ts.
import { describe, it, expect, vi } from 'vitest'
import type { GeomClient } from '../../geom'
import type { Diag, KernelInfo } from '../../geom/geom-service'
import {
  rgb01ToHex,
  pickDisplayAttributes,
  readStepDisplayAttributes,
  resolveEmbeddedColorOutcome,
} from '../../lib/import/stepAttributes'

const IMP = 'IMP1'

describe('rgb01ToHex', () => {
  it('maps [0,1] channels to #rrggbb with rounding + clamping', () => {
    expect(rgb01ToHex([0, 0, 0])).toBe('#000000')
    expect(rgb01ToHex([1, 1, 1])).toBe('#ffffff')
    // 0.85*255=216.75->217=d9, 0.2*255=51=33, 0.15*255=38.25->38=26
    expect(rgb01ToHex([0.85, 0.2, 0.15])).toBe('#d93326')
    // out-of-range clamps, does not wrap
    expect(rgb01ToHex([2, -1, 0.5])).toBe('#ff0080')
  })
})

describe('pickDisplayAttributes', () => {
  it('uses a single real embedded name', () => {
    expect(pickDisplayAttributes([{ name: 'Part 1' }], IMP)).toEqual({ name: 'Part 1', color: undefined })
  })

  it('keeps a generic embedded name (parity with Part Studio; user can rename)', () => {
    expect(pickDisplayAttributes([{ name: 'Open CASCADE STEP translator 8.0 1' }], IMP).name)
      .toBe('Open CASCADE STEP translator 8.0 1')
  })

  it('drops the synthetic body#k fallback so the caller keeps the filename', () => {
    expect(pickDisplayAttributes([{ name: `${IMP}:step:body#0` }], IMP).name).toBeUndefined()
    expect(pickDisplayAttributes([{ name: undefined }], IMP).name).toBeUndefined()
    expect(pickDisplayAttributes([{ name: '' }], IMP).name).toBeUndefined()
  })

  it('a single part with no attributes at all -> no warning (the ordinary, legitimate-absence case)', () => {
    expect(pickDisplayAttributes([{}], IMP)).toEqual({ name: undefined, color: undefined, warning: undefined })
  })

  it('keeps a common assembly name and falls back silently when names differ', () => {
    expect(pickDisplayAttributes([{ name: 'A' }, { name: 'A' }], IMP)).toEqual({ name: 'A', color: undefined })
    const differing = pickDisplayAttributes([{ name: 'A' }, { name: 'B' }], IMP)
    expect(differing.name).toBeUndefined()
    expect(differing.warning).toBeUndefined()
  })

  it('one named part + one unnamed part uses the filename without an assembly warning', () => {
    // A partial name still cannot become the label of the combined row.
    const out = pickDisplayAttributes([{ name: 'Only One Named' }, { name: `${IMP}:step:body#1` }], IMP)
    expect(out.name).toBeUndefined()
    expect(out.warning).toBeUndefined()
  })

  it('reads a single/common embedded color as hex', () => {
    expect(pickDisplayAttributes([{ color: [0.85, 0.2, 0.15] }], IMP).color).toBe('#d93326')
    expect(pickDisplayAttributes([{ color: [1, 0, 0] }, { color: [1, 0, 0] }], IMP).color).toBe('#ff0000')
  })

  it('different part colours keep the first-part row swatch without a warning', () => {
    const out = pickDisplayAttributes([{ color: [1, 0, 0] }, { color: [0, 1, 0] }], IMP)
    expect(out.color).toBe('#ff0000')
    expect(out.warning).toBeUndefined()
  })

  it('a coloured first part keeps its swatch when another part uses the default', () => {
    // WO-3093 uses the FIRST part for the row; missing first-part colour stays default.
    const out = pickDisplayAttributes([{ color: [1, 0, 0] }, {}], IMP)
    expect(out.color).toBe('#ff0000')
    expect(out.warning).toBeUndefined()
    expect(pickDisplayAttributes([{}, { color: [1, 0, 0] }], IMP).color).toBeUndefined()
  })

  it('rejects a non-finite color rather than showing it, WITH a named invalid-color warning (CAM-13-R2 MAJOR 2)', () => {
    const nan = pickDisplayAttributes([{ color: [NaN, 0, 0] }], IMP)
    expect(nan.color).toBeUndefined()
    expect(nan.warning).toContain('1/1 part(s) carry a malformed or out-of-[0,1]-range embedded color')
    const inf = pickDisplayAttributes([{ color: [Infinity, 0, 0] }], IMP)
    expect(inf.color).toBeUndefined()
    expect(inf.warning).toContain('malformed or out-of-[0,1]-range embedded color')
  })

  it('CAM-13-R2 MAJOR 2: an out-of-[0,1]-range (but finite) channel is invalid, not silently clamped', () => {
    // Pre-R2 this silently became '#ff0080' via rgb01ToHex's clamp with no warning
    // (the audit's OUT_OF_RANGE_COLOR finding) - a present, malformed triple must
    // now be DISTINGUISHED from genuine absence, not reclassified as one.
    const out = pickDisplayAttributes([{ color: [2, -1, 0.5] }], IMP)
    expect(out.color).toBeUndefined()
    expect(out.warning).toContain('1/1 part(s) carry a malformed or out-of-[0,1]-range embedded color - using default')
  })

  it('CAM-13-R2 MAJOR 2: invalid-but-present color is distinguished from genuine absence (no warning stays no-warning)', () => {
    // Genuine absence: still silent (the ordinary case, untouched by this fix).
    expect(pickDisplayAttributes([{}], IMP).warning).toBeUndefined()
    // Present-but-invalid: named warning, even as the ONLY part in the assembly
    // (collapseField alone would call this "no part carries the field" and stay
    // silent - the exact silent-reclassification bug this WO closes).
    const invalid = pickDisplayAttributes([{ color: [1, 2, 3] }], IMP)
    expect(invalid.color).toBeUndefined()
    expect(invalid.warning).toContain('malformed or out-of-[0,1]-range embedded color')
  })

  it('a malformed second colour warns without discarding the valid first-part swatch', () => {
    const out = pickDisplayAttributes([{ color: [1, 0, 0] }, { color: [1, 2, 3] }], IMP)
    expect(out.color).toBe('#ff0000')
    expect(out.warning).toContain('1/2 part(s) carry a malformed or out-of-[0,1]-range embedded color')
  })
})

describe('resolveEmbeddedColorOutcome (CAM-13-R2 MAJOR 1: cross-workspace color-parity map)', () => {
  it('maps a raw undefined (Part Studio, no baked-in default) to hasEmbeddedColor:false', () => {
    expect(resolveEmbeddedColorOutcome(undefined, undefined)).toEqual({ hasEmbeddedColor: false })
  })

  it('maps a raw value equal to the workspace default (CAM, default baked in at import) to hasEmbeddedColor:false', () => {
    expect(resolveEmbeddedColorOutcome('#8ab4cc', '#8ab4cc')).toEqual({ hasEmbeddedColor: false })
  })

  it('maps a raw value that differs from the workspace default to a real embedded color', () => {
    expect(resolveEmbeddedColorOutcome('#9dcfed', '#8ab4cc')).toEqual({ hasEmbeddedColor: true, color: '#9dcfed' })
    expect(resolveEmbeddedColorOutcome('#9dcfed', undefined)).toEqual({ hasEmbeddedColor: true, color: '#9dcfed' })
  })

  it('two workspaces with DIFFERENT raw defaults and DIFFERENT raw values agree once mapped (the parity proof)', () => {
    // Part Studio: raw undefined (no default baked in). CAM: raw '#8ab4cc' (its
    // own baked-in default). Comparing these raw values directly would say
    // "disagree" (undefined !== '#8ab4cc') even though both mean "no embedded
    // color" - exactly the MAJOR 1 defect. Mapped, they agree.
    const ps = resolveEmbeddedColorOutcome(undefined, undefined)
    const cam = resolveEmbeddedColorOutcome('#8ab4cc', '#8ab4cc')
    expect(ps).toEqual(cam)
  })
})

/** Minimal GeomClient double - readStepDisplayAttributes only uses these 4
 *  (+ whatever diagnostics readStepAttributes hands back). */
function fakeService(over: {
  bodies?: Array<{ handle: number; name?: string; color?: [number, number, number] }>
  diagnostics?: Diag[]
  initThrows?: boolean
  importThrows?: boolean
  /** MAJOR 6: init() that never resolves, simulating a hung kernel boot. */
  initHangs?: boolean
}): { svc: GeomClient; disposed: number[]; terminated: () => number } {
  const disposed: number[] = []
  let terminations = 0
  const svc = {
    init: vi.fn(async () => {
      if (over.initHangs) return new Promise<KernelInfo>(() => { /* never resolves */ })
      if (over.initThrows) throw new Error('kernel init failed')
      return {} as KernelInfo
    }),
    // WO-3046: the names-only read; it mints no bodies.
    readStepAttributes: vi.fn(async () => {
      if (over.importThrows) throw new Error('read blew up')
      return { parts: (over.bodies ?? []).map((b) => ({ name: b.name, color: b.color })), diagnostics: over.diagnostics ?? [] }
    }),
    dispose: vi.fn(async (h: number) => { disposed.push(h) }),
    terminate: vi.fn(async () => { terminations += 1 }),
  } as unknown as GeomClient
  return { svc, disposed, terminated: () => terminations }
}

describe('readStepDisplayAttributes (injected fake service)', () => {
  const BYTES = new ArrayBuffer(8)

  it('threads an embedded name+color through to the CAM display shape', async () => {
    const { svc, disposed, terminated } = fakeService({
      bodies: [{ handle: 7, name: 'Colored Part', color: [0.85, 0.2, 0.15] }],
    })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out).toEqual({ name: 'Colored Part', color: '#d93326', partCount: 1, warning: undefined })
    expect(disposed).toEqual([])           // WO-3046: no body minted, nothing to release
    expect(terminated()).toBe(1)           // service torn down (no leaked kernel)
  })

  it('names present, no color -> color undefined (the real-fixture case today)', async () => {
    const { svc } = fakeService({ bodies: [{ handle: 1, name: 'Part 1', color: undefined }] })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out).toMatchObject({ name: 'Part 1', color: undefined, partCount: 1 })
  })

  it('degrades to a named warning (defaults) when the kernel fails, still tearing down', async () => {
    const { svc, terminated } = fakeService({ initThrows: true })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out.partCount).toBe(0)
    expect(out.name).toBeUndefined()
    expect(out.color).toBeUndefined()
    expect(out.warning).toContain('kernel init failed')
    expect(terminated()).toBe(1)
  })

  it('degrades when the attribute read throws', async () => {
    const { svc } = fakeService({ importThrows: true })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out.partCount).toBe(0)
    expect(out.warning).toContain('read blew up')
  })

  it('MAJOR 4: a warning-severity xcafGap diagnostic (real parse failure) becomes a named warning', async () => {
    const { svc } = fakeService({
      bodies: [{ handle: 3, name: `${IMP}:step:body#0` }],
      diagnostics: [{
        code: 'OK', severity: 'warning',
        params: { xcafGap: 'importXCAFFromSTEP threw -- falling back to plain importStep with deterministic body names' },
      }],
    })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out.partCount).toBe(1)
    expect(out.name).toBeUndefined() // synthetic fallback name -> caller keeps the filename
    expect(out.warning).toContain('importXCAFFromSTEP threw')
  })

  it('CAM-13-R3 MAJOR 2: a warning-severity non-info diagnostic degrades name+color to defaults EVEN when parts agree on a real name+color', async () => {
    // The R3 preflight's adversarial case: unlike the MAJOR 4 test above (whose
    // parts already disagree, so name/color were undefined regardless), these
    // parts fully AGREE on a real embedded name+color, so pickDisplayAttributes
    // alone would return that name+color with no warning of its own. A
    // non-info diagnostic (readFailureMessage's exact rule, stepAttributes.ts
    // 243-251) must still force both to omit - proving degrade keys off that
    // rule, not off collapseField disagreement, one specific code, or 'error'
    // severity alone (this one is 'warning').
    const { svc } = fakeService({
      bodies: [
        { handle: 1, name: 'Real Name', color: [1, 0, 0] },
        { handle: 2, name: 'Real Name', color: [1, 0, 0] },
      ],
      diagnostics: [{ code: 'OK', severity: 'warning', params: { xcafGap: 'importXCAFFromSTEP threw' } }],
    })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out.partCount).toBe(2)
    expect(out.name).toBeUndefined()
    expect(out.color).toBeUndefined()
    expect(out.warning).toContain('importXCAFFromSTEP threw')
  })

  it('CAM-13-R2 MAJOR 2: a structured error diagnostic with NO xcafGap text still surfaces (was silently dropped)', async () => {
    // The audit's adversarial case: an error-severity KERNEL_OP_FAILED
    // diagnostic that carries no params.xcafGap string used to vanish entirely
    // (readFailureMessage returned undefined, out.warning was undefined,
    // partCount:0 with no explanation at all).
    const { svc } = fakeService({
      bodies: [],
      diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { stage: 'importStep' } }],
    })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out.partCount).toBe(0)
    expect(out.warning).toContain('KERNEL_OP_FAILED')
    expect(out.warning).toContain('error')
  })

  it('CAM-13-R2 MAJOR 2: a structured error diagnostic with no params at all still surfaces by code+severity', async () => {
    const { svc } = fakeService({
      bodies: [],
      diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error' }],
    })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out.warning).toContain('KERNEL_OP_FAILED')
  })

  it('an info-severity xcafGap diagnostic (legitimately no XCAF/PRODUCT structure) stays warning-free (A2-defaults)', async () => {
    const { svc } = fakeService({
      bodies: [{ handle: 4, name: `${IMP}:step:body#0` }],
      diagnostics: [{
        code: 'OK', severity: 'info',
        params: { xcafGap: 'importXCAFFromSTEP returned no labeled component shapes (file has no PRODUCT/XCAF structure)' },
      }],
    })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out.warning).toBeUndefined()
  })

  it('a genuine reader warning survives while mixed assembly names stay silent', async () => {
    const { svc } = fakeService({
      bodies: [
        { handle: 5, name: 'Real Name' },
        { handle: 6, name: `${IMP}:step:body#1` },
      ],
      diagnostics: [{ code: 'OK', severity: 'warning', params: { xcafGap: 'importXCAFFromSTEP threw' } }],
    })
    const out = await readStepDisplayAttributes(BYTES, IMP, () => svc)
    expect(out.name).toBeUndefined()
    expect(out.warning).toContain('importXCAFFromSTEP threw')
    expect(out.warning).not.toContain('parts disagree')
  })

  it('MAJOR 6: a hung factory/init is bounded by ONE deadline, not just importStep, and still attempts teardown', async () => {
    vi.useFakeTimers()
    try {
      const { svc, terminated } = fakeService({ initHangs: true })
      const pending = readStepDisplayAttributes(BYTES, IMP, () => svc)
      await vi.advanceTimersByTimeAsync(20_000)
      const out = await pending
      expect(out.partCount).toBe(0)
      expect(out.warning).toContain('20000 ms')
      // Teardown was still attempted on the partially-created service despite
      // init() never resolving -- the deadline covers the WHOLE lifecycle, not
      // just importStep().
      expect(terminated()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
