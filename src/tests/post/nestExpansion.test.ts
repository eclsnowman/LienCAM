// ============================================================
// P7 (ADR 0024 Amendment 1): the post emits the EXPANDED multi-copy stream.
// ============================================================
// buildPostInput substitutes the nest expansion at the seam: a nest seed op is
// replaced by its full multi-copy sections (all copies + inter-copy travel,
// generated upstream as real ToolpathMove[]); the post only FORMATS them.
// A non-nest op in the same setup is untouched (byte-identical to today).

import { describe, it, expect } from 'vitest'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'
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
function makeNest(machiningOrder?: NestRecord['machiningOrder']): NestRecord {
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
    machiningOrder,
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

/** A plain (non-nest) op bound to no geometry, with its own unique coord. */
function plainOp(): Operation {
  return makeOp({
    id: 'plain-op',
    name: 'Plain',
    type: 'contour_2d',
    toolId: 't2',
    params: {},
    toolpathMoves: [
      move({ type: 'rapid', x: 99, y: 99, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 88, y: 88, z: -1, feed: 2000, role: 'cut' }),
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
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })],
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

describe('buildPostInput — nest expansion seam (P7, ADR 0024 Amd 1)', () => {
  it('substitutes the multi-copy expansion for a nest seed op', () => {
    const setup = makeSetup([seedOp(), plainOp()])
    const input = buildPostInput(makeProject(setup, [makeNest()]), setup)

    // The seed op's 2 local moves x 2 copies = 4 copy moves, PLUS inter-copy
    // travel between the copies -> strictly more than 2x the seed move count.
    const seedSections = input.setup.operations.filter((o) => o.op.id === 'seed-op')
    const totalSeedMoves = seedSections.reduce((n, s) => n + s.moves.length, 0)
    expect(totalSeedMoves).toBeGreaterThan(2 * 2) // > both copies alone (travel added)

    // Both copies' world positions appear: copy 0 cuts at X10 (local), copy 1 is
    // offset by the placement (x:50) -> a cut endpoint at X60.
    const seedXs = seedSections.flatMap((s) => s.moves.map((m) => m.x))
    expect(seedXs).toContain(10) // copy 0 cut endpoint
    expect(seedXs).toContain(60) // copy 1 cut endpoint (10 + 50)

    // The nest seed sections are flagged nestExpanded so the drill branch (if any)
    // would fall through to the verbatim walk.
    expect(seedSections.every((s) => s.nestExpanded === true)).toBe(true)

    // The non-nest op is untouched: one section, its own moves, NOT flagged.
    const plainSections = input.setup.operations.filter((o) => o.op.id === 'plain-op')
    expect(plainSections).toHaveLength(1)
    expect(plainSections[0].moves.map((m) => m.x)).toEqual([99, 88])
    expect(plainSections[0].nestExpanded).toBeUndefined()
  })

  it('emits g-code with motion at BOTH copy locations', () => {
    const setup = makeSetup([seedOp(), plainOp()])
    const input = buildPostInput(makeProject(setup, [makeNest()]), setup)
    const res = emitProgram(input, UCCNC_CONFIG)
    expect(res.diagnostics.some((d) => d.level === 'error')).toBe(false)
    const g = res.lines.join('\n')

    // Copy 0 cuts to X10; copy 1 cuts to X60. Both must be present in the program.
    expect(g).toContain('X10')
    expect(g).toContain('X60')
    // The non-nest op's coordinate is still emitted.
    expect(g).toContain('X88')
  })

  it('with NO nests, the PostOperation list matches the per-op behavior', () => {
    const setup = makeSetup([seedOp(), plainOp()])
    // Same project but no nests AND the seed geometry no longer owned -> plain ops.
    const project = makeProject(setup, [])
    project.geometry = [{ ...seedGeometry(), ownerNestId: undefined }]
    const input = buildPostInput(project, setup)

    // One section per op, in op order; no expansion, no flags.
    expect(input.setup.operations.map((o) => o.op.id)).toEqual(['seed-op', 'plain-op'])
    expect(input.setup.operations.every((o) => o.nestExpanded === undefined)).toBe(true)
    expect(input.setup.operations[0].moves).toHaveLength(2)
  })
})
