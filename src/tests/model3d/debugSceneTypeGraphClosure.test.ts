// WO UI-24-R3 (round-3 rule, class-ending: "the validated set is the TYPE GRAPH itself -- every
// type reachable from the serialized root gets the same derived treatment, and the walk that proves
// it is a committed test, not a reviewer's eye"). R0 found unlisted TOP-LEVEL instances; R2 found an
// unvalidated NESTED type (Diag) the top-level closure never reached. This file is the mechanical
// walk that makes a THIRD occurrence of "a hand-maintained boundary around what gets validated"
// impossible to land silently: it builds a maximal fixture from a REAL FeatureDag (not hand-JSON),
// recursively walks its REAL serialized+parsed shape, and asserts every object-valued path matches a
// registered validator -- the SAME field-allowlist constants debugScene.ts's own parseDebugSceneExport
// already enforces (NODE_RECORD_FIELDS/REF_RECORD_FIELDS/DIAG_FIELDS/EXPORT_ROOT_FIELDS/CAMERA_FIELDS/
// VEC3_FIELDS/ROLLBACK_MARKER_FIELDS), imported here rather than re-typed, so this test's registry
// cannot itself drift from the loader's own allowlists.
//
// The ONLY admissible opaque leaf is dag.nodes[].payload (an intentionally opaque
// Record<string,unknown> -- see debugScene.ts's own DagNodeSnapshot.payload doc). That exemption is
// asserted EXPLICITLY, by path, in its own test below, so a second opaque region cannot appear
// silently.

import { describe, it, expect } from 'vitest'
import {
  FeatureDag,
  type DagNodeSnapshot,
  type RollbackMarker,
} from '../../doc'
import {
  DEBUG_SCENE_SCHEMA_VERSION,
  parseDebugSceneExport,
  NODE_RECORD_FIELDS,
  REF_RECORD_FIELDS,
  DIAG_FIELDS,
  EXPORT_ROOT_FIELDS,
  CAMERA_FIELDS,
  ORTHOGRAPHIC_CAMERA_FIELDS,
  PERSPECTIVE_CAMERA_FIELDS,
  VEC3_FIELDS,
  ROLLBACK_MARKER_FIELDS,
  type DebugSceneExport,
} from '../../components/model3d/debugScene'

/**
 * Builds a MAXIMAL fixture from a REAL FeatureDag -- a genesis node, two ordinary features (one
 * consuming the other, together holding every ReferenceKind member), non-empty diagnostics (one WITH
 * params, one without -- params is optional), a non-empty lastGoodBoundTo map, degraded/suppressed
 * both true at least once, and an 'after' rollbackMarker (the variant with the optional nodeId) --
 * every optional field DebugSceneExport/DagNodeSnapshot/Diag/RollbackMarker admits, exercised at
 * least once. serialize()'s output is the REAL FeatureDag.serialize() string, never hand-authored
 * JSON, so the reachable set this test derives comes from actual runtime output, not a hand-list.
 */
