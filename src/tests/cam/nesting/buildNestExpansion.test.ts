/* Unit tests for buildNestExpansion - the store->expander bridge (P7,
 * ADR 0024 Amendment 1). Validates seed-op collection, Z-plane derivation from
 * the op's own resolved moves, and that the nest's origin + machiningOrder feed
 * through to expandNest. */
import { describe, it, expect } from 'vitest'
import type {
  ImportedGeometry,
  NestRecord,
  Operation,
  ToolpathMove,
} from '../../../types/index'
import {
  buildNestExpansion,
  collectToolpathSections,
} from '../../../lib/cam/nesting/nestRuntime'

const SEED_LOCAL: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }, // clearance plane = maxZ
  { type: 'feed', x: 0, y: 0, z: -2, feed: 100, role: 'plunge' }, // feed plane = minZ
  { type: 'feed', x: 5, y: 5, z: -2, feed: 200, role: 'cut' },
  { type: 'rapid', x: 5, y: 5, z: 10, role: 'rapid' },
]

function op(over: Partial<Operation> & { geometryId?: string } = {}): Operation {
  const { geometryId = 'src-a', ...rest } = over
  return {
    id: 'op-1',
    name: 'Seed Pocket',
    status: 'ready',
    toolId: 'tool-1',
    toolpathMoves: SEED_LOCAL,
    params: { geometryId },
    ...rest,
  } as unknown as Operation
}

function nest(over: Partial<NestRecord> = {}): NestRecord {
  return {
    id: 'nest-1',
    name: 'Nest',
    sheet: { width: 300, height: 200 },
    style: 'arbitrary',
    spacing: { partGap: 1, sheetMargin: 2, windowGap: 0 },
    seed: 1,
    sources: [{ geometryId: 'src-a', quantity: 2 }],
    placements: [
      { partId: 'src-a', instanceId: 'i-0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'src-a', instanceId: 'i-1', x: 100, y: 0, rotationDeg: 0, depth: 0 },
    ],
    unplaced: [],
    utilization: 0.5,
    ...over,
  } as NestRecord
}

describe('buildNestExpansion', () => {
  it('expands a computed seed op across all placements with travel', () => {
    const exp = buildNestExpansion(nest(), [op()])
    expect(exp.sections).toHaveLength(1)
    expect(exp.sections[0].copyCount).toBe(2)
    // travel inserted -> more moves than two raw copies
    expect(exp.moves.length).toBeGreaterThan(SEED_LOCAL.length * 2)
  })

  it('derives the safe travel height from the op move stream (maxZ=10)', () => {
    const exp = buildNestExpansion(nest(), [op()])
    // the inter-copy traverse to the second copy entry (x=100) rides z=10
    const traverse = exp.moves.find((m) => m.type === 'rapid' && m.x === 100 && m.z === 10)
    expect(traverse).toBeDefined()
  })

  it('honors the nest origin offset', () => {
    const exp = buildNestExpansion(nest({ origin: { x: 1000, y: 2000 } }), [op()])
    expect(exp.moves[0]).toMatchObject({ x: 1000, y: 2000 })
  })

  it('honors machiningOrder by-part (one section per copy,op pair)', () => {
    const ops = [
      op({ id: 'op-a', geometryId: 'src-a' }),
      op({ id: 'op-b', geometryId: 'src-a' }),
    ]
    const exp = buildNestExpansion(nest({ machiningOrder: 'by-part' }), ops)
    expect(exp.sections.map((s) => s.opId)).toEqual(['op-a', 'op-b', 'op-a', 'op-b'])
  })

  it('ignores ops not bound to a nest source', () => {
    const exp = buildNestExpansion(nest(), [op({ geometryId: 'other-geo' })])
    expect(exp.sections).toHaveLength(0)
    expect(exp.moves).toHaveLength(0)
  })

  it('ignores an uncomputed seed op (no toolpathMoves)', () => {
    const exp = buildNestExpansion(nest(), [op({ toolpathMoves: undefined })])
    expect(exp.sections).toHaveLength(0)
  })

  it('ignores persisted moves on an errored seed operation', () => {
    const exp = buildNestExpansion(nest(), [op({ status: 'error' })])
    expect(exp.sections).toHaveLength(0)
    expect(exp.moves).toHaveLength(0)
  })
})

function geo(id: string, ownerNestId?: string): ImportedGeometry {
  return { id, ownerNestId } as unknown as ImportedGeometry
}

describe('collectToolpathSections', () => {
  it('with no nests, returns one section per non-empty op (byte-identical path)', () => {
    const ops = [
      op({ id: 'a', geometryId: 'plain-1' }),
      op({ id: 'b', geometryId: 'plain-2', toolpathMoves: [] }), // empty -> dropped
      op({ id: 'c', geometryId: 'plain-3' }),
    ]
    const secs = collectToolpathSections(ops, [geo('plain-1'), geo('plain-2'), geo('plain-3')], [])
    expect(secs.map((s) => s.opId)).toEqual(['a', 'c'])
    // pass-through: non-seed geo moves are the op's own moves unchanged
    expect(secs[0].moves).toEqual(SEED_LOCAL)
  })

  it('does not render persisted moves from an errored operation', () => {
    const secs = collectToolpathSections(
      [op({ id: 'error-path', geometryId: 'plain-1', status: 'error' })],
      [geo('plain-1')],
      [],
    )
    expect(secs).toEqual([])
  })

  it('collapses a nest to its expansion ONCE even with multiple seed ops', () => {
    const ops = [
      op({ id: 'seed-1', geometryId: 'src-a' }),
      op({ id: 'seed-2', geometryId: 'src-a' }),
    ]
    const geos = [geo('src-a', 'nest-1')]
    const secs = collectToolpathSections(ops, geos, [nest()])
    // by-operation: two ops x (collapsed once) -> 2 sections (one per op), NOT 4
    expect(secs.map((s) => s.opId)).toEqual(['seed-1', 'seed-2'])
    // each section spans both copies (expander travel inserted)
    expect(secs[0].moves.length).toBeGreaterThan(SEED_LOCAL.length)
  })

  it('preserves order: a plain op before and after a nest', () => {
    const ops = [
      op({ id: 'plain-pre', geometryId: 'plain-1' }),
      op({ id: 'seed-1', geometryId: 'src-a' }),
      op({ id: 'plain-post', geometryId: 'plain-2' }),
    ]
    const geos = [geo('plain-1'), geo('src-a', 'nest-1'), geo('plain-2')]
    const secs = collectToolpathSections(ops, geos, [nest()])
    expect(secs.map((s) => s.opId)).toEqual(['plain-pre', 'seed-1', 'plain-post'])
  })

  it('carries by-part interleaving through the section list', () => {
    const ops = [
      op({ id: 'seed-1', geometryId: 'src-a' }),
      op({ id: 'seed-2', geometryId: 'src-a' }),
    ]
    const geos = [geo('src-a', 'nest-1')]
    const secs = collectToolpathSections(ops, geos, [nest({ machiningOrder: 'by-part' })])
    // 2 copies x 2 ops, part-major
    expect(secs.map((s) => s.opId)).toEqual(['seed-1', 'seed-2', 'seed-1', 'seed-2'])
  })
})
