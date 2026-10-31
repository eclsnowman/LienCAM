// WO-3193: Thread Mill lets the operator choose top-down or bottom-up.
//
// Oracle, independent of the builder's own coupling: the groove a helix cuts is
// right-handed exactly when Z rises with CCW orbit angle (seen from +Z), so the
// hand is sign(dz / signed sweep) - whatever the kind, spindle or direction.
// The direction is the sign of dz, and each pass must start and end at the
// thread bottom/top in the chosen order. No choice made = today's output.
import { describe, it, expect } from 'vitest'
import { buildThreadMillToolpath } from '../../lib/cam/threadmill2d'
import type { ThreadMillParams, ThreadMillWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, ToolpathMove } from '../../types'

const TOP = 0
const BOTTOM = -9
const PITCH = 1

function makeTool(cutHand: 'right' | 'left' = 'right'): Tool {
  return {
    id: 't1', name: 'O4 thread mill', type: 'thread_mill', cutHand,
    diameter: 4, fluteLength: 30, shankDiameter: 4, overallLength: 60,
    numberOfFlutes: 3, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 6000, feedRate: 400, plungeRate: 120, depthOfCut: 5, stepover: 1 } },
  } as Tool
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: TOP, topHeightMode: 'absolute',
  bottomHeight: BOTTOM, bottomHeightMode: 'absolute',
}

function circleLoop(dia: number): LoopData {
  const points = []
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * 2 * Math.PI
    points.push({ x: (dia / 2) * Math.cos(a), y: (dia / 2) * Math.sin(a) })
  }
  return { id: 'h1', closed: true, type: 'contour', points }
}

// M6x1: internal in a 5mm tap-drill hole, external on a 6mm boss.
function build(over: Partial<ThreadMillParams>, cutHand: 'right' | 'left' = 'right'): ToolpathMove[] {
  const params: ThreadMillParams = {
    geometryId: 'g1', loopIds: [],
    threadKind: 'internal', majorDiameter: 6, pitch: PITCH,
    handedness: 'right', cutDirection: 'climb',
    roughingPasses: 2, springPasses: 1,
    leadInOut: 'arc', compensation: 'computer',
    ...over,
  }
  const payload: ThreadMillWorkerPayload = {
    opId: 'op', setupId: 'su', params, heights,
    passes: { stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    tool: makeTool(cutHand),
    loops: [circleLoop(params.threadKind === 'internal' ? 5 : 6)],
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
  return buildThreadMillToolpath(payload)
}

/** Each pass's helix: a contiguous run of role 'helix' moves. */
function helixRuns(moves: ToolpathMove[]): ToolpathMove[][] {
  const runs: ToolpathMove[][] = []
  let run: ToolpathMove[] = []
  for (const m of moves) {
    if (m.role === 'helix') run.push(m)
    else if (run.length) { runs.push(run); run = [] }
  }
  if (run.length) runs.push(run)
  return runs
}

/** CCW-positive sweep of one move from the previous point about (0,0). */
function sweepOf(a: ToolpathMove, b: ToolpathMove): number {
  let s = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)
  if (b.type === 'arc_ccw' && s <= 0) s += 2 * Math.PI
  if (b.type === 'arc_cw' && s >= 0) s -= 2 * Math.PI
  return s
}

function measure(run: ToolpathMove[]) {
  let sweep = 0
  for (let i = 1; i < run.length; i++) sweep += sweepOf(run[i - 1], run[i])
  const dz = run[run.length - 1].z - run[0].z
  return {
    hand: dz / sweep > 0 ? 'right' : 'left',
    zPerRev: Math.abs(dz / sweep) * 2 * Math.PI,
    startZ: run[0].z,
    endZ: run[run.length - 1].z,
    orbitSense: sweep > 0 ? 1 : -1,
  }
}

const KINDS = ['internal', 'external'] as const
const HANDS = ['right', 'left'] as const
const DIRECTIONS = ['bottom-up', 'top-down'] as const

describe('WO-3193 thread mill: the chosen direction is followed and still cuts the hand', () => {
  for (const kind of KINDS) {
    for (const hand of HANDS) {
      for (const direction of DIRECTIONS) {
        for (const cutHand of ['right', 'left'] as const) {
          for (const cutDirection of ['climb', 'conventional'] as const) {
            it(`${kind} ${hand}-hand ${direction}, ${cutHand}-hand cutter, stored ${cutDirection}`, () => {
              const runs = helixRuns(build({ threadKind: kind, handedness: hand, axialDirection: direction, cutDirection }, cutHand))
              expect(runs.length).toBe(3)  // 2 roughing + 1 spring: every pass follows the choice
              for (const run of runs) {
                const m = measure(run)
                expect(m.hand).toBe(hand)
                expect(m.zPerRev).toBeCloseTo(PITCH, 9)
                if (direction === 'bottom-up') {
                  expect(m.startZ).toBeCloseTo(BOTTOM, 9)
                  expect(m.endZ).toBeCloseTo(TOP, 9)
                } else {
                  expect(m.startZ).toBeCloseTo(TOP, 9)
                  expect(m.endZ).toBeCloseTo(BOTTOM, 9)
                }
              }
            })
          }
        }
      }
    }
  }

  it('RH internal M6 with Top-down chosen descends where the default ascends', () => {
    const down = measure(helixRuns(build({ axialDirection: 'top-down' }))[0])
    expect(down.startZ).toBeCloseTo(TOP, 9)
    expect(down.endZ).toBeCloseTo(BOTTOM, 9)
    expect(down.hand).toBe('right')
    expect(down.orbitSense).toBe(-1)
  })
})

describe('WO-3193 thread mill: no choice made keeps today\'s output', () => {
  for (const kind of KINDS) {
    for (const hand of HANDS) {
      for (const cutDirection of ['climb', 'conventional'] as const) {
        for (const cutHand of ['right', 'left'] as const) {
          it(`${kind} ${hand} ${cutDirection} ${cutHand}-hand cutter: unset equals the derived choice`, () => {
            const over = { threadKind: kind, handedness: hand, cutDirection } as const
            const unset = build(over, cutHand)
            const first = measure(helixRuns(unset)[0])
            const derived: 'bottom-up' | 'top-down' = first.endZ > first.startZ ? 'bottom-up' : 'top-down'
            expect(build({ ...over, axialDirection: derived }, cutHand)).toEqual(unset)
          })
        }
      }
    }
  }
})
