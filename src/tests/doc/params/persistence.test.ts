import { describe, it, expect } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import { ElementMap, FeatureDag, ParameterTable, RegenScheduler, paramNodeId } from '../../../doc'
import { createDocumentArchive, loadDocumentArchive } from '../../../doc/persist'

const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

/** WO DOC-4-R1.3: rewrites a real archive's manifest/document.json (mirrors
 *  src/tests/doc/persist/persist.test.ts's own rewriteArchive helper) so the
 *  migration test below exercises an archive that GENUINELY lacks
 *  `document.parameters` (a pre-DOC-4 schema-v1 save), not one built by the
 *  CURRENT writer (which always emits the field, even as `{}`). */
function rewriteArchive(
  archive: Uint8Array,
  mutate: (manifest: Record<string, unknown>, document: Record<string, unknown>) => void,
): Uint8Array {
  const files = unzipSync(archive)
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
  const document = JSON.parse(strFromU8(files['document.json'])) as Record<string, unknown>
  mutate(manifest, document)
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  files['document.json'] = strToU8(JSON.stringify(document))

  const zippable: Zippable = {}
  for (const path of Object.keys(files).sort()) zippable[path] = [files[path], ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

// WO DOC-4 acceptance criterion #6: persistence round-trip. Per the WO's own
// conditional ("SURGICAL persist edit ONLY if the existing serializer does
// not generically cover new doc-state slices"): it already does. Parameters
// are ordinary FeatureDag nodes (ruling 1), and DOC-3's createDocumentArchive/
// loadDocumentArchive already persist `dag.serialize()`/FeatureDag.restore()
// generically over EVERY node kind -- these tests prove that generic path
// round-trips parameter nodes correctly with ZERO changes to src/doc/persist,
// no schemaVersion bump, and no new persistence code at all.

async function buildTableDoc(): Promise<{ dag: FeatureDag; scheduler: RegenScheduler }> {
  const dag = new FeatureDag()
  const map = new ElementMap()
  const scheduler = new RegenScheduler(dag, map)
  const table = new ParameterTable(dag, scheduler)
  await table.setExpression('base', '10')
  await table.setExpression('width', '2*base+3')
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: [paramNodeId('width')] })
  scheduler.markDirty('F1')
  await scheduler.run(table.executor)
  return { dag, scheduler }
}

describe('AC #6: parameter persistence round-trip (existing DOC-3 serializer, no persist.ts edits)', () => {
  it('save -> load reproduces identical table names, expressions, values, and feature bindings', async () => {
    const { dag } = await buildTableDoc()

    const bytes = createDocumentArchive({ dag, elementMapDeltas: [] })
    const loaded = loadDocumentArchive(bytes)

    const loadedScheduler = new RegenScheduler(loaded.dag, loaded.elementMap)
    const loadedTable = ParameterTable.fromDag(loaded.dag, loadedScheduler)

    expect(loadedTable.names()).toEqual(['base', 'width'])
    expect(loadedTable.expressionOf('base')).toBe('10')
    expect(loadedTable.expressionOf('width')).toBe('2*base+3')
    expect(loadedTable.valueOf('base')).toBe(10)
    expect(loadedTable.valueOf('width')).toBe(23)

    // The feature's binding to 'width' (an ordinary consumes edge) survives.
    const f1 = loaded.dag.getNode('F1')
    expect(f1?.consumes).toEqual([paramNodeId('width')])

    // A fresh regen pass over the restored dag reproduces the same value with
    // no further edits -- the restored table is immediately usable, not just
    // inert data.
    const outcome = await loadedTable.setExpression('base', '10')
    expect(outcome.ok).toBe(true)
    expect(loadedTable.valueOf('width')).toBe(23)
  })

  it('byte-stable: the SAME final table state saved via two different edit histories produces identical archives', async () => {
    const docA = await buildTableDoc()
    const bytesA = createDocumentArchive({ dag: docA.dag, elementMapDeltas: [] })

    // A different edit path (an intermediate wrong value, corrected) reaching
    // the exact same final state.
    const dagB = new FeatureDag()
    const mapB = new ElementMap()
    const schedulerB = new RegenScheduler(dagB, mapB)
    const tableB = new ParameterTable(dagB, schedulerB)
    await tableB.setExpression('base', '5')
    await tableB.setExpression('base', '10')
    await tableB.setExpression('width', '1*base')
    await tableB.setExpression('width', '2*base+3')
    dagB.insertNode({ id: 'F1', kind: 'feature', consumes: [paramNodeId('width')] })
    schedulerB.markDirty('F1')
    await schedulerB.run(tableB.executor)
    const bytesB = createDocumentArchive({ dag: dagB, elementMapDeltas: [] })

    expect(Array.from(bytesB)).toEqual(Array.from(bytesA))
  })

  it('migration: a GENUINE pre-DOC-4 schema-v1 archive (document.parameters field ABSENT, not just empty) loads cleanly to an EMPTY table', async () => {
    // WO DOC-4-R1.3 audit finding: the original version of this test built
    // its archive with the CURRENT writer, which always emits
    // document.parameters (even as `{}`) -- so it only ever exercised
    // "zero parameter DAG nodes", never "the field itself is missing", which
    // is what an archive saved BEFORE DOC-4/schema-v2 existed actually looks
    // like (see src/doc/persist/versioning.ts's migrationV1ToV2: "if
    // (document.parameters === undefined) document.parameters = {}"). This
    // fixture is hand-constructed to be genuinely field-absent, at
    // schemaVersion 1, so the migration path is actually exercised.
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    const currentArchive = createDocumentArchive({ dag, elementMapDeltas: [] })

    const v1Archive = rewriteArchive(currentArchive, (manifest, document) => {
      manifest.schemaVersion = 1
      delete document.documentKind
      delete document.parameters
      expect('parameters' in document).toBe(false)
    })

    const loaded = loadDocumentArchive(v1Archive)
    // The migration actually ran (proves the field really was absent, not
    // just present-and-empty -- v1->v2's migrationV1ToV2 only fires when
    // schemaVersion starts below CURRENT_SCHEMA_VERSION). WO UI-51A: the chain
    // reached v3; WO UI-80: v4; WO-214: now ends at v5, so a v1 archive applies
    // [1, 2, 3, 4] (v2->v3, v3->v4, and v4->v5 are all identity steps for this
    // extrude-less, faceEdits-less fixture -- migrationV4ToV5 only rewrites a
    // node whose payload.opType === 'extrude', and this fixture's sole node has
    // no payload at all).
    expect(loaded.migrationsApplied).toEqual([1, 2, 3, 4])
    expect(loaded.document.documentKind).toBe('liencam-3d-document')
    expect(loaded.parameters).toEqual({})

    const scheduler = new RegenScheduler(loaded.dag, loaded.elementMap)
    const table = ParameterTable.fromDag(loaded.dag, scheduler)
    expect(table.names()).toEqual([])
    expect(table.has('base')).toBe(false)
    // The restored table is immediately usable, not just inert -- a fresh
    // parameter can be created and regenerates cleanly.
    const outcome = await table.setExpression('base', '10')
    expect(outcome.ok).toBe(true)
    expect(table.valueOf('base')).toBe(10)
    // The pre-existing feature node is untouched by the (absent) parameter migration.
    expect(loaded.dag.getNode('F1')?.kind).toBe('feature')
    expect(loaded.dag.getNode('F1')?.consumes).toEqual([])
  })
})
