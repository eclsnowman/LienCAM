// SKC-6B STEP 0 — last-green baselines for the ONE surviving 2D mapping.
//
// This file captures (and, on every ordinary suite run, GUARDS) the 2D CAM
// sketcher's solve behavior BEFORE the sketch3d convergence work re-routes the
// SKC solve path through gcsMapping.ts. The convergence is required to leave
// the 2D daily-driver path byte-identical (WO SKC-6B acceptance #2), so:
//
//   * GOLDEN: solved output for a set of UNCONSTRAINED 2D sketch fixtures,
//     serialized with STABLE key order. Committed as
//     coordination/reports/SKC-6B-golden-pre.json. The default (no-capture)
//     test recomputes it and asserts BYTE-IDENTICAL equality against the
//     committed file — so any drift in the 2D unconstrained solve output fails
//     loudly in the suite.
//
//   * PERF: median ms/solve of the 2D DRAG_SOLVE mapping path
//     (solveSketchOnWrapper with a DragRequest) on a ~100-entity synthetic
//     sketch with ZERO constraints, N>=50 iterations. Committed as
//     coordination/reports/SKC-6B-perf-baseline.json. Timing is noisy, so it is
//     captured/quoted, never hard-asserted (a flaky perf assertion would poison
//     the suite gate).
//
// The heavy capture (N>=50 solves, file writes) runs ONLY under the
// SKC6B_CAPTURE env flag so ordinary suite runs stay fast and never rewrite the
// committed baselines:
//   SKC6B_CAPTURE=pre  npx vitest run src/tests/perf   -> writes baseline + golden-pre
//   SKC6B_CAPTURE=post npx vitest run src/tests/perf   -> writes perf-after + golden-after
//
// Deterministic + seeded: entity coordinates come from a fixed LCG and drag
// cursors from a fixed sequence, so re-runs are reproducible.

import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type { DragRequest } from '../../lib/sketch/solver/gcsMapping'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

const CAPTURE = process.env.SKC6B_CAPTURE // 'pre' | 'post' | undefined
const REPORTS = resolve(process.cwd(), 'coordination', 'reports')
const GOLDEN_PRE = resolve(REPORTS, 'SKC-6B-golden-pre.json')

// ---- deterministic helpers -------------------------------------------------

