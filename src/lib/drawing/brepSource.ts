// WO-2988 (WO-2750 Slice D): the drawing source adapter for an imported STEP
// solid.
//
// Contract: src/tests/evidence/WO-2750/A/REFERENCE-CONTRACT.md section 4. The
// solid is made by the SAME route the Model screen's import node replays
// (store/headlessModelBodyReplay.ts replayImportNode): `importStep(bytes,
// nodeId)` on the modeling kernel, then the node's own `bodyIndex`. What the
// resolver needs from it is put into a BrepSourceState:
//
//   - scope: the archive asset id, a content fingerprint of the bytes, and the
//     solid key. The solid is always named; a multi-solid file never falls
//     back to "the first solid".
//   - the solid's ElementMap, replayed from the import delta (frozen
//     `IMPn:step:face#i` ids: same bytes + same kernel build = same ids).
//   - the live edge ids of the solid (TessBuffers.edgeIds), so an edge
//     reference can be proved instead of being reported unsupported.
//   - the kernel build as producerVersion: face numbering is only promised
//     per build.
//
// Changed bytes or another build are decided by resolve.ts (stale, the old id
// kept only as a repair seed). This file never maps one file's faces onto
// another's.
//
// The view is drawn exactly: the solid is serialized by the modeling kernel
// (serializeBody, the same BREP the document cache stores) and read into the
// drawing kernel for its hidden-line removal (projectBrepHlr).

import type { OcctKernel } from 'occt-wasm'
import { ElementMap } from '../../doc/element-map'
import type { GeomClient } from '../../geom'
import type { BodyHandle, Diag } from '../../geom/geom-service'
import { contentFingerprint } from './meshSource'
import { projectBrepHlr, type BrepProjectionOptions, type HlrKernel } from './project'
import type { AbsentSourceState, BrepSourceState } from './resolve'
import type { DrawingReference, DrawingSource, ProjectionScene, SourceRevision, ViewFrame, WitnessRole } from './types'
import { faceSnapshotSignature } from './resolve'

/** The slice of the modeling kernel client this adapter uses. */
export type StepImportClient = Pick<GeomClient, 'importStep' | 'tessellate' | 'dispose' | 'serializeBody'>

export interface StepSourceInput {
  scope: { modelItemId: string; documentId: string; lineageId: string; importAssetId: string }
  /** the asset's bytes; null/undefined = the asset is not there */
  bytes: ArrayBuffer | null | undefined
  /** the import node id; it prefixes every face id (`IMP1:step:face#0`) */
  importNodeId: string
  /** which solid of the file; required, never defaulted */
  solidIndex: number
  /** kernel build identity (the modeling kernel's OCCT and package build) */
  producerVersion: string
  frameFingerprint?: string
  /** tessellation deflection used to read the live edge ids, mm */
  edgeDeflectionMm?: number
}

export type StepSourceProblem = 'asset-missing' | 'import-failed' | 'solid-missing'

export interface StepDrawingSource {
  state: BrepSourceState | AbsentSourceState
  problem?: StepSourceProblem
  /** how many solids the file holds (0 when it could not be read) */
  solidCount: number
  /** the kept solid on the modeling kernel; the caller disposes it */
  handle?: BodyHandle
  diagnostics: Diag[]
}

/** The solid key a reference stores; derived from the index, never "first". */
export function stepSolidKey(solidIndex: number): string {
  return `solid-${solidIndex}`
}

/**
 * Import the asset through the kernel's STEP route and build the drawing
 * source for ONE named solid. Every other solid's handle is disposed.
 */
