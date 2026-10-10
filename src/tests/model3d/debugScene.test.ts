// WO UI-24: parseDebugSceneExport's own contract -- refuses BY NAME (WORKER-CHARTER item 2), never
// silently guesses at a corrupted or newer-schema debug scene file. Each `it` below corrupts
// exactly ONE field of an otherwise-valid export and asserts the thrown DebugSceneFormatError names
// that exact field -- the per-WO mutation-proof charter item 6 applied at the unit level; the
// integration test (SolidsWorkbenchPage.debugExport.test.tsx) repeats the same discipline against a
// REAL exported scene from the real kernel/dag.

import { describe, it, expect } from 'vitest'
import {
  DEBUG_SCENE_SCHEMA_VERSION,
  DebugSceneFormatError,
  parseDebugSceneExport,
  type DebugSceneExport,
  type DebugSceneCameraState,
} from '../../components/model3d/debugScene'

type PerspectiveExport = DebugSceneExport & {
  camera: Extract<DebugSceneCameraState, { projection: 'perspective' }>
}

function validExport(): PerspectiveExport {
  return {
    schemaVersion: DEBUG_SCENE_SCHEMA_VERSION,
    appVersion: '0.10.2',
    gitCommit: 'deadbeef',
    gitBranch: 'main',
    buildDate: '2026-07-11T00:00:00.000Z',
    exportedAt: '2026-07-11T12:00:00.000Z',
    dag: JSON.stringify({ nodes: [], order: [] }),
    featureOrder: [],
    rollbackMarker: { kind: 'end' },
    camera: {
      position: { x: 85, y: -85, z: 65 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fov: 45,
      projection: 'perspective',
    },
    displayMode: 'shaded-edges',
    hiddenGenesisIds: [],
    skipped: [],
  }
}

function validOrthographicExport(): DebugSceneExport {
  return {
    ...validExport(),
    camera: {
      position: { x: 123, y: -77, z: 61 },
      target: { x: 5, y: 5, z: 5 },
      up: { x: 0.2, y: 0.1, z: 1 },
      projection: 'orthographic',
      left: -91,
      right: 109,
      top: 70,
      bottom: -50,
      zoom: 1.75,
      near: 0.25,
      far: 3200,
    },
  }
}

/** WO UI-24-R1 (audit finding 1): a valid, non-empty two-node dag (F1, and F2 which consumes F1) --
 *  the same DagNodeSnapshot shape FeatureDag.serialize() produces (see dag.ts's own serialize()),
 *  hand-built so each corruption test below can mutate exactly ONE structural field. */
function twoNodeDagJson(): string {
  return JSON.stringify({
    nodes: [
      { id: 'F1', kind: 'feature', consumes: [], refs: [], payload: { opType: 'extrude' }, degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false, hidden: false },
      { id: 'F2', kind: 'feature', consumes: ['F1'], refs: [], payload: { opType: 'hole' }, degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false, hidden: false },
    ],
    order: ['F1', 'F2'],
  })
}

function twoNodeExport(): DebugSceneExport {
  return { ...validExport(), dag: twoNodeDagJson(), featureOrder: ['F1', 'F2'] }
}

/** WO UI-24-R2 (audit R1 finding 2 / this WO's genesis-canonical-shape criterion): a dag containing
 *  a CANONICAL Origin genesis node ahead of the two features -- the shape parseDebugSceneExport must
 *  accept as-is, so the corruption tests below (which mutate exactly this fixture) prove the refusal
 *  is caused by the mutation, not by genesis nodes being rejected outright. */
function genesisAndTwoNodeDagJson(): string {
  return JSON.stringify({
    nodes: [
      { id: 'origin', kind: 'datum', consumes: [], refs: [], payload: { datumType: 'origin' }, degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false, hidden: false },
      { id: 'F1', kind: 'feature', consumes: [], refs: [], payload: { opType: 'extrude' }, degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false, hidden: false },
      { id: 'F2', kind: 'feature', consumes: ['F1'], refs: [], payload: { opType: 'hole' }, degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false, hidden: false },
    ],
    order: ['origin', 'F1', 'F2'],
  })
}

function genesisAndTwoNodeExport(): DebugSceneExport {
  return { ...validExport(), dag: genesisAndTwoNodeDagJson(), featureOrder: ['origin', 'F1', 'F2'] }
}

describe('WO UI-24: parseDebugSceneExport', () => {
  it('accepts a well-formed export and returns it structurally unchanged', () => {
    const input = validExport()
    const parsed = parseDebugSceneExport(input)
    expect(parsed).toEqual(input)
  })

  it('refuses a non-object root, naming "root"', () => {
    expect(() => parseDebugSceneExport(null)).toThrow(DebugSceneFormatError)
    expect(() => parseDebugSceneExport('a string')).toThrow(DebugSceneFormatError)
    try {
      parseDebugSceneExport([1, 2, 3])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('root')
    }
  })

  it('refuses a newer schemaVersion than this build supports, naming "schemaVersion"', () => {
    const input = { ...validExport(), schemaVersion: DEBUG_SCENE_SCHEMA_VERSION + 1 }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('schemaVersion')
      expect((err as Error).message).toMatch(/newer app/)
    }
  })

  it('refuses an older schemaVersion with no migration, naming "schemaVersion"', () => {
    const input = { ...validExport(), schemaVersion: DEBUG_SCENE_SCHEMA_VERSION - 1 }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('schemaVersion')
      expect((err as Error).message).toMatch(/older schema/)
    }
  })

  it('refuses a NaN-shaped camera field (JSON null where a finite number belongs), naming the exact camera field', () => {
    // charter item 3: NaN sails through JSON as `null` -- this is the exact shape a naive
    // round-trip bug produces, and it must be caught here, never compared silently downstream.
    const input = validExport()
    ;(input.camera.position as unknown as { x: unknown }).x = null
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('camera.position')
    }
  })

  it('accepts a well-formed orthographic camera and returns its exact frustum unchanged', () => {
    const input = validOrthographicExport()
    expect(parseDebugSceneExport(input)).toEqual(input)
  })

  it('refuses an unknown camera.projection, naming "camera.projection"', () => {
    const input = validExport()
    ;(input.camera as unknown as { projection: string }).projection = 'fisheye'
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('camera.projection')
    }
  })

  it.each(['left', 'right', 'top', 'bottom', 'zoom', 'near', 'far'] as const)(
    'refuses a non-finite orthographic camera.%s by name',
    (field) => {
      const input = validOrthographicExport()
      ;(input.camera as unknown as Record<string, unknown>)[field] = null
      try {
        parseDebugSceneExport(input)
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(DebugSceneFormatError)
        expect((err as DebugSceneFormatError).field).toBe(`camera.${field}`)
      }
    },
  )

  it.each([
    ['right', -91, 'camera.right'],
    ['top', -50, 'camera.top'],
    ['zoom', 0, 'camera.zoom'],
    ['near', -0.1, 'camera.near'],
    ['far', 0.25, 'camera.far'],
  ] as const)('refuses degenerate orthographic %s=%s by name', (field, value, expectedField) => {
    const input = validOrthographicExport()
    ;(input.camera as unknown as Record<string, unknown>)[field] = value
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe(expectedField)
    }
  })

  it('enforces exact projection branch fields', () => {
    const perspective = validExport()
    ;(perspective.camera as unknown as Record<string, unknown>).left = -10
    try {
      parseDebugSceneExport(perspective)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('camera.left')
    }

    const orthographic = validOrthographicExport()
    ;(orthographic.camera as unknown as Record<string, unknown>).fov = 45
    try {
      parseDebugSceneExport(orthographic)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('camera.fov')
    }
  })

  it('refuses malformed dag JSON, naming "dag"', () => {
    const input = { ...validExport(), dag: '{not json' }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('dag')
    }
  })

  it('refuses dag JSON missing the {nodes, order} shape, naming "dag"', () => {
    const input = { ...validExport(), dag: JSON.stringify({ nodes: [] }) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('dag')
    }
  })

  it('refuses an unknown rollbackMarker.kind, naming "rollbackMarker.kind"', () => {
    const input = { ...validExport(), rollbackMarker: { kind: 'middle' } as unknown as DebugSceneExport['rollbackMarker'] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('rollbackMarker.kind')
    }
  })

  it('refuses rollbackMarker kind "after" without a nodeId, naming "rollbackMarker.nodeId"', () => {
    const input = { ...validExport(), rollbackMarker: { kind: 'after' } as unknown as DebugSceneExport['rollbackMarker'] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('rollbackMarker.nodeId')
    }
  })

  it('refuses an invalid displayMode, naming "displayMode"', () => {
    const input = { ...validExport(), displayMode: 'x-ray' as unknown as DebugSceneExport['displayMode'] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('displayMode')
    }
  })

  it('refuses a non-ISO exportedAt, naming "exportedAt"', () => {
    const input = { ...validExport(), exportedAt: 'not-a-date' }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('exportedAt')
    }
  })

  it('refuses non-array hiddenGenesisIds, naming "hiddenGenesisIds"', () => {
    const input = { ...validExport(), hiddenGenesisIds: 'datum:XY' as unknown as string[] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('hiddenGenesisIds')
    }
  })

  it('refuses non-array skipped, naming "skipped"', () => {
    const input = { ...validExport(), skipped: 'nope' as unknown as string[] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('skipped')
    }
  })

  it('accepts a well-formed non-empty dag (two nodes, one dependency)', () => {
    const input = twoNodeExport()
    expect(() => parseDebugSceneExport(input)).not.toThrow()
  })

  // WO UI-24-R1 (audit finding 1): node-level structure, unique ids, dep integrity and payload
  // sanity -- the four corruption fixtures the WO names explicitly, plus the cycle repro the audit
  // itself built (F1 consumes F2, F2 consumes F1, reproduced verbatim from the audit's own evidence).

  it('refuses a duplicate node id, naming "dag.nodes[1].id"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[1].id = 'F1' // duplicate of nodes[0]
    dagParsed.order = ['F1', 'F1']
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[1].id')
      expect((err as Error).message).toMatch(/duplicate node id/)
    }
  })

  it('refuses an unknown node kind, naming "dag.nodes[0].kind"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].kind = 'bogus-kind'
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].kind')
    }
  })

  it('requires hidden to be present and boolean on every debug-scene DAG node', () => {
    for (const mutate of [
      (node: Record<string, unknown>) => { delete node.hidden },
      (node: Record<string, unknown>) => { node.hidden = 'yes' },
    ]) {
      const dagParsed = JSON.parse(twoNodeDagJson()) as { nodes: Array<Record<string, unknown>> }
      mutate(dagParsed.nodes[0])
      const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
      try {
        parseDebugSceneExport(input)
        expect.unreachable('missing or non-boolean hidden must refuse')
      } catch (err) {
        expect(err).toBeInstanceOf(DebugSceneFormatError)
        expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].hidden')
        expect((err as Error).message).toMatch(/boolean/)
      }
    }
  })

  it('refuses a dangling consumes dependency, naming "dag.nodes"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[1].consumes = ['F99'] // F99 does not exist anywhere in this file
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes')
      expect((err as Error).message).toMatch(/dangling dependency/)
    }
  })

  it('refuses a payload number that overflows to Infinity during JSON.parse, naming "dag.nodes[0].payload"', () => {
    // charter item 3: this is how a syntactically-valid JSON file smuggles a non-finite number --
    // `1e400` is a legal JSON numeric token that JSON.parse silently overflows to Infinity (unlike
    // NaN/Infinity themselves, which are not legal JSON tokens at all and refuse earlier, at the
    // "dag field is not valid JSON" check).
    const dagStr =
      '{"nodes":[{"id":"F1","kind":"feature","consumes":[],"refs":[],"payload":{"offset":1e400},"degraded":false,"diagnostics":[],"lastGoodBoundTo":{},"suppressed":false,"hidden":false}],"order":["F1"]}'
    const input = { ...validExport(), dag: dagStr, featureOrder: ['F1'] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].payload')
      expect((err as Error).message).toMatch(/non-finite/)
    }
  })

  it('refuses a cyclic consumes graph (audit repro: F1 consumes F2, F2 consumes F1), naming "dag"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].consumes = ['F2'] // F1 now also consumes F2 -- F1<->F2 cycle
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('a cyclic consumes graph must refuse, never half-boot into a topoOrder() throw later')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag')
      expect((err as Error).message).toMatch(/cycle/i)
    }
  })

  it('refuses dag.order that is not a permutation of dag.nodes ids, naming "dag.order"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.order = ['F1'] // missing F2
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('dag.order')
    }
  })

  it('refuses featureOrder that is not a permutation of dag.nodes ids, naming "featureOrder"', () => {
    const input = { ...twoNodeExport(), featureOrder: ['F1'] } // missing F2
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('featureOrder')
    }
  })

  it('refuses rollbackMarker.nodeId that does not resolve in this file, naming "rollbackMarker.nodeId"', () => {
    const input = { ...twoNodeExport(), rollbackMarker: { kind: 'after', nodeId: 'F99' } as DebugSceneExport['rollbackMarker'] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('rollbackMarker.nodeId')
    }
  })

  it('refuses a non-genesis hiddenGenesisIds entry, naming "hiddenGenesisIds" (audit repro: hiddenGenesisIds=["F1"])', () => {
    const input = { ...twoNodeExport(), hiddenGenesisIds: ['F1'] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('hiddenGenesisIds')
    }
  })

  it('accepts a canonical genesis id in hiddenGenesisIds', () => {
    const input = { ...validExport(), hiddenGenesisIds: ['datum:XY'] }
    expect(() => parseDebugSceneExport(input)).not.toThrow()
  })

  // Camera up is authored by normal-to-plane views and is now replayed exactly.
  // Perspective fov remains fixed in schema v1.

  it('accepts a finite non-canonical camera.up because debug restore reproduces it', () => {
    const input = validExport()
    input.camera.up = { x: 1, y: 0, z: 0 }
    expect(parseDebugSceneExport(input).camera.up).toEqual(input.camera.up)
  })

  it('refuses a zero camera.up, naming "camera.up"', () => {
    const input = validExport()
    input.camera.up = { x: 0, y: 0, z: 0 }
    expect(() => parseDebugSceneExport(input)).toThrow(DebugSceneFormatError)
    try {
      parseDebugSceneExport(input)
    } catch (err) {
      expect((err as DebugSceneFormatError).field).toBe('camera.up')
    }
  })

  it('refuses camera.up parallel to the view direction, naming "camera.up"', () => {
    const input = validExport()
    input.camera.up = { x: -85, y: 85, z: -65 }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('a parallel up/view frame must refuse')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('camera.up')
    }
  })

  it('refuses a camera.fov that is finite but not the canonical fov, naming "camera.fov"', () => {
    const input = validExport()
    input.camera.fov = 70 // finite, but not this workbench's fixed fov
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('camera.fov')
    }
  })

  // WO UI-24-R2 (root-cause ruling: schema-DERIVED validation, not hand-listed field checks). Both
  // auditors' corruption shapes across rounds 1+2 are now all fixtures: dangling dep, duplicate id,
  // unknown kind, non-finite payload (covered above) -- plus unknown ref-kind, corrupt reserved
  // genesis, and an unknown field on either record (this WO's own new closure).

  it('accepts a canonical reserved genesis node ahead of ordinary features', () => {
    expect(() => parseDebugSceneExport(genesisAndTwoNodeExport())).not.toThrow()
  })

  it('refuses a reserved genesis node whose kind is not the canonical "datum", naming "dag.nodes[0]"', () => {
    const dagParsed = JSON.parse(genesisAndTwoNodeDagJson())
    dagParsed.nodes[0].kind = 'feature' // a valid DagNodeKind, but not Origin's canonical kind
    const input = { ...genesisAndTwoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('a reserved genesis id with a non-canonical kind must refuse, never be silently dropped and re-seeded')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0]')
      expect((err as Error).message).toMatch(/canonical serialized shape/)
    }
  })

  it('refuses a reserved genesis node whose payload discriminant is wrong, naming "dag.nodes[0]"', () => {
    const dagParsed = JSON.parse(genesisAndTwoNodeDagJson())
    dagParsed.nodes[0].payload = { datumType: 'plane', planeKind: 'base-plane', basePlane: 'xy' } // Origin masquerading as the XY plane's payload
    const input = { ...genesisAndTwoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('a reserved genesis id with a non-canonical payload must refuse, never be silently dropped and re-seeded')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0]')
    }
  })

  it('refuses an unrecognized refs[].kind, naming "dag.nodes[0].refs[0].kind"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].refs = [{ id: 'face:1', kind: 'audit-unknown-ref-kind' }]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('an unrecognized ReferenceKind must refuse, never fall back to single-face resolution')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].refs[0].kind')
    }
  })

  it('accepts every real ReferenceKind union member', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].refs = [
      { id: 'face:1', kind: 'single-face', role: 'supportFace', elementType: 'face' },
      { id: 'face:2', kind: 'face-set', role: 'supportFaces', elementType: 'face' },
      { id: 'edge:1', kind: 'single-edge', role: 'axisLine', elementType: 'edge' },
      { id: 'vertex:1', kind: 'single-vertex', role: 'point0', elementType: 'vertex' },
    ]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    expect(() => parseDebugSceneExport(input)).not.toThrow()
  })

  it('refuses a reference whose elementType contradicts its kind', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].refs = [{ id: 'edge:1', kind: 'single-edge', role: 'axisLine', elementType: 'face' }]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    expect(() => parseDebugSceneExport(input)).toThrowError(DebugSceneFormatError)
  })

  it('refuses an unknown field on a dag node, naming it (allowlist, never a blocklist)', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    ;(dagParsed.nodes[0] as Record<string, unknown>).auditExtraField = 'nope'
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('a field the validator does not know must refuse, never be silently ignored')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].auditExtraField')
    }
  })

  it('refuses an unknown field on a ref, naming it', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].refs = [{ id: 'face:1', kind: 'single-face', auditExtraField: 'nope' }]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].refs[0].auditExtraField')
    }
  })

  // WO UI-24-R3 (round-3 blocker, verbatim R2-audit repro): DagNodeSnapshot.diagnostics elements were
  // only checked as non-null objects -- the auditor's in-memory probe got BOTH corruption shapes
  // below ACCEPTED. Both are now committed fixtures, refusing BY NAME, plus a canonical-accept case
  // and a params-nested-object-specific refusal.

  it('accepts a fully canonical Diag (code/severity/params all valid)', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].diagnostics = [
      { code: 'FILLET_RADIUS_TOO_LARGE', severity: 'warning', params: { radius: 3.5, faceId: 'face:1' } },
      { code: 'OK', severity: 'info' }, // params is optional -- omitted entirely
    ]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    expect(() => parseDebugSceneExport(input)).not.toThrow()
  })

  it('refuses the R2-audit empty-object diagnostic shape (diagnostics:[{}]), naming "dag.nodes[0].diagnostics[0].code"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].diagnostics = [{}]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('an empty-object Diag (no code/severity at all) must refuse, never be accepted as a non-null object')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].diagnostics[0].code')
    }
  })

  it('refuses the R2-audit full corruption shape (bad code/severity/nested-params/unknown field), naming the FIRST violation by name', () => {
    // Verbatim from the R2 audit's own repro:
    // {code:'NOT_A_DIAG_CODE', severity:'banana', params:{x:{nested:'not string or number'}}, auditExtra:true}
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].diagnostics = [
      { code: 'NOT_A_DIAG_CODE', severity: 'banana', params: { x: { nested: 'not string or number' } }, auditExtra: true },
    ]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('this exact R2-audit corruption shape must refuse, never be silently accepted')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      // the unknown-field allowlist check runs before code/severity/params -- same order as the
      // node/ref record validators above, so the unknown `auditExtra` field is named first.
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].diagnostics[0].auditExtra')
    }
  })

  it('refuses an unrecognized DiagCode on an otherwise well-formed Diag, naming "dag.nodes[0].diagnostics[0].code"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].diagnostics = [{ code: 'NOT_A_DIAG_CODE', severity: 'warning' }]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].diagnostics[0].code')
    }
  })

  it('refuses an unrecognized severity on an otherwise well-formed Diag, naming "dag.nodes[0].diagnostics[0].severity"', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].diagnostics = [{ code: 'OK', severity: 'banana' }]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].diagnostics[0].severity')
    }
  })

  it('refuses a Diag.params value that is a nested object, naming "dag.nodes[0].diagnostics[0].params.x" (params nested-object refusal, isolated from the other R2-repro violations)', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].diagnostics = [{ code: 'OK', severity: 'info', params: { x: { nested: 'not string or number' } } }]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable('a params value that is a nested object must refuse, never sail through as an accepted plain object')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].diagnostics[0].params.x')
    }
  })

  it('refuses a Diag.params value that is a non-finite number smuggled via 1e400 overflow, naming "dag.nodes[0].diagnostics[0].params.radius"', () => {
    const dagStr = JSON.stringify({
      nodes: [
        {
          id: 'F1',
          kind: 'feature',
          consumes: [],
          refs: [],
          payload: {},
          degraded: false,
          diagnostics: [{ code: 'FILLET_RADIUS_TOO_LARGE', severity: 'warning', params: { radius: Infinity } }],
          lastGoodBoundTo: {},
          suppressed: false,
          hidden: false,
        },
      ],
      order: ['F1'],
    })
    const input = { ...validExport(), dag: dagStr, featureOrder: ['F1'] }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].diagnostics[0].params.radius')
    }
  })

  it('refuses an unknown field on a Diag, naming "dag.nodes[0].diagnostics[0].auditExtraField" (allowlist, never a blocklist)', () => {
    const dagParsed = JSON.parse(twoNodeDagJson())
    dagParsed.nodes[0].diagnostics = [{ code: 'OK', severity: 'info', auditExtraField: 'nope' }]
    const input = { ...twoNodeExport(), dag: JSON.stringify(dagParsed) }
    try {
      parseDebugSceneExport(input)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('dag.nodes[0].diagnostics[0].auditExtraField')
    }
  })
})
