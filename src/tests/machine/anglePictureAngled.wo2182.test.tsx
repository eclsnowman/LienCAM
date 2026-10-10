// @vitest-environment jsdom
//
// WO-2182 - THE ANGLE PICTURE SHOWS THE ANGLED FACE.
//
// Operator, 2026-09-29 12:47 AM CT: "the angle measure in probing doesn't show an
// angled line. You should show it angled or it is unclear what we are actually
// doing (angle we are measuring)." His UCCNC reference
// (docs/ui-ux/reference/uccnc-probe-screen-angle.png) draws the face tilted,
// the square axis dashed, the angle marked and the two touches on the face.
//
// Route: the production Probing panel (ProbingPanel), Angle, every step, with
// Operator's T19 (3.1 mm) in the spindle, its picture box at the sizes it has on
// the 1920x1080 and 1440x900 screens (WO-2179's: 1228x696 and 748x441).
// From the rendered SVG:
//   1. the part's measured face is drawn at an angle (a clearly visible tilt,
//      not to scale) in the top view, and point 2's touch is on it;
//   2. the top view marks the square axis (dashed), the line through the two
//      touch points, both points, and the angle between them ("angle" before
//      a run); every Angle label is short and touches nothing;
//   3. after a run, the result step draws the measured angle and its value
//      ("-0.73 deg") - ProbeStepPicture in its 'after' mode;
//   4. every other routine, every step, at both sizes, renders byte-identical
//      to main (hashes recorded from main's probeScene.ts / ProbeStepPicture.tsx
//      in src/tests/evidence/WO-2592/baselines/WO-2182-others-svg.main.json; WRITE_EVIDENCE=1
//      re-records them - only ever on main's code).
//
// Negative control (recorded in the work order): on main's probeScene.ts /
// ProbeStepPicture.tsx, 1-3 fail (the part is a square rect; no angle marks);
// 4 passes.

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const machineSession = await import('../../lib/machine/machineSession')
const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { ProbeStepPicture } = await import('../../components/machine/probing/ProbeStepPicture')
const { buildProbeScene, withMeasuredAngle, ANGLE_DRAWN_DEG } = await import('../../components/machine/probing/probeScene')
const { resolveProbeConfig } = await import('../../lib/machine/toolTable')
const { calculateYawAngle } = await import('../../lib/machine/probeRoutines')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const T19 = {
  id: 'wo2182-t19', toolNumber: 19, name: 'Rennie 1/8" single flute', type: 'flat', diameter: 3.1,
  fluteLength: 10, shankDiameter: 6, overallLength: 50, numberOfFlutes: 1, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 0, feedRate: 400, plungeRate: 50, depthOfCut: 0, stepover: 0, coolant: 'none' } },
}
const PROGRAM = 'G21 G90\nG0 X0 Y0 Z5\nG1 Z-1 F200\nG1 X60 F600\nG1 Y40\nG1 X0\nG1 Y0\nG0 Z5\nM30\n'
const OTHERS = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ', 'calibrate'] as const
/** The picture box on the 1920x1080 and the 1440x900 screen (WO-2179). */
const SIZES = [{ name: '1920x1080', w: 1228, h: 696 }, { name: '1440x900', w: 748, h: 441 }]
// WO-2592: only the eight Bore/Rect pocket wall pictures at each size changed (approved WO-2554).
// The other 156 SVG fingerprints remain identical to the historical baseline.
const BASELINE = join(process.cwd(), 'src/tests/evidence/WO-2592/baselines/WO-2182-others-svg.main.json')

