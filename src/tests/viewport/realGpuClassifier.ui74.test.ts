// WO UI-74-R1 (audit MINOR 2): the real-GPU classifier's committed matcher table.
//
// The audit's finding, verbatim: "The GPU classifier is a denylist and does not
// implement its comment/report claim that unrecognized renderers are refused...
// the exact function accepted both 'WARP' and 'Mystery Renderer', contradicting
// lines 143-148 and the worker report's fail-closed claim."
//
// So this table is the thing that was missing: every row is a renderer string a
// real driver (or a real fake) actually reports, and the table asserts the
// verdict in BOTH directions. The two strings the audit caught by hand -- 'WARP'
// and 'Mystery Renderer' -- are rows here, and they were RED against the
// pre-fix denylist (both returned ok:true).
//
// Why the table matters more than the function: this classifier is the only
// thing standing between "the depth gate ran on a real GPU" and "the depth gate
// ran on SwiftShader and proved nothing" (feedback_real_gpu_for_render_artifacts:
// a GPU artifact may not reproduce on a software rasterizer at all).

import { describe, it, expect } from 'vitest'
import { realGpuVerdict, HARDWARE_FAMILIES } from '../support/real-gpu.mjs'

/** Renderer strings that MUST be accepted, with the family each must resolve to.
 *  All are real UNMASKED_RENDERER_WEBGL forms: ANGLE's wrapped
 *  "ANGLE (<vendor>, <device> <api>, <backend>)" and the bare native strings. */
const ACCEPT: { renderer: string; family: string }[] = [
  { renderer: 'ANGLE (NVIDIA, NVIDIA RTX A4000 Direct3D11 vs_5_0 ps_5_0, D3D11)', family: 'NVIDIA' },
  { renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)', family: 'NVIDIA' },
  { renderer: 'NVIDIA GeForce GTX 1660/PCIe/SSE2', family: 'NVIDIA' },
  { renderer: 'ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', family: 'AMD' },
  { renderer: 'AMD Radeon Pro 5500M OpenGL Engine', family: 'AMD' },
  { renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', family: 'Intel' },
  { renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', family: 'Intel' },
  { renderer: 'Apple M2 Pro', family: 'Apple' },
  { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', family: 'Apple' },
  { renderer: 'Mali-G78 MP14', family: 'ARM Mali' },
  { renderer: 'Adreno (TM) 650', family: 'Qualcomm' },
  { renderer: 'PowerVR Rogue GE8320', family: 'Imagination' },
  { renderer: 'VideoCore IV HW', family: 'Broadcom' },
  { renderer: 'Vivante GC7000UL', family: 'Vivante' },
  { renderer: 'ANGLE (Samsung Electronics Co., Ltd., Samsung Xclipse 920)', family: 'Samsung' },
]

/** Renderer strings that MUST be refused. The first group is software or virtual
 *  devices; the second is the unreadable sentinels the harnesses substitute; the
 *  third is the fail-closed arm -- strings that name NO known hardware family and
 *  therefore cannot be assumed to be real silicon. */
const REFUSE: { renderer: string; label: string }[] = [
  // -- software rasterizers and virtual adapters
  { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', label: 'ANGLE SwiftShader' },
  { renderer: 'Google SwiftShader', label: 'bare SwiftShader' },
  { renderer: 'Mesa/X.org llvmpipe (LLVM 15.0.6, 256 bits)', label: 'llvmpipe' },
  { renderer: 'softpipe', label: 'softpipe' },
  { renderer: 'Mesa OffScreen', label: 'Mesa OffScreen' },
  { renderer: 'Gallium 0.4 on softpipe', label: 'gallium softpipe' },
  { renderer: 'Generic Renderer', label: 'generic renderer' },
  { renderer: 'VMware, Inc. -- SVGA3D; build: RELEASE', label: 'VMware virtual GPU' },
  // -- WARP: the audit's named escape. Both the bare token and the ANGLE form.
  { renderer: 'WARP', label: 'bare WARP (audit-named escape)' },
  { renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', label: 'WARP via ANGLE' },
  { renderer: 'Microsoft Basic Render Driver', label: 'Microsoft Basic Render Driver' },
  // -- unreadable sentinels the harnesses substitute when they cannot ask
  { renderer: '(no webgl)', label: 'no WebGL context' },
  { renderer: '(unknown)', label: 'debug-renderer extension refused' },
  { renderer: '', label: 'empty string' },
  { renderer: '   ', label: 'whitespace-only string' },
  // -- the fail-closed arm: unrecognised is REFUSED, never assumed real
  { renderer: 'Mystery Renderer', label: 'unknown string (audit-named escape)' },
  { renderer: 'ANGLE (Acme, Acme Ultra 9000 Direct3D11 vs_5_0 ps_5_0, D3D11)', label: 'plausible-looking unknown vendor' },
  { renderer: 'Chromium', label: 'a browser name, not a GPU' },
]

describe('UI-74-R1 real-GPU classifier (tools/capture/lib/real-gpu.mjs)', () => {
  it.each(ACCEPT)('ACCEPTS $renderer as $family', ({ renderer, family }) => {
    const v = realGpuVerdict(renderer)
    expect(v.ok, `expected ACCEPT but got refusal: ${v.why}`).toBe(true)
    expect(v.family).toBe(family)
  })

  it.each(REFUSE)('REFUSES $label', ({ renderer }) => {
    const v = realGpuVerdict(renderer)
    expect(v.ok, `expected REFUSE but the classifier accepted "${renderer}"`).toBe(false)
    expect(v.family).toBeNull()
    expect(v.why.length).toBeGreaterThan(0)
  })

  // The audit's exact two escapes, called out by name so a future weakening of
  // the table cannot quietly drop them.
  it('refuses the two strings the auditor caught the denylist accepting', () => {
    expect(realGpuVerdict('WARP').ok).toBe(false)
    expect(realGpuVerdict('Mystery Renderer').ok).toBe(false)
  })

  it('is an ALLOWLIST: a string naming no known family is refused with a why that says so', () => {
    const v = realGpuVerdict('Totally Legit Graphics Device 3000')
    expect(v.ok).toBe(false)
    expect(v.why).toContain('unrecognised renderer')
  })

  it('a software token beats a vendor token in the same string (deny before allow)', () => {
    // The real shape of this hazard: ANGLE names the VENDOR ("Google") and the
    // DEVICE separately, and a vendor-first classifier would accept a
    // SwiftShader run that happened to mention real hardware.
    const v = realGpuVerdict('ANGLE (NVIDIA, SwiftShader Device Direct3D11 vs_5_0 ps_5_0, D3D11)')
    expect(v.ok).toBe(false)
    expect(v.why).toContain('software rasterizer')
  })

  it('non-string inputs are refused rather than coerced', () => {
    for (const bad of [undefined, null, 0, {}, []]) {
      expect(realGpuVerdict(bad as unknown as string).ok).toBe(false)
    }
  })

  it('every declared hardware family is exercised by at least one ACCEPT row', () => {
    // Guards the table itself: a family added to the classifier without a row
    // here is an untested accept path, which is how the denylist bug shipped.
    const covered = new Set(ACCEPT.map(r => r.family))
    const uncovered = HARDWARE_FAMILIES.map(f => f.family).filter(f => !covered.has(f))
    expect(uncovered).toEqual([])
  })
})
