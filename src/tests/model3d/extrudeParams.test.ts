// WO UI-51A: the direction x booleanMode CENSUS and every accept/refuse path
// of the shared extrude request builder, as a pure unit test (no page, no
// kernel). This is the "derived completeness" gate: the matrix below is the
// full Cartesian product EXTRUDE_DIRECTIONS x EXTRUDE_BOOL_MODES, and each
// cell asserts the exact frozen ExtrudeRequest the executor will hand to
// makeExtrude -- so a mangled mapping (wrong end sign, wrong op, dropped
// target) is caught here, not in a slow real-kernel run. The refusal block
// enumerates every named failure the executor relies on (charter rules 2/3).

import { describe, it, expect } from 'vitest'
import {
  buildExtrudeRequest,
  extrudeKernelOp,
  resolveExtrudeEnd,
  EXTRUDE_DIRECTIONS,
  EXTRUDE_BOOL_MODES,
  EXTRUDE_END_CONDITIONS,
  type ExtrudeDirection,
  type ExtrudeBoolMode,
} from '../../components/model3d/workbench/extrudeParams'
import type {
  BodyHandle,
  ExtrudePlaneTargetIdentity,
  ExtrudeTargetIdentity,
  PlaneDef,
  ProfileRegion,
  ResolvedExtrudeTarget,
} from '../../geom/geom-service'

