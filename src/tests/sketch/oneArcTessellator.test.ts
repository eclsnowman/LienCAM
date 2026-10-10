// WO SKC-14, zero-regression gate criterion 4(b): CAPABILITY SCAN -- exactly ONE module in the
// sketcher ecosystem may tessellate an arc.
//
// This is the critic's DE-2 pattern (docs/3d/SKETCH-CRITIC-REPORT.md), not a name-grep. The
// failure it exists to prevent already happened twice in this lane:
//   * shareDoNotFork.test.ts asserted `makeArcEntity` was defined once, and passed the entire time
//     CAM's `arcThrough3Points` was a second arc constructor -- the test guarded a NAME.
//   * SKC-12's audit HELD a major because FOUR modules privately walked an arc's sweep
//     (arcTools, sketchLayer, filletTool, sketch3d's sampleArcPoints) and silently disagreed on
//     minimum segment count outside a 60-300deg band.
// Writing this WO's scan uncovered a FIFTH and SIXTH (toolOverlay.entityOutline's ghost arcs and
// dimPlacement's angle-guide arc) that no name-based guard would ever have surfaced.
//
// The capability, stated structurally: "a loop that accumulates points along an arc's sweep."
// Any file that grows one -- under any function name -- fails this test. The real guarantee is
// that there is no file in which a second walk could live (BK-88: the walk lives in
// src/lib/sketch/sketcher/geometry/arcTessellation.ts, and callers pass a DENSITY POLICY);
// this scan is the backstop that makes a reintroduction loud instead of silent.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { arcSweepCcw } from '../../lib/sketch/sketcher/geometry/arcTessellation'
import { arcPreview } from '../../lib/sketch/tools/arcTools'

const SRC_ROOT = join(__dirname, '..', '..')
const TWO_PI = Math.PI * 2

/** The whole surface where a sketch arc could plausibly be tessellated: the CAM sketcher, its
 *  render layer, the extracted sketcher component, and the sketch3d remains that die at S5.
 *  Roots are allowed to VANISH (S5 deletes sketch3d-shared / sketch3dlab), but the two that hold
 *  the component and its host are asserted present below so this scan can never rot into a no-op
 *  by silently scanning an empty set. */
const ECOSYSTEM_ROOTS = [
  join(SRC_ROOT, 'lib', 'sketch'), // includes lib/sketch/sketcher/**
  join(SRC_ROOT, 'lib', 'viewport'),
  join(SRC_ROOT, 'components', 'viewport'),
  join(SRC_ROOT, 'components', 'sketch3d-shared'),
  join(SRC_ROOT, 'components', 'sketch3dlab'),
  join(SRC_ROOT, 'sketch3d'),
]
const REQUIRED_ROOTS = [join(SRC_ROOT, 'lib', 'sketch'), join(SRC_ROOT, 'lib', 'viewport')]
const ECOSYSTEM_SINGLE_FILES = [join(SRC_ROOT, 'components', 'model3d', 'SolidsWorkbenchPage.tsx')]

/** The ONE module allowed to walk an arc sweep. */
const THE_TESSELLATOR = join(SRC_ROOT, 'lib', 'sketch', 'sketcher', 'geometry', 'arcTessellation.ts')

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectTsFiles(full, out)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
}

function ecosystemFiles(): string[] {
  const files: string[] = []
  for (const root of ECOSYSTEM_ROOTS) if (existsSync(root)) collectTsFiles(root, files)
  for (const f of ECOSYSTEM_SINGLE_FILES) if (existsSync(f)) files.push(f)
  // Tests may legitimately construct arcs point-by-point to CHECK the tessellator.
  return files.filter((f) => !f.includes(`${join('src', 'tests')}`))
}

/** Line numbers where a for-loop window both computes `Math.cos(...)` into a pushed point AND
 *  references an arc sweep (`startAngle` / `sweep`). That conjunction is what separates
 *  TESSELLATION (walk the sweep, emit a polyline) from mere point EVALUATION at one angle --
 *  snap.ts's arc midpoint, trimTool's split point and offsetTool's offset all do the latter and
 *  must NOT trip this scan. */
