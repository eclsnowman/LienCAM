// @vitest-environment jsdom
//
// WO-2179 - THE JOG-ZONE LABELS IN THE PROBING PICTURES ARE SIMPLE DIMENSIONS
// THAT FIT.
//
// Operator, 2026-09-29 (Boss step 1 at 1440x900): "Remove the text here in the
// images." Then: "they are fine if they fit, but don't be verbose. If you need
// more than simple dimensions put the text below like I said."
//
// Route: the production Probing panel (ProbingPanel), step 1 of every routine,
// with Operator's T19 (3.1 mm) in the spindle, its picture box measured at the
// sizes it has on the 1920x1080 and 1440x900 screens (read from the WO-2179
// captures: 1228x696 and 748x441). From the rendered SVG:
//   1. every jog-zone label (the zone's width in the side and top views, its
//      height beside it) is a simple dimension: "10 mm", "Ø 10", "< 25 mm";
//   2. none of them overlaps another label, the probe, the zone box or the
//      part (side view: material; top view: its edges and the faces drawn on
//      it - the flat face is background there), and each stays inside its view;
//   3. every width main draws (side and top) is still drawn - moved, not dropped;
//   4. every routine's sentence still carries the guidance the words gave.
// Label boxes use the width these numbers render at in the bold face (0.57 em
// a character, measured: "< 100 mm" is 118 px at 26 px), the capitals above the baseline and a little below it.
//
// Negative control (recorded in the work order): on main's ProbeStepPicture /
// probeScene the Boss step 1 words ("within 5 mm", "of the centre", "less than
// 25 mm", "above the top") fail 1, and at 748x441 they sit on the probe (2).

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
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
  id: 'wo2179-t19', toolNumber: 19, name: 'Rennie 1/8" single flute', type: 'flat', diameter: 3.1,
  fluteLength: 10, shankDiameter: 6, overallLength: 50, numberOfFlutes: 1, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 0, feedRate: 400, plungeRate: 50, depthOfCut: 0, stepover: 0, coolant: 'none' } },
}
const PROGRAM = 'G21 G90\nG0 X0 Y0 Z5\nG1 Z-1 F200\nG1 X60 F600\nG1 Y40\nG1 X0\nG1 Y0\nG0 Z5\nM30\n'
const ROUTINES = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ', 'calibrate'] as const
/** The zone widths main draws, step 1, T19, at both sizes (WO-2179 before-words.json). */
const width = (label: string) => ({ side: [label], top: [label] })
const MAIN_DIMS: Record<string, { side: string[]; top: string[] }> = {
  workZero: { side: [], top: [] }, edge: width('10 mm'), outsideCorner: width('10 mm'), insideCorner: width('5 mm'), angle: width('10 mm'),
  bore: width('Ø 10'), boss: width('Ø 10'), rectPocket: width('10 mm'), rectBoss: width('10 mm'), zSurface: { side: [], top: [] },
  toolZ: { side: [], top: [] }, calibrate: width('Ø 10'),
}
/** The picture box on the 1920x1080 and the 1440x900 screen. */
const SIZES = [{ name: '1920x1080', w: 1228, h: 696 }, { name: '1440x900', w: 748, h: 441 }]

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

interface Area { x0: number; x1: number; y0: number; y1: number; what: string }
const num = (el: Element, a: string) => Number(el.getAttribute(a) ?? 0)
const overlap = (a: Area, b: Area) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5