function buildMaximalExport(): DebugSceneExport {
  const dag = new FeatureDag()
  dag.installGenesisNode({ id: 'origin', kind: 'datum', payload: { datumType: 'origin' } })
  dag.insertNode({
    id: 'F1',
    kind: 'feature',
    consumes: [],
    refs: [
      { id: 'face:1', kind: 'single-face', role: 'supportFace', elementType: 'face' },
      { id: 'face:2', kind: 'face-set', role: 'supportFaces', elementType: 'face' },
      { id: 'edge:1', kind: 'single-edge', role: 'axisLine', elementType: 'edge' },
      { id: 'vertex:1', kind: 'single-vertex', role: 'point0', elementType: 'vertex' },
    ],
    payload: { opType: 'extrude' },
  })
  const f2Snapshot: DagNodeSnapshot = {
    id: 'F2',
    kind: 'feature',
    consumes: ['F1'],
    refs: [{ id: 'face:3', kind: 'single-face', role: 'supportFace', elementType: 'face' }],
    payload: { opType: 'hole' },
    degraded: true,
    diagnostics: [
      { code: 'FILLET_RADIUS_TOO_LARGE', severity: 'warning', params: { radius: 3.5, faceId: 'face:3' } },
      { code: 'OK', severity: 'info' },
    ],
    lastGoodBoundTo: { 'face:9': ['face:9a', 'face:9b'] },
    suppressed: true,
    hidden: false,
  }
  dag.restoreNode(f2Snapshot)
  dag.setRollbackMarker({ kind: 'after', nodeId: 'F1' } satisfies RollbackMarker)

  return {
    schemaVersion: DEBUG_SCENE_SCHEMA_VERSION,
    appVersion: '0.10.2',
    gitCommit: 'deadbeef',
    gitBranch: 'wo/UI-24',
    buildDate: '2026-07-11T00:00:00.000Z',
    exportedAt: '2026-07-11T12:00:00.000Z',
    dag: dag.serialize(),
    featureOrder: dag.featureOrder(),
    rollbackMarker: dag.getRollbackMarker(),
    camera: {
      position: { x: 85, y: -85, z: 65 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fov: 45,
      projection: 'perspective',
    },
    displayMode: 'shaded-edges',
    hiddenGenesisIds: ['origin'],
    skipped: ['audit-fixture: sample skipped-state entry'],
  }
}

function buildMaximalOrthographicExport(): DebugSceneExport {
  return {
    ...buildMaximalExport(),
    camera: {
      position: { x: 85, y: -85, z: 65 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0.2, y: 0.1, z: 1 },
      projection: 'orthographic',
      left: -80,
      right: 80,
      top: 45,
      bottom: -45,
      zoom: 1.75,
      near: 0.25,
      far: 3200,
    },
  }
}

/** dag is a JSON STRING at the wire level (opaque to a plain object walk) -- the walk needs the
 *  LOGICAL tree (dag parsed back into {nodes, order}) to reach the types nested inside it, the same
 *  substitution parseDebugSceneExport's own validateDagNodeStructure performs internally. */
type LogicalExport = Omit<DebugSceneExport, 'dag'> & { dag: { nodes: unknown[]; order: string[] } }

function toLogical(exp: DebugSceneExport): LogicalExport {
  return { ...exp, dag: JSON.parse(exp.dag) as { nodes: unknown[]; order: string[] } }
}

type RegistryEntry = { fields: readonly string[] } | { dynamicKeys: true }

/**
 * The validator registry: one entry per NORMALIZED object-valued path reachable from the root
 * (array indices collapsed to `[]`). Every entry's field list is IMPORTED from debugScene.ts's own
 * `Record<keyof T, true>`-derived constants -- this registry cannot itself hand-list a field set
 * debugScene.ts's real validator does not already enforce.
 */
const REGISTRY: Record<string, RegistryEntry> = {
  $: { fields: EXPORT_ROOT_FIELDS },
  '$.camera': { fields: CAMERA_FIELDS },
  '$.camera.position': { fields: VEC3_FIELDS },
  '$.camera.target': { fields: VEC3_FIELDS },
  '$.camera.up': { fields: VEC3_FIELDS },
  '$.rollbackMarker': { fields: ROLLBACK_MARKER_FIELDS },
  '$.dag': { fields: ['nodes', 'order'] },
  '$.dag.nodes[]': { fields: NODE_RECORD_FIELDS },
  '$.dag.nodes[].refs[]': { fields: REF_RECORD_FIELDS },
  '$.dag.nodes[].diagnostics[]': { fields: DIAG_FIELDS },
  // Diag.params: Record<string, string|number> -- dynamic keys, but every VALUE is a primitive
  // (walk() never recurses past a primitive), so no further entry is needed below this one.
  '$.dag.nodes[].diagnostics[].params': { dynamicKeys: true },
  // DagNodeSnapshot.lastGoodBoundTo: Record<StableId, StableId[]> -- dynamic keys, array-of-string
  // values (again, primitives past the array).
  '$.dag.nodes[].lastGoodBoundTo': { dynamicKeys: true },
}

/** The ONE admissible opaque leaf (WO UI-24-R3 criterion 2's own text: "assert that exemption
 *  EXPLICITLY by path so a second opaque region cannot appear silently"). */
const OPAQUE_EXEMPTIONS = new Set<string>(['$.dag.nodes[].payload'])

function normalize(path: string): string {
  return path.replace(/\[[^\]]*\]/g, '[]')
}