let box = SIZES[0]
beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  useCamStore.getState().newProject()
  useCamStore.setState({ toolLibrary: [...useCamStore.getState().toolLibrary.filter((t) => t.toolNumber !== 19), T19 as never] })
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: 19,
    tlo: null,
    programText: PROGRAM,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  // jsdom has no layout: the picture box reports the screen's measured size.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const r = this.getAttribute('data-testid') === 'probing-picture-box' ? { w: box.w, h: box.h } : { w: 0, h: 0 }
    return { x: 0, y: 0, left: 0, top: 0, right: r.w, bottom: r.h, width: r.w, height: r.h, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const svgHash = () => createHash('sha256').update(screen.getByTestId('probe-picture').outerHTML).digest('hex')
const chipCount = () => document.querySelectorAll('[data-testid^="probing-step-chip-"]').length

// ---- reading the drawn top view ---------------------------------------------
interface Pt { x: number; y: number }
interface Box { x0: number; x1: number; y0: number; y1: number; what: string }
const num = (el: Element, a: string) => Number(el.getAttribute(a) ?? NaN)
const overlap = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5
/** A text element's letters (WO-2179's measure: 0.57 em a character). */
function textBox(t: Element, what: string): Box {
  const size = num(t, 'font-size') || 19
  const w = (t.textContent ?? '').length * size * 0.57
  const x = num(t, 'x')
  const anchor = t.getAttribute('text-anchor') ?? 'start'
  const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x
  const y = num(t, 'y')
  return { x0, x1: x0 + w, y0: y - size * 0.75, y1: y + size * 0.2, what: `${what} "${t.textContent}"` }
}
const circleBox = (c: Element, what: string): Box => {
  const r = num(c, 'r')
  return { x0: num(c, 'cx') - r, x1: num(c, 'cx') + r, y0: num(c, 'cy') - r, y1: num(c, 'cy') + r, what }
}
/** Whether a segment (a stroke `half` px either side) crosses a box. */
function segHits(b: Box, p: Pt, q: Pt, half: number): boolean {
  const [bx0, bx1, by0, by1] = [b.x0 - half, b.x1 + half, b.y0 - half, b.y1 + half]
  let t0 = 0
  let t1 = 1
  const dx = q.x - p.x
  const dy = q.y - p.y
  for (const [pp, qq] of [[-dx, p.x - bx0], [dx, bx1 - p.x], [-dy, p.y - by0], [dy, by1 - p.y]]) {
    if (Math.abs(pp) < 1e-12) { if (qq < 0) return false; continue }
    const t = qq / pp
    if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}
/** Distance from a point to the (infinite) line through a and b. */
const lineDist = (p: Pt, a: Pt, b: Pt) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y)
const ends = (l: Element): [Pt, Pt] => [{ x: num(l, 'x1'), y: num(l, 'y1') }, { x: num(l, 'x2'), y: num(l, 'y2') }]
const polyPts = (el: Element): Pt[] => (el.getAttribute('points') ?? '').trim().split(/\s+/).map((s) => { const [x, y] = s.split(',').map(Number); return { x, y } })

interface AngleFound { label: string | null; tiltDeg: number; problems: string[] }

/** Angle's top view: the face, its points, the marks and the label - and what
 *  the label (and the zone's width) touch. */
function inspectAngle(svg: Element, where: string): AngleFound {
  const top = svg.querySelector('[data-testid="probe-top-view"]')!
  const problems: string[] = []
  const part = top.querySelector('[data-testid="probe-top-part"]')
  if (!part) return { label: null, tiltDeg: 0, problems: [`${where}: the part is not drawn with an angled face (no outline)`] }
  const pts = polyPts(part)
  const [f0, f1] = [pts[0], pts[1]]
  const tiltDeg = Math.abs((Math.atan2(f1.y - f0.y, f1.x - f0.x) * 180) / Math.PI) % 90
  const tilt = Math.min(tiltDeg, 90 - tiltDeg)
  const points = Array.from(top.querySelectorAll('[data-testid="probe-top-angle-point"]')).map((c) => ({ x: num(c, 'cx'), y: num(c, 'cy') }))
  if (points.length !== 2) problems.push(`${where}: ${points.length} touch points marked, not 2`)
  for (const [i, p] of points.entries()) if (lineDist(p, f0, f1) > 1.5) problems.push(`${where}: point ${i + 1} is ${lineDist(p, f0, f1).toFixed(1)} px off the face`)
  const faceLine = top.querySelector('[data-testid="probe-top-angle"] [data-testid="probe-top-face"]')
  const square = top.querySelector('[data-testid="probe-top-angle-square"]')
  const arc = top.querySelector('[data-testid="probe-top-angle-arc"]')
  if (!faceLine || !square || !arc) problems.push(`${where}: the line through the points, the square axis or the arc is missing`)
  const lines: Array<{ seg: [Pt, Pt]; half: number; what: string }> = []
  if (faceLine && points.length === 2) {
    const seg = ends(faceLine)
    for (const [i, p] of points.entries()) if (lineDist(p, seg[0], seg[1]) > 1.5) problems.push(`${where}: the line misses point ${i + 1}`)
    lines.push({ seg, half: 3, what: 'the line through the points' })
  }
  if (square && points.length === 2) {
    const seg = ends(square)
    const axisAligned = Math.abs(seg[0].x - seg[1].x) < 0.01 || Math.abs(seg[0].y - seg[1].y) < 0.01
    if (!axisAligned) problems.push(`${where}: the square axis is not square`)
    if (lineDist(points[0], seg[0], seg[1]) > 1.5) problems.push(`${where}: the square axis does not start at point 1`)
    lines.push({ seg, half: 2, what: 'the square axis' })
  }
  if (arc && points.length === 2) {
    // "M x y A r r 0 0 s x y", centred on point 1: sampled along its short way.
    const n = (arc.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number)
    const [ax, ay, r, , , , , bx, by] = n
    const c = points[0]
    const a0 = Math.atan2(ay - c.y, ax - c.x)
    let da = Math.atan2(by - c.y, bx - c.x) - a0
    if (da > Math.PI) da -= 2 * Math.PI
    if (da < -Math.PI) da += 2 * Math.PI
    if (Math.abs(Math.hypot(ax - c.x, ay - c.y) - r) > 1) problems.push(`${where}: the arc is not centred on point 1`)
    for (let i = 0; i < 12; i++) {
      const p = { x: c.x + r * Math.cos(a0 + (da * i) / 12), y: c.y + r * Math.sin(a0 + (da * i) / 12) }
      const q = { x: c.x + r * Math.cos(a0 + (da * (i + 1)) / 12), y: c.y + r * Math.sin(a0 + (da * (i + 1)) / 12) }
      lines.push({ seg: [p, q], half: 1.5, what: 'the arc' })
    }
  }
  for (let i = 0; i < pts.length; i++) lines.push({ seg: [pts[i], pts[(i + 1) % pts.length]], half: 1.5, what: 'an edge of the part' })
  for (const l of top.querySelectorAll('[data-testid="probe-move-top"] line, [data-testid="probe-top-zone-dim"] line')) lines.push({ seg: ends(l), half: 3, what: 'a drawn line' })
  const boxes: Box[] = []
  for (const c of top.querySelectorAll('[data-testid="probe-top-probe"], [data-testid="probe-top-preview"], [data-testid="probe-top-ghost"], [data-testid="probe-top-ring"], [data-testid="probe-found-top"], [data-testid="probe-top-angle-point"]')) boxes.push(circleBox(c, `a ${c.getAttribute('data-testid')}`))
  const zone = top.querySelector('[data-testid="probe-top-zone"]')
  if (zone) boxes.push({ x0: num(zone, 'x'), x1: num(zone, 'x') + num(zone, 'width'), y0: num(zone, 'y'), y1: num(zone, 'y') + num(zone, 'height'), what: 'the zone' })
  for (const el of top.querySelectorAll('[data-testid="probe-top-axes"] line, [data-testid="probe-top-axes"] polygon')) {
    const ps = el.tagName === 'line' ? ends(el) : polyPts(el)
    boxes.push({ x0: Math.min(...ps.map((p) => p.x)) - 3, x1: Math.max(...ps.map((p) => p.x)) + 3, y0: Math.min(...ps.map((p) => p.y)) - 3, y1: Math.max(...ps.map((p) => p.y)) + 3, what: 'the X/Y marker' })
  }
  for (const polygon of top.querySelectorAll('[data-testid="probe-move-top"] polygon')) {
    const ps = polyPts(polygon)
    boxes.push({ x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x)), y0: Math.min(...ps.map((p) => p.y)), y1: Math.max(...ps.map((p) => p.y)), what: 'an arrow head' })
  }
  const frame = top.querySelector('rect')!
  const labels = [
    ...Array.from(top.querySelectorAll('[data-testid="probe-top-angle-label"]')).map((t) => textBox(t, 'the angle label')),
    ...Array.from(top.querySelectorAll('[data-testid="probe-top-zone-dim"] text, [data-testid="probe-top-axes"] text')).map((t) => textBox(t, 'a top label')),
  ]
  const angleLabel = top.querySelector('[data-testid="probe-top-angle-label"]')
  // The angle label touches nothing drawn; the other labels (the zone's width,
  // the X/Y letters - WO-2179 holds them to the rest) touch none of the angle
  // marks.
  for (const a of labels) {
    const mine = a.what.startsWith('the angle label')
    if (a.x0 < num(frame, 'x') || a.x1 > num(frame, 'x') + num(frame, 'width') || a.y0 < 0 || a.y1 > num(frame, 'height')) problems.push(`${where}: ${a.what} leaves the top view`)
    for (const b of [...boxes, ...labels.filter((o) => o !== a)]) {
      if ((mine || b.what.startsWith('the angle label') || b.what.includes('angle-point')) && overlap(a, b)) problems.push(`${where}: ${a.what} overlaps ${b.what}`)
    }
    for (const l of lines) {
      const angleMark = /through the points|square axis|the arc/.test(l.what)
      if ((mine || angleMark) && segHits(a, l.seg[0], l.seg[1], l.half)) problems.push(`${where}: ${a.what} touches ${l.what}`)
    }
  }
  return { label: angleLabel?.textContent ?? null, tiltDeg: tilt, problems }
}

