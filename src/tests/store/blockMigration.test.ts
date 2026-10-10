// SKC-BLOCKS Stage 1 gate: additive schema bump 12 -> 13 for the sketch 'block'
// entity kind, and the plain-serializable round-trip of a block-bearing sketch.
//
// The migration is an IDENTITY that only CLAIMS the version (v6 arcLength / v8
// d1xd2 / v9 embedded-doc precedent): an older build must fail loud on a
// block-bearing file rather than silently drop the unknown kind (ADR-0003/0027).

import { describe, it, expect } from 'vitest'
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  projectMigrations,
  migrateSketchBlockEntity,
  migrateSketchBlockDefinitions,
  migrateProjectData,
} from '../../store/migrations/projectMigrations'
import { runMigrationChain, UnknownSchemaVersionError } from '../../store/migrations/schemaMigration'
import type { Sketch, SketchBlockEntity, BlockDefinition } from '../../lib/sketch/types'

function blockSketch(): Sketch {
  const block: SketchBlockEntity = {
    id: 'blk-1', kind: 'block', construction: false,
    origin: { x: 20, y: 15 }, rotation: 0, scale: 1, name: 'Bracket',
    members: {
      entities: [
        { id: 'l1', kind: 'line', construction: false, start: { x: -20, y: -15 }, end: { x: 20, y: -15 } },
        { id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 },
      ],
      constraints: [
        { id: 'k1', kind: 'coincident', a: { entityId: 'l1', site: 'start' }, b: { entityId: 'l1', site: 'end' } },
      ],
      dimensions: [
        { id: 'd1', kind: 'radius', entityId: 'c1', driving: true, value: 5 },
      ],
    },
  }
  return { id: 'sk', layerId: 'L', entities: [block], constraints: [], dimensions: [], solveStatus: null }
}

// A v12 project fixture whose imported-geometry layer carries a block sketch.
function v12ProjectWithBlock(): any {
  return {
    schemaVersion: 12,
    geometry: [{
      id: 'geo', name: 'Logo', type: 'curves_2d', format: 'dxf', loaded: true,
      loops: [], layers2d: [{ id: 'L', name: 'Layer', color: '#00e5ff', visible: true }],
      sketches: [blockSketch()],
    }],
    setups: [], nests: [], tools: [], toolLibraries: [{ id: 'lib-default', name: 'My Tools' }],
    modelItems: [],
  }
}

// SKC-BLOCKS Stage 5: a def-backed INSTANCE + a shared DEFINITION registry on
// the same sketch. The instance's inline members are empty; the geometry lives
// on the definition; the instance points at it via defId.
function defInstanceSketch(): Sketch {
  const def: BlockDefinition = {
    id: 'def-1', name: 'Bracket',
    members: {
      entities: [
        { id: 'l1', kind: 'line', construction: false, start: { x: -20, y: -15 }, end: { x: 20, y: -15 } },
        { id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 },
      ],
      constraints: [],
      dimensions: [{ id: 'd1', kind: 'radius', entityId: 'c1', driving: true, value: 5 }],
    },
  }
  const instA: SketchBlockEntity = {
    id: 'blk-A', kind: 'block', construction: false, defId: 'def-1',
    origin: { x: 20, y: 15 }, rotation: 0, scale: 1, name: 'Bracket',
    members: { entities: [], constraints: [], dimensions: [] },
  }
  const instB: SketchBlockEntity = {
    id: 'blk-B', kind: 'block', construction: false, defId: 'def-1',
    origin: { x: 120, y: 15 }, rotation: 0, scale: 1, name: 'Bracket',
    members: { entities: [], constraints: [], dimensions: [] },
  }
  return {
    id: 'sk', layerId: 'L', entities: [instA, instB], constraints: [], dimensions: [],
    blockDefs: { 'def-1': def }, solveStatus: null,
  }
}

function v13ProjectWithDefinition(): any {
  return {
    schemaVersion: 13,
    geometry: [{
      id: 'geo', name: 'Logo', type: 'curves_2d', format: 'dxf', loaded: true,
      loops: [], layers2d: [{ id: 'L', name: 'Layer', color: '#00e5ff', visible: true }],
      sketches: [defInstanceSketch()],
    }],
    setups: [], nests: [], tools: [], toolLibraries: [{ id: 'lib-default', name: 'My Tools' }],
    modelItems: [],
  }
}