export async function buildStepDrawingSource(client: StepImportClient, input: StepSourceInput): Promise<StepDrawingSource> {
  const absent = (problem: StepSourceProblem, solidCount = 0, diagnostics: Diag[] = []): StepDrawingSource => ({
    state: { kind: 'absent' }, problem, solidCount, diagnostics,
  })
  if (input.bytes === null || input.bytes === undefined) return absent('asset-missing')
  // The fingerprint is taken before the kernel sees the bytes (a worker
  // transfer may detach them).
  const importContentFingerprint = contentFingerprint(input.bytes)
  let imported: Awaited<ReturnType<StepImportClient['importStep']>>
  try {
    imported = await client.importStep(input.bytes.slice(0), input.importNodeId)
  } catch {
    return absent('import-failed')
  }
  const disposeAll = (keep?: BodyHandle) => Promise.all(imported.bodies
    .filter(b => b.handle !== keep)
    .map(b => client.dispose(b.handle).catch(() => undefined)))
  if (imported.diagnostics.some(d => d.severity === 'error') || imported.bodies.length === 0) {
    await disposeAll()
    return absent('import-failed', imported.bodies.length, imported.diagnostics)
  }
  const body = imported.bodies[input.solidIndex]
  if (!Number.isInteger(input.solidIndex) || !body) {
    await disposeAll()
    return absent('solid-missing', imported.bodies.length, imported.diagnostics)
  }
  await disposeAll(body.handle)

  const map = new ElementMap()
  map.applyDelta(body.elementMap)
  let tess: Awaited<ReturnType<StepImportClient['tessellate']>>
  try {
    tess = await client.tessellate(body.handle, { deflection: input.edgeDeflectionMm ?? 0.1 })
  } catch {
    // No live edge list means no proof; do not keep a handle nobody owns.
    await client.dispose(body.handle).catch(() => undefined)
    return absent('import-failed', imported.bodies.length, imported.diagnostics)
  }
  const pos = tess.position
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k])
      max[k] = Math.max(max[k], pos[i + k])
    }
  }
  const bboxDiagMm = pos.length >= 3 ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0

  const importSolidKey = stepSolidKey(input.solidIndex)
  const revision: SourceRevision = {
    // The solid is a pure function of the bytes, the solid and the build.
    geometryFingerprint: `${importContentFingerprint}#${importSolidKey}`,
    frameFingerprint: input.frameFingerprint ?? 'identity',
    producerVersion: input.producerVersion,
  }
  const state: BrepSourceState = {
    kind: 'imported-brep',
    scope: { ...input.scope, importContentFingerprint, importSolidKey },
    revision,
    map,
    bboxDiagMm,
    liveEdgeIds: new Set(tess.edgeIds),
    // No route produces live vertex ids yet (TessBuffers carries edgeIds
    // only), so vertex references stay unsupported / topology-unavailable.
  }
  return { state, solidCount: imported.bodies.length, handle: body.handle, diagnostics: imported.diagnostics }
}

/**
 * A face reference to the source as it is now, with the witness taken from
 * the face's own snapshot; undefined when the face is not live.
 */
export function placeStepFaceReference(src: StepDrawingSource, faceId: string, role: WitnessRole, referenceId: string): DrawingReference | undefined {
  if (src.state.kind === 'absent') return undefined
  const snap = src.state.map.has(faceId) ? src.state.map.snapshotOf(faceId) : undefined
  if (!snap) return undefined
  const o = snap.normal ?? snap.axis
  const source: DrawingSource = { ...src.state.scope, kind: 'imported-brep', observedRevision: src.state.revision }
  return {
    id: referenceId,
    source,
    selector: { kind: 'face', stableId: faceId },
    witness: {
      role,
      ...(o ? { orientationLocal: [o.x, o.y, o.z] as [number, number, number] } : {}),
      geometrySignature: faceSnapshotSignature(snap),
      snapshot: snap,
    },
    acceptedRevision: src.state.revision,
  }
}

/** An edge reference (by its live edge id); undefined when the edge is not live. */
export function placeStepEdgeReference(src: StepDrawingSource, edgeId: string, referenceId: string): DrawingReference | undefined {
  if (src.state.kind === 'absent' || !src.state.liveEdgeIds?.has(edgeId)) return undefined
  const source: DrawingSource = { ...src.state.scope, kind: 'imported-brep', observedRevision: src.state.revision }
  return {
    id: referenceId,
    source,
    selector: { kind: 'edge', stableId: edgeId },
    witness: { role: 'curve', geometrySignature: edgeId },
    acceptedRevision: src.state.revision,
  }
}

/** The drawing kernel slice the exact view needs. */
export type BrepViewKernel = HlrKernel & Pick<OcctKernel, 'fromBREPBinary'>

/**
 * Draw one view of the kept solid with the kernel's hidden-line removal. The
 * modeling kernel serializes the solid; the drawing kernel reads it and
 * projects it. The read shape is released afterwards.
 */
export async function projectStepDrawingSource(
  client: StepImportClient,
  src: StepDrawingSource,
  kernel: BrepViewKernel,
  frame: ViewFrame,
  opts: BrepProjectionOptions = {},
): Promise<ProjectionScene | { frame: ViewFrame; absent: StepSourceProblem }> {
  if (src.state.kind === 'absent' || src.handle === undefined) return { frame, absent: src.problem ?? 'asset-missing' }
  const brep = new Uint8Array(await client.serializeBody(src.handle))
  const shape = kernel.fromBREPBinary(brep)
  try {
    return projectBrepHlr(kernel, shape, frame, opts)
  } finally {
    try { kernel.release(shape) } catch { /* already released */ }
  }
}
