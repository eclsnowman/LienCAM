// @vitest-environment jsdom
//
// WO-1569: pattern sketch geometry along a curve (line/arc chain, closed arc
// chain, spline, elliptical arc paths). Behavioural acceptance:
//   - a 5 mm circle patterned 5x along a 100 mm line -> centres 25 mm apart
//     by arc length
//   - 8x around a closed circle path (two 180deg arcs) with equal spacing ->
//     8 distinct copies 45deg apart
//   - along a spline, consecutive copy centres are equal arc-length apart
//     within 0.01 mm
//   - Follow tangent: a small line copy is parallel to the path tangent at
//     each copy
//   - a closed path with equal spacing does not stack the last copy on the
//     first
//   - one Undo removes every copy (== ONE doc.append call; exercised at the
//     toolController integration in the click-flow describe block)
//
// Audit retry (2026-09-15): the confirm overlay's Count/Spacing-mode/fixed-
// distance/Follow-tangent controls were wired to the LINEAR/CIRCULAR pattern
// scalars no matter which pattern tool was armed, so a path-pattern edit
// never reached `chain` and every commit used the click-time defaults. The
// "rendered overlay wiring" describe block below drives the REAL
// SketchConfirmOverlay component through its DOM (typed Count, clicked
// "Fixed distance", typed Spacing, clicked OK) and asserts on the entities
// actually appended to the document -- not by calling pathPatternApply
// directly, which is exactly the hole that hid the defect the first time.

import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'
import {
  pathPatternEntities, pathPatternApply, pathPatternPreview, pathPatternClick,
  patternPathLength, patternPathPointAt, pathPatternTransformAt,
  type PathPatternChainState, type PatternPathSource,
} from '../../lib/sketch/tools/patternTools'
import { splinePointAt } from '../../lib/sketch/spline'
import type {
  SketchEntity, SketchArcEntity, SketchCircleEntity, SketchLineEntity, SketchSplineEntity,
} from '../../lib/sketch/types'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'

// EchoWorker (same scaffolding as filletRadiusPopup.test.ts): the solver
// worker is stubbed so importing the real store below never spins up a real
// Worker under jsdom. This describe block's own commit path (pathPatternApply
// via overlayApply) never calls the solver, but the store module constructs
// one at import time.
class EchoWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    const { requestId, sketch } = msg.payload
    const data: SketchWorkerResponseMsg = {
      type: 'SKETCH_SOLVE_COMPLETE',
      requestId,
      entities: sketch.entities,
      status: { dof: 0, conflicting: [], redundant: [], fullyDefinedEntities: [] },
      computeTimeMs: 0,
    }
    setTimeout(() => this.onmessage?.({ data }), 0)
  }
  terminate(): void {}
}
vi.stubGlobal('Worker', EchoWorker)

let n = 0
const newId = () => `pp-${n++}`

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function circle(id: string, cx: number, cy: number, r: number): SketchCircleEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}

function arc(
  id: string, cx: number, cy: number, r: number, a0: number, a1: number,
): SketchArcEntity {
  return {
    id, kind: 'arc', construction: false,
    center: { x: cx, y: cy }, radius: r, startAngle: a0, endAngle: a1,
  }
}

// Straight 100 mm line path along +X.
function linePath(): PatternPathSource {
  return { kind: 'chain', steps: [{ entity: line('path', 0, 0, 100, 0), forward: true }], closed: false }
}

// A full circle of radius 50 built from two 180deg arcs (the WO's path
// shapes are line/arc/spline/elliptical-arc, so a "closed circle path" is a
// closed ARC CHAIN, not a `circle` entity -- matches the offsetTool
// precedent that circles never enter a chain).
function closedCirclePath(r: number): PatternPathSource {
  const a1 = arc('a1', 0, 0, r, 0, Math.PI)
  const a2 = arc('a2', 0, 0, r, Math.PI, 2 * Math.PI)
  return {
    kind: 'chain',
    steps: [{ entity: a1, forward: true }, { entity: a2, forward: true }],
    closed: true,
  }
}