describe('SKC-BLOCKS schema v13 migration (single-use block entity kind)', () => {
  it('a v13 step claims the block entity kind', () => {
    const v13 = projectMigrations.find((s) => s.to === 13)!
    expect(v13).toBeDefined()
    expect(v13.description.toLowerCase()).toMatch(/block/)
  })

  it('the v13 step is an identity (a block-bearing doc passes through unchanged)', () => {
    const doc = v12ProjectWithBlock()
    // migrateSketchBlockEntity is a pure identity.
    expect(migrateSketchBlockEntity(doc)).toBe(doc)
    // Running the 12 -> 13 chain preserves the block byte-for-byte.
    const out: any = runMigrationChain(doc, 12, 13, projectMigrations)
    expect(out.geometry[0].sketches[0].entities[0]).toEqual(doc.geometry[0].sketches[0].entities[0])
  })

  it('a single-use block sketch survives a JSON serialization round-trip (plain data, ADR-0016)', () => {
    const sk = blockSketch()
    const round = JSON.parse(JSON.stringify(sk)) as Sketch
    expect(round).toEqual(sk)
    const block = round.entities[0] as SketchBlockEntity
    expect(block.members.constraints[0].id).toBe('k1')
    expect(block.members.dimensions[0].id).toBe('d1')
  })
})

describe('SKC-BLOCKS schema v14 migration (block definitions + instances)', () => {
  it('CURRENT schema is v19 while the v14 chain step still owns definitions/instances', () => {
    expect(CURRENT_PROJECT_SCHEMA_VERSION).toBe(19)
    const blockStep = projectMigrations.find((migration) => migration.to === 14)
    expect(blockStep).toBeDefined()
    expect(blockStep!.description.toLowerCase()).toMatch(/definition|instance/)
  })

  it('the v14 step is an identity (a definition-bearing doc passes through unchanged)', () => {
    const doc = v13ProjectWithDefinition()
    expect(migrateSketchBlockDefinitions(doc)).toBe(doc)
    const out: any = runMigrationChain(doc, 13, 14, projectMigrations)
    expect(out.geometry[0].sketches[0]).toEqual(doc.geometry[0].sketches[0])
  })

  it('migrateProjectData stamps CURRENT and preserves the definition + both instances', () => {
    const out: any = migrateProjectData(v13ProjectWithDefinition())
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    const sk = out.geometry[0].sketches[0]
    expect(Object.keys(sk.blockDefs)).toEqual(['def-1'])
    expect(sk.blockDefs['def-1'].members.entities.length).toBe(2)
    const instances = sk.entities.filter((e: any) => e.kind === 'block')
    expect(instances.map((e: any) => e.defId)).toEqual(['def-1', 'def-1'])
    // Instance inline members stay empty (the geometry lives on the definition).
    expect(instances[0].members.entities.length).toBe(0)
  })

  it('a definition/instance sketch survives a JSON serialization round-trip (plain data, ADR-0016)', () => {
    const sk = defInstanceSketch()
    const round = JSON.parse(JSON.stringify(sk)) as Sketch
    expect(round).toEqual(sk)
    expect(round.blockDefs!['def-1'].members.entities.length).toBe(2)
    expect((round.entities[0] as SketchBlockEntity).defId).toBe('def-1')
  })

  it('an OLD single-use block file (no defId, no blockDefs) still migrates to CURRENT unchanged', () => {
    const out: any = migrateProjectData(v12ProjectWithBlock())
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    const block = out.geometry[0].sketches[0].entities[0]
    expect(block.kind).toBe('block')
    expect(block.defId).toBeUndefined()
    expect(block.members.entities.length).toBe(2)
  })

  it('fails loud on a NEWER-than-supported document (ADR-0003)', () => {
    expect(() => migrateProjectData({
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION + 1,
    })).toThrow(UnknownSchemaVersionError)
  })
})
