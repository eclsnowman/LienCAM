// WO UI-74-R1 (audit MINOR 2) -- THE REAL-GPU CLASSIFIER, one copy, fail-closed.
//
// The bug this file fixes: ui74-cam-grid-clip-gate.mjs:143-148 and
// ui74-depth-site-census.mjs both CLAIMED "anything unrecognised is REFUSED
// rather than assumed real" while implementing a pure DENYLIST -- so the
// function accepted 'WARP' and 'Mystery Renderer', exactly the strings the prose
// promised to refuse. The claim was right and the code was wrong; this is the
// code catching up, in ONE place both harnesses import.
//
// WHY it must fail closed: feedback_real_gpu_for_render_artifacts is law -- a
// clip/depth artifact may simply NOT reproduce on a software rasterizer, so a
// green run there proves nothing while LOOKING like proof. "I could not identify
// this renderer" is not evidence that it is real silicon; it is absence of
// evidence, and a gate that treats the two the same is the fail-open we keep
// paying for. So the order is: unreadable sentinels REFUSE, known-software
// REFUSE, a known HARDWARE FAMILY accepts, and everything else REFUSES with the
// string quoted so a human can widen the allowlist deliberately.
//
// Adding a family is a deliberate act: add the pattern below AND its accept row
// in src/tests/viewport/realGpuClassifier.ui74.test.ts.

/** Renderer strings that name a software rasterizer, a virtual/paravirtual
 *  adapter, or Microsoft's WARP fallback. Checked BEFORE the allowlist so a
 *  string naming both a vendor and a software device (e.g. ANGLE's
 *  "(Google, Vulkan 1.3.0 (SwiftShader Device ...))") is refused on the
 *  software token rather than accepted on the vendor token. */
export const SOFTWARE_GL =
  /swiftshader|llvmpipe|softpipe|swrast|software|microsoft basic render|basic render driver|generic renderer|mesa offscreen|\bwarp\b|paravirtual|\bvirgl\b|vmware|\bsvga3d\b|virtualbox|\bgallium.*softpipe\b/i

/** Known HARDWARE families. An accepted renderer must match one of these -- this
 *  is the allowlist the prose always claimed. Each entry is a real vendor family
 *  seen in an UNMASKED_RENDERER_WEBGL string (bare, or wrapped in ANGLE's
 *  "ANGLE (<vendor>, <device> <api>, <backend>)" form). */
export const HARDWARE_FAMILIES = [
  { family: 'NVIDIA',      match: /\bnvidia\b|geforce|quadro|\brtx\b|\bgtx\b|\btesla\b|\btegra\b/i },
  { family: 'AMD',         match: /\bamd\b|radeon|\bati\b|firepro|\bvega\b|\bnavi\b/i },
  { family: 'Intel',       match: /\bintel\b|\bintel\(r\)|\biris\b|\buhd graphics\b|\bhd graphics\b|\bintel arc\b/i },
  { family: 'Apple',       match: /\bapple\b/i },
  { family: 'ARM Mali',    match: /\bmali\b/i },
  { family: 'Qualcomm',    match: /\badreno\b|\bqualcomm\b/i },
  { family: 'Imagination', match: /\bpowervr\b/i },
  { family: 'Broadcom',    match: /\bvideocore\b/i },
  { family: 'Vivante',     match: /\bvivante\b/i },
  { family: 'Samsung',     match: /\bxclipse\b/i },
]

/**
 * Classify a WebGL UNMASKED_RENDERER_WEBGL string.
 *
 * @param {unknown} renderer the raw renderer string, or one of the harnesses'
 *   sentinels: '(no webgl)' (no context could be created) / '(unknown)' (the
 *   debug-renderer extension refused).
 * @returns {{ok: boolean, why: string, family: string|null}} ok===true ONLY for a
 *   string that names a known hardware family and no software device.
 */
export function realGpuVerdict(renderer) {
  if (typeof renderer !== 'string' || renderer.trim() === '') {
    return { ok: false, why: 'no renderer string at all', family: null }
  }
  if (renderer === '(no webgl)') {
    return { ok: false, why: 'no WebGL context -- nothing was rendered', family: null }
  }
  if (renderer === '(unknown)') {
    return { ok: false, why: 'renderer string unreadable', family: null }
  }
  if (SOFTWARE_GL.test(renderer)) {
    return { ok: false, why: 'software rasterizer / virtual adapter', family: null }
  }
  const hit = HARDWARE_FAMILIES.find(f => f.match.test(renderer))
  if (hit === undefined) {
    // The fail-closed arm. Unrecognised is REFUSED, never assumed real.
    return {
      ok: false,
      why: 'unrecognised renderer -- not a known hardware family, so it cannot be '
        + 'assumed to be real silicon (add the family to HARDWARE_FAMILIES in '
        + 'tools/capture/lib/real-gpu.mjs, with its test row, if it is)',
      family: null,
    }
  }
  return { ok: true, why: `real driver (${hit.family})`, family: hit.family }
}
