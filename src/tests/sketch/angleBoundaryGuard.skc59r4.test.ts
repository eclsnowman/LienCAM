// WO SKC-59-R4: boundary guard at the solver mapping's 'angle' case
// (gcsMapping.ts), per DECISIONS.md 2026-07-18 "SKC-59 census two-bounce
// STOP" ruling part 2.
//
// R2/R3 bounced the "mechanically derived accept-path census" criterion
// twice trying to PROVE, by static analysis, that every possible write to a
// dimension's value is signed correctly -- an unsound problem (enumerating
// every dataflow path in a dynamically-typed store). The ruling moves the
// actual INVARIANT to where it is sound BY CONSTRUCTION: every reverseB=true
// angle dimension must pass through gcsMapping's 'angle' case to reach the
// solver, so a fail-loud check placed exactly there catches a wrongly-signed
// value regardless of which write path produced it -- present or future,
// enumerated or not. signedAngleAcceptPathCensus.ts is demoted to a TRIPWIRE
// on top of this (see that file's own header).
//
// The predicate (reversedAngleValueSignValid, dimTool.ts) is NOT a fresh
// invention: it reuses angleSectorValue, the EXACT formula
// selectAngleSector already uses to derive a value from live geometry
// (`theta - sign(theta)*pi` for the far/obtuse pick) -- factored out so the
// producer (selectAngleSector) and this guard (the validator) can never
// define the convention differently.
//
// (a) a correctly-signed reverseB dim (Operator's exact case: a line directed
//     +37deg, far/obtuse pick, stored -143deg) maps through this case
//     without throwing.
// (b) a WRONG-signed reverseB dim -- built by writing the raw POSITIVE
//     typed magnitude directly with reverseB retained (exactly the SKC-59-R1
//     bug shape a normalizer-bypassing writer would produce) -- trips the
//     guard loudly at mapping time.
// (b2) the same wrong-signed dim, run through the FULL solve entry point
//      (solveSketchOnWrapper), surfaces as the SAME structured
//      { ok:false, reason:'invalid_sketch' } failure every other gcsMapping
//      guard already produces for bad input (ADR-0003) -- this IS the
//      "throw in dev/test, structured-log-and-refuse in prod" behavior the
//      WO asks for: solveSystem's try/catch around sketchToGcsPrimitives is
//      the ONE code path in both environments, so there is nothing
//      environment-conditional to add.
// (c) the guard only ever fires for reverseB=true -- a near-sector dim's
//     value sign is unconstrained (it equals theta's own sign, which is
//     either polarity depending on how the lines were drawn), so this guard
//     correctly does not touch it.
//
// The Operator-case END-TO-END (real store accept path, real planegcs) is
// already proven green with this guard active by
// angleDimSignedEdit.skc59.test.ts's "typed 120 (positive) on Operator's
// -143/reverseB=true dim..." test and camAxisAnchors.test.ts's SKC-58B
// no-motion suite -- both re-run this session as part of the family gate.
//
// SKC-59-R5 (cures coordination/reports/SKC-59-R4.audit.json C1/C2):
//
// C1 [blocker]: the R4 guard derived its expected-sign rule from
// angleSectorValue while signedAngleEditValue (dimTool.ts) kept its OWN
// untouched inline `dim.value < 0 ? -1 : 1` -- a second, independent
// definition of the same sign-convention predicate, exactly what the WO
// forbids. The sign decision is now factored into ONE exported function,
// `angleValueSign` (dimTool.ts, colocated with these two), and BOTH
// signedAngleEditValue and reversedAngleValueSignValid call it -- see the
// "no second implementation" structural test below.
//
// C2 [major]: the R4 guard unconditionally accepted EITHER sign whenever
// theta fell within PARALLEL_EPS_RAD (1e-3 rad) of 0 or +-pi -- a
// tolerance BAND, not a mathematical fact, that let a genuinely
// wrong-signed value (e.g. theta=+0.0001, the audit's own repro) sail
// through unvalidated. Test (d) below now proves that exact repro THROWS.
// The math only actually collapses at the three EXACT points theta=0,
// +pi, -pi (angleSectorValue's far target is a rotation of +-pi or exactly
// 0 there, and +pi/-pi -- like +0/-0 -- denote the SAME physical rotation,
// so sign carries no information at those three points ONLY); tests (e),
// (f), (g) prove both signs pass there, and the "one ULP away" unit tests
// below prove the bypass band itself is gone.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { sketchToGcsPrimitives, solveSketchOnWrapper, SketchMappingError } from '../../lib/sketch/solver/gcsMapping'
import { angleSectorValue, reversedAngleValueSignValid, angleValueSign } from '../../lib/sketch/tools/dimTool'
import type { Sketch, SketchLineEntity, SketchDimension } from '../../lib/sketch/types'