/** Mulberry32 — a tiny deterministic PRNG so fixtures are seeded & reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Canonical JSON with recursively SORTED object keys => stable byte output. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k])
      }
      return out
    }
    if (typeof v === 'number') return Number(v.toFixed(9))
    return v
  }
  return JSON.stringify(sort(value), null, 2) + '\n'
}

function sketch(id: string, entities: SketchEntity[]): Sketch {
  return { id, layerId: 'layer', entities, constraints: [], dimensions: [], solveStatus: null }
}

// ---- golden fixtures (UNCONSTRAINED 2D sketches) ---------------------------

function goldenFixtures(): Sketch[] {
  return [
    sketch('g-line', [
      { id: 'l', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    ]),
    sketch('g-points', [
      { id: 'p0', kind: 'point', construction: false, at: { x: 1, y: 2 } },
      { id: 'p1', kind: 'point', construction: false, at: { x: -3.5, y: 4.25 } },
      { id: 'p2', kind: 'point', construction: false, at: { x: 7, y: -8 } },
    ]),
    sketch('g-round', [
      { id: 'c', kind: 'circle', construction: false, center: { x: 5, y: 5 }, radius: 3 },
      { id: 'a', kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius: 4, startAngle: 0, endAngle: Math.PI / 2 },
    ]),
    sketch('g-mixed', [
      { id: 'mp', kind: 'point', construction: false, at: { x: 2, y: 2 } },
      { id: 'ml', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 6, y: 1 } },
      { id: 'mc', kind: 'circle', construction: false, center: { x: 12, y: 3 }, radius: 2.5 },
      { id: 'ma', kind: 'arc', construction: false, center: { x: -4, y: -4 }, radius: 1.5, startAngle: Math.PI / 6, endAngle: Math.PI },
    ]),
  ]
}

async function captureGolden(): Promise<string> {
  const gcs = await createGcsWrapper()
  try {
    const records = goldenFixtures().map((sk) => {
      const out = solveSketchOnWrapper(gcs, sk)
      return {
        id: sk.id,
        ok: out.ok,
        status: out.status,
        entities: out.ok ? out.entities : sk.entities,
      }
    })
    return canonical({ what: 'SKC-6B unconstrained 2D solve golden', records })
  } finally {
    gcs.destroy_gcs_module()
  }
}

// ---- perf fixture (100-entity ZERO-constraint DRAG_SOLVE path) -------------

function perfSketch(entityCount: number): Sketch {
  const r = rng(0x5c6b0000)
  const entities: SketchEntity[] = []
  for (let i = 0; i < entityCount; i++) {
    entities.push({
      id: `p${i}`,
      kind: 'point',
      construction: false,
      at: { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 },
    })
  }
  return sketch('perf-100', entities)
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

async function measureDragPerf(entityCount: number, iterations: number): Promise<{ medianMs: number; iterations: number; entityCount: number; samplesMs: number[] }> {
  const gcs = await createGcsWrapper()
  try {
    const sk = perfSketch(entityCount)
    // Drag the first point along a deterministic path; ZERO document constraints
    // so this measures the pure mapping+solve+parking cost of the DRAG path.
    const samples: number[] = []
    // one warm-up solve (WASM/JIT) that is NOT timed
    solveSketchOnWrapper(gcs, sk, dragTo(0, 0))
    for (let i = 0; i < iterations; i++) {
      const drag = dragTo(Math.cos(i) * 50, Math.sin(i) * 50)
      const t0 = performance.now()
      solveSketchOnWrapper(gcs, sk, drag)
      samples.push(performance.now() - t0)
    }
    return { medianMs: median(samples), iterations, entityCount, samplesMs: samples.map((v) => Number(v.toFixed(4))) }
  } finally {
    gcs.destroy_gcs_module()
  }
}

function dragTo(x: number, y: number): DragRequest {
  return { targets: [{ point: { entityId: 'p0', site: 'self' }, to: { x, y } }] }
}

// ---- tests / capture --------------------------------------------------------

describe('SKC-6B STEP 0 — 2D unconstrained solve baselines', () => {
  it('golden: unconstrained 2D solve output is stable (byte-identical to committed golden-pre)', async () => {
    const golden = await captureGolden()

    if (CAPTURE === 'pre') {
      mkdirSync(REPORTS, { recursive: true })
      writeFileSync(GOLDEN_PRE, golden)
    } else if (CAPTURE === 'post') {
      mkdirSync(REPORTS, { recursive: true })
      writeFileSync(resolve(REPORTS, 'SKC-6B-golden-after.json'), golden)
    }

    // Regression guard for every ordinary suite run: once the committed
    // golden-pre exists, a fresh unconstrained solve MUST reproduce it byte for
    // byte. (Skipped only before the first STEP-0 capture, when it does not yet
    // exist.)
    if (existsSync(GOLDEN_PRE)) {
      // Normalize CRLF->LF on both sides: git's autocrlf may rewrite the
      // committed file's line endings on checkout, which is a storage artifact,
      // not a change in the solved output the golden actually guards.
      const norm = (s: string) => s.replace(/\r\n/g, '\n')
      expect(norm(golden)).toBe(norm(readFileSync(GOLDEN_PRE, 'utf8')))
    }
  })

  it('perf: 2D DRAG_SOLVE path runs on a 100-entity zero-constraint sketch', async () => {
    // Ordinary runs do a tiny smoke; the N>=50 measurement + baseline write
    // happens only under SKC6B_CAPTURE to keep the suite fast and to never
    // rewrite the committed baseline as a side effect.
    if (!CAPTURE) {
      const smoke = await measureDragPerf(100, 3)
      expect(smoke.medianMs).toBeGreaterThanOrEqual(0)
      return
    }
    const perf = await measureDragPerf(100, 60)
    const doc = canonical({ what: 'SKC-6B 2D DRAG_SOLVE median ms/solve (100 entities, 0 constraints)', ...perf })
    mkdirSync(REPORTS, { recursive: true })
    writeFileSync(resolve(REPORTS, CAPTURE === 'pre' ? 'SKC-6B-perf-baseline.json' : 'SKC-6B-perf-after.json'), doc)
    expect(perf.medianMs).toBeGreaterThan(0)
  })
})
