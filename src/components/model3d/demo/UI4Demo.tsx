// WO UI-4 evidence harness: NOT part of the production app (mirrors UI-3's
// tree/demo/ChassisDemo.tsx precedent -- a standalone page proving the
// measure/appearance/section/visibility/mass-properties modules this WO
// builds actually compose against the REAL geometry worker + UI-H1
// sectionable runtime). Real-GPU screenshots of this page are this WO's
// acceptance #7 evidence; it is also the RENDER smoke test target (acceptance
// #2/#4's "RENDER smoke test drives the real panel").
//
// Single demo body (a box, matching Lab3DView's DEMO_BOX_SIZE convention):
// per this WO's report interfaceConcerns, kernel makeBox() has no world-space
// placement parameter and PickEngine picks in raw ray-vs-local-geometry space
// with no object transform applied, so multiple independently created bodies
// can't be visually separated without either a kernel placement API (out of
// scope, geom-service.ts frozen) or breaking picking -- one body is enough to
// demonstrate every acceptance criterion except radius/diameter (no cylinder
// creation reachable through the public GeomService/GeomClient contract
// either; that gap-fill measure kind is proven against a real cylinder via
// the Node kernel test suite instead, see src/tests/model3d/measureLogic*).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { createGeomService, type GeomClient, type GeometrySnapshot } from '../../../geom'
import type { StableId } from '../../../geom/geom-service'
import {
  DEFAULT_HIGHLIGHT_COLORS,
  GeomBridgeSession,
  applyBodyHighlight,
  applyEdgeHighlights,
  applyFaceHighlights,
  attachHighlightAttributes,
  type CachedBody,
  type SelectionFilterMode,
} from '../../../viewport3d'
import { FeatureDag } from '../../../doc'
import { createDefaultSceneRuntime, type CreateSceneRuntime, type SceneRuntime } from '../sceneRuntime'
import { FeatureTree } from '../tree'
import { MeasurePanel, facePoints, useMeasureSession } from '../measure'
import { AppearancePanel, AppearanceStore, applyFaceAppearance, useAppearanceSession } from '../appearance'
import {
  VisibilityPanel,
  VisibilityStore,
  applyGeometryVisibility,
  capturePristineGeometry,
  deriveHiddenEdgeIds,
  type PristineGeometrySnapshot,
} from '../visibility'
import { SectionControls, useSectionState } from '../section'
import {
  BUILTIN_MATERIALS,
  CUSTOM_MATERIAL_ID,
  MassPropertiesPanel,
  computeMassProperties,
  createComMarker,
  materialById,
  positionComMarker,
  type MassProperties,
} from '../massProperties'

const DEMO_BODY_ID = 'demoBody'
const DEMO_SIZE = { x: 40, y: 20, z: 10 }

interface BodyEntry {
  mesh: THREE.Mesh
  edgeLines: THREE.LineSegments
  cachedBody: CachedBody
  pristine: PristineGeometrySnapshot
}

export interface UI4DemoProps {
  createClient?: () => GeomClient
  createSceneRuntime?: CreateSceneRuntime
}

declare global {
  interface Window {
    /** Test/screenshot-driver seam (WO UI-4): direct access to the live
     *  controllers so a headless driver can exercise every acceptance
     *  criterion without simulating pixel-perfect mouse coordinates -- same
     *  spirit as Lab3DView's window.__lab3dTestHooks. */
    __ui4Hooks?: {
      session: GeomBridgeSession
      runtime: SceneRuntime
      cachedBody: CachedBody
      appearance: AppearanceStore
      visibility: VisibilityStore
      setActiveTool(tool: 'measure' | 'appearance'): void
      /** Project a named face's triangle centroid to canvas-relative pixel
       *  coordinates using the SAME camera projection the real pick path
       *  reads from (mirrors Lab3DView's projectBodyCenter) -- lets a
       *  screenshot driver target a specific face precisely instead of
       *  guessing screen position from the camera setup. Returns null if
       *  the face id is unknown or projects behind the camera. */
      projectFaceCenter(faceId: string): { x: number; y: number } | null
    }
  }
}

