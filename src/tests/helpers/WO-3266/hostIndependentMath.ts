// WO-3266: host-independent Math for the GOOD-SPEC tripwire counts.
//
// MEASURED (src/tests/evidence/WO-3266/divergence.json): the same engine on the same arm64
// host gives different tripwire counts under Node 22 (V8 12.4) and Node 25 (V8 14.1), and
// Node 25 on x64 Windows gives a third table. The first engine value that differs is a
// 1-ulp Math.atan2 result (processFeature.ts recordTakenDeflection); the engine's stepper
// amplifies one ulp into whole passes. V8 implements Math.sin/cos/tan/atan2/acos in C++
// compiled per platform and per V8 release, so no pin table can hold on every host.
//
// These are pure-JS ports of the fdlibm routines V8 has historically shipped (and of V8's
// own Math.hypot algorithm). JS arithmetic is IEEE-754 double with no fused multiply-add,
// so every host computes them bit-identically. installHostIndependentMath() swaps them in
// for the duration of a test; restore() puts the host's functions back.
//
// Only the transcendental functions the adaptive engine calls on the GOOD-SPEC corpus are
// replaced (measured: sin, cos, tan, acos, atan2, hypot). Math.sqrt is correctly rounded on
// every host and needs no replacement.

const buf = new DataView(new ArrayBuffer(8))
const hi = (x: number): number => { buf.setFloat64(0, x); return buf.getInt32(0) }
const lo = (x: number): number => { buf.setFloat64(0, x); return buf.getUint32(4) }
const withLo = (x: number, l: number): number => { buf.setFloat64(0, x); buf.setUint32(4, l >>> 0); return buf.getFloat64(0) }
const fromWords = (h: number, l: number): number => { buf.setInt32(0, h | 0); buf.setUint32(4, l >>> 0); return buf.getFloat64(0) }

// ---- argument reduction (fdlibm __ieee754_rem_pio2, |x| < 2^19 * pi/2) ----
const invpio2 = 6.36619772367581382433e-01
const pio2_1 = 1.57079632673412561417e+00
const pio2_1t = 6.07710050650619224932e-11
const pio2_2 = 6.07710050630396597660e-11
const pio2_2t = 2.02226624879595063154e-21
const pio2_3 = 2.02226624871116645580e-21
const pio2_3t = 8.47842766036889956997e-32
const npio2_hw = [
  0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
  0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
  0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
  0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
]
const y = [0, 0]
let largeArgCalls = 0

function remPio2(x: number): number {
  const hx = hi(x)
  const ix = hx & 0x7fffffff
  if (ix <= 0x3fe921fb) { y[0] = x; y[1] = 0; return 0 }
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - pio2_1
      if (ix !== 0x3ff921fb) { y[0] = z - pio2_1t; y[1] = (z - y[0]) - pio2_1t }
      else { z -= pio2_2; y[0] = z - pio2_2t; y[1] = (z - y[0]) - pio2_2t }
      return 1
    }
    let z = x + pio2_1
    if (ix !== 0x3ff921fb) { y[0] = z + pio2_1t; y[1] = (z - y[0]) + pio2_1t }
    else { z += pio2_2; y[0] = z + pio2_2t; y[1] = (z - y[0]) + pio2_2t }
    return -1
  }
  if (ix <= 0x413921fb) {
    let t = Math.abs(x)
    const n = Math.trunc(t * invpio2 + 0.5)
    const fn = n
    let r = t - fn * pio2_1
    let w = fn * pio2_1t
    if (n < 32 && ix !== npio2_hw[n - 1]) {
      y[0] = r - w
    } else {
      const j = ix >> 20
      y[0] = r - w
      let i = j - ((hi(y[0]) >> 20) & 0x7ff)
      if (i > 16) {
        t = r; w = fn * pio2_2; r = t - w; w = fn * pio2_2t - ((t - r) - w); y[0] = r - w
        i = j - ((hi(y[0]) >> 20) & 0x7ff)
        if (i > 49) { t = r; w = fn * pio2_3; r = t - w; w = fn * pio2_3t - ((t - r) - w); y[0] = r - w }
      }
    }
    y[1] = (r - y[0]) - w
    if (hx < 0) { y[0] = -y[0]; y[1] = -y[1]; return -n }
    return n
  }
  return NaN // huge argument: the caller falls back (counted, never expected on the corpus)
}

// ---- kernels (fdlibm __kernel_sin / __kernel_cos / __kernel_tan) ----
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04
const S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10
function kSin(x: number, yy: number, iy: number): number {
  const ix = hi(x) & 0x7fffffff
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return x
  const z = x * x
  const v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  if (iy === 0) return x + v * (S1 + z * r)
  return x - ((z * (0.5 * yy - v * r) - yy) - v * S1)
}

