/* Seeded RNG for the nesting engine.
 *
 * Determinism is the #1 port risk for the SVGnest GA (NESTING-P1-ENGINE-PLAN.md):
 * every randomness consumer in the packer/solver MUST draw from a generator
 * created here so identical input yields byte-identical placements across runs.
 *
 * This mirrors the exact mulberry32 implementation shipped in the adaptive-
 * clearing engine (src/lib/cam/adaptiveClearing2d/engine/interpolation.ts) -
 * the project's established seeded-PRNG pattern. Do NOT swap in Math.random or a
 * different algorithm; that reintroduces nondeterminism the AC determinism gate
 * was built to catch.
 */

/** Create a seeded mulberry32 generator. Returns a function producing the next
 *  pseudo-random number in [0, 1) on each call. Same seed -> same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
