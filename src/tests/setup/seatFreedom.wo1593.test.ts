// WO-1593: the 3-2-1 freedom ladder. One engine function seats every contact,
// the SECOND contact squares as well as slides (the defect this order closes),
// and every seat reports the freedom it leaves as a named state that
// `describeFreedom` turns into the operator's sentence.
//
// Pure geometry - no store, no React, no UI. WO-1587 renders the sentence;
// this order only has to make it exist and be true.

import { describe, it, expect } from 'vitest'
import type { Vec3 } from '../../types'
import { rotationMatrixXYZ } from '../../lib/geometry/rotationMatrixXYZ'
import {
  seatAgainstFace, seatFirstFace, seatSecondFace, describeFreedom,
  SEAT_FREEDOM_STATES, SEAT_FREEDOM_FREE,
  type FacePick, type RigidPose, type SeatFreedom, type SeatFreedomState,
} from '../../lib/cam/workholdingSeat'

const TOL = 0.001 // mm, the order's own gap tolerance

function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
function scale(a: Vec3, s: number): Vec3 { return { x: a.x * s, y: a.y * s, z: a.z * s } }
function neg(a: Vec3): Vec3 { return scale(a, -1) }
function norm(a: Vec3): Vec3 { return scale(a, 1 / Math.sqrt(dot(a, a))) }

/** A local face carried into world space through a pose - the same trip the
 *  viewport makes when it draws the body. */
function worldFace(pose: RigidPose, local: FacePick): FacePick {
  const R = rotationMatrixXYZ(pose.rotation)
  const mv = (v: Vec3): Vec3 => ({
    x: R.col1.x * v.x + R.col2.x * v.y + R.col3.x * v.z,
    y: R.col1.y * v.x + R.col2.y * v.y + R.col3.y * v.z,
    z: R.col1.z * v.x + R.col2.z * v.y + R.col3.z * v.z,
  })
  const p = mv(local.point)
  return { point: { x: p.x + pose.position.x, y: p.y + pose.position.y, z: p.z + pose.position.z }, normal: mv(local.normal) }
}

/** The order's acceptance wording, measured: the two faces are PARALLEL
 *  (normals exactly opposed) and coplanar within 0.001 mm. */
function expectFlush(pose: RigidPose, local: FacePick, target: FacePick) {
  const seated = worldFace(pose, local)
  expect(dot(norm(seated.normal), norm(target.normal))).toBeCloseTo(-1, 6)
  expect(Math.abs(dot(sub(seated.point, target.point), norm(target.normal)))).toBeLessThan(TOL)
}

/** The gap at the pick point only - what a drafted face closes, since it meets
 *  the jaw along a line rather than flush. */
function expectTouchingAtThePickPoint(pose: RigidPose, local: FacePick, target: FacePick) {
  const seated = worldFace(pose, local)
  expect(Math.abs(dot(sub(seated.point, target.point), norm(target.normal)))).toBeLessThan(TOL)
}

// ---------------------------------------------------------------------------
// The fixture: a vise standing square but turned 30deg on the table, so the
// jaw and the stop are square to the floor and to each other and NOTHING is
// trivially axis-aligned. Floor normal points up at the part, jaw and stop
// normals point in at it.
// ---------------------------------------------------------------------------
const A = (30 * Math.PI) / 180
const FLOOR: FacePick = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } }
const JAW: FacePick = { point: { x: 0, y: 0, z: 0 }, normal: { x: -Math.sin(A), y: Math.cos(A), z: 0 } }
const STOP: FacePick = { point: { x: -10, y: 4, z: 0 }, normal: { x: Math.cos(A), y: Math.sin(A), z: 0 } }