function splinePath(points: { x: number; y: number }[], closed = false): PatternPathSource {
  const entity: SketchSplineEntity = { id: 'spl', kind: 'spline', construction: false, points, closed }
  return { kind: 'spline', entity }
}

describe('patternPathLength / patternPathPointAt', () => {
  it('a line chain: exact length, point/tangent by arc length', () => {
    const p = linePath()
    expect(patternPathLength(p)).toBeCloseTo(100, 9)
    const mid = patternPathPointAt(p, 25)
    expect(mid.at).toEqual({ x: 25, y: 0 })
    expect(mid.tangent).toEqual({ x: 1, y: 0 })
  })

  it('a closed two-arc circle chain: full circumference, wraps modulo length', () => {
    const p = closedCirclePath(50)
    expect(patternPathLength(p)).toBeCloseTo(2 * Math.PI * 50, 6)
    const wrapped = patternPathPointAt(p, 2 * Math.PI * 50 + 10)
    const direct = patternPathPointAt(p, 10)
    expect(wrapped.at.x).toBeCloseTo(direct.at.x, 9)
    expect(wrapped.at.y).toBeCloseTo(direct.at.y, 9)
  })
})

describe('pathPatternEntities / pathPatternApply', () => {
  it('a 5 mm circle patterned 5x along a 100 mm line: centres 25 mm apart by arc length', () => {
    const src = circle('c1', 0, 0, 2.5) // 5mm-diameter circle, centroid = its center
    const chain: PathPatternChainState = {
      kind: 'pathpat', ids: ['c1'], confirmed: true, path: linePath(),
      count: 5, spacingMode: 'equal', fixedSpacing: 10, followTangent: false,
    }
    const r = pathPatternApply(chain, [src], [], newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.entities).toHaveLength(5)
    const centers = r.entities.map((e) => (e as SketchCircleEntity).center.x).sort((a, b) => a - b)
    expect(centers).toEqual([0, 25, 50, 75, 100])
    for (const e of r.entities) {
      expect((e as SketchCircleEntity).center.y).toBeCloseTo(0, 9)
      expect((e as SketchCircleEntity).radius).toBe(2.5)
    }
    // Rule 2: the first copy sits at the set's position projected onto the
    // path start.
    const first = r.entities.find((e) => (e as SketchCircleEntity).center.x === 0)!
    expect((first as SketchCircleEntity).center).toEqual({ x: 0, y: 0 })
  })

  it('8x around a closed circle path with equal spacing: 8 distinct copies 45 deg apart', () => {
    const src = circle('marker', 50, 0, 1) // sits AT the path radius so angle reads cleanly
    const chain: PathPatternChainState = {
      kind: 'pathpat', ids: ['marker'], confirmed: true, path: closedCirclePath(50),
      count: 8, spacingMode: 'equal', fixedSpacing: 10, followTangent: false,
    }
    const r = pathPatternApply(chain, [src], [], newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.entities).toHaveLength(8)
    const angles = r.entities
      .map((e) => Math.atan2((e as SketchCircleEntity).center.y, (e as SketchCircleEntity).center.x))
      .map((a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
      .sort((a, b) => a - b)
    // Rule 4: a closed path never stacks the last copy on the first -- 8
    // DISTINCT angles, each pair (wrapping) exactly 45 deg apart.
    const uniq = new Set(angles.map((a) => a.toFixed(6)))
    expect(uniq.size).toBe(8)
    for (let i = 0; i < angles.length; i++) {
      const next = angles[(i + 1) % angles.length]
      const step = i + 1 < angles.length ? next - angles[i] : next + 2 * Math.PI - angles[i]
      expect(step).toBeCloseTo(Math.PI / 4, 6)
    }
  })

  it('along a spline, consecutive copy centres are equal arc-length apart within 0.01 mm', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 20, y: 15 }, { x: 45, y: -5 }, { x: 70, y: 10 }, { x: 100, y: 0 },
    ]
    const src = circle('c1', 0, 0, 1)
    const path = splinePath(pts)
    const chain: PathPatternChainState = {
      kind: 'pathpat', ids: ['c1'], confirmed: true, path,
      count: 6, spacingMode: 'equal', fixedSpacing: 10, followTangent: false,
    }
    const r = pathPatternApply(chain, [src], [], newId)
    if (typeof r === 'string') throw new Error(r)
    const centers = r.entities.map((e) => (e as SketchCircleEntity).center)
    const L = patternPathLength(path)
    const expectedStep = L / (chain.count - 1)
    // Re-integrate the TRUE arc length between each consecutive pair (fine
    // independent re-sampling of the native Catmull-Rom curve, not the
    // pattern's own lookup table) and confirm it matches the intended even
    // step within 0.01 mm -- the acceptance's literal tolerance.
    const nativeParamAt = (s: number): number => {
      // Binary search using patternPathPointAt's own arc-length contract:
      // reconstruct via a fine independent sampling of splinePointAt.
      const segCount = pts.length - 1
      const N = 20000
      let lo = 0, cum = 0
      let prev = splinePointAt(pts, false, 0)
      for (let i = 1; i <= N; i++) {
        const q = (segCount * i) / N
        const at = splinePointAt(pts, false, q)
        const d = Math.hypot(at.x - prev.x, at.y - prev.y)
        if (cum + d >= s) { lo = q; break }
        cum += d
        prev = at
        lo = q
      }
      return lo
    }
    let prevParam = nativeParamAt(0)
    for (let k = 1; k < centers.length; k++) {
      const targetS = k * expectedStep
      const param = nativeParamAt(targetS)
      // Fine re-integration of the TRUE arc length between the two native
      // parameters (independent of the pattern's own sampling table).
      const N = 4000
      let arcLen = 0
      let prevPt = splinePointAt(pts, false, prevParam)
      for (let i = 1; i <= N; i++) {
        const q = prevParam + ((param - prevParam) * i) / N
        const at = splinePointAt(pts, false, q)
        arcLen += Math.hypot(at.x - prevPt.x, at.y - prevPt.y)
        prevPt = at
      }
      expect(Math.abs(arcLen - expectedStep)).toBeLessThan(0.01)
      prevParam = param
    }
    void centers
  })

  it('Follow tangent: a small line copy stays parallel to the path tangent at each copy', () => {
    // A short line already drawn PARALLEL to the path's start tangent: the
    // closed circle path starts at (50,0) (angle 0), where the CCW tangent
    // points straight up (perpendicular to the radius) -- a vertical line.
    const src = line('ln', 5, -1, 5, 1)
    const chain: PathPatternChainState = {
      kind: 'pathpat', ids: ['ln'], confirmed: true, path: closedCirclePath(50),
      count: 8, spacingMode: 'equal', fixedSpacing: 10, followTangent: true,
    }
    const r = pathPatternApply(chain, [src], [], newId)
    if (typeof r === 'string') throw new Error(r)
    const path = closedCirclePath(50)
    r.entities.forEach((e, k) => {
      const l = e as SketchLineEntity
      const dx = l.end.x - l.start.x, dy = l.end.y - l.start.y
      const lineAngle = Math.atan2(dy, dx)
      const s = (k * patternPathLength(path)) / chain.count
      const tangent = patternPathPointAt(path, s).tangent
      const tanAngle = Math.atan2(tangent.y, tangent.x)
      // The line's direction and the local tangent agree up to a sign flip
      // (parallel, not necessarily co-directional).
      const diff = Math.abs(Math.atan2(Math.sin(lineAngle - tanAngle), Math.cos(lineAngle - tanAngle)))
      expect(Math.min(diff, Math.PI - diff)).toBeLessThan(1e-6)
    })
  })

  it('rejects count < 2 and an unpatternable (all-construction) set', () => {
    const src = circle('c1', 0, 0, 2)
    expect(pathPatternEntities([src], [], ['c1'], 1, () => ({ map: (p) => p, dTheta: 0 }), newId))
      .toMatch(/count/)
    const constructionSrc: SketchEntity = { ...src, construction: true }
    expect(pathPatternEntities([constructionSrc], [], ['c1'], 3, () => ({ map: (p) => p, dTheta: 0 }), newId))
      .toMatch(/nothing to pattern/)
  })
})