const PROFILE: ProfileRegion = {
  sketchId: 'SK1',
  plane: { origin: { x: 0, y: 0, z: 0 }, xDir: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
  loops: [
    [
      { kind: 'line', a: [0, 0], b: [10, 0], srcId: 'SK1.e0' },
      { kind: 'line', a: [10, 0], b: [10, 10], srcId: 'SK1.e1' },
      { kind: 'line', a: [10, 10], b: [0, 10], srcId: 'SK1.e2' },
      { kind: 'line', a: [0, 10], b: [0, 0], srcId: 'SK1.e3' },
    ],
  ],
}

const TARGET_HANDLE = 77 as BodyHandle
const liveTarget = (id: string): BodyHandle | undefined => (id === 'B1' ? TARGET_HANDLE : undefined)

// Expected kernel op per UI mode -- the ONE translation ('remove' -> 'cut').
const EXPECTED_OP: Record<ExtrudeBoolMode, string> = {
  newBody: 'newBody',
  add: 'add',
  remove: 'cut',
  intersect: 'intersect',
}
// Expected frozen ExtrudeEnd per direction at magnitude 10.
const EXPECTED_END: Record<ExtrudeDirection, { kind: string; distance?: number }> = {
  up: { kind: 'blind', distance: 10 },
  down: { kind: 'blind', distance: -10 },
  midplane: { kind: 'symmetric', distance: 10 },
}

describe('extrudeParams direction x booleanMode census (WO UI-51A)', () => {
  it('the union tuples are exactly the closed vocabularies (nothing drifted in)', () => {
    expect([...EXTRUDE_DIRECTIONS]).toEqual(['up', 'down', 'midplane'])
    expect([...EXTRUDE_BOOL_MODES]).toEqual(['newBody', 'add', 'remove', 'intersect'])
  })

  // 3 directions x 4 modes = 12 cells; every cell maps to the expected frozen
  // request with the target attached iff the mode is not newBody.
  for (const direction of EXTRUDE_DIRECTIONS) {
    for (const boolMode of EXTRUDE_BOOL_MODES) {
      it(`cell direction=${direction} x mode=${boolMode}: maps to the expected frozen ExtrudeRequest`, () => {
        const build = buildExtrudeRequest({
          featureId: 'F1',
          payload: { direction, boolMode, targetFeatureId: 'B1' },
          profiles: [PROFILE],
          distance: 10,
          lookupTarget: liveTarget,
        })
        expect(build.ok).toBe(true)
        if (!build.ok) return
        expect(build.req.featureId).toBe('F1')
        expect(build.req.op).toBe(EXPECTED_OP[boolMode])
        expect(build.req.end).toEqual(EXPECTED_END[direction])
        if (boolMode === 'newBody') {
          expect(build.req.target).toBeUndefined()
          expect(build.hideTargetId).toBeUndefined()
        } else {
          expect(build.req.target).toBe(TARGET_HANDLE)
          expect(build.hideTargetId).toBe('B1')
        }
      })
    }
  }

  it('extrudeKernelOp translates ONLY remove->cut; every other mode is identity', () => {
    expect(extrudeKernelOp('newBody')).toBe('newBody')
    expect(extrudeKernelOp('add')).toBe('add')
    expect(extrudeKernelOp('remove')).toBe('cut')
    expect(extrudeKernelOp('intersect')).toBe('intersect')
  })

  it('resolveExtrudeEnd: down is a NEGATIVE blind magnitude, never a caller sign', () => {
    expect(resolveExtrudeEnd('up', 8)).toEqual({ ok: true, end: { kind: 'blind', distance: 8 } })
    expect(resolveExtrudeEnd('down', 8)).toEqual({ ok: true, end: { kind: 'blind', distance: -8 } })
    expect(resolveExtrudeEnd('midplane', 8)).toEqual({ ok: true, end: { kind: 'symmetric', distance: 8 } })
  })
})

describe('extrudeParams accept/refuse enumeration (WO UI-51A)', () => {
  const base = { featureId: 'F1', profiles: [PROFILE], lookupTarget: liveTarget }

  it('distance <= 0 refuses BY NAME (closes the silent anti-normal path -- down is direction, not sign)', () => {
    for (const bad of [0, -5, -0.0001]) {
      const r = buildExtrudeRequest({ ...base, payload: { direction: 'up', boolMode: 'newBody' }, distance: bad })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/positive magnitude/i)
    }
  })

  it('non-finite distance (NaN/Infinity) refuses BY NAME -- never sails through a comparison', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = buildExtrudeRequest({ ...base, payload: { direction: 'up', boolMode: 'newBody' }, distance: bad })
      expect(r.ok).toBe(false)
    }
  })

  it('unknown direction / boolMode refuse BY NAME (never coerced to a default)', () => {
    const d = buildExtrudeRequest({ ...base, payload: { direction: 'sideways', boolMode: 'newBody' }, distance: 10 })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/unknown extrude direction/i)
    const m = buildExtrudeRequest({ ...base, payload: { direction: 'up', boolMode: 'subtractish' }, distance: 10 })
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.reason).toMatch(/unknown extrude boolean mode/i)
  })

  it('undefined direction/boolMode default to the legacy up/newBody (migration compat), NOT a refusal', () => {
    const r = buildExtrudeRequest({ ...base, payload: {}, distance: 10 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.req.end).toEqual({ kind: 'blind', distance: 10 })
    expect(r.req.op).toBe('newBody')
    expect(r.req.target).toBeUndefined()
  })

  it('add/remove/intersect with a missing/empty target refuse BY NAME', () => {
    for (const boolMode of ['add', 'remove', 'intersect'] as ExtrudeBoolMode[]) {
      for (const targetFeatureId of [undefined, '']) {
        const r = buildExtrudeRequest({ ...base, payload: { direction: 'up', boolMode, targetFeatureId }, distance: 10 })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toMatch(/requires a target body/i)
      }
    }
  })

  it('self-target refuses BY NAME (a feature cannot consume its own body)', () => {
    const r = buildExtrudeRequest({ ...base, payload: { direction: 'up', boolMode: 'remove', targetFeatureId: 'F1' }, distance: 10 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/cannot target itself/i)
  })

  it('a target with no live handle (missing OR already consumed) refuses BY NAME', () => {
    const r = buildExtrudeRequest({ ...base, payload: { direction: 'up', boolMode: 'add', targetFeatureId: 'GHOST' }, distance: 10 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/has no live body/i)
  })

  it('newBody ignores a stray targetFeatureId (switching a saved cut back to New body must not wedge)', () => {
    const r = buildExtrudeRequest({ ...base, payload: { direction: 'up', boolMode: 'newBody', targetFeatureId: 'GHOST' }, distance: 10 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.req.target).toBeUndefined()
    expect(r.hideTargetId).toBeUndefined()
  })
})

describe('WO-214 persisted extrude end-condition request mapping', () => {
  const MODEL = 'MODEL-1'
  const FACE_TARGET: ExtrudeTargetIdentity = {
    modelItemId: MODEL,
    bodyFeatureId: 'B1',
    subshape: { kind: 'face', stableId: 'B1:BOX:+Z', lineage: ['B0:BOX:+Z'] },
  }
  const VERTEX_TARGET: ExtrudeTargetIdentity = {
    modelItemId: MODEL,
    bodyFeatureId: 'B1',
    subshape: { kind: 'vertex', stableId: '(B1:BOX:+X<AND>B1:BOX:+Y<AND>B1:BOX:+Z)' },
  }
  const BODY_TARGET: ExtrudeTargetIdentity = { modelItemId: MODEL, bodyFeatureId: 'B1' }
  const PLANE_TARGET: ExtrudePlaneTargetIdentity = { modelItemId: MODEL, planeFeatureId: 'datum:XY' }
  const PLANE_DEF: PlaneDef = {
    origin: { x: 0, y: 0, z: 12 },
    normal: { x: 0, y: 0, z: 1 },
    xDir: { x: 1, y: 0, z: 0 },
  }
  const CANDIDATES: ResolvedExtrudeTarget[] = [{ identity: BODY_TARGET, body: TARGET_HANDLE }]
  const base = {
    featureId: 'F1',
    profiles: [PROFILE],
    distance: 10,
    lookupTarget: liveTarget,
    lookupPlaneTarget: (id: string) => id === PLANE_TARGET.planeFeatureId ? PLANE_DEF : undefined,
    modelItemId: MODEL,
    candidateTargets: CANDIDATES,
  }

  it('publishes the complete closed end-condition vocabulary', () => {
    expect([...EXTRUDE_END_CONDITIONS]).toEqual(['blind', 'symmetric', 'upToNext', 'toFace', 'toPart', 'toVertex', 'throughAll'])
  })

  it.each([
    ['upToNext', undefined, { kind: 'upToNext', direction: 1, candidates: CANDIDATES, offset: -2 }],
    ['toFace', FACE_TARGET, { kind: 'toFace', direction: 1, target: { identity: FACE_TARGET, body: TARGET_HANDLE }, offset: -2 }],
    ['toFace', PLANE_TARGET, { kind: 'toFace', direction: 1, target: { identity: PLANE_TARGET, plane: PLANE_DEF }, offset: -2 }],
    ['toPart', BODY_TARGET, { kind: 'toPart', direction: 1, target: { identity: BODY_TARGET, body: TARGET_HANDLE }, offset: -2 }],
    ['toVertex', VERTEX_TARGET, { kind: 'toVertex', direction: 1, target: { identity: VERTEX_TARGET, body: TARGET_HANDLE }, offset: -2 }],
  ] as const)('maps %s with its signed terminal offset and stable target', (endCondition, endTarget, expected) => {
    const r = buildExtrudeRequest({
      ...base,
      payload: { direction: 'up', boolMode: 'newBody', endCondition, terminalOffset: -2, endTarget },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.req.end).toEqual(expected)
  })

  it('maps Through all in either one direction or symmetric mode', () => {
    const up = buildExtrudeRequest({ ...base, payload: { direction: 'up', boolMode: 'newBody', endCondition: 'throughAll' } })
    const symmetric = buildExtrudeRequest({ ...base, payload: { direction: 'midplane', boolMode: 'newBody', endCondition: 'throughAll' } })
    expect(up.ok && up.req.end).toEqual({ kind: 'throughAll', direction: 1, targets: CANDIDATES, symmetric: false })
    expect(symmetric.ok && symmetric.req.end).toEqual({ kind: 'throughAll', direction: 1, targets: CANDIDATES, symmetric: true })
  })

  it('preserves reverse direction independently from terminal offset sign', () => {
    const r = buildExtrudeRequest({
      ...base,
      payload: { direction: 'down', boolMode: 'newBody', endCondition: 'toFace', terminalOffset: 3, endTarget: FACE_TARGET },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.req.end).toEqual({ kind: 'toFace', direction: -1, target: { identity: FACE_TARGET, body: TARGET_HANDLE }, offset: 3 })
  })

  it('re-resolves a persisted standalone datum-plane identity to its current plane definition', () => {
    const rebuiltPlane = { ...PLANE_DEF, origin: { x: 0, y: 0, z: 18 } }
    const r = buildExtrudeRequest({
      ...base,
      lookupPlaneTarget: (id) => id === PLANE_TARGET.planeFeatureId ? rebuiltPlane : undefined,
      payload: { direction: 'up', boolMode: 'newBody', endCondition: 'toFace', endTarget: PLANE_TARGET },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.req.end).toEqual({ kind: 'toFace', direction: 1, target: { identity: PLANE_TARGET, plane: rebuiltPlane }, offset: 0 })
  })

  it('uses the boolean target as Through all scope when no separate census is supplied', () => {
    const r = buildExtrudeRequest({
      ...base,
      candidateTargets: undefined,
      payload: { direction: 'up', boolMode: 'remove', targetFeatureId: 'B1', endCondition: 'throughAll' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.req.target).toBe(TARGET_HANDLE)
    expect(r.req.end).toEqual({ kind: 'throughAll', direction: 1, targets: CANDIDATES, symmetric: false })
  })

  it.each([
    [{ direction: 'up', boolMode: 'newBody', endCondition: 'toFace' }, /stable target identity/i],
    [{ direction: 'up', boolMode: 'newBody', endCondition: 'toFace', endTarget: BODY_TARGET }, /stable face id/i],
    [{ direction: 'up', boolMode: 'newBody', endCondition: 'toPart', endTarget: FACE_TARGET }, /body target/i],
    [{ direction: 'midplane', boolMode: 'newBody', endCondition: 'toVertex', endTarget: VERTEX_TARGET }, /does not support a symmetric direction/i],
    [{ direction: 'up', boolMode: 'newBody', endCondition: 'toFace', terminalOffset: Infinity, endTarget: FACE_TARGET }, /offset must be finite/i],
  ])('refuses malformed or unsupported end-condition payload %# by name', (payload, reason) => {
    const r = buildExtrudeRequest({ ...base, payload })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(reason)
  })

  it('refuses lost and cross-Model-Item targets rather than falling back to Blind', () => {
    const lost = buildExtrudeRequest({
      ...base,
      payload: { direction: 'up', boolMode: 'newBody', endCondition: 'toFace', endTarget: { ...FACE_TARGET, bodyFeatureId: 'GHOST' } },
    })
    expect(lost.ok).toBe(false)
    if (!lost.ok) expect(lost.reason).toMatch(/no live body/i)

    const foreign = buildExtrudeRequest({
      ...base,
      payload: { direction: 'up', boolMode: 'newBody', endCondition: 'toFace', endTarget: { ...FACE_TARGET, modelItemId: 'MODEL-2' } },
    })
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) expect(foreign.reason).toMatch(/not 'MODEL-1'/i)

    const lostPlane = buildExtrudeRequest({
      ...base,
      payload: { direction: 'up', boolMode: 'newBody', endCondition: 'toFace', endTarget: { ...PLANE_TARGET, planeFeatureId: 'datum:lost' } },
    })
    expect(lostPlane.ok).toBe(false)
    if (!lostPlane.ok) expect(lostPlane.reason).toMatch(/no live plane definition/i)

    const foreignPlane = buildExtrudeRequest({
      ...base,
      payload: { direction: 'up', boolMode: 'newBody', endCondition: 'toFace', endTarget: { ...PLANE_TARGET, modelItemId: 'MODEL-2' } },
    })
    expect(foreignPlane.ok).toBe(false)
    if (!foreignPlane.ok) expect(foreignPlane.reason).toMatch(/not 'MODEL-1'/i)
  })
})