// The block being located: 40 x 25 x 15, dumped in the workspace at a pose
// nothing about the fixture implies.
const START: RigidPose = { position: { x: 17, y: -6, z: 30 }, rotation: { x: 12, y: -25, z: 40 } }
// Four ways the operator might have dropped it in. The seat must not care.
const STARTS: readonly RigidPose[] = [
  START,
  { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
  { position: { x: -40, y: 22, z: -9 }, rotation: { x: -40, y: 15, z: -110 } },
  { position: { x: 3, y: 3, z: 3 }, rotation: { x: 5, y: 0, z: 95 } },
]
const BOTTOM: FacePick = { point: { x: 20, y: 12.5, z: 0 }, normal: { x: 0, y: 0, z: -1 } }
const TOP: FacePick = { point: { x: 20, y: 12.5, z: 15 }, normal: { x: 0, y: 0, z: 1 } }
const SIDE: FacePick = { point: { x: 20, y: 0, z: 7.5 }, normal: { x: 0, y: -1, z: 0 } }
const END: FacePick = { point: { x: 0, y: 12.5, z: 7.5 }, normal: { x: -1, y: 0, z: 0 } }

// The same side face with 8deg of draft: its normal leans out of the block's
// side, so it can never lie flush against a flat jaw.
const DRAFT = (8 * Math.PI) / 180
const DRAFTED_SIDE: FacePick = {
  point: { x: 20, y: 0, z: 7.5 },
  normal: { x: 0, y: -Math.cos(DRAFT), z: Math.sin(DRAFT) },
}

const VISE_NAMES = { mover: 'The block', contacts: ['the vise floor', 'the fixed jaw', 'the end stop'] }

function contact1(): { pose: RigidPose; freedom: SeatFreedom } {
  return seatAgainstFace(START, SEAT_FREEDOM_FREE, BOTTOM, FLOOR)
}

describe('WO-1593: contact 1 - the block sits flat on the floor', () => {
  it('seats flush and leaves the freedom of a part lying on a surface plate', () => {
    const r1 = contact1()
    expectFlush(r1.pose, BOTTOM, FLOOR)
    expect(r1.freedom.state).toBe('on-plane')
  })

  it('the sentence says it can still slide across the floor and turn on it', () => {
    const sentence = describeFreedom(contact1().freedom, VISE_NAMES)
    expect(sentence).toBe('The block sits flat on the vise floor. It can still slide across the vise floor and turn on it.')
  })
})

/** WO-1574's retired second contact, reproduced here as a CONTROL - it slid
 *  along the first contact plane and returned `current.rotation` untouched.
 *  It is never application truth; it exists so the test below can show the
 *  defect this order closes on this very geometry, without checking out an
 *  older engine. */
function translateOnlySecondContact(pose: RigidPose, n1raw: Vec3, local: FacePick, target: FacePick): RigidPose {
  const n1 = norm(n1raw)
  const t = neg(norm(target.normal))
  const slide = sub(t, scale(n1, dot(t, n1)))
  const mag = Math.sqrt(dot(slide, slide))
  const m = scale(slide, 1 / mag)
  const s = dot(sub(target.point, worldFace(pose, local).point), t) / mag
  return {
    position: { x: pose.position.x + m.x * s, y: pose.position.y + m.y * s, z: pose.position.z + m.z * s },
    rotation: pose.rotation,
  }
}

describe('WO-1593: contact 2 - the second contact SQUARES as well as slides', () => {
  it('the two faces come out PARALLEL and coplanar - this is what translate-only seating could not do', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
    expectFlush(r2.pose, SIDE, JAW)
    // The squaring is a real rotation: a translate-only second contact would
    // have returned the first contact's orientation untouched.
    expect(r2.pose.rotation).not.toEqual(r1.pose.rotation)
  })

  it('squares from ANY starting pose - the operator drops the block in wherever he likes', () => {
    for (const start of STARTS) {
      const r1 = seatAgainstFace(start, SEAT_FREEDOM_FREE, BOTTOM, FLOOR)
      const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
      expectFlush(r2.pose, SIDE, JAW)
      expectFlush(r2.pose, BOTTOM, FLOOR)
      expect(r2.freedom.state).toBe('along-line')
    }
  })

  it('CONTROL: the retired translate-only contact leaves the part touching the jaw at an angle', () => {
    const misses = STARTS.map((start) => {
      const r1 = seatAgainstFace(start, SEAT_FREEDOM_FREE, BOTTOM, FLOOR)
      const old = translateOnlySecondContact(r1.pose, neg(FLOOR.normal), SIDE, JAW)
      // It closes the gap at the PICK POINT - that part always worked...
      expectTouchingAtThePickPoint(old, SIDE, JAW)
      // ...but the faces are not parallel, so the part touches the jaw at a
      // point instead of sitting flush against it. That is the defect.
      const cos = dot(norm(worldFace(old, SIDE).normal), norm(JAW.normal))
      return 180 - (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI
    })
    // Every start is off; the worst is grossly off, not a rounding error.
    for (const miss of misses) expect(miss).toBeGreaterThan(1)
    expect(Math.max(...misses)).toBeGreaterThan(20)
  })

  it('the first contact still holds - turning about its normal cannot open it', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
    expectFlush(r2.pose, BOTTOM, FLOOR)
  })

  it('what is left is one slide, along the line the two contact planes share', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
    expect(r2.freedom.state).toBe('along-line')
    if (r2.freedom.state !== 'along-line') return
    const d = norm(r2.freedom.direction)
    expect(dot(d, norm(FLOOR.normal))).toBeCloseTo(0, 9)
    expect(dot(d, norm(JAW.normal))).toBeCloseTo(0, 9)
    // Sliding along it really does leave both contacts closed.
    const slid: RigidPose = {
      position: {
        x: r2.pose.position.x + d.x * 7, y: r2.pose.position.y + d.y * 7, z: r2.pose.position.z + d.z * 7,
      },
      rotation: r2.pose.rotation,
    }
    expectFlush(slid, BOTTOM, FLOOR)
    expectFlush(slid, SIDE, JAW)
  })

  it('the sentence names the jaw the operator picked, not an axis', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
    expect(describeFreedom(r2.freedom, VISE_NAMES)).toBe(
      'The block sits flat on the vise floor, squared against the fixed jaw. It can still slide along the fixed jaw.',
    )
  })

  it('seating the same contact twice moves nothing - least motion, so a re-solve does not drift', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
    const again = seatAgainstFace(r2.pose, r1.freedom, SIDE, JAW)
    expect(again.pose.rotation).toEqual(r2.pose.rotation)
    expect(again.pose.position.x).toBeCloseTo(r2.pose.position.x, 9)
    expect(again.pose.position.y).toBeCloseTo(r2.pose.position.y, 9)
    expect(again.pose.position.z).toBeCloseTo(r2.pose.position.z, 9)
  })
})