const rad = (d: number): number => (d * Math.PI) / 180

// Operator's exact pair: 'a' fixed along +X, 'b' directed +37deg -- theta(a,b) =
// +37deg, so the far/obtuse pick's correctly-signed value is 37-180=-143deg.
function sampleMachineSketch(storedValueDeg: number, reverseB: boolean | undefined): Sketch {
  const l1: SketchLineEntity = {
    id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
  }
  const l2: SketchLineEntity = {
    id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
    end: { x: 10 * Math.cos(rad(37)), y: 10 * Math.sin(rad(37)) },
  }
  const dim: SketchDimension = {
    id: 'ang', kind: 'angle', driving: true, value: rad(storedValueDeg), a: 'l1', b: 'l2',
    ...(reverseB !== undefined ? { reverseB } : {}),
  }
  return {
    id: 'sk', layerId: 'layer',
    entities: [l1, l2],
    constraints: [
      { id: 'f1s', kind: 'fix', point: { entityId: 'l1', site: 'start' } },
      { id: 'f1e', kind: 'fix', point: { entityId: 'l1', site: 'end' } },
      { id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } },
    ],
    dimensions: [dim],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

// General two-line reverseB=true fixture (SKC-59-R5): 'a' from (0,0) to
// `l1End`, 'b' from (0,0) to `l2End`, so lineAngle(a,b) is fully controlled
// by the two endpoints -- used to hit the exact degenerate theta values
// (0, +pi, -pi) that sampleMachineSketch's fixed +37deg pair cannot reach.
function twoLineSketch(
  l1End: { x: number; y: number }, l2End: { x: number; y: number },
  storedValue: number, reverseB: boolean,
): Sketch {
  const l1: SketchLineEntity = {
    id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: l1End,
  }
  const l2: SketchLineEntity = {
    id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: l2End,
  }
  const dim: SketchDimension = {
    id: 'ang', kind: 'angle', driving: true, value: storedValue, a: 'l1', b: 'l2', reverseB,
  }
  return {
    id: 'sk', layerId: 'layer', entities: [l1, l2],
    constraints: [
      { id: 'f1s', kind: 'fix', point: { entityId: 'l1', site: 'start' } },
      { id: 'f1e', kind: 'fix', point: { entityId: 'l1', site: 'end' } },
      { id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } },
    ],
    dimensions: [dim],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

describe('SKC-59-R4: gcsMapping boundary guard on reverseB angle dimensions', () => {
  it('(a) correctly-signed (Operator-exact: line@+37, far pick, stored -143deg) maps without throwing, as l2l_angle_pppp', () => {
    const sk = sampleMachineSketch(-143, true)
    const prims = sketchToGcsPrimitives(sk)
    const angPrim = prims.find((p) => p.id === 'ang')
    expect(angPrim?.type).toBe('l2l_angle_pppp')
  })

  it('(b) WRONG-signed (raw typed +120 written directly, reverseB retained -- the exact SKC-59-R1 bug shape) trips the guard loudly at mapping time', () => {
    const sk = sampleMachineSketch(120, true)
    expect(() => sketchToGcsPrimitives(sk)).toThrow(SketchMappingError)
    expect(() => sketchToGcsPrimitives(sk)).toThrow(/reversed-operand sign convention/)
  })

  it('(b2) the same wrong-signed dim surfaces as a structured invalid_sketch failure through the full solve entry point (ADR-0003, same path as every other gcsMapping guard)', async () => {
    const wrapper = await createGcsWrapper()
    const sk = sampleMachineSketch(120, true)
    const out = solveSketchOnWrapper(wrapper, sk)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toBe('invalid_sketch')
      expect(out.message).toMatch(/reversed-operand sign convention/)
    }
  })

  it('(c) reverseB=false (near sector) is never checked by this guard -- either sign maps without throwing', () => {
    const skPositive = sampleMachineSketch(37, false)
    const skNegative = sampleMachineSketch(-37, false)
    const skAbsent = sampleMachineSketch(37, undefined)
    expect(() => sketchToGcsPrimitives(skPositive)).not.toThrow()
    expect(() => sketchToGcsPrimitives(skNegative)).not.toThrow()
    expect(() => sketchToGcsPrimitives(skAbsent)).not.toThrow()
  })

  it('(d) SKC-59-R5 (cures C2): a wrong-signed value at a near-but-not-exactly-degenerate theta (0.0001rad -- INSIDE the old, now-removed 1e-3 tolerance band) trips the guard -- the R4 bypass window is closed', () => {
    // theta(a,b) ~ +0.0001rad: R4's tolerance band would have accepted
    // EITHER sign here unconditionally. It is not one of the three exact
    // degenerate points, so it must now validate normally -- expected sign
    // is negative (angleSectorValue(0.0001, true) ~ -pi), so a POSITIVE
    // stored value is a genuine contradiction.
    const sk = twoLineSketch(
      { x: 10, y: 0 },
      { x: 10 * Math.cos(0.0001), y: 10 * Math.sin(0.0001) },
      1.5, true,
    )
    expect(() => sketchToGcsPrimitives(sk)).toThrow(SketchMappingError)
    expect(() => sketchToGcsPrimitives(sk)).toThrow(/reversed-operand sign convention/)
  })

  it('(e) SKC-59-R5 (cures C2): theta=0 exactly (lines parallel, same direction) -- both signs of a reverseB value map without throwing, the predicate collapses at this exact point', () => {
    const skPos = twoLineSketch({ x: 10, y: 0 }, { x: 5, y: 0 }, 1.5, true)
    const skNeg = twoLineSketch({ x: 10, y: 0 }, { x: 5, y: 0 }, -1.5, true)
    expect(() => sketchToGcsPrimitives(skPos)).not.toThrow()
    expect(() => sketchToGcsPrimitives(skNeg)).not.toThrow()
  })

  it('(f) SKC-59-R5 (cures C2): theta=+pi exactly (lines parallel, opposite direction) -- both signs map without throwing', () => {
    const skPos = twoLineSketch({ x: 10, y: 0 }, { x: -5, y: 0 }, 0.2, true)
    const skNeg = twoLineSketch({ x: 10, y: 0 }, { x: -5, y: 0 }, -0.2, true)
    expect(() => sketchToGcsPrimitives(skPos)).not.toThrow()
    expect(() => sketchToGcsPrimitives(skNeg)).not.toThrow()
  })

  it('(g) SKC-59-R5 (cures C2): theta=-pi exactly (operands swapped from (f), the OTHER antiparallel branch cut) -- both signs map without throwing', () => {
    const skPos = twoLineSketch({ x: -5, y: 0 }, { x: 10, y: 0 }, 0.2, true)
    const skNeg = twoLineSketch({ x: -5, y: 0 }, { x: 10, y: 0 }, -0.2, true)
    expect(() => sketchToGcsPrimitives(skPos)).not.toThrow()
    expect(() => sketchToGcsPrimitives(skNeg)).not.toThrow()
  })
})

describe('SKC-59-R4/R5: reversedAngleValueSignValid + angleSectorValue + angleValueSign (pure helper unit contract)', () => {
  it('angleSectorValue matches Operator-exact numbers: theta=+37deg near=+37, far=-143', () => {
    const theta = rad(37)
    expect(angleSectorValue(theta, false) * 180 / Math.PI).toBeCloseTo(37, 6)
    expect(angleSectorValue(theta, true) * 180 / Math.PI).toBeCloseTo(-143, 6)
  })

  it('angleSectorValue flips correctly for a negative theta too: theta=-37deg near=-37, far=+143', () => {
    const theta = rad(-37)
    expect(angleSectorValue(theta, false) * 180 / Math.PI).toBeCloseTo(-37, 6)
    expect(angleSectorValue(theta, true) * 180 / Math.PI).toBeCloseTo(143, 6)
  })

  it('reversedAngleValueSignValid: theta=+37, reverseB value must be negative', () => {
    expect(reversedAngleValueSignValid(rad(37), rad(-120))).toBe(true)
    expect(reversedAngleValueSignValid(rad(37), rad(120))).toBe(false) // the R1 bug shape
  })

  it('reversedAngleValueSignValid: theta=-37 (lines drawn the OTHER way), reverseB value must be POSITIVE -- the guard is not a naive "always negative" rule', () => {
    expect(reversedAngleValueSignValid(rad(-37), rad(120))).toBe(true)
    expect(reversedAngleValueSignValid(rad(-37), rad(-120))).toBe(false)
  })

  it('SKC-59-R5 (cures C2): at the three EXACT degenerate points (theta=0, +pi, -pi) both signs are provably equivalent -- the predicate says so unconditionally, not via a tolerance band', () => {
    expect(reversedAngleValueSignValid(0, 1.5)).toBe(true)
    expect(reversedAngleValueSignValid(0, -1.5)).toBe(true)
    expect(reversedAngleValueSignValid(Math.PI, 0.2)).toBe(true)
    expect(reversedAngleValueSignValid(Math.PI, -0.2)).toBe(true)
    expect(reversedAngleValueSignValid(-Math.PI, 0.2)).toBe(true)
    expect(reversedAngleValueSignValid(-Math.PI, -0.2)).toBe(true)
  })

  it('SKC-59-R5 (cures C2): one ULP-scale step away from a degenerate point is NOT degenerate -- the old 1e-3 tolerance window is closed, wrong sign trips normally', () => {
    // R4 treated ANY theta within PARALLEL_EPS_RAD (1e-3) of 0/+-pi as
    // unconditionally valid for either sign. 1e-4 sits INSIDE that former
    // window but is not one of the three exact points -- it now validates
    // normally, exactly like any other non-degenerate angle.
    expect(reversedAngleValueSignValid(0.0001, -1.5)).toBe(true) // correct sign
    expect(reversedAngleValueSignValid(0.0001, 1.5)).toBe(false) // wrong sign, no longer bypassed
    expect(reversedAngleValueSignValid(Math.PI - 0.0001, -0.2)).toBe(true)
    expect(reversedAngleValueSignValid(Math.PI - 0.0001, 0.2)).toBe(false)
    expect(reversedAngleValueSignValid(-(Math.PI - 0.0001), 0.2)).toBe(true)
    expect(reversedAngleValueSignValid(-(Math.PI - 0.0001), -0.2)).toBe(false)
  })

  it('SKC-59-R5 (cures C1): angleValueSign matches signedAngleEditValue\'s documented sign contract (negative strictly negative, 0/-0 read positive)', () => {
    expect(angleValueSign(-5)).toBe(-1)
    expect(angleValueSign(5)).toBe(1)
    expect(angleValueSign(0)).toBe(1)
    expect(angleValueSign(-0)).toBe(1)
  })

  it('SKC-59-R5 (cures C1, blocker): angleValueSign is the ONLY sign-decision implementation in dimTool.ts -- signedAngleEditValue and reversedAngleValueSignValid both call it by name, and no second inline copy of the ternary survives anywhere else in the file', () => {
    const path = resolve(__dirname, '../../lib/sketch/tools/dimTool.ts')
    const source = readFileSync(path, 'utf8')
    const signTernary = /[a-zA-Z0-9_.]+\s*<\s*0\s*\?\s*-1\s*:\s*1/

    const extractFunctionBody = (fnName: string): string => {
      const marker = `export function ${fnName}(`
      const start = source.indexOf(marker)
      if (start === -1) throw new Error(`${fnName} not found in dimTool.ts`)
      const braceStart = source.indexOf('{', start)
      let depth = 0
      let i = braceStart
      for (; i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') {
          depth--
          if (depth === 0) { i++; break }
        }
      }
      return source.slice(start, i)
    }

    const angleValueSignBody = extractFunctionBody('angleValueSign')
    const signedAngleEditValueBody = extractFunctionBody('signedAngleEditValue')
    const reversedAngleValueSignValidBody = extractFunctionBody('reversedAngleValueSignValid')

    // The ternary is legally defined exactly once, inside angleValueSign.
    expect(angleValueSignBody).toMatch(signTernary)
    // Its two consumers call the shared function by name (import-identity/
    // structural proof)...
    expect(signedAngleEditValueBody).toMatch(/angleValueSign\(/)
    expect(reversedAngleValueSignValidBody).toMatch(/angleValueSign\(/)
    // ...and neither reimplements its own copy of the ternary.
    expect(signedAngleEditValueBody).not.toMatch(signTernary)
    expect(reversedAngleValueSignValidBody).not.toMatch(signTernary)
    // Whole-file check: strip angleValueSign's own (sole legal) body out and
    // confirm the ternary pattern does not appear anywhere else in the file.
    const rest = source.replace(angleValueSignBody, '')
    expect(rest).not.toMatch(signTernary)
  })
})
