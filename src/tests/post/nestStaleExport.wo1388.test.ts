// ============================================================
// WO-1388: Post exports an outdated nest layout after its gap changes
// ============================================================
// A nest edit (gap/solver/style/seed) sets NestRecord.needsRecompute, but the
// seed geometry's own loops are untouched, so the seed op's OWN generation
// fingerprint still matches and buildPostInput's existing
// operationGenerationIsCurrent gate never catches it — Post kept exporting the
// stale placements. Decided (WO-1388): no new nest-specific export gate. A
// nest that needs recompute is the same situation as any other outdated
// operation, so buildPostInput downgrades the seed op's status to 'outdated'
// the same way operationGenerationIsCurrent already does, reusing
// validateOpsCurrent's existing OP_OUTDATED diagnostic.

import { describe, it, expect } from 'vitest'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { postProgram } from '../../lib/post'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'
import type {
  ImportedGeometry,
  NestRecord,
  Operation,
  Project,
  Setup,
} from '../../types'

// --- fixtures ----------------------------------------------------------------

const SEED_GEO_ID = 'seed-1'
const NEST_ID = 'nest-1'

/** An owned-seed geometry: the integrated copy a nest packs (ownerNestId set). */
function seedGeometry(): ImportedGeometry {
  return {
    id: SEED_GEO_ID,
    name: 'Seed Part',
    filename: '',
    type: 'imported',
    format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 },
      center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ownerNestId: NEST_ID,
  } as unknown as ImportedGeometry
}

/** The nest: one source (the seed), 2 placements at distinct sheet XY. */
function makeNest(overrides: Partial<NestRecord> = {}): NestRecord {
  return {
    id: NEST_ID,
    name: 'Nest 1',
    sheet: { width: 200, height: 200 },
    style: 'ninety',
    spacing: {} as NestRecord['spacing'],
    seed: 1,
    sources: [{ geometryId: SEED_GEO_ID, quantity: 2 }],
    placements: [
      { partId: SEED_GEO_ID, instanceId: 'i0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: SEED_GEO_ID, instanceId: 'i1', x: 50, y: 40, rotationDeg: 0, depth: 0 },
    ],
    unplaced: [],
    utilization: 0.5,
    origin: { x: 0, y: 0 },
    needsRecompute: false,
    ...overrides,
  } as unknown as NestRecord
}

/** A computed seed op (pocket/contour, NOT drill), bound to the seed geometry.
 *  Stores 2 seed-LOCAL moves: a rapid down to feed Z then a cut at X10. */
function seedOp(): Operation {
  return makeOp({
    id: 'seed-op',
    name: 'Seed Contour',
    type: 'contour_2d',
    toolId: 't1',
    params: { geometryId: SEED_GEO_ID },
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 10, y: 0, z: -2, feed: 2000, role: 'cut' }),
    ],
  })
}

function makeSetup(ops: Operation[]): Setup {
  return {
    id: 's1',
    name: 'Setup 1',
    wcs: makeWcs(),
    stock: {} as Setup['stock'],
    operations: ops,
    notes: '',
  }
}

function makeProject(setup: Setup, nests: NestRecord[]): Project {
  return {
    id: 'p1',
    name: 'P',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [seedGeometry()],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    nests,
    notes: '',
  } as unknown as Project
}

// --- tests -------------------------------------------------------------------

describe('buildPostInput — stale nest export refusal (WO-1388)', () => {
  it('downgrades a nest seed op to outdated when its nest needs recompute, even though the op is otherwise generation-current', () => {
    const setup = makeSetup([seedOp()])
    const nest = makeNest({ needsRecompute: true })
    const project = makeProject(setup, [nest])
    const op = setup.operations[0]
    // Stamp the op generation-current against these EXACT inputs — proves
    // operationGenerationIsCurrent alone would say "ready to post"; only the
    // nest's own needsRecompute flag makes this stale.
    stampGenerationCurrent(project, setup, op, project.toolLibrary[0])

    const input = buildPostInput(project, setup)
    const seedSections = input.setup.operations.filter((o) => o.op.id === 'seed-op')
    expect(seedSections.length).toBeGreaterThan(0)
    for (const section of seedSections) {
      expect(section.op.status).toBe('outdated')
    }

    // The existing fail-loud gate (validateOpsCurrent's OP_OUTDATED) refuses
    // the post — no new nest-specific diagnostic code.
    const result = postProgram(input, UCCNC_CONFIG)
    expect(result.ok).toBe(false)
    expect(
      result.diagnostics.some((d) => d.code === 'OP_OUTDATED' && d.opId === 'seed-op'),
    ).toBe(true)
  })

  it('posts the CURRENT placements once the nest is recomputed', () => {
    const setup = makeSetup([seedOp()])
    // Recompute moved copy 1 for a wider gap (x:70 instead of x:50) and
    // cleared needsRecompute, exactly like a real Recompute click.
    const nest = makeNest({
      needsRecompute: false,
      placements: [
        { partId: SEED_GEO_ID, instanceId: 'i0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
        { partId: SEED_GEO_ID, instanceId: 'i1', x: 70, y: 40, rotationDeg: 0, depth: 0 },
      ],
    })
    const project = makeProject(setup, [nest])
    const op = setup.operations[0]
    stampGenerationCurrent(project, setup, op, project.toolLibrary[0])

    const input = buildPostInput(project, setup)
    const seedSections = input.setup.operations.filter((o) => o.op.id === 'seed-op')
    expect(seedSections.length).toBeGreaterThan(0)
    expect(seedSections.every((s) => s.op.status === 'ready')).toBe(true)

    // Copy 1's cut endpoint reflects the NEW gap (10 local + 70 placement =
    // X80), not the stale X60 the old gap would have produced.
    const seedXs = seedSections.flatMap((s) => s.moves.map((m) => m.x))
    expect(seedXs).toContain(80)
    expect(seedXs).not.toContain(60)

    const result = postProgram(input, UCCNC_CONFIG)
    expect(result.ok).toBe(true)
  })
})