const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05
const C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11
function kCos(x: number, yy: number): number {
  const ix = hi(x) & 0x7fffffff
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return 1
  const z = x * x
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
  if (ix < 0x3FD33333) return 1 - (0.5 * z - (z * r - x * yy))
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0)
  const hz = 0.5 * z - qx
  const a = 1 - qx
  return a - (hz - (z * r - x * yy))
}

const T = [
  3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02,
  2.18694882948595424599e-02, 8.86323982359930005737e-03, 3.59207910759131235356e-03,
  1.45620945432529025516e-03, 5.88041240820264096874e-04, 2.46463134818469906812e-04,
  7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05,
  2.59073051863633712884e-05,
]
const pio4 = 7.85398163397448278999e-01, pio4lo = 3.06161699786838301793e-17
function kTan(x: number, yy: number, iy: number): number {
  const hx = hi(x)
  const ix = hx & 0x7fffffff
  if (ix < 0x3e300000 && Math.trunc(x) === 0) {
    if (((ix | lo(x)) | (iy + 1)) === 0) return 1 / Math.abs(x)
    if (iy === 1) return x
    const w = x + yy
    const z = withLo(w, 0)
    const v = yy - (z - x)
    const a = -1 / w
    const t = withLo(a, 0)
    const s = 1 + t * z
    return t + a * (s + t * v)
  }
  if (ix >= 0x3FE59428) {
    if (hx < 0) { x = -x; yy = -yy }
    const z = pio4 - x
    const w = pio4lo - yy
    x = z + w; yy = 0
  }
  const z = x * x
  let w = z * z
  let r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))))
  let v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))))
  const s = z * x
  r = yy + z * (s * (r + v) + yy)
  r += T[0] * s
  w = x + r
  if (ix >= 0x3FE59428) {
    v = iy
    return (1 - ((hx >> 30) & 2)) * (v - 2 * (x - (w * w / (w + v) - r)))
  }
  if (iy === 1) return w
  const zz = withLo(w, 0)
  v = r - (zz - x)
  const a = -1 / w
  const t = withLo(a, 0)
  const ss = 1 + t * zz
  return t + a * (ss + t * v)
}

function sin(x: number): number {
  const ix = hi(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kSin(x, 0, 0)
  if (ix >= 0x7ff00000) return x - x
  const n = remPio2(x)
  if (Number.isNaN(n)) { largeArgCalls++; return hostSin(x) }
  switch (n & 3) {
    case 0: return kSin(y[0], y[1], 1)
    case 1: return kCos(y[0], y[1])
    case 2: return -kSin(y[0], y[1], 1)
    default: return -kCos(y[0], y[1])
  }
}

function cos(x: number): number {
  const ix = hi(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kCos(x, 0)
  if (ix >= 0x7ff00000) return x - x
  const n = remPio2(x)
  if (Number.isNaN(n)) { largeArgCalls++; return hostCos(x) }
  switch (n & 3) {
    case 0: return kCos(y[0], y[1])
    case 1: return -kSin(y[0], y[1], 1)
    case 2: return -kCos(y[0], y[1])
    default: return kSin(y[0], y[1], 1)
  }
}

function tan(x: number): number {
  const ix = hi(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kTan(x, 0, 1)
  if (ix >= 0x7ff00000) return x - x
  const n = remPio2(x)
  if (Number.isNaN(n)) { largeArgCalls++; return hostTan(x) }
  return kTan(y[0], y[1], 1 - ((n & 1) << 1))
}

// ---- atan / atan2 (fdlibm s_atan.c, e_atan2.c) ----
const atanhi = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00]
const atanlo = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]
const aT = [
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
  -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
  6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
  -3.65315727442169155270e-02, 1.62858201153657823623e-02,
]
function atan(x: number): number {
  const hx = hi(x)
  const ix = hx & 0x7fffffff
  let id: number
  if (ix >= 0x44100000) {
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lo(x) !== 0)) return x + x
    return hx > 0 ? atanhi[3] + atanlo[3] : -atanhi[3] - atanlo[3]
  }
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e400000 && 1e300 + x > 1) return x
    id = -1
  } else {
    x = Math.abs(x)
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) { id = 0; x = (2 * x - 1) / (2 + x) } else { id = 1; x = (x - 1) / (x + 1) }
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1 + 1.5 * x) } else { id = 3; x = -1 / x }
  }
  const z = x * x
  const w = z * z
  const s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))))
  const s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))))
  if (id < 0) return x - x * (s1 + s2)
  const r = atanhi[id] - ((x * (s1 + s2) - atanlo[id]) - x)
  return hx < 0 ? -r : r
}

