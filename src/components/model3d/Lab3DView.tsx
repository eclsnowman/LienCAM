// 3D Lab (WO UI-2, extended WO INT-1): standalone diagnostic view proving the
// real geometry worker -> render bridge round trip inside the actual app.
// Creates a demo boolean-cut body through the REAL src/geom facade (or a fake
// injected for tests), renders it via the merged UI-1 bridge
// (GeomBridgeSession + highlight.ts), and supports hover/select across all
// four selection filter modes on the real tessellation.
//
// WO INT-1 (M1 gate) adds the STEP Vault Viewer surface on top of that proven
// bridge: an "Open STEP" file control (real importStep, multi-body,
// names/colors), exact measure readout (face area / edge length / body
// volume from the kernel measure API, never a tessellation-derived
// approximation), and a visual clip-plane section control. Per architect
// ruling 1, the section is a real three.js clipping plane -- cheap and
// honest, NOT a kernel-exact section curve (that lands with UI-4).
//
// Two injection points keep this testable without a browser:
//  1. `createClient` (default createGeomService, the real worker facade) --
//     the "worker faked at the facade boundary" the WO's render smoke test
//     acceptance criterion requires.
//  2. `createSceneRuntime` (default createDefaultSceneRuntime, see
//     sceneRuntime.ts) -- so the component itself never touches
//     THREE.WebGLRenderer; tests inject a stub that never constructs one.

import { useText, textFor } from '../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createGeomService, tessQualityForTier, type GeomClient } from '../../geom'
import type { FeatureClass, MeasureResult } from '../../geom/geom-service'
import {
  DEFAULT_HIGHLIGHT_COLORS,
  GeomBridgeSession,
  applyBodyHighlight,
  applyEdgeHighlights,
  applyFaceHighlights,
  attachHighlightAttributes,
  faceAreaFromMesh,
  paintEdgeColor,
  type BridgeVertexRef,
  type CachedBody,
  type HighlightColorSet,
  type PickHit,
  type SelectionFilterMode,
} from '../../viewport3d'
import { BodyListPanel, type BodyListEntry } from './BodyListPanel'
import { createDefaultSceneRuntime, type CreateSceneRuntime, type SceneRuntime } from './sceneRuntime'

export interface Lab3DViewProps {
  createClient?: () => GeomClient
  createSceneRuntime?: CreateSceneRuntime
}

interface BodyObjects {
  mesh: THREE.Mesh
  edgeLines: THREE.LineSegments
}

/** One (bodyId, phase) sample recorded during a STEP import's progressive
 *  tessellation -- WO INT-1 acceptance #2 (BK-15), read by the permanent
 *  headless smoke (tools/smoke/lab3d-smoke.mjs) via window.__lab3dImportStats.
 *  Only populated by the "Open STEP" flow, never the demo box, so the array
 *  staying empty is itself a reliable "no STEP import has landed yet" signal
 *  for a driver waiting on it. */
export interface Lab3DImportStat {
  bodyId: string
  name: string
  phase: 'coarse' | 'display'
  ms: number
  triangles: number
}

declare global {
  interface Window {
    __lab3dImportStats?: Lab3DImportStat[]
    /** Test/smoke-only seam (WO INT-1): lets a headless driver target a real
     *  screen pixel for a body it just imported, without knowing in advance
     *  where the STEP file's own coordinates placed it. Uses the SAME camera
     *  projection the real pick path reads from -- not a raycast bypass. */
    __lab3dTestHooks?: {
      projectBodyCenter(bodyId: string): { x: number; y: number } | null
    }
  }
}

const DEMO_BODY_ID = 'demoBody'
// Exported so tests can build the IDENTICAL cut-box shape independently (WO
// INT-1-R1.2's real-kernel ground-truth test) without duplicating literals.
export const DEMO_BOX_SIZE = { x: 40, y: 20, z: 10 }
export const DEMO_TOOL_SIZE = { x: 10, y: 10, z: 20 }

const FILTER_MODES: SelectionFilterMode[] = ['body', 'face', 'edge', 'vertex']
const SECTION_AXES = ['x', 'y', 'z'] as const
type SectionAxis = (typeof SECTION_AXES)[number]

/** WO INT-1: -axis unit vectors -- see the section-control effect for why
 *  the plane normal points the OPPOSITE way from the axis it's named after
 *  (so the slider clips away the "above the slider" side as it moves down). */
const SECTION_AXIS_NORMALS: Record<SectionAxis, THREE.Vector3> = {
  x: new THREE.Vector3(-1, 0, 0),
  y: new THREE.Vector3(0, -1, 0),
  z: new THREE.Vector3(0, 0, -1),
}

const MEASURE_UNITS: Record<MeasureResult['kind'], string> = {
  distance: 'mm',
  radius: 'mm',
  angle: 'deg',
  get volume() { return workbenchText('Lab3DView.mm3') },
  get area() { return workbenchText('Lab3DView.mm2') },
  length: 'mm',
}

interface MeasureState {
  label: string
  kind: MeasureResult['kind']
  value: number
  error?: string
  /** WO INT-1-R1.2: true ONLY for the instant mesh-derived preview shown the
   *  moment a face is picked, before the frozen facade's own measure('area',
   *  ids) resolves and replaces it (see applySelectPick's face branch) --
   *  never a claim that the SETTLED value is an approximation. */
  approx?: boolean
  /** WO INT-1-R1.1: vertex selection has no numeric MeasureResult kind in
   *  the frozen facade (no 'point'/'position' kind exists) -- when present,
   *  this overrides the numeric formatting below so the panel reports the
   *  vertex's BridgeVertexRef identity honestly instead of fabricating a
   *  measurement. */
  text?: string
}

