// @vitest-environment jsdom
//
// WO-2063 - the Probing screen v2 (docs/design/PROBING-SCREEN-V2.md).
//
// ONE SOURCE OF TRUTH (the brief's "Done means"): the routine's setup fields
// are the only numbers the pictures use, and the pictures are drawn from the
// routine's plan. Proven two ways:
//   1. through the production screen (ProbingPanel): change a setup field and
//      the numbers drawn in the picture change to match;
//   2. at the model: the steps the screen draws are the planner's own moves
//      (planFeatureProbeCycle - the call Start probing runs), for every routine.

import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
const { buildProbeScene, moveLabel, moveLength } = await import('../../components/machine/probing/probeScene')
type SceneSetup = import('../../components/machine/probing/probeScene').SceneSetup
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } = await import('../../lib/machine/toolTable')
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

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

const labels = () => screen.getAllByTestId('probe-move-label').map((el) => el.textContent)
const commit = (testId: string, text: string) => {
  const input = screen.getByTestId(testId) as HTMLInputElement
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

describe('WO-2063 one source of truth, through the Probing screen', () => {
  it('Edge step 5: changing "Start within" redraws the step-out distance in the picture and the sentence', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.click(screen.getByTestId('probing-step-chip-5'))
    // start within 10 + tip radius 1.5 (the default) + clearance 5 = 16.5
    expect(labels()).toContain('X- 16.5 mm')
    expect(screen.getByTestId('probing-step-sentence').textContent).toContain('X- 16.5 mm')
    commit('control-work-probe-start-within', '20')
    expect(labels()).toContain('X- 26.5 mm')
    expect(screen.getByTestId('probing-step-sentence').textContent).toContain('X- 26.5 mm')
  })

  it('Edge step 1: the zone dimension is the "Start within" field, in both views', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    const picture = () => screen.getByTestId('probe-picture')
    expect(within(picture()).getByTestId('probe-zone-dim').textContent).toContain('10 mm')
    expect(within(picture()).getByTestId('probe-top-zone-dim').textContent).toContain('10 mm')
    commit('control-work-probe-start-within', '15')
    expect(within(picture()).getByTestId('probe-zone-dim').textContent).toContain('15 mm')
    expect(within(picture()).getByTestId('probe-top-zone-dim').textContent).toContain('15 mm')
    expect(screen.getByTestId('probing-step-sentence').textContent).toContain('within 15 mm of the left face')
  })

  it('Edge: changing Face redraws both views along the new axis and face', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.click(screen.getByTestId('probing-step-chip-7'))
    expect(screen.getByTestId('probe-picture').getAttribute('data-view')).toBe('X')
    expect(labels()).toContain('X+ 10 mm')
    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'Y-' } })
    fireEvent.click(screen.getByTestId('probing-step-chip-7'))
    expect(screen.getByTestId('probe-picture').getAttribute('data-view')).toBe('Y')
    expect(labels()).toContain('Y- 10 mm')
    expect(screen.getByTestId('probing-step-sentence').textContent).toBe('Probes Y- toward the face until it touches, then again slowly.')
    fireEvent.click(screen.getByTestId('probing-step-chip-1'))
    expect(screen.getByTestId('probing-step-sentence').textContent).toContain('back face')
  })

  it('Edge: changing "Probing depth" moves the depth line and the descent', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.click(screen.getByTestId('probing-step-chip-6'))
    const heights = () => screen.getAllByTestId('probe-height-label').map((el) => el.textContent)
    expect(heights()).toContain('depth -5 · probe tip')
    expect(labels()).toContain('Z- 10 mm')
    commit('control-work-probe-depth', '8')
    expect(heights()).toContain('depth -8 · probe tip')
    expect(labels()).toContain('Z- 13 mm')
    expect(screen.getByTestId('probing-step-sentence').textContent).toContain('top - 8')
  })

  it('Bore: changing nominal diameter redraws the wall seek, with no plain approach', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    // WO-2057: the descent from over the hole to probing depth below the top
    // (work Z0) is step 3, as in the Bore video; the left wall is step 4.
    fireEvent.click(screen.getByTestId('probing-step-chip-3'))
    expect(screen.getByTestId('probing-step-sentence').textContent).toBe('Descends to probing depth (top - 5). Stops if it touches anything.')
    fireEvent.click(screen.getByTestId('probing-step-chip-4'))
    expect(screen.getByTestId('probing-step-sentence').textContent)
      .toBe('Left wall: probes X- until it touches (fast, then slow), backs off, returns toward the start.')
    // The picture estimates contact at nominal radius - tip radius; the
    // production plan's seek limit is Maximum search, independent of size.
    expect(labels()).toEqual(['X- 11 mm'])
    expect(screen.getAllByTestId('probe-move-side').every((el) => el.getAttribute('data-move-kind') === 'probe')).toBe(true)
    commit('control-work-probe-nominal-diameter', '40')
    expect(labels()).toEqual(['X- 18.5 mm'])
  })

  it('Tip radius is one of the numbers: it moves the step-out', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.click(screen.getByTestId('probing-step-chip-5'))
    commit('control-work-probe-tip-radius', '1.5875')
    expect(labels()).toContain('X- 16.6 mm')
  })

  // WO-2063 audit: these five routines descend to probing depth too, so the
  // field must be on their setup and must move the depth they draw.
  const depthsDrawn = () => {
    const found = new Set<string>()
    for (const chip of screen.getAllByTestId(/^probing-step-chip-\d+$/)) {
      fireEvent.click(chip)
      for (const el of screen.queryAllByTestId('probe-height-label')) {
        const match = /depth -[\d.]+/.exec(el.textContent ?? '')
        if (match) found.add(match[0])
      }
    }
    return [...found]
  }
  for (const [routine, label] of [
    ['insideCorner', 'Inside corner'],
    ['bore', 'Bore'],
    ['rectPocket', 'Rect pocket'],
    ['boss', 'Boss'],
    ['rectBoss', 'Rect boss'],
  ] as const) {
    it(`${label}: the setup has "Probing depth", and changing it moves the depth drawn`, () => {
      render(React.createElement(ProbingPanel))
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
      const field = screen.getByTestId('control-work-probe-depth') as HTMLInputElement
      expect(Number(field.value)).toBe(5)
      expect(depthsDrawn()).toEqual(['depth -5'])
      commit('control-work-probe-depth', '8')
      expect(depthsDrawn()).toEqual(['depth -8'])
    })
  }
})