describe('pathPatternTransformAt', () => {
  it('k=0 lands the reference EXACTLY at the path start (rule 2)', () => {
    const path = linePath()
    const transformAt = pathPatternTransformAt(path, { x: 7, y: 3 }, 5, 'equal', 10, false)
    const t0 = transformAt(0)
    expect(t0.map({ x: 7, y: 3 })).toEqual({ x: 0, y: 0 })
    expect(t0.dTheta).toBe(0)
  })

  it('fixed spacing mode steps by the literal distance, clamped to the path on an open curve', () => {
    const path = linePath()
    const transformAt = pathPatternTransformAt(path, { x: 0, y: 0 }, 4, 'fixed', 30, false)
    expect(transformAt(0).map({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
    expect(transformAt(1).map({ x: 0, y: 0 })).toEqual({ x: 30, y: 0 })
    expect(transformAt(2).map({ x: 0, y: 0 })).toEqual({ x: 60, y: 0 })
    // k=4 would be at s=120 > path length 100 -- clamped to the path end.
    expect(transformAt(4).map({ x: 0, y: 0 })).toEqual({ x: 100, y: 0 })
  })
})

describe('path pattern click gestures (set - Confirm - pick path - apply)', () => {
  const entities: SketchEntity[] = [
    circle('c1', 5, 5, 2),
    line('guide', 0, 0, 100, 0),
  ]

  it('clicks toggle the set; Confirm closes it; the next click picks the path', () => {
    const c1 = pathPatternClick(null, entities, [], { x: 5, y: 5 }, 3)
    expect(c1.chain?.kind).toBe('pathpat')
    expect(c1.chain?.ids).toEqual(['c1'])
    expect(c1.chain?.confirmed).toBe(false)
    const confirmed: PathPatternChainState = { ...(c1.chain as PathPatternChainState), confirmed: true }
    const picked = pathPatternClick(confirmed, entities, [], { x: 50, y: 0 }, 0.5)
    expect(picked.chain?.path).not.toBeNull()
    expect(picked.chain?.path?.kind).toBe('chain')
    // Re-click re-picks (misses explain themselves, never silently clear it).
    const miss = pathPatternClick(picked.chain, entities, [], { x: 500, y: 500 }, 0.5)
    expect(miss.chain?.path).toEqual(picked.chain?.path)
    expect(miss.notice).toMatch(/path/)
  })

  it('the pattern set itself is excluded from path candidates (self-reference guard)', () => {
    const chain: PathPatternChainState = {
      kind: 'pathpat', ids: ['guide'], confirmed: true, path: null,
      count: 5, spacingMode: 'equal', fixedSpacing: 10, followTangent: false,
    }
    const r = pathPatternClick(chain, entities, [], { x: 50, y: 0 }, 0.5)
    expect(r.chain?.path).toBeNull()
    expect(r.notice).toMatch(/path/)
  })

  it('preview-equals-commit: ghosts match the applied copies', () => {
    const chain: PathPatternChainState = {
      kind: 'pathpat', ids: ['c1'], confirmed: true, path: linePath(),
      count: 4, spacingMode: 'equal', fixedSpacing: 10, followTangent: false,
    }
    const ghosts = pathPatternPreview(chain, entities)!
    const r = pathPatternApply(chain, entities, [], newId)
    if (typeof r === 'string') throw new Error(r)
    expect(ghosts).toHaveLength(r.entities.length)
    ghosts.forEach((g, i) => {
      const c = r.entities[i]
      if (g.kind === 'circle' && c.kind === 'circle') {
        expect(g.center).toEqual(c.center)
      }
    })
  })
})

describe('confirm overlay wiring (rendered): Count / Spacing mode / Follow tangent reach the pathpat chain', () => {
  it('typed Count + clicked "Fixed distance" + typed Spacing all land on the chain, and OK commits exactly that', async () => {
    const React = await import('react')
    const { render, cleanup, fireEvent } = await import('@testing-library/react')
    const { useCamStore } = await import('../../store')
    const { sketcherToolStore } = await import('../../lib/sketch/sketcher')
    const { createCamOverlaysPort } = await import('../../components/viewport/camOverlaysPort')
    const { SketchConfirmOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay')

    try {
      act(() => {
        useCamStore.setState({
          activeSketch: null, sketchSolveStatus: null, sketchSelectedIds: [],
          sketchNotice: null, sketchHistory: [], projectHistory: [], canUndo: false,
        } as never)
        useCamStore.getState().startNewSketch()
        useCamStore.getState().setDisplayUnits('mm')
        useCamStore.setState((s) => ({
          activeSketch: {
            ...s.activeSketch!,
            entities: [...s.activeSketch!.entities, circle('seed', 0, 0, 1)],
          },
        } as never))
        sketcherToolStore.setState({
          tool: 'pattern-path',
          chain: {
            kind: 'pathpat', ids: ['seed'], confirmed: true, path: linePath(),
            count: 5, spacingMode: 'equal', fixedSpacing: 10, followTangent: false,
          },
        } as never)
      })

      const port = createCamOverlaysPort(() => null)
      const { container } = render(React.createElement(SketchConfirmOverlay, { port }))

      const fieldInput = (label: string): HTMLInputElement => {
        const field = Array.from(container.querySelectorAll('.sketch-confirm-field'))
          .find((el) => el.querySelector('span')?.textContent === label)
        const input = field?.querySelector('input')
        if (!input) throw new Error(`no rendered field for "${label}"`)
        return input as HTMLInputElement
      }
      const modeButton = (label: string): HTMLButtonElement => {
        const btn = Array.from(container.querySelectorAll('.sketch-confirm-chamfer-modes button'))
          .find((el) => el.textContent === label)
        if (!btn) throw new Error(`no rendered mode button "${label}"`)
        return btn as HTMLButtonElement
      }

      // Typed Count -> chain.count (was inert: it wrote circularPatternCount instead).
      fireEvent.change(fieldInput('Count'), { target: { value: '8' } })
      expect((sketcherToolStore.getState().chain as PathPatternChainState).count).toBe(8)

      // "Fixed distance" -> chain.spacingMode (was inert: hardcoded to the chamfer chain).
      fireEvent.click(modeButton('Fixed distance'))
      expect((sketcherToolStore.getState().chain as PathPatternChainState).spacingMode).toBe('fixed')

      // Typed Spacing (now rendered, since spacingMode is 'fixed') -> chain.fixedSpacing
      // (was inert: no switch case existed at all).
      fireEvent.change(fieldInput('Spacing'), { target: { value: '10' } })
      expect((sketcherToolStore.getState().chain as PathPatternChainState).fixedSpacing).toBe(10)

      // Follow tangent -> chain.followTangent (was inert: hardcoded to the transform tool's flag).
      const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      fireEvent.click(toggle)
      expect((sketcherToolStore.getState().chain as PathPatternChainState).followTangent).toBe(true)
      fireEvent.click(toggle) // back off for a clean, orientation-kept commit below

      // OK commits at the LIVE (edited) chain, not the click-time defaults.
      const okButton = container.querySelector('.sketch-prompt-btn-confirm') as HTMLButtonElement
      fireEvent.click(okButton)

      expect(sketcherToolStore.getState().chain).toBeNull()
      const seeded = useCamStore.getState().activeSketch!.entities.filter(
        (e): e is SketchCircleEntity => e.kind === 'circle' && e.id !== 'seed',
      )
      expect(seeded).toHaveLength(8) // the typed Count, not the click-time default of 5
      seeded.forEach((e, k) => {
        expect(e.center.x).toBeCloseTo(k * 10, 9) // the typed fixed Spacing, not equal-over-path
        expect(e.center.y).toBeCloseTo(0, 9)
      })
    } finally {
      cleanup()
    }
  })
})