const tiny = 1e-300
const pi_o_4 = 7.8539816339744827900e-01, pi_o_2 = 1.5707963267948965580e+00
const pi = 3.1415926535897931160e+00, pi_lo = 1.2246467991473532e-16
function atan2(yv: number, xv: number): number {
  if (Number.isNaN(xv) || Number.isNaN(yv)) return xv + yv
  const hx = hi(xv), lx = lo(xv), ix = hx & 0x7fffffff
  const hy = hi(yv), ly = lo(yv), iy = hy & 0x7fffffff
  if (((hx - 0x3ff00000) | lx) === 0) return atan(yv)
  let m = ((hy >> 31) & 1) | ((hx >> 30) & 2)
  if ((iy | ly) === 0) {
    switch (m) { case 0: case 1: return yv; case 2: return pi + tiny; default: return -pi - tiny }
  }
  if ((ix | lx) === 0) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) { case 0: return pi_o_4 + tiny; case 1: return -pi_o_4 - tiny; case 2: return 3 * pi_o_4 + tiny; default: return -3 * pi_o_4 - tiny }
    }
    switch (m) { case 0: return 0; case 1: return -0; case 2: return pi + tiny; default: return -pi - tiny }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny
  const k = (iy - ix) >> 20
  let z: number
  if (k > 60) { z = pi_o_2 + 0.5 * pi_lo; m &= 1 }
  else if (hx < 0 && k < -60) z = 0
  else z = atan(Math.abs(yv / xv))
  switch (m) {
    case 0: return z
    case 1: return -z
    case 2: return pi - (z - pi_lo)
    default: return (z - pi_lo) - pi
  }
}

// ---- acos (fdlibm e_acos.c) ----
const pio2_hi = 1.57079632679489655800e+00, pio2_lo = 6.12323399573676603587e-17
const pS0 = 1.66666666666666657415e-01, pS1 = -3.25565818622400915405e-01, pS2 = 2.01212532134862925881e-01
const pS3 = -4.00555345006794114027e-02, pS4 = 7.91534994289814532176e-04, pS5 = 3.47933107596021167570e-05
const qS1 = -2.40339491173441421878e+00, qS2 = 2.02094576023350569471e+00, qS3 = -6.88283971605453293030e-01
const qS4 = 7.70381505559019352791e-02
function acos(x: number): number {
  const hx = hi(x)
  const ix = hx & 0x7fffffff
  if (ix >= 0x3ff00000) {
    if (((ix - 0x3ff00000) | lo(x)) === 0) return hx > 0 ? 0 : pi + 2 * pio2_lo
    return (x - x) / (x - x)
  }
  if (ix < 0x3fe00000) {
    if (ix <= 0x3c600000) return pio2_hi + pio2_lo
    const z = x * x
    const p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))))
    const q = 1 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)))
    return pio2_hi - (x - (pio2_lo - x * (p / q)))
  }
  if (hx < 0) {
    const z = (1 + x) * 0.5
    const p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))))
    const q = 1 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)))
    const s = Math.sqrt(z)
    const w = (p / q) * s - pio2_lo
    return pi - 2 * (s + w)
  }
  const z = (1 - x) * 0.5
  const s = Math.sqrt(z)
  const df = withLo(s, 0)
  const c = (z - df * df) / (s + df)
  const p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))))
  const q = 1 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)))
  const w = (p / q) * s + c
  return 2 * (df + w)
}

// ---- hypot (V8's MathHypot algorithm: scale by the max, Kahan-summed squares) ----
function hypot(...args: number[]): number {
  const n = args.length
  if (n === 0) return 0
  const abs = new Array<number>(n)
  let max = 0
  let nan = false
  for (let i = 0; i < n; i++) {
    const v = +args[i]
    if (Number.isNaN(v)) { nan = true; abs[i] = 0 } else { const a = Math.abs(v); abs[i] = a; if (a > max) max = a }
  }
  if (max === Infinity) return Infinity
  if (nan) return NaN
  if (max === 0) return 0
  let sum = 0
  let compensation = 0
  for (let i = 0; i < n; i++) {
    const r = abs[i] / max
    const summand = r * r - compensation
    const preliminary = sum + summand
    compensation = (preliminary - sum) - summand
    sum = preliminary
  }
  return Math.sqrt(sum) * max
}

const hostSin = Math.sin, hostCos = Math.cos, hostTan = Math.tan

export const HOST_INDEPENDENT_MATH = { sin, cos, tan, atan2, acos, hypot } as const

/** Calls whose argument exceeded the reduction range and fell back to the host (expected 0). */
export function hostIndependentMathFallbacks(): number { return largeArgCalls }

/** Swap the host's transcendental Math functions for the host-independent ones. Returns restore(). */
export function installHostIndependentMath(): () => void {
  const m = Math as unknown as Record<string, unknown>
  const saved: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(HOST_INDEPENDENT_MATH)) { saved[name] = m[name]; m[name] = fn }
  return () => { for (const [name, fn] of Object.entries(saved)) m[name] = fn }
}
