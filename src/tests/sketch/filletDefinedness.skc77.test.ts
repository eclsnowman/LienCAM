// SKC-77 (Operator, from the road): fillet all 4 corners of a fully-defined
// sketch (H/V + coincident corners + position anchor + 2 driving dims) and
// the sketch status FLIPS to under-defined -- even though every fillet gets
// its own driving radius dimension exactly as the tool's step-2 banner
// promises ("a driving radius dimension you can edit later").
//
// ROOT CAUSE (coordination/reports/SKC-77.report.md has the full derivation
// and DOF evidence): each fillet JOINT (arc endpoint <-> line endpoint, tied
// by a coincident PLUS a tangent -- filletTool.ts's `joints` array, present
// since the tool's very first radius-dim commit, cae81ad6a) is geometrically
// unique and correctly solved (DogLeg never drifts), but is RANK-DEFICIENT
// in planegcs's raw dof() by exactly 1 per joint: a line and an arc that are
// TANGENT at a point have parallel tangent directions there, so the
// coincident's own linearization cannot distinguish "slide along the line"
// from "slide around the arc" to first order. C5 (benignFilletTangentIds,
// gcsMapping.ts) already discounts this from the "N redundant" advisory
// banner, but never touched the separate DOF/definedness readout this test
// pins -- that gap is what SKC-77 closes (groundFilletJointPrimitives /
// adjustedFilletJointDof, gcsMapping.ts).
//
// LONGSTANDING, not a fresh regression: the joint shape this bug lives in is
// byte-identical back to cae81ad6a (months before this week's SKC-74/75/76
// batch) -- verified via `git show cae81ad6a:src/lib/sketch/tools/
// filletTool.ts`. This week's phantom-corner/node-pick work never touched
// it and is not implicated.
//
// PARITY: both sketch hosts (CAM's src/store/index.ts and the Model
// workspace's workbenchSketchDocumentPort.ts) route through this SAME
// shared solveSketchOnWrapper (sketchSolverWorker.ts is host-neutral
// transport around it) -- one fix, both hosts, proven structurally by the
// single shared entry point plus real-app headed evidence in both hosts
// (coordination/evidence/SKC-77-FILLET-UNDEFINED/).

import { describe, it, expect, beforeAll } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { injectSketchAnchors } from '../../lib/sketch/sketchAnchors'
import { buildRectCommit } from '../../lib/sketch/tools/rectTools'
import { filletApplyAll, filletSeedFromSelection } from '../../lib/sketch/tools/filletTool'
import type { GcsWrapper } from '@salusoft89/planegcs'
import type { Sketch, SketchDimension, SketchEntity, SketchConstraint } from '../../lib/sketch/types'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function idFactory(prefix: string): () => string {
  let n = 0
  return () => `${prefix}${n++}`
}

async function solveFullyAnchored(wrapper: GcsWrapper, sketch: Sketch) {
  return solveSketchOnWrapper(wrapper, injectSketchAnchors(sketch, { x: 0, y: 0 }))
}