/** A text element's letters. */
function textArea(t: Element, what: string): Area {
  const size = num(t, 'font-size') || 26
  const w = (t.textContent ?? '').length * size * 0.57
  const x = num(t, 'x')
  const anchor = t.getAttribute('text-anchor') ?? 'start'
  const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x
  const y = num(t, 'y')
  return { x0, x1: x0 + w, y0: y - size * 0.75, y1: y + size * 0.2, what: `${what} "${t.textContent}"` }
}
const rectArea = (r: Element, what: string): Area => ({ x0: num(r, 'x'), x1: num(r, 'x') + num(r, 'width'), y0: num(r, 'y'), y1: num(r, 'y') + num(r, 'height'), what })
const circleArea = (c: Element, what: string, pad = 0): Area => {
  const r = num(c, 'r') + pad
  return { x0: num(c, 'cx') - r, x1: num(c, 'cx') + r, y0: num(c, 'cy') - r, y1: num(c, 'cy') + r, what }
}
/** A box touches a circle's outline (stroke `half` either side). */
function onRing(a: Area, c: Element, half: number): boolean {
  const cx = num(c, 'cx'); const cy = num(c, 'cy'); const r = num(c, 'r')
  const near = Math.hypot(Math.max(a.x0 - cx, 0, cx - a.x1), Math.max(a.y0 - cy, 0, cy - a.y1))
  const far = Math.hypot(Math.max(Math.abs(a.x0 - cx), Math.abs(a.x1 - cx)), Math.max(Math.abs(a.y0 - cy), Math.abs(a.y1 - cy)))
  return near <= r + half && far >= r - half
}
/** A box touches a drawn outline: a circle's rim, a line, a rectangle's sides. */
function onOutline(a: Area, f: Element, half: number): boolean {
  if (f.tagName === 'circle') return onRing(a, f, half)
  const band = (x0: number, y0: number, x1: number, y1: number) => overlap(a, { x0: Math.min(x0, x1) - half, x1: Math.max(x0, x1) + half, y0: Math.min(y0, y1) - half, y1: Math.max(y0, y1) + half, what: '' })
  if (f.tagName === 'line') return band(num(f, 'x1'), num(f, 'y1'), num(f, 'x2'), num(f, 'y2'))
  const r = rectArea(f, '')
  return band(r.x0, r.y0, r.x1, r.y0) || band(r.x0, r.y1, r.x1, r.y1) || band(r.x0, r.y0, r.x0, r.y1) || band(r.x1, r.y0, r.x1, r.y1)
}
/** A simple dimension: a number and a unit, a diameter, or "less than". */
const DIMENSION = /^(< |Ø )?\d+(\.\d+)? ?(mm|in|")?$/

interface Found { labels: string[]; problems: string[]; side: string[]; top: string[] }

/** The jog-zone labels of the picture shown, and what each touches. */
function inspect(where: string): Found {
  const svg = screen.getByTestId('probe-picture')
  const problems: string[] = []
  const labels: string[] = []
  const sideView = svg.querySelector('[data-testid="probe-side-view"]')!
  const topView = svg.querySelector('[data-testid="probe-top-view"]')!
  const sideW = num(svg.querySelector('clipPath[id$="-side"] rect')!, 'width')
  const sideH = num(svg.querySelector('clipPath[id$="-side"] rect')!, 'height')
  const caption = svg.querySelector('[data-testid="probe-caption"] rect')

  // ---- the side view ----
  const sideLabels = [
    ...Array.from(sideView.querySelectorAll('[data-testid="probe-zone-dim"] text')).map((t) => ({ t, what: 'side zone width' })),
    ...Array.from(sideView.querySelectorAll('[data-testid="probe-zone-words"] text')).map((t) => ({ t, what: 'side zone words' })),
  ]
  const sideOthers: Area[] = []
  const zone = sideView.querySelector('[data-testid="probe-zone"]')
  if (zone) sideOthers.push(rectArea(zone, 'the zone'))
  if (caption) sideOthers.push(rectArea(caption, 'the caption'))
  for (const g of sideView.querySelectorAll('[data-testid="probe-side-probe"]')) {
    for (const r of g.querySelectorAll('rect')) sideOthers.push(rectArea(r, 'the probe'))
    for (const c of g.querySelectorAll('circle')) sideOthers.push(circleArea(c, 'the probe'))
  }
  for (const t of sideView.querySelectorAll('[data-testid="probe-part-dim"] text')) sideOthers.push(textArea(t, 'the part size'))
  // The part: material pieces less the open air of a hole in them.
  const solid = Array.from(sideView.querySelectorAll('rect.control-probe-diagram-stock, rect.pbn-setter')).map((r) => rectArea(r, 'the part'))
  const open = Array.from(sideView.querySelectorAll('rect.pbn-cut')).map((r) => rectArea(r, 'a hole'))
  // Height lines drawn across the side view.
  const heightLines = Array.from(sideView.querySelectorAll('line')).filter((l) => num(l, 'x1') === 0 && num(l, 'y1') === num(l, 'y2'))
    .map((l) => ({ x0: 0, x1: sideW, y0: num(l, 'y1') - 1.5, y1: num(l, 'y1') + 1.5, what: 'a height line' }))
  const sideAreas = sideLabels.map(({ t, what }) => textArea(t, what))
  for (const a of sideAreas) {
    labels.push(a.what)
    if (a.x0 < 0 || a.x1 > sideW || a.y1 > sideH) problems.push(`${where}: ${a.what} leaves the side view`)
    for (const o of [...sideOthers, ...heightLines, ...sideAreas.filter((b) => b !== a)]) if (overlap(a, o)) problems.push(`${where}: ${a.what} overlaps ${o.what}`)
    // On material: a sample point in a solid piece and in no hole.
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 4; j++) {
        const x = a.x0 + ((a.x1 - a.x0) * i) / 8
        const y = a.y0 + ((a.y1 - a.y0) * j) / 4
        const inside = (r: Area) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1
        if (solid.some(inside) && !open.some(inside)) { problems.push(`${where}: ${a.what} is on the part`); i = 9; break }
      }
    }
  }

  // ---- the top view ----
  const frame = topView.querySelector('rect')!
  const topFrame = rectArea(frame, 'the top view')
  const topLabels = Array.from(topView.querySelectorAll('[data-testid="probe-top-zone-dim"] text')).map((t) => textArea(t, 'top zone width'))
  const topOthers: Area[] = []
  const tzone = topView.querySelector('[data-testid="probe-top-zone"]')
  if (tzone) topOthers.push(tzone.tagName === 'circle' ? circleArea(tzone, 'the zone') : rectArea(tzone, 'the zone'))
  for (const c of topView.querySelectorAll('[data-testid="probe-top-probe"]')) topOthers.push(circleArea(c, 'the probe'))
  for (const t of topView.querySelectorAll('[data-testid="probe-top-part-dim"], [data-testid="probe-top-axes"] text')) topOthers.push(textArea(t, 'a top label'))
  for (const l of topView.querySelectorAll('[data-testid="probe-top-axes"] line, [data-testid="probe-top-axes"] polygon')) {
    const pts = l.tagName === 'line'
      ? [[num(l, 'x1'), num(l, 'y1')], [num(l, 'x2'), num(l, 'y2')]]
      : (l.getAttribute('points') ?? '').trim().split(/\s+/).map((p) => p.split(',').map(Number))
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1])
    topOthers.push({ x0: Math.min(...xs) - 3, x1: Math.max(...xs) + 3, y0: Math.min(...ys) - 3, y1: Math.max(...ys) + 3, what: 'the X/Y marker' })
  }
  // The part's edges: every stock and cut outline. Its flat face is background
  // a label may sit on (architect 09-29), as the feature size in the corner.
  const outlines = Array.from(topView.querySelectorAll('rect.control-probe-diagram-stock, circle.control-probe-diagram-stock, rect.pbn-cut, circle.pbn-cut'))
  for (const a of topLabels) {
    labels.push(a.what)
    if (a.x0 < topFrame.x0 || a.x1 > topFrame.x1 || a.y0 < topFrame.y0 || a.y1 > topFrame.y1) problems.push(`${where}: ${a.what} leaves the top view`)
    for (const o of topOthers) if (overlap(a, o)) problems.push(`${where}: ${a.what} overlaps ${o.what}`)
    for (const f of topView.querySelectorAll('[data-testid="probe-top-face"]')) {
      if (onOutline(a, f, 3)) problems.push(`${where}: ${a.what} overlaps a face of the part`)
    }
    for (const f of outlines) if (onOutline(a, f, 2)) problems.push(`${where}: ${a.what} is on an edge of the part`)
  }
  // Every label is a simple dimension.
  for (const t of [...sideLabels.map((s) => s.t), ...topView.querySelectorAll('[data-testid="probe-top-zone-dim"] text')]) {
    if (!DIMENSION.test((t.textContent ?? '').trim())) problems.push(`${where}: "${t.textContent}" is more than a simple dimension`)
  }
  const texts = (root: Element, id: string) => Array.from(root.querySelectorAll(`[data-testid="${id}"] text`)).map((t) => t.textContent ?? '')
  return { labels, problems, side: texts(sideView, 'probe-zone-dim'), top: texts(topView, 'probe-top-zone-dim') }
}