/** A plain angle setup, as the production screen builds it (T19's 1.55 mm). */
const SETUP = {
  routine: 'angle' as const,
  config: resolveProbeConfig(null, null),
  tipRadiusMm: 1.55,
  plateMm: 0,
  startDistanceMm: 10,
  depthMm: 5,
  edgeAxis: 'X' as const,
  edgeDirection: '+' as const,
  cornerXDirection: '+' as const,
  cornerYDirection: '+' as const,
  angleNominalAxis: 'X' as 'X' | 'Y',
  angleProbeDirection: '+' as '+' | '-',
  angleAlongDirection: '+' as '+' | '-',
  angleSpacingMm: 25,
  sizeXmm: 25,
  sizeYmm: 25,
  wcs: 'G54',
}

describe('WO-2182 the Angle picture shows the angled face', () => {
  for (const size of SIZES) {
    it(`through the Probing screen at ${size.name}: every Angle step draws the face angled, both points on it, the angle marked; nothing overlaps`, () => {
      box = size
      render(React.createElement(ProbingPanel))
      fireEvent.click(screen.getByTestId('control-work-probe-routine-angle'))
      const n = chipCount()
      expect(n).toBe(5)
      const problems: string[] = []
      for (let i = 1; i <= n; i++) {
        fireEvent.click(screen.getByTestId(`probing-step-chip-${i}`))
        const found = inspectAngle(screen.getByTestId('probe-picture'), `step ${i} ${size.name}`)
        problems.push(...found.problems)
        // A clearly visible tilt (not to scale), and the angle named before a run.
        expect(found.tiltDeg, `step ${i}: the face's drawn tilt (deg)`).toBeGreaterThan(5)
        expect(found.tiltDeg, `step ${i}: the face's drawn tilt (deg)`).toBeCloseTo(10, 1)
        expect(found.label, `step ${i}: the angle is marked`).toBe('angle')
      }
      expect(problems).toEqual([])
      expect(ANGLE_DRAWN_DEG).toBe(10)
    })
  }

  it('every face and either way along it: every step at both sizes, the face angled, both points on it, the label touching nothing', () => {
    const problems: string[] = []
    let drawn = 0
    for (const angleNominalAxis of ['X', 'Y'] as const) {
      for (const angleProbeDirection of ['+', '-'] as const) {
        for (const angleAlongDirection of ['+', '-'] as const) {
          const scene = buildProbeScene({ ...SETUP, angleNominalAxis, angleProbeDirection, angleAlongDirection })
          expect(scene.refusal, `${angleNominalAxis}${angleProbeDirection} along ${angleAlongDirection}`).toBeNull()
          // Point 2 is on the face where the face is - farther from the probe
          // than point 1 (it recedes from the probe on point 2's side).
          const [p1, p2] = scene.angle!.points
          const probeKey = angleNominalAxis === 'X' ? 'y' : 'x'
          const alongKey = angleNominalAxis === 'X' ? 'x' : 'y'
          const s = angleProbeDirection === '+' ? 1 : -1
          expect(Math.sign(p2[alongKey] - p1[alongKey])).toBe(angleAlongDirection === '+' ? 1 : -1)
          expect(s * (p2[probeKey] - p1[probeKey])).toBeCloseTo(Math.abs(p2[alongKey] - p1[alongKey]) * Math.tan((ANGLE_DRAWN_DEG * Math.PI) / 180), 3)
          for (const size of SIZES) {
            for (const step of scene.steps) {
              const where = `${angleNominalAxis}${angleProbeDirection} along ${angleAlongDirection}, step ${step.n} ${size.name}`
              render(React.createElement(ProbeStepPicture, { scene, step, width: size.w, height: size.h, progress: null, touched: false, mode: 'preview' }))
              const found = inspectAngle(screen.getByTestId('probe-picture'), where)
              problems.push(...found.problems)
              if (found.label === 'angle') drawn++
              else problems.push(`${where}: the angle label is not drawn`)
              cleanup()
            }
          }
        }
      }
    }
    expect(problems).toEqual([])
    expect(drawn).toBe(8 * 2 * 5)
  })

  it('after a run the result step draws the measured angle and its value; before one, the word', () => {
    const scene = buildProbeScene(SETUP)
    const last = scene.steps.at(-1)!
    expect(last.confirm, 'Angle\'s last step is its result step').toBe(true)
    for (const size of SIZES) {
      for (const [deg, text] of [[-0.7342, '-0.73 deg'], [1.146, '1.15 deg'], [0.0001, '0.00 deg']] as const) {
        render(React.createElement(ProbeStepPicture, {
          scene: withMeasuredAngle(scene, deg), step: last, width: size.w, height: size.h, progress: null, touched: true, mode: 'after', real: last.end,
        }))
        const found = inspectAngle(screen.getByTestId('probe-picture'), `after ${deg} ${size.name}`)
        expect(found.problems).toEqual([])
        expect(found.label).toBe(text)
        // Both touches lit, on the angled face (point 2 is drawn twice: found,
        // and this step's own touch - as on main).
        const lit = new Set(screen.getAllByTestId('probe-found-top').map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`))
        expect(lit.size).toBe(2)
        const marks = new Set(screen.getAllByTestId('probe-top-angle-point').map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`))
        expect(lit).toEqual(marks)
        cleanup()
      }
    }
    // No measured angle (a stopped run): the word, not a number.
    render(React.createElement(ProbeStepPicture, { scene: withMeasuredAngle(scene, null), step: last, width: 1228, height: 696, progress: null, touched: true, mode: 'after', real: last.end }))
    expect(screen.getByTestId('probe-top-angle-label').textContent).toBe('angle')
  })

  it('through Start probing: the run\'s measured angle is the one the result step draws', async () => {
    useMachineControl.setState({
      connectionKind: 'serial', homed: true, mpos: { x: -50, y: -50, z: -10 },
      settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    })
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-angle'))
    const last = chipCount()
    fireEvent.click(screen.getByTestId(`probing-step-chip-${last}`))
    expect(screen.getByTestId('probe-top-angle-label').textContent).toBe('angle')
    type Plan = Parameters<typeof machineSession.runFeatureProbeCycle>[0]
    let ran: Plan | null = null
    const touches = { angleFirst: -40, angleSecond: -39.5 }
    vi.mocked(machineSession.runFeatureProbeCycle).mockImplementationOnce(async (plan, _config, _clear, onTouch) => {
      ran = plan
      for (const [k, mm] of Object.entries(touches)) onTouch?.(k as never, mm)
      useMachineControl.setState({ mpos: { x: -25, y: -60, z: -5 } })
      return { ok: true, message: 'angle cycle recorded 2 touches.', touches, topMachineZ: null }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-probe-run-guided'))
      await Promise.resolve()
    })
    expect(ran).not.toBeNull()
    // The angle, worked out independently from the ran plan's two points.
    const along = (key: string) => {
      const step = ran!.steps.find((s) => s.kind === 'touch' && s.key === key)
      if (!step || step.kind !== 'touch') throw new Error(`no ${key} touch`)
      return step.expectedStart.x
    }
    const deg = calculateYawAngle({
      nominalAxis: 'X', direction: '+', tipRadiusMm: 1.55,
      first: { alongMm: along('angleFirst'), triggerPositionMm: -40 },
      second: { alongMm: along('angleSecond'), triggerPositionMm: -39.5 },
    }).thetaDeg
    expect(deg).toBeCloseTo((Math.atan2(0.5, 25) * 180) / Math.PI, 6)
    expect(screen.getByTestId('control-work-probe-result').textContent).toContain(`Measured ${deg.toFixed(3)} deg`)
    expect(screen.getByTestId('probing-step-sentence').textContent).toMatch(/Shows the angle of the line through the two points\.$/)
    expect(screen.getByTestId('probe-top-angle-label').textContent).toBe(`${deg.toFixed(2)} deg`)
    const found = inspectAngle(screen.getByTestId('probe-picture'), 'after the run')
    expect(found.problems).toEqual([])
  })

  it('writes nothing: no Confirm, no rotation - the picture only', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-angle'))
    for (let i = 1; i <= chipCount(); i++) {
      fireEvent.click(screen.getByTestId(`probing-step-chip-${i}`))
      expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    }
    expect(vi.mocked(machineSession.setWorkOffsetValue)).not.toHaveBeenCalled()
  })

  it('every other routine, every step, at both sizes, renders byte-identical to main', () => {
    const hashes: Record<string, string> = {}
    for (const size of SIZES) {
      box = size
      render(React.createElement(ProbingPanel))
      for (const routine of OTHERS) {
        fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
        const n = chipCount()
        for (let i = 1; i <= n; i++) {
          fireEvent.click(screen.getByTestId(`probing-step-chip-${i}`))
          hashes[`${routine} step ${i} ${size.name}`] = svgHash()
        }
        if (n === 0) hashes[`${routine} (no steps) ${size.name}`] = svgHash()
      }
      cleanup()
    }
    // Recorded from main's code, deliberately (WRITE_EVIDENCE=1), never by default.
    if (process.env.WRITE_EVIDENCE === '1') writeFileSync(BASELINE, `${JSON.stringify(hashes, null, 2)}\n`)
    expect(existsSync(BASELINE), 'the main baseline exists').toBe(true)
    const main = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, string>
    expect(Object.keys(hashes).length).toBeGreaterThan(60)
    expect(hashes).toEqual(main)
  })
})
