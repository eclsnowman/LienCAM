// WO-2988 (WO-2750 Slice D): the drawing source adapter for a raw STL row.
//
// Contract: src/tests/evidence/WO-2750/A/REFERENCE-CONTRACT.md section 5. A
// drawing of an imported mesh is made from what the operator sees on the Model
// screen, which is the row's source bytes WITH its edit journal replayed
// (resolveEditedStlMesh, ADR-0051 s1.2). This file is the one place a drawing
// turns those two things into the resolver's MeshSourceState; it never parses
// the original bytes on its own and never converts the mesh to a BREP.
//
//   bytes + journal --resolveEditedStlMesh--> edited mesh
//     --extractMeshEdgeChains-->  chains   (geometry-derived ids)
//     --recognizeMeshFeatures-->  features (summarizeMeshFeatures fingerprints)
//     --projectMesh-->            views    (approximate, labelled)
//
// Identity stays what resolve.ts already proves: a chain by its id AND its
// point signature, a fitted feature by its support fingerprint. Recogniser
// query ids and facet numbers are kept out of every selector this file makes:
// a moved hole keeps its query id, and a facet the journal generated has no
// source triangle at all (NO_SOURCE_FACET) to borrow one from.
//
// Pure functions over plain data, apart from the clock projectMesh reads.

import { DEFAULT_MESH_FEATURE_ANGLE_DEG, extractMeshEdgeChains, type MeshEdgeChain } from '../../mesh/edgeChains'
import { NO_SOURCE_FACET } from '../../mesh/edit/idView'
import { resolveEditedStlMesh } from '../../mesh/edit/resolve'
import type { MeshEditRecord, MeshEditReplayStop } from '../../mesh/edit/types'
import { DEFAULT_MESH_WELD_TOL_FRACTION } from '../../mesh/prismatic'
import { recognizeMeshFeatures } from '../../mesh/recognition/recognize'
import { weldMesh } from '../../mesh/recognition/topology'
import { DEFAULT_FEATURE_OPTIONS, type MeshFeatureOptions } from '../../mesh/recognition/types'
import type { MeshBuffers } from '../../mesh/types'
import { projectMesh, type MeshProjectionOptions } from './project'
import {
  meshChainSignature,
  resolveDrawingReference,
  summarizeMeshFeatures,
  type AbsentSourceState,
  type MeshSourceState,
} from './resolve'
import type { DrawingReference, DrawingSource, ProjectionScene, ReferenceResult, SourceRevision, ViewFrame } from './types'

/** Identity of this adapter's chain + feature pipeline; part of producerVersion. */
export const MESH_DRAWING_PRODUCER = 'liencam-mesh-drawing/1'

export type MeshSourceScope = Omit<DrawingSource, 'observedRevision' | 'kind'>

/** The detector settings a mesh reference was placed under. */
export interface MeshDrawingSettings {
  /** sharp-edge angle for chains, degrees */
  featureAngleDeg?: number
  /** chain weld tolerance, fraction of the bbox diagonal */
  weldTolFraction?: number
  /** feature recogniser options (tolerance, region growing, weld) */
  recognition?: MeshFeatureOptions
}

export interface MeshSourceInput {
  scope: MeshSourceScope
  /** the row's imported bytes; null/undefined = the asset is not there */
  bytes: ArrayBuffer | Uint8Array | string | null | undefined
  /** the row's edit journal (ImportedGeometry.meshEdits) */
  edits?: readonly MeshEditRecord[]
  /** source-to-view placement fingerprint, owned by the caller */
  frameFingerprint?: string
  settings?: MeshDrawingSettings
}

/** One fitted feature, with the evidence a mesh value has to carry beside it. */
export interface MeshFeatureFacts {
  featureKind: string
  supportFingerprint: string
  diametersMm: number[]
  depthMm: number
  /** measured worst fit error of the feature; reported, never a tolerance */
  maxDeviationMm: number
  /** the recogniser's chord-deviation budget the fit was accepted under */
  toleranceMm: number
  /**
   * Where its supporting facets came from: the imported file ('source'), edits
   * that made new facets with no source triangle ('generated'), or both.
   */
  provenance: 'source' | 'generated' | 'mixed'
  /** supporting facets that descend from a triangle of the imported file */
  sourceFacetCount: number
  /** supporting facets an edit generated (no source triangle) */
  generatedFacetCount: number
}