// ---------------------------------------------------------------------------

const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)
const BASE: SceneSetup = {
  routine: 'edge', config: CONFIG, tipRadiusMm: 1.5875, plateMm: 0, startDistanceMm: 10, depthMm: 5,
  edgeAxis: 'X', edgeDirection: '+', cornerXDirection: '+', cornerYDirection: '+', angleNominalAxis: 'X',
  angleProbeDirection: '+', angleAlongDirection: '+', angleSpacingMm: 25, sizeXmm: 25, sizeYmm: 25, wcs: 'G54',
  mesh: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], heightChangeMm: 5 },
}
const ENVELOPE = { x: { min: 0, max: 2000 }, y: { min: 0, max: 2000 }, z: { min: 0, max: 1000 } }
const START = { x: 1000, y: 1000, z: 500 }

describe('WO-2063 the pictures are the planner\'s own moves', () => {
  it('Edge: the step-out, descent and search are the plan\'s numbers', () => {
    const scene = buildProbeScene(BASE)
    const plan = planFeatureProbeCycle({
      kind: 'edge', start: START, envelope: ENVELOPE as never, config: CONFIG, tipRadiusMm: 1.5875,
      edgeAxis: 'X', edgeDirection: '+', startDistanceMm: 10, depthBelowTopMm: 5,
    })
    if (!plan.ok) throw new Error(plan.reason)
    const out = scene.steps.find((s) => s.sentence.startsWith('Steps out'))!
    expect(moveLength(out.moves[0])).toBeCloseTo(plan.plan.fromTop!.stepOutMm, 4)
    const touch = plan.plan.steps[0]
    if (touch.kind !== 'touch') throw new Error('expected a touch')
    // The picture's step-out ends where the plan's touch starts (relative to the operator's start).
    expect(out.moves[0].to.x - scene.start.x).toBeCloseTo(touch.expectedStart.x - START.x, 4)
    const descent = scene.steps.find((s) => s.sentence.startsWith('Descends'))!
    expect(descent.moves[0].to.z).toBeCloseTo(-plan.plan.fromTop!.depthMm, 4)
    const probe = scene.steps.find((s) => s.sentence.startsWith('Probes X+'))!
    expect(probe.moves[0].searchMm).toBe(touch.travelMm)
  })

  it('every feature routine draws its touches in the plan\'s order and directions', () => {
    const kinds = ['edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss'] as const
    for (const routine of kinds) {
      const scene = buildProbeScene({ ...BASE, routine, cornerXDirection: routine === 'insideCorner' ? '-' : '+', cornerYDirection: routine === 'insideCorner' ? '-' : '+' })
      expect(scene.refusal, routine).toBeNull()
      const drawn = scene.steps
        .flatMap((s) => s.moves.filter((m) => m.touches && Math.abs(m.to.z - m.from.z) < 1e-9))
        .map((m) => moveLabel(m).split(' ')[0])
      const plan = planFeatureProbeCycle({
        kind: routine, start: START, envelope: ENVELOPE as never, config: CONFIG, tipRadiusMm: 1.5875,
        nominalSizeXmm: 25, nominalSizeYmm: 25, edgeAxis: 'X', edgeDirection: '+',
        cornerXDirection: routine === 'insideCorner' ? '-' : '+', cornerYDirection: routine === 'insideCorner' ? '-' : '+',
        angleNominalAxis: 'X', angleProbeDirection: '+', angleAlongDirection: '+', angleSpacingMm: 25,
        startDistanceMm: 10, depthBelowTopMm: 5, safeZMachineMm: START.z + CONFIG.crossOverLift,
      })
      if (!plan.ok) throw new Error(`${routine}: ${plan.reason}`)
      expect(drawn, routine).toEqual(plan.plan.review.touchOrder.map((t) => `${t.axis}${t.direction}`))
    }
  })

  it('each step starts where the one before it ended (the picture shows the whole path)', () => {
    for (const routine of ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ'] as const) {
      const scene = buildProbeScene({ ...BASE, routine })
      let prev: { x: number; y: number; z: number } | null = null
      for (const step of scene.steps) {
        if (step.moves.length === 0) continue
        if (prev) {
          expect(Math.hypot(step.at.x - prev.x, step.at.y - prev.y, step.at.z - prev.z), `${routine} step ${step.n}`).toBeLessThan(1e-6)
        }
        for (let i = 1; i < step.moves.length; i++) {
          expect(step.moves[i].from, `${routine} step ${step.n} move 2`).toEqual(step.moves[i - 1].to)
        }
        // More than two moves is a face's step (Operator 09-27, "Group by face"):
        // it makes exactly one touch.
        if (step.moves.length > 2) expect(step.touch, `${routine} step ${step.n}`).not.toBeNull()
        prev = step.end
      }
    }
  })

  it('a plate held against the face moves the touch by its thickness', () => {
    const bare = buildProbeScene(BASE)
    const plate = buildProbeScene({ ...BASE, plateMm: 3 })
    const touchX = (scene: typeof bare) => scene.steps.find((s) => s.sentence.startsWith('Probes X+'))!.moves[0].to.x
    expect(touchX(bare) - touchX(plate)).toBeCloseTo(3, 6)
  })
})