/** STEP colors may arrive as either 0-1 floats (THREE vertex-color
 *  convention, occt-wasm XCAF's own native range) or 0-255 bytes -- clamp
 *  defensively rather than assume, since GEO-2.report.json didn't pin the
 *  range (no fixture with real color data was available when it was written). */
function normalizeColorComponent(c: number): number {
  if (c > 1) return Math.min(c / 255, 1)
  return Math.max(c, 0)
}

function colorSetFor(color: [number, number, number] | undefined): HighlightColorSet {
  if (color === undefined) return DEFAULT_HIGHLIGHT_COLORS
  const base: [number, number, number] = [
    normalizeColorComponent(color[0]),
    normalizeColorComponent(color[1]),
    normalizeColorComponent(color[2]),
  ]
  return { ...DEFAULT_HIGHLIGHT_COLORS, base }
}

/** Build/refresh a THREE.Mesh + LineSegments pair for a CachedBody, reusing
 *  the SAME Object3D instances across a re-ingest (progressive refine swaps
 *  in the display tier without a visible unmount -- WO acceptance #2). */
function paintBody(
  bodyId: string,
  cachedBody: CachedBody,
  runtime: SceneRuntime,
  objects: Map<string, BodyObjects>,
  selection: GeomBridgeSession['selection'],
  colors: HighlightColorSet = DEFAULT_HIGHLIGHT_COLORS,
): void {
  attachHighlightAttributes(cachedBody, colors)
  applyFaceHighlights(cachedBody, selection, colors)
  applyEdgeHighlights(cachedBody, selection, colors)

  const existing = objects.get(bodyId)
  if (existing === undefined) {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.1,
      roughness: 0.8,
      // WO UI-H1 z-fight candidate (c), architect note: push the filled
      // faces a hair back in depth so the coincident edge-overlay
      // LineSegments always wins the depth test instead of a per-pixel
      // coin-flip between the two coincident surfaces.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    })
    const mesh = new THREE.Mesh(cachedBody.geometry, material)
    const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true })
    const edgeLines = new THREE.LineSegments(cachedBody.edgeGeometry, edgeMaterial)
    objects.set(bodyId, { mesh, edgeLines })
    runtime.addObject(mesh)
    runtime.addObject(edgeLines)
    // WO UI-H1: wires this body into the section stencil-cap system (see
    // sceneRuntime.ts) -- a clipped body now reads as solid instead of a
    // hollow shell.
    runtime.registerSectionable(mesh, edgeLines)
  } else {
    // Reassign geometry on the SAME Mesh/LineSegments -- never remove+re-add
    // the Object3D (that's what "refine swaps in the display tier without a
    // visible unmount" means). GeometryCache.ingest already disposed the
    // prior tier's BufferGeometry, so this never leaks.
    existing.mesh.geometry = cachedBody.geometry
    existing.edgeLines.geometry = cachedBody.edgeGeometry
    runtime.syncSectionGeometry(existing.mesh)
  }
  runtime.requestRender()
}