describe('WO-1593: contact 3 - the same function, run against a line', () => {
  it('the end against the stop closes the last slide and all three contacts hold', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
    const r3 = seatAgainstFace(r2.pose, r2.freedom, END, STOP)

    expectFlush(r3.pose, BOTTOM, FLOOR)
    expectFlush(r3.pose, SIDE, JAW)
    expectFlush(r3.pose, END, STOP)
    expect(r3.freedom.state).toBe('located')
    // No turn left to spend, so the third contact only slides.
    expect(r3.pose.rotation).toEqual(r2.pose.rotation)
  })

  it('the sentence says it is fully located, naming the three faces in the order they were made', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
    const r3 = seatAgainstFace(r2.pose, r2.freedom, END, STOP)
    expect(describeFreedom(r3.freedom, VISE_NAMES)).toBe(
      'The block is fully located: on the vise floor, against the fixed jaw, against the end stop.',
    )
  })

  it('a located body has nothing left to spend, so a further contact leaves it exactly where it is', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW)
    const r3 = seatAgainstFace(r2.pose, r2.freedom, END, STOP)
    const r4 = seatAgainstFace(r3.pose, r3.freedom, TOP, FLOOR)
    expect(r4.pose).toEqual(r3.pose)
    expect(r4.freedom.state).toBe('located')
  })
})

describe('WO-1593: a drafted face squares to its own normal', () => {
  it('turns until the draft face is square to the jaw, touches at the pick point, and keeps the floor contact', () => {
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, DRAFTED_SIDE, JAW)

    // It is NOT flush - a drafted face pushed against a flat jaw meets it
    // along a line, which is what physically happens and needs no warning.
    const seated = worldFace(r2.pose, DRAFTED_SIDE)
    expect(dot(norm(seated.normal), norm(JAW.normal))).toBeCloseTo(-Math.cos(DRAFT), 6)
    expect(dot(norm(seated.normal), norm(JAW.normal))).not.toBeCloseTo(-1, 4)

    // But its direction WITHIN the floor plane is square to the jaw: the part
    // is not skew on the floor, it is leaning.
    const n1 = norm(FLOOR.normal)
    const inPlane = norm(sub(norm(seated.normal), scale(n1, dot(norm(seated.normal), n1))))
    expect(dot(inPlane, norm(JAW.normal))).toBeCloseTo(-1, 6)

    expectTouchingAtThePickPoint(r2.pose, DRAFTED_SIDE, JAW)
    expectFlush(r2.pose, BOTTOM, FLOOR)
    expect(r2.freedom.state).toBe('along-line')
  })
})