describe('WO-2063 a long routine\'s step numbers', () => {
  it('all show when they fit; else the first, the last and a run round the current step', async () => {
    const { chipWindow } = await import('../../components/machine/probing/ProbingScreen')
    // No routine is this long since Operator's "Group by face" (Boss was 22): the
    // window stays for any that is.
    const n = 22
    expect(chipWindow(n, 6, n)).toEqual(Array.from({ length: n }, (_, i) => i))
    for (const current of [0, 1, 6, 11, n - 2, n - 1]) {
      const shown = chipWindow(n, current, 20)
      expect(shown.length, `current ${current}`).toBe(20)
      expect(shown[0]).toBe(0)
      expect(shown.at(-1)).toBe(n - 1)
      expect(shown, `current ${current}`).toContain(current)
      expect([...shown].sort((a, b) => a - b)).toEqual(shown)
      expect(new Set(shown).size).toBe(shown.length)
    }
  })
})

describe('WO-2063 group by face (Operator, 09-27, card Q-BOSS-PROBING-22-STEPS-OR-GROUP-T)', () => {
  it('the long routines show one MACHINE step per face; Edge and Inside corner keep theirs', () => {
    const count = (routine: SceneSetup['routine']) => buildProbeScene({ ...BASE, routine }).steps.length
    // Before: Boss 22, Rect boss 22, Bore 17, Rect pocket 17, Outside corner 14, Angle 13.
    expect(count('boss')).toBe(9)
    expect(count('rectBoss')).toBe(9)
    // Bore and Rect pocket: 9, as the Bore video (descent, four walls, rise).
    expect(count('bore')).toBe(9)
    expect(count('rectPocket')).toBe(9)
    expect(count('outsideCorner')).toBe(6)
    expect(count('angle')).toBe(5)
    expect(count('edge')).toBe(9)
    expect(count('insideCorner')).toBe(7)
  })

  it('a Boss face step is the whole path: step out, descend, probe in fast, back off, again slowly, back off and rise', () => {
    const scene = buildProbeScene({ ...BASE, routine: 'boss' })
    const face = scene.steps.filter((s) => s.owner === 'machine' && s.touch && s.moves.length > 5)
    expect(face.map((s) => s.sentence.split(':')[0])).toEqual(['Right face', 'Left face', 'Back face', 'Front face'])
    for (const s of face) {
      expect(s.moves.map((m) => m.kind)).toEqual(['move', 'probe', 'probe', 'move', 'probe', 'move', 'move'])
      // The touch lights where the fast pass reaches it; the slow pass comes back to the same point.
      expect(s.touchMove).toBe(2)
      expect(s.moves[4].to).toEqual(s.moves[2].to)
      expect(s.touch).not.toBeNull()
    }
  })

  it('Bore: a wall step seeks fast, backs off, seeks slow, backs off, returns toward the start', () => {
    const scene = buildProbeScene({ ...BASE, routine: 'bore' })
    expect(scene.steps.map((s) => s.owner)).toEqual(['you', 'you', 'machine', 'machine', 'machine', 'machine', 'machine', 'machine', 'you'])
    const left = scene.steps[3]
    expect(left.moves.map((m) => `${m.kind === 'probe' ? '~' : ''}${moveLabel(m)}`)).toEqual(['~X- 10.9 mm', 'X+ 2 mm', '~X- 2 mm', 'X+ 2 mm', 'X+ 8.9 mm'])
    expect(left.touchMove).toBe(0)
    expect(scene.steps[7].sentence).toBe('Rises to safe height (top + 5). Shows the centre and diameter it found.')
  })

  it('through the Probing screen: the Boss face step draws ONE path and ONE distance, and the setup redraws it', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-boss'))
    fireEvent.click(screen.getByTestId('probing-step-chip-4'))
    expect(screen.getByTestId('probing-step-sentence').textContent).toMatch(/^Right face: steps out X\+ /)
    // The Bore video: one move at a time - its path in each view it shows in, one distance.
    const before = labels()
    expect(before).toHaveLength(1)
    expect(before[0]).toMatch(/^X\+ /)
    expect(screen.queryAllByTestId('probe-move-side')).toHaveLength(1)
    expect(screen.queryAllByTestId('probe-move-top')).toHaveLength(1)
    const out = (ls: Array<string | null>) => Number(/^X\+ ([\d.]+)/.exec(ls[0]!)![1])
    const was = out(before)
    commit('control-work-probe-nominal-diameter', '40')
    // The step-out is half the diameter + tip radius + clearance: 40 - 25 = 15 mm across, 7.5 each side.
    expect(out(labels()) - was).toBeCloseTo(7.5, 1)
  })
})

