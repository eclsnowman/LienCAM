// WO-3234: extrudes carry an explicit wall mode from schema 7 on.
//
//  - A schema-6 file's extrudes reopen as wallMode 'solid' (migrationV6ToV7),
//    the migration is recorded, and nothing else in the payload moves.
//  - An old, never-honoured opaque `thin` field stays inert: the extrude still
//    builds the same solid request, and no thickness is backfilled.
//  - A thin extrude saved now round-trips its mode, thickness and side, and is
//    stamped schema 7 so a schema-6 build refuses it as a future file.
//  - Non-extrude payloads are byte-identical through the step.

import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import { FeatureDag } from '../../../doc'
import {
  CURRENT_SCHEMA_VERSION,
  FutureSchemaVersionError,
  createDocumentArchive,
  loadDocumentArchive,
  stableStringify,
} from '../../../doc/persist'
import type { ProfileRegion } from '../../../geom/geom-service'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../../components/model3d/workbench/extrudeParams'

const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

function rewriteArchive(
  archive: Uint8Array,
  mutate: (manifest: Record<string, unknown>, document: Record<string, unknown>) => void,
): Uint8Array {
  const files = unzipSync(archive)
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
  const document = JSON.parse(strFromU8(files['document.json'])) as Record<string, unknown>
  mutate(manifest, document)
  files['manifest.json'] = strToU8(stableStringify(manifest))
  files['document.json'] = strToU8(stableStringify(document))
  const zippable: Zippable = {}
  for (const path of Object.keys(files).sort()) zippable[path] = [files[path], ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

const RECT: ProfileRegion = {
  plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
  loops: [[
    { kind: 'line', srcId: 'l0', a: { x: 0, y: 0 }, b: { x: 40, y: 0 } },
    { kind: 'line', srcId: 'l1', a: { x: 40, y: 0 }, b: { x: 40, y: 20 } },
    { kind: 'line', srcId: 'l2', a: { x: 40, y: 20 }, b: { x: 0, y: 20 } },
    { kind: 'line', srcId: 'l3', a: { x: 0, y: 20 }, b: { x: 0, y: 0 } },
  ]],
} as unknown as ProfileRegion

function requestFor(featureId: string, payload: Record<string, unknown>) {
  return buildExtrudeRequest({
    featureId,
    payload: payload as ExtrudeParamsInput,
    profiles: [RECT],
    distance: payload.distance as number,
    lookupTarget: () => undefined,
  })
}

function oldDoc(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch SK1' } })
  dag.insertNode({
    id: 'F1',
    kind: 'feature',
    consumes: ['SK1'],
    payload: { opType: 'extrude', sketchId: 'SK1', distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', name: 'Extrude F1' },
  })
  dag.insertNode({
    id: 'F2',
    kind: 'feature',
    consumes: ['SK1'],
    // An opaque `thin` trap field written by some older tool: never read by
    // any schema-6 build, so this extrude was always a solid.
    payload: {
      opType: 'extrude', sketchId: 'SK1', distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody',
      thin: { thickness: 2, side: 'outside' }, name: 'Extrude F2',
    },
  })
  dag.insertNode({ id: 'R1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'revolve', sketchId: 'SK1', angleDeg: 90, name: 'Revolve R1' } })
  return dag
}

function asSchema6(dag: FeatureDag): Uint8Array {
  return rewriteArchive(createDocumentArchive({ dag, elementMapDeltas: [] }), (manifest) => {
    manifest.schemaVersion = 6
  })
}

describe('WO-3234 schema 7: explicit extrude wall mode', () => {
  it('is schema 7 or later (later steps are identity stamps)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(7)
  })

  it('reopens a schema-6 extrude as an explicit solid and records the step', () => {
    const before = oldDoc().getNode('F1')!.payload
    const loaded = loadDocumentArchive(asSchema6(oldDoc()))
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(loaded.migrationsApplied).toEqual([6])
    expect(loaded.dag.getNode('F1')!.payload).toEqual({ ...before, wallMode: 'solid' })
  })

  it('keeps an opaque legacy thin field inert: same solid request, no thickness backfilled', () => {
    const loaded = loadDocumentArchive(asSchema6(oldDoc()))
    const payload = loaded.dag.getNode('F2')!.payload
    expect(payload.wallMode).toBe('solid')
    expect(payload.wallThickness).toBeUndefined()
    expect(payload.wallSide).toBeUndefined()
    // The old data is kept as it was, not deleted and not promoted.
    expect(payload.thin).toEqual({ thickness: 2, side: 'outside' })

    const build = requestFor('F2', payload)
    expect(build.ok).toBe(true)
    if (!build.ok) return
    expect(build.req.thin).toBeUndefined()
    const plain = requestFor('F1', loaded.dag.getNode('F1')!.payload)
    expect(plain.ok && { ...plain.req, featureId: 'F2' }).toEqual(build.req)
  })

  it('leaves non-extrude payloads byte-identical', () => {
    const loaded = loadDocumentArchive(asSchema6(oldDoc()))
    expect(loaded.dag.getNode('R1')!.payload).toEqual({ opType: 'revolve', sketchId: 'SK1', angleDeg: 90, name: 'Revolve R1' })
    expect(loaded.dag.getNode('SK1')!.payload).toEqual({ name: 'Sketch SK1' })
  })

  it('round-trips a thin extrude at schema 7 and refuses it as a future file below that', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch SK1' } })
    const thin = {
      opType: 'extrude', sketchId: 'SK1', distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody',
      wallMode: 'thin', wallThickness: 2, wallSide: 'center', name: 'Extrude F1',
    }
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: thin })
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const loaded = loadDocumentArchive(archive)
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(loaded.migrationsApplied).toEqual([])
    expect(loaded.dag.getNode('F1')!.payload).toEqual(thin)
    const build = requestFor('F1', loaded.dag.getNode('F1')!.payload)
    expect(build.ok && build.req.thin).toEqual({ thickness: 2, side: 'center' })

    // A schema-6 build's loader is migrateToCurrent with CURRENT_SCHEMA_VERSION
    // 6: the stamp below is to it what CURRENT+1 is to this build.
    const stamp = JSON.parse(strFromU8(unzipSync(archive)['manifest.json'])) as { schemaVersion: number }
    expect(stamp.schemaVersion).toBeGreaterThan(6)
    const future = rewriteArchive(archive, (manifest) => { manifest.schemaVersion = CURRENT_SCHEMA_VERSION + 1 })
    expect(() => loadDocumentArchive(future)).toThrow(FutureSchemaVersionError)
  })
})
