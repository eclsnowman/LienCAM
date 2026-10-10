// WO UI-57-R2: the merged-away-face fixture, extracted so the R1 healing suite
// (faceOffsetHealing.test.ts) and the R2 proof matrix (aliasLineageMatrix.test
// .ts) drive ONE fixture rather than a copy that can drift. Every helper here
// drives the REAL exported production functions on a REAL occt-wasm kernel --
// there is no stub engine and no hand-authored delta anywhere in this file.
//
// The fixture's whole job is to produce the thing the R0 suite never had: a
// merged-away PRE-EXISTING StableId. A generated prism face losing a merge
// proves nothing (a generated id gets no alias), which is why the R0 mutation
// proof could disable the alias lookup outright and stay 5/5 green.
import { expect } from 'vitest'
import type { GeomEngine } from '../../../geom/worker/geom-engine.ts'
import type { BodyHandle, ProfileRegion, StableId } from '../../../geom/geom-service.ts'
import { rectLoop, xyPlane } from './profiles.ts'

/** Block A (x 0..30, z 0..10) and block B (x 30..60, z 0..6); pulling B's top
 *  up by 4 makes the two tops coplanar, and healing merges them into one. */
export const STEP = { ax1: 30, bx1: 60, y: 30, az: 10, bz: 6, pull: 4 }

function rect(sketchId: string, x0: number, x1: number): ProfileRegion {
  return { sketchId, plane: xyPlane(0), loops: [rectLoop(sketchId, x0, 0, x1, STEP.y)] }
}

/** The stepped two-block body: A (x 0..30, z 0..10) fused with B (x 30..60,
 *  z 0..6). Both blocks' ids are PRE-EXISTING by the time the faceOffset runs. */
export async function stepBody(engine: GeomEngine): Promise<BodyHandle> {
  const a = await engine.makeExtrude({
    featureId: 'FA', profile: rect('SA', 0, STEP.ax1), end: { kind: 'blind', distance: STEP.az }, op: 'newBody',
  })
  expect(a.ok, `step fixture: block A extrude failed: ${JSON.stringify(a.diagnostics)}`).toBe(true)
  const b = await engine.makeExtrude({
    featureId: 'FB', profile: rect('SB', STEP.ax1, STEP.bx1), end: { kind: 'blind', distance: STEP.bz },
    op: 'add', target: a.body!,
  })
  expect(b.ok, `step fixture: block B add-extrude failed: ${JSON.stringify(b.diagnostics)}`).toBe(true)
  return b.body!
}

/** Find the ONE face matching `pred`. Fails loud on 0 or >1 -- a fixture that
 *  silently picked "the first plausible face" would make every assertion that
 *  uses it meaningless (charter item 2: a probe that cannot fail is not a gate). */
export function faceWhere(
  engine: GeomEngine, body: BodyHandle, what: string,
  pred: (s: { type: string; centroid: number[]; area: number; normal?: number[] }) => boolean,
): StableId {
  const snaps = engine.snapshotsFor(body)
  const hits = Object.entries(snaps).filter(([, s]) => pred(s as never))
  if (hits.length !== 1) {
    throw new Error(`fixture: expected exactly 1 face for "${what}", found ${hits.length}: ${hits.map(([id]) => id).join(', ')}`)
  }
  return hits[0][0] as StableId
}

export const topFaceAtZ = (engine: GeomEngine, body: BodyHandle, z: number, what: string): StableId =>
  faceWhere(engine, body, what, (s) =>
    s.type === 'plane' && !!s.normal && s.normal[2] > 0.999 &&
    Math.abs(s.centroid[2] - z) < 1e-6 && Math.abs(s.area - STEP.ax1 * STEP.y) < 1e-6)

export interface Merge { winner: StableId; loser: StableId }

/** Read the merge out of the delta the ENGINE emitted -- never hardcoded. The
 *  R0 audit requires capturing the ACTUAL losing id, because which of the two
 *  pre-existing contributors wins is an engine tie-break, not a test input. */
export function mergeOf(modified: Record<string, string[]>, a: StableId, b: StableId): Merge {
  const aTo = modified[a], bTo = modified[b]
  if (aTo?.length === 1 && aTo[0] === b) return { winner: b, loser: a }
  if (bTo?.length === 1 && bTo[0] === a) return { winner: a, loser: b }
  throw new Error(`expected exactly one of ${a}/${b} to be a merged-away loser of the other; got modified[${a}]=${JSON.stringify(aTo)}, modified[${b}]=${JSON.stringify(bTo)}`)
}

export interface HealedStep {
  body: BodyHandle
  merge: Merge
  before: BodyHandle
  topA: StableId
  topB: StableId
  /** The healing feature's OWN delta -- the one that carries the loser->winner
   *  pair. Every later feature's delta must re-state it (UI-57-R2's blocker). */
  elementMap: NonNullable<Awaited<ReturnType<GeomEngine['editFeature']>>['elementMap']>
  modified: Record<string, string[]>
  generated: string[]
  deleted: string[]
}

/** Build the step body, pull topB flush with topA, and return the captured
 *  merge plus the healed body. THE starting point of every alias proof. */
export async function healedStep(engine: GeomEngine): Promise<HealedStep> {
  const before = await stepBody(engine)
  const topA = topFaceAtZ(engine, before, STEP.az, 'block A top (z=10)')
  const topB = topFaceAtZ(engine, before, STEP.bz, 'block B top (z=6)')
  expect(topA, 'fixture: A and B tops must be DISTINCT pre-existing faces').not.toBe(topB)
  const r = await engine.editFeature({ featureId: 'E1', body: before, featureKey: topB as string, delta: STEP.pull, kind: 'faceOffset' })
  expect(r.ok, `healed pull failed: ${JSON.stringify(r.diagnostics)}`).toBe(true)
  expect(
    r.diagnostics.some((d) => /seam retained/i.test(String(d.params?.reason ?? ''))),
    `this fixture must actually HEAL (a "seam retained" fallback would make every alias assertion vacuous): ${JSON.stringify(r.diagnostics)}`,
  ).toBe(false)
  const modified = r.elementMap!.modified as Record<string, string[]>
  return {
    body: r.body!, merge: mergeOf(modified, topA, topB), before, topA, topB,
    elementMap: r.elementMap!, modified, generated: r.elementMap!.generated, deleted: r.elementMap!.deleted,
  }
}
