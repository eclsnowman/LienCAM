// Worker protocol for the B-rep MODEL worker (ADR 0018).
//
// The model worker reads STEP bytes, heals the shape, tessellates it, and returns
// transferable buffers. The TopoDS_Shape handle itself NEVER crosses the worker
// boundary (ADR 0018 D2) -- it stays in the worker's wasm heap, keyed by geoId.

import type { HoleFeature, CylinderFeature } from '../../../../../types'
import type { SectionPlane } from './derive'

export type { HoleFeature }
export type { CylinderFeature }
export type { SectionPlane }

/**
 * A loop derived from B-rep geometry, in world XY at a constant Z (Stage 3
 * derivation layer, ADR 0018 D4). Shape mirrors Loop2D minus id/layerId --
 * the store assigns those when it lands the loops as a Layer2D.
 *
 * Winding convention (house rule, see src/lib/geometry/path2d.ts joinSegments):
 * closed 'contour' loops are CCW (signed area > 0), closed 'hole' loops are CW
 * (signed area < 0), open chains are type 'open'. `area` is the absolute value.
 */
export interface DerivedLoop {
  points: { x: number; y: number }[]
  closed: boolean
  type: 'contour' | 'hole' | 'open'
  area: number
}

/** Loops + the machining-plane Z they live at. */
export interface DerivedLoopsResult {
  loops: DerivedLoop[]
  z: number
}

/**
 * Complete worker-side classification for the narrow prismatic target shape
 * that scalar 2D roughing can represent. Coordinates are MODEL-space; the
 * store adapter applies the ImportedGeometry pose before Smart Height sees it.
 */
export interface PrismaticRoughTargetRegion {
  faceIndex: number
  loop: DerivedLoop
  targetTopZ: number
}

export interface PrismaticRoughTargetFacts {
  bounds: { min: [number, number, number]; max: [number, number, number] }
  solidCount: number
  roughFloorZ?: number
  keepOutRegions: PrismaticRoughTargetRegion[]
  classification: {
    allFacesClassified: boolean
    hasSlopedFaces: boolean
    hasUndercuts: boolean
    deckLevelsZ: number[]
    unclassifiedFaceIds: string[]
  }
}

/** Main thread -> model worker. */
export type ModelRequestMsg =
  | {
      type: 'READ_STEP'
      /** Correlates responses to this request (a geometry may be re-imported). */
      requestId: string
      /** ImportedGeometry id this shape belongs to. */
      geoId: string
      /** Raw STEP file bytes (transferred, not copied). */
      bytes: ArrayBuffer
      /** Original file name -- used only for error messages. */
      fileName: string
      /**
       * Render-fidelity deflection (BRepMesh). Optional + back-compatible: when
       * omitted the worker passes undefined and core.ts uses its built-in
       * defaults. Resolved from app settings via quality.ts before posting.
       */
      tessellation?: { linearDeflection: number; angularDeflection: number }
    }
  // Stage 3 derivation requests. All operate on the in-heap shape registry
  // (getShape(geoId)); if the shape is not resident the worker answers with
  // MODEL_ERROR where='shape-not-resident' and the CLIENT recovers by re-running
  // READ_STEP from stepCache (the worker never touches IndexedDB).
  | { type: 'DERIVE_FACE_LOOPS'; requestId: string; geoId: string; faceIndex: number }
  | { type: 'DERIVE_EDGE_LOOPS'; requestId: string; geoId: string; edgeIndices: number[] }
  | { type: 'DERIVE_HOLES'; requestId: string; geoId: string }
  // Vertical cylinders (bores + bosses). `faceIndices` restricts the scan to a
  // picked subset (e.g. a single bore/boss wall); omitted = full-shape scan.
  | { type: 'DERIVE_CYLINDERS'; requestId: string; geoId: string; faceIndices?: number[] }
  // Complete analytic classification for the narrow one-deck prismatic target
  // representation accepted by scalar 2D roughing workers.
  | { type: 'DERIVE_PRISMATIC_ROUGH_TARGET'; requestId: string; geoId: string }
  // `z` is the legacy horizontal cut height; when `plane` is present the worker
  // cuts against that arbitrary MODEL-space frame instead (z then carries the
  // representative scalar for naming). z stays required for back-compat callers.
  | {
      type: 'DERIVE_SECTION'
      requestId: string
      geoId: string
      z: number
      plane?: SectionPlane
    }