export interface MeshSourceQuality {
  triangleCount: number
  /** open edges: the mesh is not closed when this is above 0 */
  boundaryEdgeCount: number
  nonManifoldEdgeCount: number
  watertight: boolean
  /** facets of the edited mesh with no triangle in the imported file */
  generatedFacetCount: number
  /** regions the recogniser refused to call a feature */
  refusedRegionCount: number
}

export type MeshSourceProblem = 'asset-missing' | 'unreadable'

export interface MeshDrawingSource {
  /** what resolveDrawingReference is handed */
  state: MeshSourceState | AbsentSourceState
  /** why the source is absent */
  problem?: MeshSourceProblem
  /** the edited mesh the views are drawn from (absent with the source) */
  mesh?: MeshBuffers
  /** per facet of `mesh`, its triangle in the imported file (NO_SOURCE_FACET if generated) */
  sourceFacetIds?: Uint32Array
  chains: MeshEdgeChain[]
  features: MeshFeatureFacts[]
  quality?: MeshSourceQuality
  /** journal records that replayed */
  appliedEdits: number
  /** where the journal stopped, if it did; earlier edits stay applied */
  stopped?: MeshEditReplayStop
  settingsFingerprint: string
  /** the sharp-edge angle the chains used, so a view draws the same chains */
  featureAngleDeg: number
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/**
 * Content hash of bytes or text (two FNV-1a lanes plus the length). It tells
 * one revision from another; it is not a security digest.
 */
export function contentFingerprint(data: ArrayBuffer | ArrayBufferView | string): string {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
  let a = 0x811c9dc5
  let b = 0x01000193 ^ bytes.length
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193)
    b = Math.imul(b ^ bytes[i] ^ (i & 0xff), 0x05bd1e95)
  }
  return `fnv2:${bytes.length.toString(16)}:${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
}

/** Settings with every default written out, so "default" and its value agree. */
export function meshSettingsFingerprint(settings: MeshDrawingSettings = {}): string {
  const rec = { ...DEFAULT_FEATURE_OPTIONS, ...settings.recognition }
  return [
    `angle=${settings.featureAngleDeg ?? DEFAULT_MESH_FEATURE_ANGLE_DEG}`,
    `weld=${settings.weldTolFraction ?? DEFAULT_MESH_WELD_TOL_FRACTION}`,
    `tol=${rec.toleranceMm}`,
    `slope=${rec.maxNormalSlope}`,
    `minRegion=${rec.minRegionFacets}`,
    `featureWeld=${rec.weldToleranceMm}`,
    `subdiv=${rec.fitSubdivisionLevels}`,
    `split=${rec.splitMergedRegions}`,
  ].join(';')
}

function journalFingerprint(edits: readonly MeshEditRecord[] | undefined): string {
  if (!edits || edits.length === 0) return 'none'
  return contentFingerprint(JSON.stringify(edits.map(e => [e.id, e.kind, e.version, e.parameters, e.facets, e.witness])))
}

function meshFingerprint(mesh: MeshBuffers): string {
  const p = contentFingerprint(mesh.positions)
  const i = contentFingerprint(mesh.indices)
  return `${p}|${i}`
}

// ---------------------------------------------------------------------------
// Building the source
// ---------------------------------------------------------------------------

/**
 * Build the drawing source for one STL row: replay its journal over its bytes,
 * then derive chains, fitted features and quality from the EDITED mesh.
 * A missing asset is `absent` (every reference: missing / source-missing).
 */
export function buildMeshDrawingSource(input: MeshSourceInput): MeshDrawingSource {
  const settings = input.settings ?? {}
  const settingsFingerprint = meshSettingsFingerprint(settings)
  const featureAngleDeg = settings.featureAngleDeg ?? DEFAULT_MESH_FEATURE_ANGLE_DEG
  const absent = (problem: MeshSourceProblem): MeshDrawingSource => ({
    state: { kind: 'absent' }, problem, chains: [], features: [], appliedEdits: 0, settingsFingerprint, featureAngleDeg,
  })
  if (input.bytes === null || input.bytes === undefined) return absent('asset-missing')
  let resolved: ReturnType<typeof resolveEditedStlMesh>
  try {
    resolved = resolveEditedStlMesh(input.bytes, input.edits)
  } catch {
    return absent('unreadable')
  }
  const { mesh, sourceFacetIds } = resolved
  if (mesh.indices.length < 3) return absent('unreadable')

  const chains = extractMeshEdgeChains(mesh, { featureAngleDeg, weldTolFraction: settings.weldTolFraction })
  // Mesh-local facet ids here, mapped below: the provenance count needs to see
  // the generated facets that a source-id query would silently drop.
  const recognition = recognizeMeshFeatures(mesh, undefined, settings.recognition)
  const supports = summarizeMeshFeatures(recognition)
  const facetsOf = [
    ...recognition.features.map(f => f.sourceFacetIds),
    ...recognition.pockets.map(p => p.sourceFacetIds),
  ]
  const features: MeshFeatureFacts[] = supports.map((s, i) => {
    const local = facetsOf[i] ?? []
    const generated = local.filter(f => sourceFacetIds[f] === NO_SOURCE_FACET).length
    const sourced = local.length - generated
    const round = i < recognition.features.length ? recognition.features[i] : undefined
    const pocket = round ? undefined : recognition.pockets[i - recognition.features.length]
    return {
      featureKind: s.featureKind,
      supportFingerprint: s.supportFingerprint,
      diametersMm: round ? [...round.diametersMm] : [],
      depthMm: round ? round.depthMm : pocket?.depthMm ?? 0,
      maxDeviationMm: round ? round.maxDeviationMm : pocket?.maxDeviationMm ?? 0,
      toleranceMm: recognition.toleranceMm,
      provenance: generated === 0 ? 'source' : sourced === 0 ? 'generated' : 'mixed',
      sourceFacetCount: sourced,
      generatedFacetCount: generated,
    }
  })

  // An STL is a triangle soup: count open and over-shared edges on the
  // position-welded mesh, never on the file's own vertex numbering.
  const welded = weldMesh(mesh)
  let boundaryEdgeCount = 0
  let nonManifoldEdgeCount = 0
  for (const e of welded.edges) {
    if (e.facets.length === 1) boundaryEdgeCount++
    else if (e.facets.length > 2) nonManifoldEdgeCount++
  }
  let generatedFacetCount = 0
  for (const id of sourceFacetIds) if (id === NO_SOURCE_FACET) generatedFacetCount++

  const revision: SourceRevision = {
    geometryFingerprint: meshFingerprint(mesh),
    frameFingerprint: input.frameFingerprint ?? 'identity',
    producerVersion: `${MESH_DRAWING_PRODUCER}|${settingsFingerprint}`,
    journalFingerprint: journalFingerprint(input.edits),
  }
  const state: MeshSourceState = {
    kind: 'mesh',
    scope: input.scope,
    revision,
    chains,
    features: supports,
    settingsFingerprint,
    ...(resolved.stopped ? { replayStopped: { reason: resolved.stopped.reason } } : {}),
  }
  return {
    state,
    mesh,
    sourceFacetIds,
    chains,
    features,
    quality: {
      triangleCount: welded.facetCount,
      boundaryEdgeCount,
      nonManifoldEdgeCount,
      watertight: boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0,
      generatedFacetCount,
      refusedRegionCount: recognition.refusals.length,
    },
    appliedEdits: resolved.appliedCount,
    ...(resolved.stopped ? { stopped: resolved.stopped } : {}),
    settingsFingerprint,
    featureAngleDeg,
  }
}

// ---------------------------------------------------------------------------
// Placing references (what the editor stores when the operator picks)
// ---------------------------------------------------------------------------

function placedSource(src: MeshDrawingSource & { state: MeshSourceState }): DrawingSource {
  return { ...src.state.scope, kind: 'mesh', observedRevision: src.state.revision }
}

/** A reference to one chain of the source as it is now; undefined if the id is not unique. */
export function placeMeshChainReference(src: MeshDrawingSource, chainId: string, referenceId: string): DrawingReference | undefined {
  if (src.state.kind !== 'mesh') return undefined
  const same = src.chains.filter(c => c.id === chainId)
  if (same.length !== 1) return undefined
  return {
    id: referenceId,
    source: placedSource(src as MeshDrawingSource & { state: MeshSourceState }),
    selector: { kind: 'mesh-chain', chainId, settingsFingerprint: src.settingsFingerprint },
    witness: { role: 'curve', geometrySignature: meshChainSignature(same[0]) },
    acceptedRevision: src.state.revision,
  }
}

/**
 * A reference to one fitted feature, named by its support fingerprint (never
 * the recogniser's query id); undefined if the support is not unique.
 */
export function placeMeshFeatureReference(src: MeshDrawingSource, supportFingerprint: string, referenceId: string): DrawingReference | undefined {
  if (src.state.kind !== 'mesh') return undefined
  const same = src.features.filter(f => f.supportFingerprint === supportFingerprint)
  if (same.length !== 1) return undefined
  return {
    id: referenceId,
    source: placedSource(src as MeshDrawingSource & { state: MeshSourceState }),
    selector: { kind: 'mesh-feature', featureKind: same[0].featureKind, supportFingerprint, settingsFingerprint: src.settingsFingerprint },
    witness: { role: 'center', geometrySignature: supportFingerprint },
    acceptedRevision: src.state.revision,
  }
}

// ---------------------------------------------------------------------------
// Values and views
// ---------------------------------------------------------------------------

export interface MeshFeatureMeasurement {
  result: ReferenceResult
  /** present only when the reference is current */
  diametersMm?: number[]
  depthMm?: number
  /** the fit's measured worst error, printed beside the value; not a tolerance */
  maxDeviationMm?: number
  toleranceMm?: number
  provenance?: MeshFeatureFacts['provenance']
  /** a mesh value is a fit, never an exact analytic size */
  approximate: true
}

/**
 * Resolve a fitted-feature reference and, only when it is current, hand back
 * its fitted sizes with the fit deviation beside them (contract section 5).
 */
export function measureMeshFeature(ref: DrawingReference, src: MeshDrawingSource): MeshFeatureMeasurement {
  const result = resolveDrawingReference(ref, src.state)
  if (result.state !== 'current' || ref.selector.kind !== 'mesh-feature') return { result, approximate: true }
  const facts = src.features.find(f => f.supportFingerprint === result.resolvedIds[0])
  if (!facts) return { result, approximate: true }
  return {
    result,
    diametersMm: facts.diametersMm,
    depthMm: facts.depthMm,
    maxDeviationMm: facts.maxDeviationMm,
    toleranceMm: facts.toleranceMm,
    provenance: facts.provenance,
    approximate: true,
  }
}

/**
 * Draw one view of the edited mesh. Open, non-manifold or coarse meshes still
 * draw; the scene's limits say what the view cannot promise. An absent source
 * draws nothing and says so.
 */
export function projectMeshDrawingSource(src: MeshDrawingSource, frame: ViewFrame, opts: MeshProjectionOptions = {}): ProjectionScene | { frame: ViewFrame; absent: MeshSourceProblem } {
  if (!src.mesh || src.state.kind !== 'mesh') return { frame, absent: src.problem ?? 'asset-missing' }
  const scene = projectMesh(src.mesh, frame, { ...opts, featureAngleDeg: opts.featureAngleDeg ?? src.featureAngleDeg })
  const limits = [...scene.limits]
  const q = src.quality
  if (q && q.boundaryEdgeCount > 0) limits.push(`Open mesh: ${q.boundaryEdgeCount} open edges; its boundary is drawn as lines and nothing behind a gap is hidden by it.`)
  if (q && q.nonManifoldEdgeCount > 0) limits.push(`Non-manifold mesh: ${q.nonManifoldEdgeCount} edges are shared by more than two facets.`)
  if (src.stopped) limits.push(`The edit journal stopped at edit ${src.stopped.index + 1} (${src.stopped.reason}); this view shows the edits before it.`)
  return { ...scene, limits }
}