function stepOne(routine: string): void {
  fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
  const chip = screen.queryByTestId('probing-step-chip-1')
  if (chip) fireEvent.click(chip)
}
const sentence = () => screen.getByTestId('probing-step-sentence').textContent ?? ''

describe('WO-2179 the jog-zone labels are simple dimensions that fit', () => {
  for (const size of SIZES) {
    it(`step 1 of every routine at ${size.name} (picture ${size.w}x${size.h}, T19): dimensions only, touching nothing`, () => {
      box = size
      render(React.createElement(ProbingPanel))
      const problems: string[] = []
      const seen: Record<string, string[]> = {}
      const dims: Record<string, { side: string[]; top: string[] }> = {}
      for (const routine of ROUTINES) {
        stepOne(routine)
        const picture = screen.getByTestId('probe-picture')
        expect(Number(picture.getAttribute('width')), 'the picture is drawn at the measured size').toBe(size.w)
        const found = inspect(`${routine} ${size.name}`)
        problems.push(...found.problems)
        seen[routine] = found.labels
        dims[routine] = { side: found.side, top: found.top }
      }
      expect(problems).toEqual([])
      // Fitting is never bought by dropping one: every width main draws in
      // either view is still drawn, and no other (architect 09-29, from the
      // before captures, before-words.json). Every top-search routine keeps
      // its height; where one fits nowhere (Z surface) the sentence says it.
      expect(dims).toEqual(MAIN_DIMS)
      const has = (routine: string, prefix: string) => expect(seen[routine].some((l) => l.startsWith(prefix)), `${routine} ${size.name}: ${seen[routine].join(', ')}`).toBe(true)
      for (const routine of ['edge', 'outsideCorner', 'angle', 'boss', 'rectBoss', 'calibrate']) has(routine, 'side zone words "< 25 mm"')
      expect(seen.toolZ).toEqual([])
    })
  }

  it('Boss step 1: the width is "Ø 10" in both views and the height "< 25 mm"; no words', () => {
    box = SIZES[1]
    render(React.createElement(ProbingPanel))
    stepOne('boss')
    const picture = screen.getByTestId('probe-picture')
    expect(picture.querySelector('[data-testid="probe-zone-dim"] text')?.textContent).toBe('Ø 10')
    expect(picture.querySelector('[data-testid="probe-zone-words"]')?.textContent).toBe('< 25 mm')
    expect(picture.querySelector('[data-testid="probe-top-zone-dim"] text')?.textContent).toBe('Ø 10')
    for (const words of ['within', 'of the centre', 'less than', 'above the top', 'any height']) {
      expect(picture.textContent, words).not.toContain(words)
    }
  })

  it('every routine\'s sentence still says what the words in the picture said', () => {
    render(React.createElement(ProbingPanel))
    const said: Record<string, string> = {}
    for (const routine of ROUTINES) { stepOne(routine); said[routine] = sentence() }
    expect(said.workZero).toMatch(/over the stock, less than \d+ mm above it/)
    expect(said.edge).toMatch(/within 10 mm of the \w+ face, less than 25 mm above the top/)
    expect(said.outsideCorner).toMatch(/within 10 mm of both faces, less than 25 mm above the top/)
    expect(said.insideCorner).toMatch(/within 5 mm of both walls, above the top/)
    expect(said.angle).toMatch(/within 10 mm of the \w+ face, at point 1, less than 25 mm above the top/)
    expect(said.bore).toContain('over the middle of the bore (by eye is fine), above the top')
    expect(said.rectPocket).toContain('over the middle of the pocket (by eye is fine), above the top')
    expect(said.boss).toContain('over the middle of the boss (by eye is fine), less than 25 mm above the top')
    expect(said.rectBoss).toContain('over the middle of the boss (by eye is fine), less than 25 mm above the top')
    expect(said.calibrate).toContain('over the middle of the reference (by eye is fine), less than 25 mm above the top')
    expect(said.zSurface).toMatch(/a safe start height, clear of the clamps and less than \d+ mm above the top/)
  })
})