describe('SKC-77: filleting a fully-defined sketch stays fully defined', () => {
  let wrapper: GcsWrapper
  beforeAll(async () => {
    wrapper = await createGcsWrapper()
  })

  it('Erics exact saved repro (80x60 rect, 4x R12 fillets) solves to dof 0, every real entity defined', async () => {
    const raw = JSON.parse(readFileSync(
      path.resolve(__dirname, '../fixtures/skc77/sampleRectFilletsSketch.json'), 'utf8',
    )) as {
      id: string; layerId: string
      entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDimension[]
    }
    const sketch: Sketch = {
      id: raw.id,
      layerId: raw.layerId,
      entities: raw.entities,
      constraints: raw.constraints,
      dimensions: raw.dimensions,
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
    const outcome = await solveFullyAnchored(wrapper, sketch)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.status.conflicting).toEqual([])
    // The header chip (SketchToolbox.tsx SketchDefinitionChip) reads exactly
    // this field to decide "Fully defined" vs "N DoF" -- this is Operator's bug,
    // pinned at the field his screenshot's flipped status came from.
    expect(outcome.status.dof).toBe(0)
    const defined = new Set(outcome.status.fullyDefinedEntities ?? [])
    for (const e of sketch.entities) {
      expect(defined.has(e.id), `entity ${e.id} (${e.kind}) should be fully defined`).toBe(true)
    }
  })

  it('from-scratch fully-defined 80x60 rect stays fully defined after EACH of 1/2/3/4 sequential fillets', async () => {
    const newId = idFactory('e')
    const commit = buildRectCommit({ x: -40, y: -30 }, { x: 40, y: 30 }, false, newId)
    const centerPoint = commit.entities.find((e) => e.kind === 'point' && e.construction)
    if (!centerPoint) throw new Error('expected the D1 construction center point')
    const dims: SketchDimension[] = [
      {
        id: newId(), kind: 'distanceX', driving: true, value: 80,
        a: { entityId: commit.entities[0].id, site: 'start' },
        b: { entityId: commit.entities[2].id, site: 'start' },
        labelAnchor: { x: 0, y: 40 },
      },
      {
        id: newId(), kind: 'distanceY', driving: true, value: 60,
        a: { entityId: commit.entities[0].id, site: 'start' },
        b: { entityId: commit.entities[2].id, site: 'start' },
        labelAnchor: { x: 50, y: 0 },
      },
    ]
    let sketch: Sketch = {
      id: 'sk', layerId: 'layer', entities: commit.entities,
      constraints: [
        ...commit.constraints,
        { id: newId(), kind: 'fix', point: { entityId: centerPoint.id, site: 'self' } },
      ],
      dimensions: dims, solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }

    const baseline = await solveFullyAnchored(wrapper, sketch)
    expect(baseline.ok).toBe(true)
    if (baseline.ok) expect(baseline.status.dof).toBe(0)

    const lineIds = commit.entities.filter((e) => e.kind === 'line').map((e) => e.id)
    for (let step = 1; step <= 4; step++) {
      const cornerLineA = lineIds[step - 1]
      const cornerLineB = lineIds[step % 4]
      const corners = filletSeedFromSelection(sketch.entities, [cornerLineA, cornerLineB])
      expect(corners.length).toBeGreaterThan(0)
      const result = filletApplyAll(sketch, corners, 8, idFactory(`f${step}_`))
      expect(result.transform).not.toBeNull()
      if (!result.transform) continue
      sketch = { ...sketch, ...result.transform }
      const outcome = await solveFullyAnchored(wrapper, sketch)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.status.dof, `dof after ${step} fillet(s)`).toBe(0)
      const defined = new Set(outcome.status.fullyDefinedEntities ?? [])
      for (const e of sketch.entities) {
        expect(defined.has(e.id), `after ${step} fillet(s): entity ${e.id} (${e.kind}) should be defined`).toBe(true)
      }
    }
  })

  it('a sketch with no fillets is completely unaffected (fast-path no-op)', async () => {
    const newId = idFactory('p')
    const a = newId(), b = newId()
    const sketch: Sketch = {
      id: 'sk-plain', layerId: 'layer',
      entities: [
        { id: a, kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      ],
      constraints: [{ id: newId(), kind: 'horizontal', line: a }],
      dimensions: [{
        id: newId(), kind: 'distance', driving: true, value: 10,
        a: { entityId: a, site: 'start' }, b: { entityId: a, site: 'end' },
        labelAnchor: { x: 5, y: 5 },
      }],
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
    void b
    const outcome = await solveFullyAnchored(wrapper, sketch)
    expect(outcome.ok).toBe(true)
    // Still under-defined (position is free) -- proves the fix does not
    // silently zero out dof for ordinary geometry with genuine free DoF.
    if (outcome.ok) expect(outcome.status.dof).toBeGreaterThan(0)
  })
})