export function Lab3DView({
  createClient = createGeomService,
  createSceneRuntime = createDefaultSceneRuntime,
}: Lab3DViewProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const runtimeRef = useRef<SceneRuntime | null>(null)
  const sessionRef = useRef<GeomBridgeSession | null>(null)
  const clientRef = useRef<GeomClient | null>(null)
  const objectsRef = useRef<Map<string, BodyObjects>>(new Map())
  const bodyColorsRef = useRef<Map<string, HighlightColorSet>>(new Map())
  // WO UI-10 (BK-60): name-per-bodyId, mirroring bodyColorsRef -- the
  // adopted-defeatured-body flow needs the pre-defeature body's display name
  // to derive "<name> (defeatured)" without reading stale `bodies` state
  // from outside the mount effect (see fetchAndSetVolumeRef below for the
  // same "outer handler needs effect-local state" problem, solved the same
  // way the codebase already solves it for openStepFileRef).
  const bodyNamesRef = useRef<Map<string, string>>(new Map())
  const hoveredVertexRef = useRef<{ bodyId: string; ref: BridgeVertexRef } | null>(null)
  // WO INT-1-R1.1: body/vertex select+hover state, tracked outside
  // SelectionState the same way hoveredVertexRef already was -- BodyId isn't
  // a StableId (types.ts), so neither has a slot in SelectionState.
  const hoveredBodyIdRef = useRef<string | null>(null)
  const selectedBodyIdsRef = useRef<Set<string>>(new Set())
  const selectedVertexRef = useRef<{ bodyId: string; ref: BridgeVertexRef } | null>(null)
  // WO INT-1-R1.2: bumped on every select-pick so a stale async measure()
  // resolution (e.g. face area, arriving after the user already moved on)
  // never clobbers a newer measurement panel state.
  const measureTokenRef = useRef(0)
  const importStatsRef = useRef<Lab3DImportStat[]>([])
  const importCounterRef = useRef(0)
  const mountedRef = useRef(true)
  const openStepFileRef = useRef<((file: File) => Promise<void>) | null>(null)
  // WO UI-10 (BK-60): same ref-to-effect-closure pattern as openStepFileRef
  // -- fetchAndSetVolume is defined inside the mount effect (closes over
  // `cancelled`/`session`), so the outer handleDefeatureHoles reaches it
  // through this ref instead of duplicating the measure+setBodies logic.
  const fetchAndSetVolumeRef = useRef<((bodyId: string) => void) | null>(null)
  // GEO-6: the most-recently imported STEP body -- the defeature affordance
  // operates on it (recognize -> batch-remove holes -> adopt the healed
  // result, BK-60).
  const lastStepBodyIdRef = useRef<string | null>(null)
  // WO UI-10 (BK-60): disambiguates repeated defeature runs on the same
  // original STEP bodyId into distinct adopted bodyIds.
  const defeatureCounterRef = useRef(0)

  const [bodies, setBodies] = useState<BodyListEntry[]>([])
  const [defeatureBusy, setDefeatureBusy] = useState(false)
  const [defeatureMsg, setDefeatureMsg] = useState<string | null>(null)
  const [filterMode, setFilterMode] = useState<SelectionFilterMode>('body')
  const [status, setStatus] = useState<string>(workbenchText('Lab3DView.initializing'))
  const [measurement, setMeasurement] = useState<MeasureState | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [sectionAxis, setSectionAxis] = useState<SectionAxis>('z')
  const [sectionPos, setSectionPos] = useState<number | null>(null) // null = auto (fully open)
  // Per-axis, NOT a single combined min/max: a flat wide part (e.g. a tray,
  // large XY footprint, small Z thickness) needs the Z slider's range to
  // reflect Z's own small extent -- a shared scalar range would put the
  // slider's "middle" far above the part's actual Z extent, clipping
  // nothing (caught via the Tray.step smoke screenshot before this fix).
  // Sentinels (Infinity/-Infinity), NOT an arbitrary placeholder like
  // {-50,50}: Math.min/max folding can only WIDEN a range, never narrow it,
  // so a placeholder wider than the real geometry would poison the range
  // forever -- e.g. a real part whose true Z extent is [3, 28] would still
  // report a stale [-50, 50] window, putting the slider's "middle" (0) well
  // outside where the geometry actually is (second bug this WO caught via
  // the same screenshot: a plane at 0 clipped nothing because the part's
  // real Z minimum was above it). The first body to paint bootstraps a tight
  // range; later bodies only widen it as needed.
  const [sectionRanges, setSectionRanges] = useState<Record<SectionAxis, { min: number; max: number }>>({
    x: { min: Infinity, max: -Infinity },
    y: { min: Infinity, max: -Infinity },
    z: { min: Infinity, max: -Infinity },
  })
  const rawSectionRange = sectionRanges[sectionAxis]
  // Before any body has painted, fall back to a harmless placeholder --
  // there's nothing to clip yet, so the exact numbers don't matter.
  const sectionRange = Number.isFinite(rawSectionRange.min)
    ? rawSectionRange
    : { min: -50, max: 50 }

  // Pointer handlers close over the CURRENT filter mode via a ref (avoids
  // rebinding DOM listeners on every filter-mode click).
  const filterModeRef = useRef(filterMode)
  useEffect(() => {
    filterModeRef.current = filterMode
  }, [filterMode])

  const expandSectionRangeFor = useCallback((geometry: THREE.BufferGeometry): void => {
    geometry.computeBoundingBox()
    const bb = geometry.boundingBox
    if (bb === null) return
    if (![bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].every(Number.isFinite)) return
    setSectionRanges((prev) => ({
      x: { min: Math.min(prev.x.min, bb.min.x), max: Math.max(prev.x.max, bb.max.x) },
      y: { min: Math.min(prev.y.min, bb.min.y), max: Math.max(prev.y.max, bb.max.y) },
      z: { min: Math.min(prev.z.min, bb.min.z), max: Math.max(prev.z.max, bb.max.z) },
    }))
  }, [])

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (canvas === null) return

    const runtime = createSceneRuntime(canvas)
    runtimeRef.current = runtime

    const client = createClient()
    clientRef.current = client
    const session = new GeomBridgeSession(client)
    sessionRef.current = session

    function sameVertexRef(a: BridgeVertexRef, b: BridgeVertexRef): boolean {
      return (
        a.adjacentEdgeIds.length === b.adjacentEdgeIds.length &&
        a.adjacentEdgeIds.every((id, i) => id === b.adjacentEdgeIds[i])
      )
    }

    /** Single source of truth for one body's full repaint (WO INT-1-R1.1):
     *  per-face/per-edge StableId highlighting from SelectionState, THEN a
     *  whole-body tint if `bodyId` itself is body-mode hovered/selected
     *  (coarser granularity -- a body pick has no StableId of its own to key
     *  SelectionState off, see types.ts -- so it wins over any leftover
     *  face/edge highlight on the same body), THEN a vertex-mode hover/
     *  select overlay on just that vertex's adjacent edges (finest
     *  granularity, applied last so it always shows through even over a
     *  body-wide tint). */
    function repaintHighlights(bodyId: string): void {
      const body = session.cache.get(bodyId)
      if (body === undefined) return
      const colors = bodyColorsRef.current.get(bodyId) ?? DEFAULT_HIGHLIGHT_COLORS
      applyFaceHighlights(body, session.selection, colors)
      applyEdgeHighlights(body, session.selection, colors)

      if (selectedBodyIdsRef.current.has(bodyId)) {
        applyBodyHighlight(body, 'selected', colors)
      } else if (hoveredBodyIdRef.current === bodyId) {
        applyBodyHighlight(body, 'hovered', colors)
      }

      const selectedVertex = selectedVertexRef.current
      const hoveredVertex = hoveredVertexRef.current
      if (selectedVertex !== null && selectedVertex.bodyId === bodyId) {
        for (const edgeId of selectedVertex.ref.adjacentEdgeIds) paintEdgeColor(body, edgeId, colors.selected)
      } else if (hoveredVertex !== null && hoveredVertex.bodyId === bodyId) {
        for (const edgeId of hoveredVertex.ref.adjacentEdgeIds) paintEdgeColor(body, edgeId, colors.hovered)
      }
    }

    /** Every cached body is cheap to repaint at this WO's demo scale (a
     *  handful of bodies) -- simpler and just as correct as tracking exactly
     *  which body needs a refresh across cross-body hover/select moves. */
    function repaintAll(): void {
      for (const bodyId of objectsRef.current.keys()) repaintHighlights(bodyId)
      runtime.requestRender()
    }

    /** WO INT-1-R1.1: EVERY pickable kind gets a visible hover state. Body/
     *  vertex have no StableId to drive through SelectionState (types.ts) --
     *  their hover state lives in hoveredBodyIdRef/hoveredVertexRef instead,
     *  read back by repaintHighlights(). */
    function applyHoverPick(hit: PickHit | null): void {
      hoveredBodyIdRef.current = hit !== null && hit.kind === 'body' ? hit.bodyId : null
      if (hit === null) {
        hoveredVertexRef.current = null
        session.selection.setHover(null)
      } else if (hit.kind === 'face' || hit.kind === 'edge') {
        hoveredVertexRef.current = null
        session.selection.setHover(hit.id)
      } else if (hit.kind === 'vertex') {
        session.selection.setHover(null)
        hoveredVertexRef.current = { bodyId: hit.bodyId, ref: hit.id }
      } else {
        // 'body' kind: whole-body tint via hoveredBodyIdRef, above.
        hoveredVertexRef.current = null
        session.selection.setHover(null)
      }
      repaintAll()
    }

    async function runMeasure(
      bodyId: string,
      kind: MeasureResult['kind'],
      ids: string[] | undefined,
      label: string,
      token: number,
    ): Promise<void> {
      try {
        const result = await session.measure(bodyId, kind, ids)
        if (cancelled || measureTokenRef.current !== token) return
        // GEO-16 Fold 2: the worker refuses an unresolvable edge-length pick
        // STRUCTURALLY -- value NaN + aux.edgeIdCollisionCount -- because the
        // frozen MeasureResult.aux is numeric-only and cannot carry the id
        // string. Render that as a NAMED refusal (which requested id, how many
        // are ambiguous), never a bare 'NaN mm'. Any other non-finite value is
        // likewise surfaced as a refusal, not printed as NaN.
        const collisionCount = result.aux?.edgeIdCollisionCount ?? 0
        if (collisionCount >= 1 || !Number.isFinite(result.value)) {
          const named = ids !== undefined && ids.length > 0 ? ids.join(', ') : workbenchText('Lab3DView.wholeBody')
          const error = collisionCount >= 1
            ? workbenchText('Lab3DView.pickedEdgeCannotBeResolvedToASinglePhysical', { named: String(named), collisionCount: String(collisionCount) })
            : workbenchText('Lab3DView.isUnavailableForNoFiniteValueReturned', { label: String(label), named: String(named) })
          setMeasurement({ label, kind: result.kind, value: NaN, error })
          return
        }
        setMeasurement({ label, kind: result.kind, value: result.value })
      } catch (err) {
        if (cancelled || measureTokenRef.current !== token) return
        setMeasurement({ label, kind, value: NaN, error: err instanceof Error ? err.message : String(err) })
      }
    }

    /** WO INT-1-R1.1: EVERY pickable kind gets a defined select behavior --
     *  body used to only run a measure with no visual, vertex had no branch
     *  at all. */
    function applySelectPick(hit: PickHit | null): void {
      if (hit === null) return
      const token = ++measureTokenRef.current
      if (hit.kind === 'face' || hit.kind === 'edge') {
        session.selection.toggleSelection(hit.id)
        repaintAll()
        if (!session.selection.isSelected(hit.id)) {
          setMeasurement(null)
        } else if (hit.kind === 'edge') {
          // Edge length IS id-scoped in the kernel measure API (GEO-2 BK-10b,
          // analytic curveLength) -- real exact value, no fallback needed.
          void runMeasure(hit.bodyId, 'length', [hit.id], workbenchText('Lab3DView.edgeLength'), token)
        } else {
          // Face area (WO INT-1-R1.2): show the mesh-derived value INSTANTLY
          // as a labeled-APPROXIMATE preview (cheap, synchronous), then
          // replace it with the frozen facade's own kernel measure once that
          // resolves -- never settle on the client-side approximation. The
          // facade's measure('area', ids) still ignores `ids` and returns the
          // WHOLE BODY's surface area (documented gap: faceArea.ts, GEO-2,
          // geomBridgeSessionMeasureImport.integration.test.ts's "DOCUMENTS A
          // GAP" case) -- that is still the kernel's own analytic answer, not
          // a tessellation-bounded approximation, so it unconditionally
          // replaces the preview rather than being treated as another
          // fallback.
          const body = session.cache.get(hit.bodyId)
          const previewArea = body === undefined ? 0 : faceAreaFromMesh(body, hit.id)
          setMeasurement({ label: workbenchText('Lab3DView.faceArea'), kind: 'area', value: previewArea, approx: true })
          // BK-20 LANDED (GEO-3 merge, 2026-07-08): measure('area', [faceId]) is
          // id-scoped in the kernel now, so the settled value IS this face's
          // exact area and the label says so. ('Body surface' was the pre-BK-20
          // honesty stopgap; demo script updated to match.)
          void runMeasure(hit.bodyId, 'area', [hit.id], workbenchText('Lab3DView.faceArea'), token)
        }
      } else if (hit.kind === 'body') {
        if (selectedBodyIdsRef.current.has(hit.bodyId)) selectedBodyIdsRef.current.delete(hit.bodyId)
        else selectedBodyIdsRef.current.add(hit.bodyId)
        repaintAll()
        if (selectedBodyIdsRef.current.has(hit.bodyId)) {
          void runMeasure(hit.bodyId, 'volume', undefined, workbenchText('Lab3DView.bodyVolume'), token)
        } else {
          setMeasurement(null)
        }
      } else if (hit.kind === 'vertex') {
        const current = selectedVertexRef.current
        const isSame = current !== null && current.bodyId === hit.bodyId && sameVertexRef(current.ref, hit.id)
        selectedVertexRef.current = isSame ? null : { bodyId: hit.bodyId, ref: hit.id }
        repaintAll()
        if (isSame) {
          setMeasurement(null)
        } else {
          // No numeric MeasureResult kind exists for a vertex in the frozen
          // facade -- report its BridgeVertexRef identity honestly instead
          // of fabricating a measurement (WO INT-1-R1.1).
          const edgeList = hit.id.adjacentEdgeIds.join(', ') || workbenchText('Lab3DView.none')
          setMeasurement({
            label: workbenchText('Lab3DView.vertex'),
            kind: 'length',
            value: NaN,
            text: workbenchText('Lab3DView.vertexSelectedAdjacentEdges', { edgeList: String(edgeList) }),
          })
        }
      }
    }

    // Arrow function expression (not a `function` declaration): TS's
    // narrowed-const-in-closure analysis only tracks the `canvas !== null`
    // check above through expressions defined after it, not hoisted function
    // declarations.
    const rayFromPointer = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const ndcX = rect.width === 0 ? 0 : ((ev.clientX - rect.left) / rect.width) * 2 - 1
      const ndcY = rect.height === 0 ? 0 : -((ev.clientY - rect.top) / rect.height) * 2 + 1
      return runtime.screenToRay(ndcX, ndcY)
    }

    const onPointerMove = (ev: PointerEvent): void => {
      const ray = rayFromPointer(ev)
      const hit = session.pick([...objectsRef.current.keys()], ray, filterModeRef.current)
      applyHoverPick(hit)
    }
    const onPointerDown = (ev: PointerEvent): void => {
      const ray = rayFromPointer(ev)
      const hit = session.pick([...objectsRef.current.keys()], ray, filterModeRef.current)
      applySelectPick(hit)
    }
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerdown', onPointerDown)

    function fetchAndSetVolume(bodyId: string): void {
      session
        .measure(bodyId, 'volume')
        .then((result) => {
          if (cancelled) return
          setBodies((prev) => prev.map((b) => (b.bodyId === bodyId ? { ...b, volume: result.value } : b)))
        })
        .catch(() => undefined) // fail-soft: a body-panel volume miss shouldn't break the rest of the demo
    }
    fetchAndSetVolumeRef.current = fetchAndSetVolume

    window.__lab3dTestHooks = {
      projectBodyCenter: (bodyId) => {
        const body = session.cache.get(bodyId)
        if (body === undefined) return null
        body.geometry.computeBoundingBox()
        const bb = body.geometry.boundingBox
        if (bb === null) return null
        const center = { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 }
        const projected = runtime.projectToCanvas(center)
        if (projected === null) return null
        const rect = canvas.getBoundingClientRect()
        return { x: rect.left + projected.x, y: rect.top + projected.y }
      },
    }

    /** WO INT-1 "Open STEP": import every body in `file`, tracking each
     *  under a fresh bodyId, tessellating at a bbox-relative tier (unlike
     *  the demo box's fixed-scale tier -- a STEP part can be any real-world
     *  size) and recording the BK-15 coarse-tier numbers as it lands. */
    async function openStepFile(file: File): Promise<void> {
      setImportError(null)
      setImportBusy(true)
      try {
        const bytes = await file.arrayBuffer()
        const importId = `IMP${++importCounterRef.current}`
        const { bodies: imported, diagnostics } = await session.importStepFile(importId, bytes)
        const fatal = diagnostics.find((d) => d.severity === 'error')
        if (fatal !== undefined) {
          throw new Error(workbenchText('Lab3DView.importDiagnostic', { code: String(fatal.code), value2: String(JSON.stringify(fatal.params ?? {})) }))
        }
        if (cancelled) return
        if (imported[0] !== undefined) lastStepBodyIdRef.current = imported[0].bodyId

        for (const body of imported) {
          const colors = colorSetFor(body.color)
          bodyColorsRef.current.set(body.bodyId, colors)
          bodyNamesRef.current.set(body.bodyId, body.name)
          setBodies((prev) => [...prev, { bodyId: body.bodyId, name: body.name, visible: true }])
          fetchAndSetVolume(body.bodyId)

          const handle = session.getHandle(body.bodyId)
          if (handle === undefined) continue // importStepFile always sets this; defensive only
          const diag = await client.bboxDiagonal(handle)
          if (cancelled) return
          const qualities = {
            coarse: tessQualityForTier(diag, 'coarse'),
            display: tessQualityForTier(diag, 'fine'),
          }
          const t0 = performance.now()
          let framed = false
          setStatus(workbenchText('Lab3DView.importingTessellatingCoarse', { name: String(body.name) }))
          await session.tessellateProgressiveAtQuality(body.bodyId, qualities, (phase, cachedBody) => {
            if (cancelled) return
            paintBody(body.bodyId, cachedBody, runtime, objectsRef.current, session.selection, colors)
            expandSectionRangeFor(cachedBody.geometry)
            if (!framed) {
              framed = true
              const bb = cachedBody.geometry.boundingBox
              if (bb !== null) runtime.frameBox(bb.min, bb.max)
            }
            if (phase === 'coarse') {
              const ms = performance.now() - t0
              const stat: Lab3DImportStat = {
                bodyId: body.bodyId,
                name: body.name,
                phase: 'coarse',
                ms,
                triangles: cachedBody.triFace.length,
              }
              importStatsRef.current = [...importStatsRef.current, stat]
              window.__lab3dImportStats = importStatsRef.current
              setStatus(
                workbenchText('Lab3DView.importedCoarseTessellationMs', { name: String(body.name), value2: String(ms.toFixed(0)) }) +
                  workbenchText('Lab3DView.trisRefining', { value1: String(cachedBody.triFace.length.toLocaleString()) }),
              )
            } else {
              setStatus(workbenchText('Lab3DView.importedReady', { name: String(body.name) }))
            }
          })
        }
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        setImportError(msg)
        setStatus(workbenchText('Lab3DView.stepImportFAILED', { msg: String(msg) }))
      } finally {
        if (!cancelled) setImportBusy(false)
      }
    }
    openStepFileRef.current = openStepFile

    async function boot(): Promise<void> {
      try {
        setStatus(workbenchText('Lab3DView.initializingGeometryKernel'))
        await session.init((pct, phase) => {
          window.LienSplash?.setProgress(pct, phase)
        })
        if (cancelled) return

        setStatus(workbenchText('Lab3DView.creatingDemoCutBox'))
        await session.createCutBox(DEMO_BODY_ID, {
          featureId: 'DEMO',
          size: DEMO_BOX_SIZE,
          toolFeatureId: 'DEMO_TOOL',
          toolSize: DEMO_TOOL_SIZE,
        })
        if (cancelled) return
        bodyNamesRef.current.set(DEMO_BODY_ID, workbenchText('Lab3DView.cutBox'))
        setBodies((prev) => [...prev, { bodyId: DEMO_BODY_ID, name: workbenchText('Lab3DView.cutBox'), visible: true }])
        fetchAndSetVolume(DEMO_BODY_ID)

        setStatus(workbenchText('Lab3DView.tessellatingCoarse'))
        await session.tessellateProgressive(DEMO_BODY_ID, (phase, body) => {
          if (cancelled) return
          paintBody(DEMO_BODY_ID, body, runtime, objectsRef.current, session.selection)
          expandSectionRangeFor(body.geometry)
          setStatus(phase === 'coarse' ? workbenchText('Lab3DView.coarseTessellationPaintedRefiningToDisplayTier') : 'ready')
        })
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        setStatus(workbenchText('Lab3DView.failed', { msg: String(msg) }))
      }
    }
    void boot()

    return () => {
      cancelled = true
      mountedRef.current = false
      openStepFileRef.current = null
      fetchAndSetVolumeRef.current = null
      delete window.__lab3dTestHooks
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      runtime.dispose()
      void session.disposeAllBodies().catch(() => undefined)
    }
    // Mount-once effect: createClient/createSceneRuntime are either the
    // stable module-level defaults or a caller-supplied stable reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createClient, createSceneRuntime, expandSectionRangeFor])

  // WO INT-1 visual section: a real three.js clipping plane (architect ruling
  // 1 -- cheap and honest, not a kernel-exact section curve). `sectionPos`
  // starts at null ("auto" = the current known max), so the section is fully
  // open (nothing clipped) until the user actually moves the slider -- an
  // import that lands after the slider was already touched keeps the user's
  // chosen position instead of snapping back open.
  useEffect(() => {
    const runtime = runtimeRef.current
    if (runtime === null) return
    const rawPos = sectionPos ?? sectionRange.max
    // WO UI-H1 z-fighting root cause (architect candidate 'a', confirmed):
    // at the slider's exact min/max the clip plane is geometrically
    // COINCIDENT with the body's own flat top/bottom face (max === the
    // bbox's own top; the "fully open" default IS max). A coincident plane
    // makes the GPU discard fragments of that face inconsistently per-pixel
    // (floating-point noise on which side of the plane a coplanar fragment
    // falls) -- exactly Operator's reported top-face stipple/moire. Nudge the
    // plane a hair PAST the extreme it's at (never an interior slider
    // position, which does not sit on a face for this WO's fixtures) so it
    // is never exactly coplanar with real geometry. The nudge is far too
    // small to be a visible difference in where the section "is".
    const span = sectionRange.max - sectionRange.min
    const epsilon = Math.max(span * 1e-4, 1e-4)
    const effectivePos =
      rawPos >= sectionRange.max ? rawPos + epsilon : rawPos <= sectionRange.min ? rawPos - epsilon : rawPos
    const plane = new THREE.Plane(SECTION_AXIS_NORMALS[sectionAxis], effectivePos)
    runtime.setClipPlanes([plane])
  }, [sectionAxis, sectionPos, sectionRange])

  const handleOpenStepChange = useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0]
    ev.target.value = '' // allow re-selecting the same file to re-fire this handler
    if (file === undefined) return
    void openStepFileRef.current?.(file)
  }, [])

  const handleSectionAxisChange = useCallback((axis: SectionAxis) => {
    setSectionAxis(axis)
    setSectionPos(null) // re-open fully on axis switch -- avoids carrying a position tuned for a different axis's extent
  }, [])

  const handleToggleVisibility = useCallback((bodyId: string) => {
    setBodies((prev) =>
      prev.map((body) => {
        if (body.bodyId !== bodyId) return body
        const nextVisible = !body.visible
        const obj = objectsRef.current.get(bodyId)
        if (obj !== undefined) {
          obj.mesh.visible = nextVisible
          obj.edgeLines.visible = nextVisible
          runtimeRef.current?.setSectionableVisible(obj.mesh, nextVisible)
          runtimeRef.current?.requestRender()
        }
        return { ...body, visible: nextVisible }
      }),
    )
  }, [])

  const handleDispose = useCallback((bodyId: string) => {
    void (async () => {
      const session = sessionRef.current
      if (session === null) return
      // Releases BOTH the bridge cache entry AND the worker-side handle
      // (GeomBridgeSession.disposeBody, part 1).
      await session.disposeBody(bodyId)
      const obj = objectsRef.current.get(bodyId)
      if (obj !== undefined) {
        runtimeRef.current?.removeObject(obj.mesh)
        runtimeRef.current?.removeObject(obj.edgeLines)
        runtimeRef.current?.unregisterSectionable(obj.mesh, obj.edgeLines)
        objectsRef.current.delete(bodyId)
      }
      bodyColorsRef.current.delete(bodyId)
      bodyNamesRef.current.delete(bodyId)
      setBodies((prev) => prev.filter((body) => body.bodyId !== bodyId))
      runtimeRef.current?.requestRender()
    })()
  }, [])

  // GEO-6/BK-60 lab affordance: recognize + rule-based batch-remove the holes
  // on the most-recently imported STEP body, then adopt the healed WORKER
  // HANDLE straight into this session (GeomBridgeSession.adoptBody) and
  // tessellate+paint it into the viewport directly -- NO exportStep,
  // NO re-import. The prior path round-tripped the healed body through
  // exportStep -> openStepFile: that leaked the intermediate defeatured
  // worker handle (never disposed after export) and discarded the engine's
  // stable-id lineage from the defeature op (re-import mints fresh ids).
  // adoptBody keeps the SAME worker handle defeatureBatch produced as the
  // tracked handle for the body now on display -- disposeBody releases it
  // exactly like any created/imported body's handle. Drives the SAME engine
  // defeature API the tests exercise; the status message contract (healed/
  // failed/refused/delta) is unchanged.
  const handleDefeatureHoles = useCallback(() => {
    void (async () => {
      const session = sessionRef.current
      const client = clientRef.current
      const runtime = runtimeRef.current
      const bodyId = lastStepBodyIdRef.current
      if (session === null || client === null || runtime === null || bodyId === null) {
        setDefeatureMsg(workbenchText('Lab3DView.defeatureImportASTEPFirst'))
        return
      }
      const handle = session.getHandle(bodyId)
      if (handle === undefined || client.recognizeFeatures === undefined || client.defeatureBatch === undefined) {
        setDefeatureMsg(workbenchText('Lab3DView.defeatureNoHandleEngineMethodUnavailable'))
        return
      }
      setDefeatureBusy(true)
      setDefeatureMsg(workbenchText('Lab3DView.recognizingFeatures'))
      try {
        const verdicts = await client.recognizeFeatures(handle)
        if (!mountedRef.current) return
        const holeClasses: FeatureClass[] = ['throughHole', 'blindHole', 'counterboreStack']
        const holes = verdicts.filter((v) => v.removable && holeClasses.includes(v.featureClass))
        setDefeatureMsg(workbenchText('Lab3DView.removingHoleFeatureS', { length: String(holes.length) }))
        const r = await client.defeatureBatch({ featureId: 'LAB_DEFEATURE', body: handle, query: { classes: holeClasses } })
        if (!mountedRef.current) return
        if (!r.ok || r.body === undefined) {
          setDefeatureMsg(workbenchText('Lab3DView.defeatureFAILED', { value1: String(r.diagnostics[0]?.code ?? 'unknown') }))
          return
        }

        const oldName = bodyNamesRef.current.get(bodyId) ?? bodyId
        const colors = bodyColorsRef.current.get(bodyId) ?? DEFAULT_HIGHLIGHT_COLORS
        const newBodyId = `${bodyId}:defeatured#${++defeatureCounterRef.current}`
        const summary = session.adoptBody(newBodyId, r.body, workbenchText('Lab3DView.defeatured', { oldName: String(oldName) }))

        // Remove the pre-defeature body from the view (worker handle + cache
        // + scene) -- awaited (unlike handleDispose's own fire-and-forget
        // callers) so the old handle is provably released before this flow
        // reports done, per the WO's no-leak acceptance criterion.
        await session.disposeBody(bodyId)
        const obj = objectsRef.current.get(bodyId)
        if (obj !== undefined) {
          runtime.removeObject(obj.mesh)
          runtime.removeObject(obj.edgeLines)
          runtime.unregisterSectionable(obj.mesh, obj.edgeLines)
          objectsRef.current.delete(bodyId)
        }
        bodyColorsRef.current.delete(bodyId)
        bodyNamesRef.current.delete(bodyId)
        setBodies((prev) => prev.filter((b) => b.bodyId !== bodyId))
        runtime.requestRender()
        if (!mountedRef.current) return

        bodyColorsRef.current.set(summary.bodyId, colors)
        bodyNamesRef.current.set(summary.bodyId, summary.name)
        setBodies((prev) => [...prev, { bodyId: summary.bodyId, name: summary.name, visible: true }])
        lastStepBodyIdRef.current = summary.bodyId
        fetchAndSetVolumeRef.current?.(summary.bodyId)

        const diag = await client.bboxDiagonal(r.body)
        if (!mountedRef.current) return
        const qualities = {
          coarse: tessQualityForTier(diag, 'coarse'),
          display: tessQualityForTier(diag, 'fine'),
        }
        setDefeatureMsg(workbenchText('Lab3DView.tessellatingHealedBody'))
        await session.tessellateProgressiveAtQuality(summary.bodyId, qualities, (phase, cachedBody) => {
          if (!mountedRef.current) return
          paintBody(summary.bodyId, cachedBody, runtime, objectsRef.current, session.selection, colors)
          expandSectionRangeFor(cachedBody.geometry)
          if (phase === 'display') {
            const bb = cachedBody.geometry.boundingBox
            if (bb !== null) runtime.frameBox(bb.min, bb.max)
          }
        })
        if (!mountedRef.current) return
        setDefeatureMsg(workbenchText('Lab3DView.defeaturedHealedFailedRefusedDeltaMm3', { value1: String(r.report?.healed ?? 0), value2: String(r.report?.failed ?? 0), value3: String(r.report?.refused ?? 0), value4: String((r.report?.totalVolumeDelta ?? 0).toFixed(2)) }))
      } catch (err) {
        if (!mountedRef.current) return
        setDefeatureMsg(workbenchText('Lab3DView.defeatureError', { value1: String(err instanceof Error ? err.message : String(err)) }))
      } finally {
        if (mountedRef.current) setDefeatureBusy(false)
      }
    })()
  }, [expandSectionRangeFor])

  const measureText =
    measurement === null
      ? workbenchText('Lab3DView.nothingSelected')
      : measurement.text !== undefined
        ? measurement.text
        : measurement.error !== undefined
          ? workbenchText('Lab3DView.failed2', { label: String(measurement.label), error: String(measurement.error) })
          : `${measurement.label}: ${measurement.value.toFixed(3)} ${MEASURE_UNITS[measurement.kind]}` +
            (measurement.approx === true ? workbenchText('Lab3DView.meshDerivedSeeM1DemoNotes') : '')

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        background: '#101418',
        color: '#d8e0e8',
        font: '13px/1.5 Consolas, monospace',
      }}
    >
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          data-testid="lab3d-canvas"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
        <div
          data-testid="lab3d-status"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 2,
            padding: '6px 10px',
            background: 'rgba(16,20,24,0.85)',
            borderBottom: '1px solid #2a3540',
            whiteSpace: 'pre',
          }}
        >
          {status}
        </div>
        <div
          data-testid="lab3d-toolbar"
          style={{
            position: 'absolute',
            top: 32,
            left: 0,
            right: 0,
            zIndex: 2,
            padding: '6px 10px',
            background: 'rgba(16,20,24,0.85)',
            borderBottom: '1px solid #2a3540',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {workbenchText('Lab3DView.openSTEP')}<input
              type="file"
              accept=".step,.stp"
              data-testid="lab3d-open-step"
              disabled={importBusy}
              onChange={handleOpenStepChange}
            />
          </label>
          {importError !== null && (
            <span data-testid="lab3d-import-error" style={{ color: '#ff6b6b' }}>
              {importError}
            </span>
          )}
          <button
            type="button"
            data-testid="lab3d-defeature-holes"
            disabled={defeatureBusy}
            onClick={handleDefeatureHoles}
            data-tooltip={workbenchText('Lab3DView.recognizeBatchRemoveTheDrilledCounterboredHolesOnThe')}
            style={{
              background: 'rgba(16,20,24,0.85)', color: '#d8e0e8', border: '1px solid #2a3540',
              borderRadius: 4, padding: '2px 8px', cursor: defeatureBusy ? 'default' : 'pointer',
            }}
          >
            {workbenchText('Lab3DView.defeatureHoles')}</button>
          {defeatureMsg !== null && (
            <span data-testid="lab3d-defeature-status" style={{ color: '#8fd0a0' }}>
              {defeatureMsg}
            </span>
          )}
        </div>
        <div
          data-testid="lab3d-measure-panel"
          style={{
            position: 'absolute',
            top: 62,
            left: 8,
            zIndex: 2,
            padding: '4px 8px',
            background: 'rgba(16,20,24,0.85)',
            border: '1px solid #2a3540',
          }}
        >
          {measureText}
        </div>
        <div
          data-testid="lab3d-filter-toolbar"
          style={{ position: 'absolute', bottom: 8, left: 8, zIndex: 2, display: 'flex', gap: 4 }}
        >
          {FILTER_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`lab3d-filter-${mode}`}
              aria-pressed={filterMode === mode}
              onClick={() => setFilterMode(mode)}
              style={{
                background: filterMode === mode ? '#2a3540' : 'transparent',
                color: '#d8e0e8',
                border: '1px solid #2a3540',
                padding: '4px 8px',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
        <div
          data-testid="lab3d-section-toolbar"
          style={{
            position: 'absolute',
            bottom: 8,
            right: 8,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(16,20,24,0.85)',
            border: '1px solid #2a3540',
            padding: '4px 8px',
          }}
        >
          <span>{workbenchText('Lab3DView.section')}</span>
          {SECTION_AXES.map((axis) => (
            <button
              key={axis}
              type="button"
              data-testid={`lab3d-section-axis-${axis}`}
              aria-pressed={sectionAxis === axis}
              onClick={() => handleSectionAxisChange(axis)}
              style={{
                background: sectionAxis === axis ? '#2a3540' : 'transparent',
                color: '#d8e0e8',
                border: '1px solid #2a3540',
                padding: '2px 6px',
                cursor: 'pointer',
                textTransform: 'uppercase',
              }}
            >
              {axis}
            </button>
          ))}
          <input
            type="range"
            data-testid="lab3d-section-slider"
            min={sectionRange.min}
            max={sectionRange.max}
            step={Math.max((sectionRange.max - sectionRange.min) / 200, 0.01)}
            value={sectionPos ?? sectionRange.max}
            onChange={(ev) => setSectionPos(Number(ev.target.value))}
          />
        </div>
      </div>
      <BodyListPanel bodies={bodies} onToggleVisibility={handleToggleVisibility} onDispose={handleDispose} />
    </div>
  )
}