export function UI4Demo({ createClient = createGeomService, createSceneRuntime = createDefaultSceneRuntime }: UI4DemoProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [runtime, setRuntime] = useState<SceneRuntime | null>(null)
  const [session, setSession] = useState<GeomBridgeSession | null>(null)
  const clientRef = useRef<GeomClient | null>(null)
  const bodyRef = useRef<BodyEntry | null>(null)
  const comMarkerRef = useRef<THREE.Group | null>(null)
  const snapshotsRef = useRef<Record<StableId, GeometrySnapshot>>({})
  const [status, setStatus] = useState('booting...')
  const [ready, setReady] = useState(false)

  const appearanceRef = useRef(new AppearanceStore())
  const visibilityRef = useRef(new VisibilityStore())

  const dagRef = useRef<FeatureDag | null>(null)
  if (dagRef.current === null) {
    const dag = new FeatureDag()
    dag.insertNode({ id: DEMO_BODY_ID, kind: 'body', payload: { name: 'Demo Box' } })
    dagRef.current = dag
  }
  const dag = dagRef.current

  const [activeTool, setActiveTool] = useState<'measure' | 'appearance'>('measure')
  const [measureFilterMode, setMeasureFilterMode] = useState<SelectionFilterMode>('face')
  const [repaintTick, setRepaintTick] = useState(0)
  const triggerRepaint = useCallback(() => setRepaintTick((t) => t + 1), [])
  const liveBodyIds = useCallback((): string[] => (bodyRef.current !== null ? [DEMO_BODY_ID] : []), [])

  const snapshotSource = useMemo(
    () => ({
      async snapshotsFor(bodyId: string): Promise<Record<StableId, GeometrySnapshot>> {
        if (Object.keys(snapshotsRef.current).length > 0) return snapshotsRef.current
        const client = clientRef.current
        const handle = session?.getHandle(bodyId)
        if (client === null || client === undefined || handle === undefined) return {}
        const snaps = await client.snapshotsFor(handle)
        snapshotsRef.current = snaps
        return snaps
      },
    }),
    [session],
  )

  const measure = useMeasureSession({ session, snapshotSource, liveBodyIds, filterMode: measureFilterMode, onChanged: triggerRepaint })
  const appearance = useAppearanceSession({ session, appearance: appearanceRef.current, liveBodyIds, onChanged: triggerRepaint })
  const section = useSectionState({ runtime })

  const [materialId, setMaterialId] = useState<string>(BUILTIN_MATERIALS[0].id)
  const [customDensity, setCustomDensity] = useState(2.7)
  const [massProps, setMassProps] = useState<MassProperties | null>(null)
  const [massBusy, setMassBusy] = useState(false)
  // Bumped to the fresh CachedBody.version every paintCachedBody() call
  // (GeometryCache.ingest() increments version on EVERY ingest of a bodyId,
  // including a same-id regenerate) -- included in the mass effect's deps
  // below so a regenerated body's stale mass/CoM is never left standing
  // (R1.1 rework: UI4.audit.json finding, mass previously kept the pre-edit
  // volume/CoM until an unrelated materialId/customDensity change happened
  // to also fire the effect).
  const [bodyVersion, setBodyVersion] = useState(0)

  const repaint = useCallback((): void => {
    const rt = runtime
    const entry = bodyRef.current
    const sess = session
    if (rt === null || entry === null || sess === null) return
    const { mesh, edgeLines, cachedBody, pristine } = entry

    applyFaceHighlights(cachedBody, sess.selection, DEFAULT_HIGHLIGHT_COLORS)
    applyEdgeHighlights(cachedBody, sess.selection, DEFAULT_HIGHLIGHT_COLORS)
    applyFaceAppearance(cachedBody, DEMO_BODY_ID, sess.selection, appearanceRef.current, DEFAULT_HIGHLIGHT_COLORS.base)
    // R1.3 rework (UI4.audit.json, Operator's binding Q-1 feedback bar): body
    // hover/selected feedback must track whichever tool is actually driving
    // picks right now -- appearance body-mode picks have their OWN
    // hover/target state (useAppearanceSession.ts), never measure.state, so
    // reading only measure.state here left every appearance body pick with
    // no viewport feedback at all.
    if (activeTool === 'appearance') {
      if (appearance.state.target?.kind === 'body' && appearance.state.target.bodyId === DEMO_BODY_ID) applyBodyHighlight(cachedBody, 'selected')
      else if (appearance.state.hoveredBodyId === DEMO_BODY_ID) applyBodyHighlight(cachedBody, 'hovered')
    } else {
      if (measure.state.selectedBodyIds.has(DEMO_BODY_ID)) applyBodyHighlight(cachedBody, 'selected')
      else if (measure.state.hoveredBodyId === DEMO_BODY_ID) applyBodyHighlight(cachedBody, 'hovered')
    }

    const visibility = visibilityRef.current
    const hiddenFaces = new Set(cachedBody.faceIds.filter((id) => !visibility.isFaceVisible(DEMO_BODY_ID, id)))
    // R1.2 rework (UI4.audit.json): an edge overlay segment must disappear
    // whenever EVERY face it borders is hidden/non-isolated -- otherwise
    // isolate mode still shows the full hidden-body wireframe around the
    // one visible face. deriveHiddenEdgeIds parses each edge's own StableId
    // (the adjacent-face-pair encoding, docs/stable-id-spec.md) rather than
    // needing separate edge/face adjacency data.
    const hiddenEdges = deriveHiddenEdgeIds(cachedBody.edgeIds, (faceId) => hiddenFaces.has(faceId))
    applyGeometryVisibility(cachedBody, pristine, { hiddenFaceIds: hiddenFaces, hiddenEdgeIds: hiddenEdges })
    const bodyVisible = visibility.isBodyVisible(DEMO_BODY_ID)
    mesh.visible = bodyVisible
    edgeLines.visible = bodyVisible
    rt.setSectionableVisible(mesh, bodyVisible)

    rt.requestRender()
  }, [runtime, session, measure.state, appearance.state, activeTool])

  // repaintTick is intentionally in this effect's deps (not repaint's own
  // useCallback deps): appearance/visibility store mutations and selection
  // changes all funnel through triggerRepaint() -> repaintTick, and must
  // force a fresh repaint() call even though repaint's OWN identity (which
  // only depends on runtime/session/measure.state) hasn't changed -- a bug
  // caught by src/tests/model3d/UI4DemoAppearanceVisibility.test.tsx (colors/
  // isolate silently not re-painting until an unrelated measure.state change
  // happened to also fire the effect).
  useEffect(() => {
    repaint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repaint, repaintTick])

  useEffect(() => {
    const unsubs = [appearanceRef.current.subscribe(triggerRepaint), visibilityRef.current.subscribe(triggerRepaint)]
    if (session !== null) unsubs.push(session.selection.subscribe(triggerRepaint))
    return () => unsubs.forEach((u) => u())
  }, [session, triggerRepaint])

  // Shared by boot AND handleRegenerate below (WO UI-4 acceptance #5
  // evidence: re-minting the SAME body under the SAME featureId 'F1' at a
  // DIFFERENT size yields IDENTICAL stable ids -- boxFaceId('F1','zmax') is
  // derived from featureId+originTag only, never from size -- so any
  // per-face appearance color assigned before this regen survives it with
  // zero special-case code, a live demonstration of the same stable-id
  // property appearanceStore.test.ts proves rigorously via a real
  // ElementMap-scoped modify delta).
  const paintCachedBody = useCallback(
    (rt: SceneRuntime, cachedBody: CachedBody): void => {
      attachHighlightAttributes(cachedBody, DEFAULT_HIGHLIGHT_COLORS)
      const existing = bodyRef.current
      if (existing === null) {
        const material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          metalness: 0.1,
          roughness: 0.8,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        })
        const mesh = new THREE.Mesh(cachedBody.geometry, material)
        const edgeLines = new THREE.LineSegments(cachedBody.edgeGeometry, new THREE.LineBasicMaterial({ vertexColors: true }))
        rt.addObject(mesh)
        rt.addObject(edgeLines)
        rt.registerSectionable(mesh, edgeLines)
        bodyRef.current = { mesh, edgeLines, cachedBody, pristine: capturePristineGeometry(cachedBody) }
      } else {
        existing.mesh.geometry = cachedBody.geometry
        existing.edgeLines.geometry = cachedBody.edgeGeometry
        rt.syncSectionGeometry(existing.mesh)
        bodyRef.current = { ...existing, cachedBody, pristine: capturePristineGeometry(cachedBody) }
      }
      section.expandRangeFor(cachedBody.geometry)
      cachedBody.geometry.computeBoundingBox()
      const bb = cachedBody.geometry.boundingBox
      if (bb !== null) rt.frameBox(bb.min, bb.max)
      setBodyVersion(cachedBody.version)
      triggerRepaint()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [section.expandRangeFor, triggerRepaint],
  )

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (canvas === null) return
    const rt = createSceneRuntime(canvas)
    setRuntime(rt)
    const marker = createComMarker(2)
    marker.visible = false
    rt.addObject(marker)
    comMarkerRef.current = marker

    const client = createClient()
    clientRef.current = client
    const sess = new GeomBridgeSession(client)
    setSession(sess)

    async function boot(): Promise<void> {
      setStatus('initializing geometry kernel...')
      await sess.init()
      if (cancelled) return
      setStatus('creating demo box...')
      await sess.createBox(DEMO_BODY_ID, { featureId: 'F1', size: DEMO_SIZE })
      await sess.tessellateProgressive(DEMO_BODY_ID, (_phase, cachedBody) => {
        if (cancelled) return
        paintCachedBody(rt, cachedBody)
      })
      if (cancelled) return
      setStatus('ready')
      setReady(true)
    }
    void boot()

    return () => {
      cancelled = true
      rt.dispose()
      void sess.disposeAllBodies().catch(() => undefined)
    }
    // Mount-once bootstrap effect (mirrors Lab3DView/ChassisDemo's own
    // contract) -- createClient/createSceneRuntime/section/triggerRepaint are
    // either stable module-level defaults or stable-identity hook returns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready || session === null) return
    const entry = bodyRef.current
    const client = clientRef.current
    if (entry === null || client === null) return
    let cancelled = false
    setMassBusy(true)
    void (async () => {
      const density = materialId === CUSTOM_MATERIAL_ID ? customDensity : materialById(materialId)?.densityGPerCm3 ?? customDensity
      const volumeResult = await session.measure(DEMO_BODY_ID, 'volume')
      if (cancelled) return
      const handle = session.getHandle(DEMO_BODY_ID)
      const snaps = handle !== undefined ? await client.snapshotsFor(handle) : {}
      if (cancelled) return
      const hasCurvedFaces = Object.values(snaps).some((s) => s.type !== 'plane')
      const props = computeMassProperties(entry.cachedBody, volumeResult.value, density, hasCurvedFaces)
      setMassProps(props)
      setMassBusy(false)
      const marker = comMarkerRef.current
      if (marker !== null) {
        positionComMarker(marker, props.centerOfMass)
        marker.visible = true
        runtime?.requestRender()
      }
    })()
    return () => {
      cancelled = true
    }
    // bodyVersion: see its declaration above -- a regenerate must invalidate
    // the mass/CoM readout even when material/density are untouched.
  }, [ready, session, materialId, customDensity, runtime, bodyVersion])

  useEffect(() => {
    if (session === null || runtime === null || bodyRef.current === null) return
    window.__ui4Hooks = {
      session,
      runtime,
      cachedBody: bodyRef.current.cachedBody,
      appearance: appearanceRef.current,
      visibility: visibilityRef.current,
      setActiveTool,
      projectFaceCenter: (faceId) => {
        const entry = bodyRef.current
        if (entry === null) return null
        const pts = facePoints(entry.cachedBody, faceId)
        if (pts.length === 0) return null
        const center = new THREE.Vector3()
        for (const p of pts) center.add(p)
        center.divideScalar(pts.length)
        const projected = runtime.projectToCanvas({ x: center.x, y: center.y, z: center.z })
        if (projected === null) return null
        const canvas = canvasRef.current
        const rect = canvas?.getBoundingClientRect()
        return rect === undefined ? projected : { x: rect.left + projected.x, y: rect.top + projected.y }
      },
    }
    return () => {
      delete window.__ui4Hooks
    }
  }, [session, runtime, ready])

  const rayFromPointer = useCallback(
    (ev: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (canvas === null || runtime === null) return null
      const rect = canvas.getBoundingClientRect()
      const ndcX = rect.width === 0 ? 0 : ((ev.clientX - rect.left) / rect.width) * 2 - 1
      const ndcY = rect.height === 0 ? 0 : -((ev.clientY - rect.top) / rect.height) * 2 + 1
      return runtime.screenToRay(ndcX, ndcY)
    },
    [runtime],
  )

  const handlePointerMove = useCallback(
    (ev: React.PointerEvent<HTMLCanvasElement>) => {
      const ray = rayFromPointer(ev)
      if (ray === null) return
      if (activeTool === 'measure') measure.handlePointerMove(ray)
      else appearance.handlePointerMove(ray)
    },
    [rayFromPointer, activeTool, measure, appearance],
  )

  const handlePointerDown = useCallback(
    (ev: React.PointerEvent<HTMLCanvasElement>) => {
      const ray = rayFromPointer(ev)
      if (ray === null) return
      if (activeTool === 'measure') measure.handlePointerClick(ray)
      else appearance.handlePointerClick(ray)
    },
    [rayFromPointer, activeTool, measure, appearance],
  )

  const selectedFaceIds = session !== null ? [...session.selection.selection] : []
  const selectedBodyIdsForVisibility = [...measure.state.selectedBodyIds]
  const isolateActive = visibilityRef.current.isolateActive

  const handleHideSelectedFaces = useCallback(() => {
    for (const id of selectedFaceIds) visibilityRef.current.setFaceHidden(id, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFaceIds])

  const handleIsolateSelection = useCallback(() => {
    if (isolateActive) {
      visibilityRef.current.clearIsolate()
      return
    }
    const bodyIds = selectedBodyIdsForVisibility.length > 0 ? selectedBodyIdsForVisibility : selectedFaceIds.length > 0 ? [DEMO_BODY_ID] : []
    if (bodyIds.length === 0) return
    visibilityRef.current.isolateIds(bodyIds, selectedFaceIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolateActive, selectedBodyIdsForVisibility, selectedFaceIds])

  /** WO UI-4 acceptance #5 evidence seam: re-mint the demo box at a bumped
   *  Z size under the SAME featureId -- see paintCachedBody's doc comment
   *  for why this proves appearance colors survive without any special-case
   *  pruning code. Test/screenshot-only affordance, not a modeling feature
   *  (no dialog, no undo) -- this WO's real editable-feature surface is
   *  M4's future INT-4 wiring, out of scope here. */
  const handleRegenerate = useCallback(() => {
    if (session === null || runtime === null) return
    void (async () => {
      await session.disposeBody(DEMO_BODY_ID)
      // R1.5 rework (UI4.audit.json): snapshotSource's own memo below the
      // useMeasureSession cache is keyed by nothing at all ("if non-empty,
      // return it") -- clearing it here is what actually lets a fresh
      // client.snapshotsFor(handle) run for the new handle; without this,
      // useMeasureSession's (bodyId, body.version) keying alone can't help
      // because this outer memo never calls through to the client again.
      snapshotsRef.current = {}
      await session.createBox(DEMO_BODY_ID, { featureId: 'F1', size: { ...DEMO_SIZE, z: DEMO_SIZE.z + 6 } })
      await session.tessellateProgressive(DEMO_BODY_ID, (_phase, cachedBody) => paintCachedBody(runtime, cachedBody))
    })()
  }, [session, runtime, paintCachedBody])

  return (
    <div
      data-testid="ui4-demo-root"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        background: 'var(--surface-page, #0d1117)',
        color: 'var(--text-primary, #e2e8f0)',
        font: '13px/1.5 Consolas, monospace',
      }}
    >
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          data-testid="ui4-canvas"
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
        <div
          data-testid="ui4-status"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2, padding: '6px 10px', background: 'rgba(16,20,24,0.85)' }}
        >
          {status}
        </div>
        <div style={{ position: 'absolute', top: 36, left: 8, zIndex: 2, display: 'flex', gap: 6 }}>
          <button
            type="button"
            data-testid="ui4-tool-measure"
            aria-pressed={activeTool === 'measure'}
            onClick={() => setActiveTool('measure')}
            style={toolButtonStyle(activeTool === 'measure')}
          >
            Measure
          </button>
          <button
            type="button"
            data-testid="ui4-tool-appearance"
            aria-pressed={activeTool === 'appearance'}
            onClick={() => setActiveTool('appearance')}
            style={toolButtonStyle(activeTool === 'appearance')}
          >
            Appearance
          </button>
          {activeTool === 'measure' &&
            (['face', 'edge', 'vertex', 'body'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`ui4-measure-filter-${mode}`}
                aria-pressed={measureFilterMode === mode}
                onClick={() => setMeasureFilterMode(mode)}
                style={toolButtonStyle(measureFilterMode === mode)}
              >
                {mode}
              </button>
            ))}
          <button
            type="button"
            data-testid="ui4-regenerate"
            disabled={!ready}
            onClick={handleRegenerate}
            data-tooltip="Re-mint the demo body under the same feature id (proves appearance survives)"
            style={toolButtonStyle(false)}
          >
            Regenerate
          </button>
        </div>
        <div style={{ position: 'absolute', top: 68, left: 8, zIndex: 2 }}>
          {activeTool === 'measure' ? (
            <MeasurePanel state={measure.state} onModeChange={measure.setMode} onClear={measure.clear} />
          ) : (
            <AppearancePanel
              state={appearance.state}
              onFilterModeChange={appearance.setFilterMode}
              onColorChange={appearance.applyColor}
              onClear={appearance.clearColor}
            />
          )}
        </div>
        <div style={{ position: 'absolute', bottom: 8, left: 8, right: 8, zIndex: 2, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <VisibilityPanel
            selectedFaceIds={selectedFaceIds}
            selectedBodyIds={selectedBodyIdsForVisibility}
            isolateActive={isolateActive}
            onHideSelectedFaces={handleHideSelectedFaces}
            onIsolateSelection={handleIsolateSelection}
            onClearIsolate={() => visibilityRef.current.clearIsolate()}
            onShowAll={() => visibilityRef.current.showAll()}
          />
          <SectionControls controller={section} />
        </div>
      </div>
      <div style={{ width: 320, flexShrink: 0, borderLeft: '1px solid var(--border-subtle, #2a3540)', padding: 10, overflowY: 'auto' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Design tree</div>
        <FeatureTree
          dag={dag}
          visibility={{
            isBodyVisible: (id) => visibilityRef.current.isBodyVisible(id),
            isIsolated: (id) => visibilityRef.current.snapshot().isolate?.bodyIds.has(id) ?? false,
            onToggleVisible: (id) => visibilityRef.current.toggleBodyHidden(id),
            onIsolate: (id) => {
              const snap = visibilityRef.current.snapshot()
              if (snap.isolate !== null && snap.isolate.bodyIds.has(id)) visibilityRef.current.clearIsolate()
              else visibilityRef.current.isolateIds([id])
            },
          }}
        />
        <div style={{ fontWeight: 600, margin: '16px 0 8px' }}>Mass properties (BK-49)</div>
        <MassPropertiesPanel
          bodyId={ready ? DEMO_BODY_ID : null}
          materialId={materialId}
          customDensityGPerCm3={customDensity}
          onMaterialChange={setMaterialId}
          onCustomDensityChange={setCustomDensity}
          properties={massProps}
          busy={massBusy}
        />
      </div>
    </div>
  )
}

function toolButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'var(--select-ui-bg)' : 'rgba(16,20,24,0.85)',
    color: 'var(--text-primary, #e2e8f0)',
    border: '1px solid var(--border-subtle, #2a3540)',
    borderRadius: 'var(--radius-md, 4px)',
    padding: '2px 8px',
    cursor: 'pointer',
    textTransform: 'capitalize',
  }
}