function arcSweepWalks(src: string): number[] {
  const lines = src.split(/\r?\n/)
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/\bfor\s*\(/.test(lines[i])) continue
    const window = lines.slice(i, i + 9).join('\n')
    if (/Math\.cos\(/.test(window) && /\.push\(/.test(window) && /(startAngle|sweep)/.test(window)) {
      hits.push(i + 1)
    }
  }
  return hits
}

describe('WO SKC-14 (BK-88): capability scan -- exactly one module tessellates an arc', () => {
  it('the scan actually scans something (roots that must exist, do)', () => {
    // FAILS-IF: a refactor moves lib/sketch or lib/viewport and every assertion below silently
    // starts passing over an empty file list.
    for (const root of REQUIRED_ROOTS) expect(existsSync(root), root).toBe(true)
    expect(ecosystemFiles().length).toBeGreaterThan(50)
  })

  it('no module outside sketcher/geometry/arcTessellation.ts walks an arc sweep', () => {
    const offenders: string[] = []
    for (const file of ecosystemFiles()) {
      if (file === THE_TESSELLATOR) continue
      const walks = arcSweepWalks(readFileSync(file, 'utf8'))
      if (walks.length) offenders.push(`${file.replace(/\\/g, '/')}:${walks.join(',')}`)
    }
    // FAILS-IF: any of the six historical forks returns, or a new one is written -- CNCViewport
    // regrowing a preview tessellator, a mount painting its own arc, sketch3d re-deriving points.
    expect(offenders).toEqual([])
  })

  it('sanity: the one allowed module really does contain the walk (the scan is not vacuous)', () => {
    // FAILS-IF: the walk is renamed/reshaped so the scan pattern stops matching it -- at which
    // point the scan above would be green against a tree full of forks.
    expect(existsSync(THE_TESSELLATOR)).toBe(true)
    expect(arcSweepWalks(readFileSync(THE_TESSELLATOR, 'utf8')).length).toBe(1)
  })

  // Collapsing six tessellators onto one forces a single answer to a question they DISAGREED on:
  // what does a sweep that normalizes to zero mean? Getting it wrong is not cosmetic -- the
  // arc-center preview derives endAngle straight from the cursor (arcTools.arcPreview), so it hits
  // the exactly-zero case every time the cursor crosses the start ray.
  describe('the two zero-sweep cases stay distinct', () => {
    it('a raw delta of exactly zero is a DEGENERATE arc (sweep 0), not a full turn', () => {
      expect(arcSweepCcw(0.37, 0.37)).toBe(0)
      expect(arcSweepCcw(-2, -2)).toBe(0)
    })

    it('a NONZERO raw delta that is a whole number of turns is a FULL TURN', () => {
      // The full-circle-via-arc-sampler convenience: {startAngle: 0, endAngle: 2*PI}.
      expect(arcSweepCcw(0, TWO_PI)).toBe(TWO_PI)
      expect(arcSweepCcw(1.1, 1.1 + TWO_PI)).toBeCloseTo(TWO_PI, 12)
    })

    it('the arc-center preview shows NOTHING (not a full circle) when the cursor is on the start ray', () => {
      // FAILS-IF: arcSweepCcw maps a zero raw delta to a full turn -- the preview would flash a
      // whole circle as the cursor crosses the start ray. Regression introduced and caught while
      // writing this WO's one-tessellator collapse.
      const center = { x: 0, y: 0 }
      const start = { x: 10, y: 0 }
      const chain = { kind: 'arc' as const, mode: 'center' as const, center, start }
      const onStartRay = { x: 25, y: 0 } // same angle as `start`, further out
      const pts = arcPreview(chain, onStartRay)
      expect(pts).not.toBeNull()
      const xs = pts!.map((p) => p.x)
      const ys = pts!.map((p) => p.y)
      // Every sample sits at the start point: a degenerate (invisible) rubber band.
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-9)
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-9)
      // A full-circle preview would have spanned the diameter.
      expect(Math.max(...xs) - Math.min(...xs)).not.toBeCloseTo(20, 3)
    })
  })

  it('sketch3d does not tessellate: sampleArcPoints delegates to CAM tessellateArc (BK-88)', () => {
    const geometry2d = join(SRC_ROOT, 'components', 'sketch3d-shared', 'geometry2d.ts')
    if (!existsSync(geometry2d)) return // retired at S5 -- the capability scan above still holds
    const src = readFileSync(geometry2d, 'utf8')
    // FAILS-IF: the delegation is replaced by a local walk (the exact mutation this WO proved red).
    expect(src).toMatch(/import\s*\{[^}]*\btessellateArc\b[^}]*\}\s*from\s*['"][^'"]*arcTools['"]/)
    expect(src).toMatch(/return\s+tessellateArc\(/)
  })
})