describe('WO-1593: the one degenerate refusal is unchanged and nothing joins it', () => {
  it('a second face parallel to the first contact plane still refuses, with its existing sentence', () => {
    const r1 = contact1()
    expect(() => seatAgainstFace(r1.pose, r1.freedom, TOP, FLOOR)).toThrow(
      'Seat in vise: the second face is parallel to the first contact plane - sliding along it can never close this gap.',
    )
  })

  it('a face parallel to the first contact plane on the MOVING side does not refuse - it spends its slide', () => {
    // The block's own top face against the jaw: no turn about the floor normal
    // can orient it, but a slide CAN close the gap at the pick point, so the
    // software does it rather than handing the operator our problem (rule 11).
    const r1 = contact1()
    const r2 = seatAgainstFace(r1.pose, r1.freedom, TOP, JAW)
    expectTouchingAtThePickPoint(r2.pose, TOP, JAW)
    expectFlush(r2.pose, BOTTOM, FLOOR)
    expect(r2.freedom.state).toBe('along-line')
  })
})

describe('WO-1593: seatFirstFace / seatSecondFace are the same engine', () => {
  it('seatSecondFace now squares, and lands exactly where seatAgainstFace does', () => {
    const first = seatFirstFace(START, BOTTOM, FLOOR)
    const second = seatSecondFace(first, neg(FLOOR.normal), SIDE, JAW)
    expectFlush(second, SIDE, JAW)
    expectFlush(second, BOTTOM, FLOOR)
    expect(second.rotation).not.toEqual(first.rotation)

    const r1 = contact1()
    expect(first).toEqual(r1.pose)
    expect(second).toEqual(seatAgainstFace(r1.pose, r1.freedom, SIDE, JAW).pose)
  })
})

describe('WO-1593: describeFreedom is the one home for the words', () => {
  const SAMPLES: Record<SeatFreedomState, SeatFreedom> = {
    'free': SEAT_FREEDOM_FREE,
    'on-plane': { state: 'on-plane', normal: { x: 0, y: 0, z: 1 } },
    'along-line': { state: 'along-line', direction: { x: 0, y: 1, z: 0 } },
    'located': { state: 'located' },
    'on-axis': { state: 'on-axis', axis: { x: 0, y: 0, z: 1 } },
    'about-axis': { state: 'about-axis', axis: { x: 0, y: 0, z: 1 } },
  }

  it('there are exactly six states and every one of them has a sentence', () => {
    expect([...SEAT_FREEDOM_STATES]).toEqual(['free', 'on-plane', 'along-line', 'located', 'on-axis', 'about-axis'])
    for (const state of SEAT_FREEDOM_STATES) {
      const sentence = describeFreedom(SAMPLES[state], VISE_NAMES)
      expect(sentence.length, state).toBeGreaterThan(0)
      expect(sentence.endsWith('.'), state).toBe(true)
    }
  })

  it('no sentence counts degrees of freedom - no number, no "DOF", no jargon', () => {
    const plain = { mover: 'The block', contacts: ['the vise floor', 'the fixed jaw', 'the end stop'], axis: 'the chuck axis' }
    for (const state of SEAT_FREEDOM_STATES) {
      const sentence = describeFreedom(SAMPLES[state], plain)
      expect(sentence, state).not.toMatch(/\d/)
      expect(sentence, state).not.toMatch(/\bdof\b|degree|constrain|freedom/i)
    }
  })

  it('reads without any names at all - it never throws and never leaves a blank', () => {
    for (const state of SEAT_FREEDOM_STATES) {
      const sentence = describeFreedom(SAMPLES[state])
      expect(sentence, state).toMatch(/^The part\b/)
      expect(sentence, state).not.toMatch(/undefined|null|\s{2}/)
    }
  })

  it('a direction earns a machine-axis name only when there is no face to name it after', () => {
    const alongY: SeatFreedom = { state: 'along-line', direction: { x: 0, y: 1, z: 0 } }
    expect(describeFreedom(alongY, { mover: 'The block', contacts: ['the table'] }))
      .toBe('The block sits flat on the table, squared against the second face. It can still slide along Y.')
    // A skew direction with nothing to name it after falls back to the face.
    const skew: SeatFreedom = { state: 'along-line', direction: { x: 1, y: 1, z: 0 } }
    expect(describeFreedom(skew, { mover: 'The block', contacts: ['the table'] }))
      .toBe('The block sits flat on the table, squared against the second face. It can still slide along the second face.')
  })

  it('the coaxial states read the way the review wrote them', () => {
    expect(describeFreedom(SAMPLES['on-axis'], { mover: 'Part', axis: 'the chuck axis' }))
      .toBe('Part is on the chuck axis. It can still slide along the axis and turn about it.')
    expect(describeFreedom(SAMPLES['about-axis'], { mover: 'Part', axis: 'the chuck axis', contacts: ['the chuck bore', 'the chuck face'] }))
      .toBe('Part is on the chuck axis, against the chuck face. It can still turn about it.')
  })
})