/**
 * Recursively walks a REAL (parsed) export value, asserting every object-valued path matches a
 * REGISTRY entry (or the one named opaque exemption). Throws, naming the exact offending path, the
 * moment it finds an object this registry does not know -- the mechanism criterion 2 asks for: "every
 * type reachable from the serialized root ... asserts each non-leaf type has a validator entry."
 */
function walk(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return // primitive leaf
  const normalized = normalize(path)
  if (OPAQUE_EXEMPTIONS.has(normalized)) return // deliberately opaque -- walk stops here, by name
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`))
    return
  }
  const entry = REGISTRY[normalized]
  if (!entry) {
    throw new Error(`debugSceneTypeGraphClosure: no registered validator for object-valued path '${normalized}' (concrete: '${path}').`)
  }
  const obj = value as Record<string, unknown>
  if ('dynamicKeys' in entry) {
    for (const [key, v] of Object.entries(obj)) walk(v, `${path}.${key}`)
    return
  }
  for (const key of Object.keys(obj)) {
    if (!entry.fields.includes(key)) {
      throw new Error(`debugSceneTypeGraphClosure: unregistered field '${key}' at '${normalized}' (allowlist: ${entry.fields.join(', ')}).`)
    }
    walk(obj[key], `${path}.${key}`)
  }
}

describe('WO UI-24-R3: debug-scene type-graph closure', () => {
  it('the maximal fixture (real FeatureDag output) is itself accepted by parseDebugSceneExport', () => {
    // sanity: the walk below is only meaningful against a fixture the REAL loader itself accepts --
    // proves the maximal fixture is a genuinely well-formed scene, not an artificial shape the loader
    // would refuse for an unrelated reason.
    expect(() => parseDebugSceneExport(buildMaximalExport())).not.toThrow()
    expect(() => parseDebugSceneExport(buildMaximalOrthographicExport())).not.toThrow()
  })

  it('walks the maximal fixture clean -- every object-valued path in the real serialized+parsed export matches a registered validator', () => {
    const logical = toLogical(buildMaximalExport())
    expect(() => walk(logical, '$')).not.toThrow()
    const orthographicLogical = toLogical(buildMaximalOrthographicExport())
    expect(() => walk(orthographicLogical, '$')).not.toThrow()
  })

  it('camera field closures are projection-specific while the graph registry covers their union', () => {
    expect(PERSPECTIVE_CAMERA_FIELDS).toContain('fov')
    expect(PERSPECTIVE_CAMERA_FIELDS).not.toContain('left')
    expect(ORTHOGRAPHIC_CAMERA_FIELDS).toContain('left')
    expect(ORTHOGRAPHIC_CAMERA_FIELDS).not.toContain('fov')
    expect(new Set(CAMERA_FIELDS)).toEqual(new Set([...PERSPECTIVE_CAMERA_FIELDS, ...ORTHOGRAPHIC_CAMERA_FIELDS]))
  })

  it('exempts EXACTLY ONE opaque path -- dag.nodes[].payload -- so a second opaque region cannot appear silently', () => {
    expect([...OPAQUE_EXEMPTIONS]).toEqual(['$.dag.nodes[].payload'])
  })

  it('MUTATION PROOF A: an unregistered field on an already-closed type (dag.nodes[]) makes the walk FAIL, then the unmutated fixture still walks clean (restore)', () => {
    const logical = toLogical(buildMaximalExport())

    // Baseline: unmutated, walks clean (repeats the prior test's assertion so this one test is
    // self-contained proof of both directions without depending on execution order).
    expect(() => walk(logical, '$')).not.toThrow()

    // Mutation: a future author adds a brand-new NESTED OBJECT field to a dag node with no matching
    // REGISTRY entry -- e.g. a hypothetical per-node "provenance" record nobody wired a validator
    // for. Injected into a deep-cloned copy of the walked DATA (never a source-code edit), so
    // "restore" here is simply discarding the mutated clone -- the ORIGINAL fixture object, asserted
    // clean again below, was never touched.
    const mutated = structuredClone(logical)
    ;(mutated.dag.nodes[0] as Record<string, unknown>).auditFakeNestedField = { nested: 'typed field with no validator entry' }

    let thrown: unknown
    try {
      walk(mutated, '$')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/unregistered field 'auditFakeNestedField' at '\$\.dag\.nodes\[\]'/)

    // Restore proof: the pre-mutation fixture, re-derived fresh (never mutated), still walks clean --
    // byte-identical behavior to the first assertion in this test.
    const restored = toLogical(buildMaximalExport())
    expect(() => walk(restored, '$')).not.toThrow()
  })

  it('MUTATION PROOF B: a fake nested typed field inside a currently-open dynamic region (Diag.params) makes the walk FAIL on the OBJECT-VALUED-PATH check itself, then restores clean', () => {
    // Proof A shows the field-allowlist arm of walk() catching a new field on an ALREADY-CLOSED
    // type. This proof targets the OTHER arm -- "no registered validator for object-valued path" --
    // by adding a nested OBJECT inside Diag.params, a `dynamicKeys` region that currently only ever
    // holds primitive string/number leaves (validateDiag's own isFiniteStringOrNumber check is what
    // keeps it that way at the LOADER level; this is the closure walk's OWN independent check that a
    // second opaque/nested region cannot silently appear here either).
    const logical = toLogical(buildMaximalExport())
    expect(() => walk(logical, '$')).not.toThrow()

    const mutated = structuredClone(logical)
    const f2 = (mutated.dag.nodes as Record<string, unknown>[]).find((n) => n.id === 'F2') as Record<string, unknown>
    const diagWithParams = (f2.diagnostics as Record<string, unknown>[]).find((d) => d.params !== undefined) as Record<string, unknown>
    ;(diagWithParams.params as Record<string, unknown>).auditFakeNestedField = { nested: 'typed field with no validator entry' }

    let thrown: unknown
    try {
      walk(mutated, '$')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(
      /no registered validator for object-valued path '\$\.dag\.nodes\[\]\.diagnostics\[\]\.params\.auditFakeNestedField'/,
    )

    const restored = toLogical(buildMaximalExport())
    expect(() => walk(restored, '$')).not.toThrow()
  })

  it('MUTATION PROOF (negative control): removing a registry entry makes the UNMUTATED fixture itself fail, proving the walk is not vacuously permissive', () => {
    // WORKER-CHARTER item 1 ("a probe that cannot fail is not a gate"), applied to the walker itself:
    // if REGISTRY had a bug that made it accept anything, the mutation proof above would pass for the
    // wrong reason. This proves the registry lookup is load-bearing -- delete the diagnostics entry
    // and the CLEAN, unmutated fixture (which has real diagnostics) now fails, naming that exact path.
    const registryWithoutDiagnostics: Record<string, RegistryEntry> = { ...REGISTRY }
    delete registryWithoutDiagnostics['$.dag.nodes[].diagnostics[]']
    function walkWithRegistry(value: unknown, path: string, registry: Record<string, RegistryEntry>): void {
      if (value === null || typeof value !== 'object') return
      const normalized = normalize(path)
      if (OPAQUE_EXEMPTIONS.has(normalized)) return
      if (Array.isArray(value)) {
        value.forEach((item, i) => walkWithRegistry(item, `${path}[${i}]`, registry))
        return
      }
      const entry = registry[normalized]
      if (!entry) throw new Error(`debugSceneTypeGraphClosure: no registered validator for object-valued path '${normalized}' (concrete: '${path}').`)
      const obj = value as Record<string, unknown>
      if ('dynamicKeys' in entry) {
        for (const [key, v] of Object.entries(obj)) walkWithRegistry(v, `${path}.${key}`, registry)
        return
      }
      for (const key of Object.keys(obj)) {
        if (!entry.fields.includes(key)) throw new Error(`unregistered field '${key}' at '${normalized}'`)
        walkWithRegistry(obj[key], `${path}.${key}`, registry)
      }
    }
    const logical = toLogical(buildMaximalExport())
    expect(() => walkWithRegistry(logical, '$', registryWithoutDiagnostics)).toThrow(
      /no registered validator for object-valued path '\$\.dag\.nodes\[\]\.diagnostics\[\]'/,
    )
  })
})