/** Model worker -> main thread. */
export type ModelResponseMsg =
  | {
      type: 'MODEL_PROGRESS'
      requestId: string
      phase: 'read' | 'heal' | 'mesh'
      note?: string
    }
  | {
      type: 'MODEL_READY'
      requestId: string
      geoId: string
      payload: BrepModelPayload
    }
  | { type: 'DERIVED_FACE_LOOPS'; requestId: string; geoId: string; result: DerivedLoopsResult }
  // One DerivedLoopsResult PER Z plane the picked edges span (edgeChainLoops
  // groups its chained loops by Z): the common single-plane pick is a length-1
  // array. The store lands one derived layer per element.
  | { type: 'DERIVED_EDGE_LOOPS'; requestId: string; geoId: string; result: DerivedLoopsResult[] }
  | { type: 'DERIVED_HOLES'; requestId: string; geoId: string; holes: HoleFeature[] }
  | { type: 'DERIVED_CYLINDERS'; requestId: string; geoId: string; cylinders: CylinderFeature[] }
  | {
      type: 'DERIVED_PRISMATIC_ROUGH_TARGET'
      requestId: string
      geoId: string
      facts: PrismaticRoughTargetFacts
    }
  | { type: 'DERIVED_SECTION'; requestId: string; geoId: string; result: DerivedLoopsResult }
  | {
      // ADR 0003: errors name what failed and where -- no silent fallbacks.
      type: 'MODEL_ERROR'
      requestId: string
      geoId: string
      where: string
      message: string
    }

/**
 * Everything the main thread needs to render and pick a B-rep model.
 *
 * IDENTITY CONTRACT (ADR 0018 D3): face index i and edge index i below are the
 * stable subshape indices -- TopExp_Explorer DFS first-encounter order with
 * IsSame() dedup over the HEALED shape, exactly as the smoke test
 * (src/tests/geometry/occt-model-smoke.test.ts GATE B) counts them. That order
 * is deterministic for the same STEP bytes + same OCCT build, so faceRanges[2i]
 * / edgeRanges[2i] indexed here MUST line up 1:1 with the shapes returned by
 * core.ts indexSubshapes() inside the worker. Do not re-order either side.
 *
 * Every typed array is a fresh JS-heap array (copied OUT of the wasm heap),
 * safe to transfer via postMessage.
 */
export interface BrepModelPayload {
  faceCount: number
  edgeCount: number
  solidCount: number
  /** Axis-aligned bounding box of the healed shape, world mm. */
  bbox: { min: [number, number, number]; max: [number, number, number] }
  mesh: {
    /** xyz triples; vertices are NOT shared across faces (per-face blocks). */
    positions: Float32Array
    /** Per-vertex normals, same length as positions; outward, orientation-corrected. */
    normals: Float32Array
    /** Triangle vertex indices into positions/3; winding corrected for REVERSED faces. */
    indices: Uint32Array
    /** Per face i: [2i] = first index offset into indices, [2i+1] = index count. */
    faceRanges: Uint32Array
    /** Optional deterministic full-quality per-vertex ambient occlusion. */
    ao?: Float32Array
  }
  edges: {
    /** Concatenated polyline points, xyz triples. */
    positions: Float32Array
    /** Per edge i: [2i] = first POINT offset (in points, not floats), [2i+1] = point count. */
    edgeRanges: Uint32Array
  }
  /**
   * Per face: GeomAbs_SurfaceType numeric value in GeomAbs enum order
   * (Plane=0, Cylinder=1, Cone=2, Sphere=3, Torus=4, BezierSurface=5,
   * BSplineSurface=6, SurfaceOfRevolution=7, SurfaceOfExtrusion=8,
   * OffsetSurface=9, OtherSurface=10).
   */
  faceTypes: Uint8Array
}