describe('WO-2063 before Start, as the Bore video (the standard Operator locked 09-27)', () => {
  it('the where-to-be step dimensions the start zone in both views, from the setup (overtravel and clearance)', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    const picture = () => screen.getByTestId('probe-picture')
    expect(picture().getAttribute('data-mode')).toBe('preview')
    expect(within(picture()).getByTestId('probe-caption').textContent).toBe('BEFORE START - preview (nothing moves)')
    // Within 5 mm of the centre (the search overtravel; the clearance is 5 too): a 10 mm circle.
    expect(within(picture()).getByTestId('probe-zone-dim').textContent).toBe('Ø 10')
    // WO-2179: from above too - moved to where it fits, never dropped.
    expect(within(picture()).getByTestId('probe-top-zone-dim').textContent).toBe('Ø 10')
    // WO-2179: dimensions only in the picture - a hole's zone runs to any
    // height, so no height; "above the top" is the sentence's.
    expect(within(picture()).queryByTestId('probe-zone-words')).toBeNull()
    expect(screen.getByTestId('probing-step-sentence').textContent).toContain('above the top')
    expect(within(picture()).getByTestId('probe-top-part-dim').textContent).toBe('Ø 25')
    // A smaller clearance shrinks the zone: the move toward a wall stops that far short of it.
    commit('control-work-probe-face-distance', '3')
    expect(within(picture()).getByTestId('probe-zone-dim').textContent).toBe('Ø 6')
    commit('control-work-probe-nominal-diameter', '40')
    expect(within(picture()).getByTestId('probe-top-part-dim').textContent).toBe('Ø 40')
  })

  it('a MACHINE step before Start: the real probe stays put, a see-through preview probe plays the move', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    fireEvent.click(screen.getByTestId('probing-step-chip-4'))
    const picture = screen.getByTestId('probe-picture')
    expect(picture.getAttribute('data-mode')).toBe('preview')
    expect(within(picture).getAllByTestId('probe-side-probe')).toHaveLength(1)
    expect(within(picture).getAllByTestId('probe-side-preview')).toHaveLength(1)
    expect(within(picture).getAllByTestId('probe-top-preview')).toHaveLength(1)
    // Nothing is lit before Start.
    expect(within(picture).queryAllByTestId('probe-found-top')).toHaveLength(0)
    expect(within(picture).queryAllByTestId('probe-found-side')).toHaveLength(0)
    // The step's first move, one path in the side view, its distance.
    expect(within(picture).getAllByTestId('probe-move-side')).toHaveLength(1)
    expect(labels()).toEqual(['X- 11 mm'])
  })

  it('the preview plays every move of the step in order, holds where it touches, then again', async () => {
    const { previewTimeline } = await import('../../components/machine/probing/ProbingScreen')
    const step = buildProbeScene({ ...BASE, routine: 'bore' }).steps[3]
    const line = previewTimeline(step.moves, step.touchMove)
    const seen: number[] = []
    let touchHeld = 0
    for (let ms = 0; ms < line.total; ms += 20) {
      const p = line.at(ms)
      if (seen.at(-1) !== p.move) seen.push(p.move)
      if (p.move === step.touchMove && p.t === 1) touchHeld += 20
    }
    expect(seen).toEqual(step.moves.map((_, i) => i))
    expect(touchHeld).toBeGreaterThanOrEqual(400)
    // It loops: past the end it starts over, at the step's start.
    expect(line.at(line.total + 10)).toEqual({ move: 0, t: 0 })
  })
})

