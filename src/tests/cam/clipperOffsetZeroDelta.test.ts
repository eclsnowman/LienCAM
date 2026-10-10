// CAM-14-R1.3 — regression pin for offsetLoop's zero-delta contract.
//
// Pre-CAM-14 (main), offsetLoop(loop, 0, minArea) returned an unmodified copy
// immediately, before any decimation or area filtering. CAM-14's R0 Phase A
// instrumentation refactor (factoring the clipper call into a shared inflate()
// helper) silently dropped that early return from offsetLoop itself, so a
// zero-delta call started decimating and area-filtering its result — an
// undisclosed behavior change the R0 report claimed was byte-identical (audit
// finding [2]). Restored in R1; this test pins the restored contract so it
// cannot silently regress again.

import { describe, it, expect } from 'vitest'
import { ensureClipperReady, offsetLoop } from '../../lib/cam/face2d/clipperOffset'

await ensureClipperReady()

describe('offsetLoop — CAM-14-R1 zero-delta contract', () => {
  it('returns an unmodified copy of the input loop for delta=0, with no decimation', () => {
    // A dense loop (points far closer together than the decimate epsilon would
    // ever merge under a nonzero delta) — if offsetLoop still decimated on the
    // zero-delta path, this count would shrink.
    const loop = Array.from({ length: 40 }, (_, i) => {
      const t = (2 * Math.PI * i) / 40
      return { x: 10 * Math.cos(t), y: 10 * Math.sin(t) }
    })
    const result = offsetLoop(loop, 0)
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(loop.length)
    expect(result[0]).toEqual(loop)
  })

  it('ignores minArea for delta=0 (pre-CAM-14 contract: no area filter on the unmodified-copy path)', () => {
    // A tiny triangle whose area is far below the minArea threshold — under
    // the general (nonzero-delta) path this would be dropped by the minArea
    // filter; the zero-delta path must return it anyway (unmodified copy,
    // unconditionally, matching pre-CAM-14 main).
    const tinyLoop = [{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 0, y: 0.001 }]
    const result = offsetLoop(tinyLoop, 0, /* minArea */ 1e6)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(tinyLoop)
  })

  it('returns a COPY, not the same array reference, for delta=0', () => {
    const loop = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }]
    const result = offsetLoop(loop, 0)
    expect(result[0]).not.toBe(loop)
  })
})