describe('WO-2063 the one distance keeps its move\'s axis', () => {
  it('a Y+ probe near its end still reads "Y+", counting down to 0', async () => {
    const { ProbeStepPicture } = await import('../../components/machine/probing/ProbeStepPicture')
    const scene = buildProbeScene({ ...BASE, routine: 'outsideCorner' })
    // A move whose end the probe reaches exactly (no float residue left to
    // read an axis from) - the video's "X+ 0 mm" on a Y+ probe.
    const face = scene.steps.find((s) => s.sentence.startsWith('Front face'))!
    const step = { ...face, moves: [{ kind: 'probe' as const, from: { x: 0, y: -10, z: -5 }, to: { x: 0, y: 0, z: -5 }, touches: true }], touchMove: 0 }
    const probe = 0
    for (const [t, want] of [[0, /^Y\+ 10 mm$/], [0.5, /^Y\+ 5 mm$/], [1, /^Y\+ 0 mm$/]] as const) {
      const { unmount } = render(React.createElement(ProbeStepPicture, {
        scene, step, width: 1240, height: 675, progress: { move: probe, t }, touched: false, mode: 'running',
      }))
      expect(screen.getByTestId('probe-move-label').textContent).toMatch(want)
      unmount()
    }
  })
})

describe('WO-2063 architect review of attempt 4: the side view looks along X, labels keep off the part', () => {
  const rectOf = (el: Element) => {
    const n = (a: string) => Number(el.getAttribute(a))
    return { x0: n('x'), x1: n('x') + n('width'), y0: n('y'), y1: n('y') + n('height') }
  }
  const area = (a: { x0: number; x1: number; y0: number; y1: number }, b: typeof a) =>
    Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))

  // Boss's Y faces now look from the right (architect review after Operator's
  // video check, item 1 - below): its X-Z cut drew the probe inside the boss.
  it('Bore and Rect pocket keep one X-Z side view; a Y move draws its arrow in the top view only, the probe at its own X', async () => {
    const { ProbeStepPicture } = await import('../../components/machine/probing/ProbeStepPicture')
    for (const routine of ['bore', 'rectPocket'] as const) {
      const scene = buildProbeScene({ ...BASE, routine })
      expect(new Set(scene.steps.map((s) => s.view))).toEqual(new Set(['X']))
      const step = scene.steps.find((s) => /^Front wall/.test(s.sentence))!
      // Every move of that step: a Y move (step out, probe, back off) never draws a side arrow.
      for (const [i, m] of step.moves.entries()) {
        const { unmount } = render(React.createElement(ProbeStepPicture, {
          scene, step, width: 1240, height: 675, progress: { move: i, t: 0.3 }, touched: false, mode: 'preview',
        }))
        const yMove = Math.abs(m.to.y - m.from.y) > 1e-6 && Math.abs(m.to.x - m.from.x) < 1e-6 && Math.abs(m.to.z - m.from.z) < 1e-6
        if (yMove) {
          expect(screen.queryAllByTestId('probe-move-side')).toHaveLength(0)
          // Its arrow is in the top view (a short back-off may end inside the drawn probe: no room for one).
          const top = screen.queryAllByTestId('probe-move-top').length
          if (moveLength(m) > 5) expect(top).toBe(1)
          else expect(top).toBeLessThanOrEqual(1)
          expect(screen.getByTestId('probe-move-label').textContent).toMatch(/^Y[+-] /)
        }
        // A move with no X in it: the preview probe stands at the X where it
        // happens - the middle, where the real probe stands too.
        if (Math.abs(m.to.x - m.from.x) < 1e-6) {
          expect(m.from.x).toBeCloseTo(scene.start.x, 6)
          const preview = screen.getByTestId('probe-side-preview').querySelector('rect')!
          const real = screen.getByTestId('probe-side-probe').querySelector('rect')!
          expect(Number(preview.getAttribute('x'))).toBeCloseTo(Number(real.getAttribute('x')), 3)
        }
        unmount()
      }
    }
  })

  it('Edge on a Y face still looks along Y (it touches no X face)', () => {
    const scene = buildProbeScene({ ...BASE, routine: 'edge', edgeAxis: 'Y', edgeDirection: '-' })
    expect(new Set(scene.steps.map((s) => s.view))).toEqual(new Set(['Y']))
  })

  it('the one distance never sits on the part, at 1920x1080 and 1440x900 picture sizes', async () => {
    const { ProbeStepPicture } = await import('../../components/machine/probing/ProbeStepPicture')
    const bad: string[] = []
    for (const routine of ['edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss'] as const) {
      const scene = buildProbeScene({ ...BASE, routine })
      for (const [width, height] of [[1240, 675], [760, 520]]) {
        for (const step of scene.steps.filter((s) => s.owner === 'machine')) {
          for (let i = 0; i < step.moves.length; i++) {
            for (const t of [0, 0.5]) {
              const { unmount } = render(React.createElement(ProbeStepPicture, {
                scene, step, width, height, progress: { move: i, t }, touched: false, mode: 'running',
              }))
              const side = screen.getByTestId('probe-side-view')
              const dist = screen.queryByTestId('probe-move-distance')?.querySelector('rect')
              if (dist) {
                const box = rectOf(dist)
                const solid = [...side.querySelectorAll('rect.control-probe-diagram-stock')].reduce((c, r) => c + area(box, rectOf(r)), 0)
                const open = [...side.querySelectorAll('rect.pbn-cut')].reduce((c, r) => c + area(box, rectOf(r)), 0)
                if (solid - open > 1) bad.push(`${routine} ${width} step ${step.n} move ${i} t ${t}: ${Math.round(solid - open)} px2 on the part`)
              }
              unmount()
            }
          }
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('WO-2063 the where-to-be words are never cut off', () => {
  it('every routine\'s zone words sit inside the side view, at 1920x1080 and 1440x900 picture sizes', async () => {
    const { ProbeStepPicture, pictureLayout } = await import('../../components/machine/probing/ProbeStepPicture')
    const bad: string[] = []
    for (const routine of ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ'] as const) {
      const scene = buildProbeScene({ ...BASE, routine })
      for (const [width, height] of [[1240, 675], [760, 520]]) {
        const { sideW } = pictureLayout(scene, width, height)
        for (const step of scene.steps.filter((s) => s.owner === 'you' && s.zone)) {
          const { unmount } = render(React.createElement(ProbeStepPicture, {
            scene, step, width, height, progress: null, touched: false, mode: 'preview',
          }))
          for (const t of screen.queryByTestId('probe-zone-words')?.querySelectorAll('text') ?? []) {
            const x = Number(t.getAttribute('x'))
            // The picture's own width rule for the bold face: half an em a character.
            const w = (t.textContent ?? '').length * 26 * 0.5
            const anchor = t.getAttribute('text-anchor') ?? 'start'
            const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x
            if (x0 < 0 || x0 + w > sideW) bad.push(`${routine} ${width} step ${step.n}: "${t.textContent}" ${Math.round(x0)}..${Math.round(x0 + w)} of 0..${sideW}`)
          }
          unmount()
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('WO-2063 architect review of attempt 5: before Start, a MACHINE step plays its path, never just its end', () => {
  afterEach(() => { vi.useRealTimers() })
  // The loop the screen plays (usePreviewLoop), frame by frame on a fake
  // clock, through the production screen. Every frame that shows a distance
  // shows its arrow too, pointing the way its words say, and the distance is
  // still to go (never a "0 mm" left standing at the touch); the probing pass
  // toward the wall is drawn dashed with its distance.
  for (const routine of ['bore', 'boss'] as const) {
    it(`${routine} step 4: the dashed probing arrow points toward the wall with a distance, and no distance stands without its arrow`, () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      render(React.createElement(ProbingPanel))
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
      fireEvent.click(screen.getByTestId('probing-step-chip-4'))
      // Both routines' first face is approached in X-. WO-2284 explains
      // Boss's descent here; the direction assertion must not parse prose.
      const toward = 'X-'
      const bad: string[] = []
      let probing = 0
      let frames = 0
      for (let ms = 0; ms < 9000; ms += 40) {
        act(() => { vi.advanceTimersByTime(40) })
        const pic = screen.getByTestId('probe-picture')
        expect(pic.getAttribute('data-mode')).toBe('preview')
        if (pic.getAttribute('data-preview') === 'playing') frames++
        const label = within(pic).queryByTestId('probe-move-label')?.textContent ?? null
        const arrows = [...within(pic).queryAllByTestId('probe-move-side'), ...within(pic).queryAllByTestId('probe-move-top')]
        if (label === null) {
          if (arrows.length) bad.push(`${ms} ms: an arrow with no distance`)
          continue
        }
        const [, axis, sign, mm] = /^([XYZ])([+-]) ([\d.]+) mm$/.exec(label)!
        if (Number(mm) === 0) bad.push(`${ms} ms: "${label}" - a distance of nothing`)
        if (arrows.length === 0) bad.push(`${ms} ms: "${label}" with no arrow`)
        const s = sign === '+' ? 1 : -1
        for (const a of arrows) {
          const dx = Number(a.getAttribute('data-dx'))
          const dy = Number(a.getAttribute('data-dy'))
          const ok = axis === 'X' ? dx === s : axis === 'Y' ? dy === -s : dy === -s
          if (!ok) bad.push(`${ms} ms: "${label}" but its ${a.getAttribute('data-testid')} points ${dx},${dy}`)
        }
        if (`${axis}${sign}` === toward && Number(mm) > 0 && arrows.some((a) => a.getAttribute('data-move-kind') === 'probe')) probing++
      }
      expect(frames).toBeGreaterThan(50)
      expect(bad).toEqual([])
      expect(probing).toBeGreaterThan(5)
    })
  }
})

describe('WO-2063 architect review of attempt 5, every routine: each preview frame shows its path', () => {
  it('every MACHINE step of every routine, across one preview loop: a distance always has its arrow, pointing the way its words say', async () => {
    const { ProbeStepPicture } = await import('../../components/machine/probing/ProbeStepPicture')
    const { previewTimeline } = await import('../../components/machine/probing/ProbingScreen')
    const bad: string[] = []
    let checked = 0
    for (const routine of ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ'] as const) {
      const scene = buildProbeScene({ ...BASE, routine })
      for (const [width, height] of [[1240, 675], [760, 520]]) {
        for (const step of scene.steps.filter((s) => s.owner === 'machine' && s.moves.length)) {
          const line = previewTimeline(step.moves, step.touchMove)
          const props = (ms: number) => ({ scene, step, width, height, progress: line.at(ms), touched: false, mode: 'preview' as const })
          const { rerender, unmount } = render(React.createElement(ProbeStepPicture, props(0)))
          for (let ms = 0; ms < line.total; ms += 90) {
            rerender(React.createElement(ProbeStepPicture, props(ms)))
            const label = screen.queryByTestId('probe-move-label')?.textContent ?? null
            const arrows = [...screen.queryAllByTestId('probe-move-side'), ...screen.queryAllByTestId('probe-move-top')]
            const at = `${routine} ${width} step ${step.n} ${ms} ms`
            if (label === null) {
              if (arrows.length) bad.push(`${at}: an arrow with no distance`)
              continue
            }
            checked++
            // WO-2108: the top search is labelled with how far it may search ("Z- up to 25 mm").
            const [, axis, sign, mm] = /^([XYZ])([+-]) (?:up to )?([\d.]+) mm$/.exec(label)!
            if (Number(mm) === 0) bad.push(`${at}: "${label}"`)
            if (arrows.length === 0) bad.push(`${at}: "${label}" with no arrow`)
            // The words name the move's own axis and sign; each arrow points
            // the way the move goes in its view (a diagonal step-out - Boss's
            // back face, from the left face - goes both ways at once).
            const mv = step.moves[line.at(ms).move]
            if (`${axis}${sign}` !== moveLabel(mv).split(' ')[0]) bad.push(`${at}: "${label}" for a ${moveLabel(mv)} move`)
            const sg = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Math.sign(v))
            for (const a of arrows) {
              const dx = Number(a.getAttribute('data-dx'))
              const dy = Number(a.getAttribute('data-dy'))
              const side = a.getAttribute('data-testid') === 'probe-move-side'
              const want = side
                ? [sg(step.view === 'X' ? mv.to.x - mv.from.x : mv.to.y - mv.from.y), -sg(mv.to.z - mv.from.z)]
                : [sg(mv.to.x - mv.from.x), -sg(mv.to.y - mv.from.y)]
              if (dx !== want[0] || dy !== want[1]) bad.push(`${at}: "${label}" but its ${a.getAttribute('data-testid')} points ${dx},${dy} (want ${want})`)
            }
          }
          unmount()
        }
      }
    }
    expect(checked).toBeGreaterThan(500)
    expect(bad).toEqual([])
  }, 60_000)
})

describe('WO-2063 architect review after Operator\'s video check, item 1: the probe is never drawn inside the part', () => {
  // Every routine and the setups that turn it round: each face, each corner.
  const setups = (): SceneSetup[] => {
    const out: SceneSetup[] = []
    for (const routine of ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ'] as const) {
      out.push({ ...BASE, routine })
    }
    for (const edgeAxis of ['X', 'Y'] as const) for (const edgeDirection of ['+', '-'] as const) out.push({ ...BASE, routine: 'edge', edgeAxis, edgeDirection })
    for (const routine of ['outsideCorner', 'insideCorner'] as const) {
      for (const cornerXDirection of ['+', '-'] as const) for (const cornerYDirection of ['+', '-'] as const) out.push({ ...BASE, routine, cornerXDirection, cornerYDirection })
    }
    for (const angleNominalAxis of ['X', 'Y'] as const) for (const angleProbeDirection of ['+', '-'] as const) out.push({ ...BASE, routine: 'angle', angleNominalAxis, angleProbeDirection })
    out.push({ ...BASE, routine: 'rectBoss', sizeXmm: 40, sizeYmm: 20 }, { ...BASE, routine: 'boss', sizeXmm: 60, sizeYmm: 60 })
    return out
  }

  it('in no step of any routine is the probe drawn inside the material of its side view', async () => {
    const { drawnInsideMaterial } = await import('../../components/machine/probing/probeScene')
    const bad: string[] = []
    for (const setup of setups()) {
      const scene = buildProbeScene(setup)
      for (const step of scene.steps) {
        if (drawnInsideMaterial(scene, step)) bad.push(`${setup.routine} ${setup.edgeAxis}${setup.edgeDirection} ${setup.cornerXDirection}${setup.cornerYDirection} step ${step.n}: ${step.sentence}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('Boss and Rect boss: the front and back face steps look from the right; Bore and Rect pocket keep one X-Z view', () => {
    for (const routine of ['boss', 'rectBoss'] as const) {
      const scene = buildProbeScene({ ...BASE, routine })
      const yFaces = scene.steps.filter((s) => /^(Front|Back) face/.test(s.sentence))
      expect(yFaces).toHaveLength(2)
      for (const s of yFaces) expect(s.view).toBe('Y')
      for (const s of scene.steps.filter((x) => /^(Left|Right) face/.test(x.sentence))) expect(s.view).toBe('X')
    }
    for (const routine of ['bore', 'rectPocket'] as const) {
      expect(new Set(buildProbeScene({ ...BASE, routine }).steps.map((s) => s.view))).toEqual(new Set(['X']))
    }
  })

  it('through the Probing screen: Boss\'s front face step draws the probe beside the boss, and the view says it looks from the right', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-boss'))
    const chips = screen.getAllByTestId(/^probing-step-chip-/)
    const shown: string[] = []
    for (const chip of chips) {
      fireEvent.click(chip)
      const sentence = screen.getByTestId('probing-step-sentence').textContent ?? ''
      if (!/^Front face/.test(sentence)) continue
      shown.push(sentence)
      expect(screen.getByTestId('probing-caption-side').textContent).toBe('Right view')
      expect(screen.getByTestId('probe-picture').getAttribute('data-view')).toBe('Y')
      // The drawn probe (the preview probe at the step's start) sits clear of
      // every piece of material in the side view.
      const side = screen.getByTestId('probe-side-view')
      const probe = screen.getByTestId('probe-side-preview').querySelector('circle')!
      const cx = Number(probe.getAttribute('cx'))
      const cy = Number(probe.getAttribute('cy'))
      for (const r of side.querySelectorAll('rect.control-probe-diagram-stock')) {
        const x = Number(r.getAttribute('x'))
        const y = Number(r.getAttribute('y'))
        const inside = cx > x + 1 && cx < x + Number(r.getAttribute('width')) - 1 && cy > y + 1 && cy < y + Number(r.getAttribute('height')) - 1
        expect(inside).toBe(false)
      }
    }
    expect(shown).toHaveLength(1)
    fireEvent.click(screen.getByTestId('probing-step-chip-4'))
    expect(screen.getByTestId('probing-caption-side').textContent).toBe('Front view')
  })
})

describe('WO-2063 architect review after Operator\'s video check, item 3: Z0\'s preview plays its descent', () => {
  it('Z0 step 3 before Start: the preview probe comes down through the heights between the start and the top, as every routine\'s does', async () => {
    const { previewTimeline } = await import('../../components/machine/probing/ProbingScreen')
    const { probeAt } = await import('../../components/machine/probing/ProbeStepPicture')
    const scene = buildProbeScene({ ...BASE, routine: 'workZero' })
    const step = scene.steps[2]
    expect(step.sentence).toMatch(/^Probes down/)
    const line = previewTimeline(step.moves, step.touchMove)
    const zs: number[] = []
    for (let ms = 0; ms < line.total; ms += 50) zs.push(probeAt(step, line.at(ms)).z)
    const between = new Set(zs.filter((z) => z < step.moves[0].from.z - 0.2 && z > step.moves[0].to.z + 0.2).map((z) => z.toFixed(1)))
    // The descent takes a second on screen: many heights between, going down only.
    expect(between.size).toBeGreaterThan(10)
    const falling = zs.slice(0, zs.indexOf(Math.min(...zs)) + 1)
    for (let i = 1; i < falling.length; i++) expect(falling[i]).toBeLessThanOrEqual(falling[i - 1] + 1e-9)
  })
})
