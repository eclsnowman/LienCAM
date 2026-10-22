import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { ReferenceImage2dScene } from '../panels/sketch/ReferenceImage2d'
import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import {
  useCamStore,
  getAdaptive3dCarvedStock,
  camSketchDocumentPort,
  onCamStoreHydrated,
} from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { CNCViewport } from './CNCViewport'
import { shouldDisplayAdaptiveCarvedStock } from '../../lib/viewport/stockRemovalDisplayAuthority'
import { serializeCamera, deserializeCamera } from '../../lib/viewport/cameraPersist'
import type { SketchOffset } from '../../lib/sketch/sketcher/sketchLayer'
import { resolveSketchEditorPose } from '../../lib/sketch/sketchEditorPose'
import { useSketcherTool, SketcherOverlays, sketcherMenuPort } from '../../lib/sketch/sketcher'
import { camOverlaysPort, setCamOverlaySurface } from './camOverlaysPort'
import { sketchEditingLayerId } from '../../lib/sketch/editingLayer'
import { restoreGeometryToViewport, restoreNestsToViewport, retessellateBrepParts } from '../../lib/viewport/restoreScene'
import { buildSceneStockRebuildKey } from './sceneStockRebuildKey'
import { nestOwnedGeometryIds } from '../../lib/cam/nesting/seedSelectors'
import { seedPoseKeyForGeo } from '../../lib/cam/nesting/instanceToolpath'
import { collectToolpathSections } from '../../lib/cam/nesting/nestRuntime'
import { selectEnabledOperations } from '../../lib/cam/operationSuppression'
import { operationHeightPlaneDisplay, operationHeightPlaneNames } from '../../lib/cam/heightIntent'
import { isModelOriginGeometry } from '../../lib/cam/modelOrigin'
import { resolveModelReferenceFrame } from '../../lib/cam/modelReferenceFrame'
import { LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
import {
  DEFAULT_CONTOUR_TABS,
  resolveSetupSupportPlane,
  type ContourParams,
} from '../../lib/cam/types'
import { wcsBoundStockId } from '../../lib/post/workOffsets'
import { stockWorldBounds } from '../../store/stockAssignment'
import { evenTabFractions } from '../../lib/viewport/tabPlacement'
import { ViewportOverlay } from './ViewportOverlay'
import { ViewportToolbar } from './ViewportToolbar'
import { SeatInViseStrip } from './SeatInViseStrip'
import {
  instancePoseFromComponentDrag, openingFromJawDrag, workholdingOfGeometry,
} from '../../lib/workholding/vise'
import { applyViseDrawPoses } from '../workholding/viseViewport'
import { applyClampDrawings, clampInstanceOfDrawId } from '../workholding/clampViewport'
import { ClampPlacer, selectClamp, useClampUi } from '../workholding/ClampEditor'
import { clampInstance, nearestFraction, resolveClampBoundary } from '../../lib/workholding/clamps'
import { ViewCube, type ViewCubeCameraApi } from './ViewCube'
import { CAM_SECTION_MAX, CAM_SECTION_MIN, DisplayModeControl } from './DisplayModeControl'
import { useSectionPlaneDrag } from '../../hooks/useSectionPlaneDrag'
import {
  ViewportContextMenu,
} from './ViewportContextMenu'
import { ViewportContextMenuSurface } from './ViewportContextMenuSurface'
import {
  type ViewportContextAction,
  type ViewportContextTarget,
} from './ViewportContextMenu'
import { DeviationPanel } from '../simulation/DeviationPanel'
import { attachDeviationOverlay } from '../../lib/viewport/deviationOverlay'
import type { DeviationResult } from '../../lib/simulation/deviationComparison'
import type { Object3D } from 'three'
import { SimulationPanel } from '../simulation/SimulationPanel'
import { projectSTLToLoopsInPlane, buildPlaneFrame } from '../../lib/geometry/stlProjection'
import type { ImportedGeometry, ToolpathMove, ProjectionPlane, Layer2D } from '../../types'
import type { MoveOwner } from '../../lib/viewport/toolpathSegments'
// WO SKC-49 (Operator Q-35): CAM's view-state seam for the injected origin+axis anchors. The DATA
// (activeSketch.entities/constraints) is injected in src/store/index.ts (setActiveSketch,
// camSketchDocumentPort.ensureSketch); this is the other half -- the SketchViewState that tells
// the shared sketchLayer.ts package which ids get the specialized paint/marquee/badge treatment.
// Workbench's twin is sketchSessionStore.ts's getViewState().
import {
  SKETCH_ORIGIN_ENTITY_ID,
  SKETCH_ORIGIN_FIX_ID,
  SKETCH_AXIS_X_ENTITY_ID,
  SKETCH_AXIS_X_FIX_ID,
  SKETCH_AXIS_Y_ENTITY_ID,
  SKETCH_AXIS_Y_FIX_ID,
} from '../../lib/sketch/sketchAnchors'

const CAM_AXIS_ENTITY_IDS: ReadonlySet<string> = new Set([SKETCH_AXIS_X_ENTITY_ID, SKETCH_AXIS_Y_ENTITY_ID])
const CAM_AXIS_FIX_IDS: ReadonlySet<string> = new Set([SKETCH_AXIS_X_FIX_ID, SKETCH_AXIS_Y_FIX_ID])

/** WO INT-13B (spec 3.2): the CAM host's half of the workspace suspend/resume
 *  contract. App owns the DECISION (it owns the workspace axis and both hosts);
 *  this component owns the WIRING, because it owns both the CNCViewport instance
 *  and the ViewCube call site the contract acts on. `suspended` is false in every
 *  pre-INT-13 caller, so the CAM-only app is bit-for-bit unaffected. */
export interface ViewportProps {
  suspended?: boolean
}

// WO-2172: vise bodies are drawn where the vise has them - see
// components/workholding/viseViewport.ts (applyViseDrawPoses).

export function Viewport({ suspended = false }: ViewportProps = {}) {
  useText('cam-operations-new-operation')
  const containerRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<CNCViewport | null>(null)
  const deviationCleanup = useRef<(() => void) | null>(null)
  const showDeviation = useCallback((result: DeviationResult | null, opacity: number, scaleMm: number) => {
    deviationCleanup.current?.()
    deviationCleanup.current = null
    // Narrow adapter to the existing scene; no second renderer or modification
    // of stock/trail groups. CNCViewport's camera and scene are world-mm.
    const scene = (viewportRef.current as unknown as { scene?: Object3D } | null)?.scene
    if (scene && result) deviationCleanup.current = attachDeviationOverlay(scene, result, opacity, scaleMm)
  }, [])
  useEffect(() => () => { deviationCleanup.current?.() }, [])

  const [referenceHost, setReferenceHost] = useState<ReturnType<CNCViewport['referenceImageHost']> | null>(null)
  const [sectionDragElement, setSectionDragElement] = useState<HTMLElement | null>(null)

  /** WO INT-13B (D1.3): CAM's ViewCube camera contract, handed to the cube as a
   *  prop instead of the cube reading window.__cncViewport. Built ONCE (stable
   *  identity, [] deps) and resolving viewportRef at CALL time -- the ref is still
   *  null on the first render, and CNCViewport is rebuilt whenever the mount
   *  effect's deps change, so a captured instance would go stale. The global at
   *  :844 is deliberately untouched: it stays published for its twelve non-cube
   *  CAM consumers (spec 1.3), it just no longer carries the cube. */
  const cubeCamera = useMemo<ViewCubeCameraApi>(() => ({
    getCamera: () => viewportRef.current?.getCamera(),
    setCameraView: (view) => viewportRef.current?.setCameraView(view),
  }), [])


  const viewer                  = useCamStore((s) => s.viewer)
  const setSectionView          = useCamStore((s) => s.setSectionView)
  const viewportRefreshTrigger  = useCamStore((s) => s.viewportRefreshTrigger)
  const setSelectedFaces        = useCamStore((s) => s.setSelectedFaces)
  const setSelectedGeometry     = useCamStore((s) => s.setSelectedGeometry)
  const setSelectedStock        = useCamStore((s) => s.setSelectedStock)
  const setStockMembership      = useCamStore((s) => s.setStockMembership)
  const updateGeometryTransform = useCamStore((s) => s.updateGeometryTransform)
  const updateModelItemPlacement = useCamStore((s) => s.updateModelItemPlacement)
  const patchGeometry           = useCamStore((s) => s.patchGeometry)
  const setActivePanel          = useCamStore((s) => s.setActivePanel)
  const toggleViewerFlag        = useCamStore((s) => s.toggleViewerFlag)
  const setSelectedMove         = useCamStore((s) => s.setSelectedMove)   // PP-MOVE-PICK
  const addConsoleEvent         = useCamStore((s) => s.addConsoleEvent)   // PP-MOVE-PICK

  const camSectionDragController = useMemo(() => ({
    state: {
      dragEnabled: viewer.sectionDragEnabled,
      pos: viewer.sectionPosition,
      range: { min: CAM_SECTION_MIN, max: CAM_SECTION_MAX },
    },
    setPos: (sectionPosition: number) => setSectionView({ sectionPosition }),
  }), [setSectionView, viewer.sectionDragEnabled, viewer.sectionPosition])

  useSectionPlaneDrag({
    domElement: sectionDragElement,
    enabled: !suspended && viewer.sectionEnabled && viewer.sectionDragEnabled,
    section: camSectionDragController,
    exclusive: true,
  })

  // Stable key that changes whenever the displayed toolpath data changes.
  // The actual move array is built inside the render effect to avoid creating
  // a new array reference on every selector call (which would trigger infinite re-renders).
  const toolpathKey = useCamStore(s => {
    const setup = s.project.setups.find(st => st.id === s.project.activeSetupId)
    if (!setup) return ''
    // A nest seed op renders at its slot pose (renderMovesForGeo); moving the
    // bound stock moves that pose without changing move counts. Fold the bound
    // geo's seed pose into the key so the render effect re-fires on a pose move.
    // Non-seed ops contribute "" -> the key is byte-identical to before.
    const opKey = (o: typeof setup.operations[number]) => {
      const geoId = (o.params as { geometryId?: string }).geometryId
      const geo = geoId ? s.project.geometry.find(g => g.id === geoId) : undefined
      // P7: a nest seed op renders the WHOLE nest expansion (all copies +
      // inter-copy travel). Re-fire when the nest's copy count, cut order, or
      // world origin change (a re-pack, the Cut-order toggle, a stock move) -
      // none of which alter the seed op's own move count. Non-nest ops add "".
      let nestFrag = ''
      if (geo?.ownerNestId) {
        const n = s.project.nests?.find(nn => nn.id === geo.ownerNestId)
        if (n) {
          const o0 = n.origin ?? { x: 0, y: 0 }
          nestFrag = `:nest${n.placements.length}:${n.machiningOrder ?? 'by-operation'}:${o0.x},${o0.y}`
        }
      }
      return `${o.id}:${o.status}:${o.toolpathMoves?.length ?? 0}:${seedPoseKeyForGeo(geo)}${nestFrag}`
    }
    // All-ops mode: key based on every enabled op's move count + seed pose
    return selectEnabledOperations(setup.operations, s.project.activeOperationId)
      .map(opKey)
      .join('|')
  })

  const [interactionMode, setInteractionMode] = useState<'normal' | 'lay-on-face' | 'project-plane'>('normal')
  const [contextMenu, setContextMenu] = useState<{
    at: { x: number; y: number }
    target: ViewportContextTarget
  } | null>(null)

  /** The DOM surface the component attaches its overlay gestures to: this root covers the canvas
   *  AND the DOM sketch overlays (dimension value labels) rendered below. */
  const rootElRef = useRef<HTMLDivElement>(null)

  // Restore geometry from IndexedDB for a given geometry list. The body lives
  // in lib/viewport/restoreScene.ts so the store's loadProjectFromFile action
  // can drive the same restore (B2); this wrapper just binds the store hooks.
  const restoreGeometry = useCallback(async (
    vp: CNCViewport,
    geometry: ImportedGeometry[],
    // WO-353 audit fix: forced by restoreGeometryToViewport's new
    // `checkDocumentConsistency` parameter (a boot-only gate -- see that
    // function's own comment in restoreScene.ts). This wrapper serves BOTH
    // the startup/hydration restore (true, a real boot) and the undo/redo +
    // sketch-bake rebuild (false -- an in-session restore of an older
    // `project` snapshot, where a cached-vs-durable documentRevision mismatch
    // is normal and must not be read as a partial write). No default: every
    // caller must state which one it is.
    isBootRestore: boolean,
  ) => {
    const s = useCamStore.getState()
    await restoreGeometryToViewport(vp, geometry, {
      patchGeometry: s.patchGeometry,
      setBrepImportError: s.setBrepImportError,
      // INT-17A-R2 C2: scopes the durable model-body display lookup to THIS
      // project, so a reused `modelbody:F1` id cannot restore another project's
      // tessellation.
    }, s.project?.stocks ?? [], nestOwnedGeometryIds(s.project), s.project?.id, undefined, isBootRestore)
    // Instanced nests (ADR 0024, P3.2) render after their source geometry exists.
    // Same path serves first mount and the undo/refresh rebuild (clearScene drops
    // the prior nest groups; this re-instances them from the restored project).
    restoreNestsToViewport(vp, s.project?.nests, geometry)

    // UI-75: clearScene necessarily drops the imperative selection and its
    // gizmo. Once every async geometry loader has settled, restore only a
    // still-valid project selection. Re-reads the store rather than reusing `s`
    // above, because the awaited restore may have changed it. Sketch mode and
    // the fixed-stock gizmo own interaction exclusively, so they must not have a
    // part handle resurrected underneath them; restoreSelectedPartAfterSceneRestore
    // re-checks the same gate and REFUSES rather than stealing.
    const restored = useCamStore.getState()
    const selectedId = restored.viewer.selectedGeometryId
    const selectionStillExists = selectedId != null
      && restored.project.geometry.some((g) => g.id === selectedId)
    if (
      selectionStillExists
      && restored.viewer.mode !== 'sketch'
      && restored.viewer.selectedStockId == null
    ) {
      vp.restoreSelectedPartAfterSceneRestore(selectedId)
    }
    // WO-2172: the rebuilt scene drew every body at its row's pose; put vise bodies where the vise has them.
    applyViseDrawPoses(vp)
    // WO-2192: and every placed clamp of the active setup where its edge puts it.
    void applyClampDrawings(vp)
  }, [])

  const handleFaceSelect = useCallback(
    (faceId: string | null) => {
      if (faceId) setSelectedFaces([faceId])
      else setSelectedFaces([])
    },
    [setSelectedFaces]
  )

  const handlePartTransformChange = useCallback(
    (
      id: string,
      pos: { x: number; y: number; z: number },
      rot: { x: number; y: number; z: number }
    ) => {
      // WO INT-17C Stage C2: the gizmo drag-end commit for a model-origin row
      // must NEVER reach updateGeometryTransform (it refuses these by name,
      // C1 step 3b) -- it writes the row's OWN ModelItemPlacement instead, so
      // moving a Model Item never touches its geometry row's position/
      // rotation or its feature history/archive (Placement Composition
      // Contract invariant 3, "one fact, one owner").
      const geo = useCamStore.getState().project.geometry.find((g) => g.id === id)
      // WO-2172: a vise body is placed by its vise. Dragging the moving jaw
      // sets the opening by how far it travelled along its slide axis (kept
      // within travel); dragging the fixed body moves the whole vise. Either
      // is one undo step, and the drawn bodies then snap to the vise's pose.
      const project = useCamStore.getState().project
      // WO-2192: a placed clamp dropped after a drag slides along its edge to
      // the point nearest where it was dropped (one undo step); a clamp whose
      // edge is gone is simply moved there. Either way it is then drawn where
      // the store has it.
      const clampDraw = clampInstanceOfDrawId(id)
      if (clampDraw) {
        const found = clampInstance(project.workholding, clampDraw.instanceId)
        const component = found?.definition.components.find((c) => c.id === clampDraw.componentId)
        if (found && component) {
          const store = useCamStore.getState()
          const dropped = instancePoseFromComponentDrag(component, { position: pos, rotation: rot })
          const p = found.instance.placement
          const edge = p?.kind === 'boundary' ? resolveClampBoundary(project, p.target) : null
          if (edge) {
            // The clamp origin sits normalOffset outside the edge; slide by the point it was dropped over.
            store.moveClampOnEdge(found.instance.id, { fraction: nearestFraction(edge, dropped.position).fraction })
          } else {
            store.updateWorkholdingInstance(found.instance.id, {
              worldPose: { position: dropped.position, rotation: found.instance.worldPose.rotation },
            })
          }
        }
        const vp = viewportRef.current
        if (vp) void applyClampDrawings(vp)
        return
      }
      const vise = workholdingOfGeometry(project.workholding, id)
      if (vise) {
        const store = useCamStore.getState()
        if (vise.component.joint) {
          const opening = openingFromJawDrag(project, vise, pos)
          if (opening !== null) store.setWorkholdingJointValue(vise.instance.id, vise.component.id, opening)
        } else {
          store.updateWorkholdingInstance(vise.instance.id, {
            worldPose: instancePoseFromComponentDrag(vise.component, { position: pos, rotation: rot }),
          })
        }
        const vp = viewportRef.current
        if (vp) applyViseDrawPoses(vp)
        return
      }
      if (geo && isModelOriginGeometry(geo)) {
        const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
        updateModelItemPlacement(itemId, geo.modelBody?.ref.bodyId, pos, rot)
        return
      }
      updateGeometryTransform(id, pos, rot)
    },
    [updateGeometryTransform, updateModelItemPlacement]
  )

  const handlePartSelect = useCallback(
    (id: string | null) => {
      // WO-2192: a drawn clamp selects that clamp (Properties shows it; dragging slides it).
      const clampDraw = clampInstanceOfDrawId(id)
      if (clampDraw) {
        selectClamp(clampDraw.instanceId)
        return
      }
      useClampUi.getState().selectClamp(null)
      setSelectedGeometry(id)
      viewportRef.current?.setSelectedPart(id)
      // Empty-viewport click / deselect (id === null) must also clear the
      // shared stock selection so the stock gizmo exits and the tree icon
      // un-blues (the gizmo lifecycle effect in DesignTree keys on this).
      // Selecting a geometry (id != null) already clears selectedStockId via
      // setSelectedGeometry (commit A); this covers only the empty-click path.
      if (id === null) setSelectedStock(null)
    },
    [setSelectedGeometry, setSelectedStock]
  )

  // Rendered-stock click in the 3D viewport -> set the shared selectedStockId.
  // When the click began with a stock-eligible part selected, the SAME hit also
  // assigns that part through the canonical membership action before ordinary
  // stock selection takes over. The viewport passes its existing selectedPartId
  // as click context; no parallel assignment mode or identity store is needed.
  // Model-origin rows remain read-only and fall through to ordinary stock
  // selection. The move gizmo still attaches only when selectedStockId resolves
  // to a fixed stock in DesignTree.
  const handleStockSelect = useCallback(
    (id: string | null, assignmentPartId: string | null = null) => {
      if (id !== null && assignmentPartId !== null) {
        const part = useCamStore.getState().project.geometry.find((geo) => geo.id === assignmentPartId)
        if (part !== undefined && !isModelOriginGeometry(part)) {
          setStockMembership(assignmentPartId, id)
        }
      }
      setSelectedStock(id)
    },
    [setSelectedStock, setStockMembership]
  )

  // MODEL-mode context menu (UI-40): never a sketch handler - it bails in
  // sketch mode below. Attached via ViewportContextMenuSurface so the sketch
  // pointer-owner census can tell this file holds no sketch pointer JSX.
  const handleModelContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (suspended || interactionMode !== 'normal' || viewer.mode === 'sketch') return

    const viewport = viewportRef.current
    // WO-1503: release-order browsers must not open a menu after a right-drag.
    // WO-2728: press-order browsers open it first; ViewportContextMenu observes
    // the still-held gesture and dismisses it when movement exceeds 10 px.
    if (viewport?.consumeRightButtonWasDrag(event.clientX, event.clientY)) {
      event.preventDefault()
      return
    }
    event.preventDefault()

    const pick = viewport?.pickAtClientPosition(event.clientX, event.clientY)
    let target: ViewportContextTarget = { kind: 'empty' }

    if (pick?.kind === 'part') {
      const geometry = useCamStore.getState().project.geometry.find((item) => item.id === pick.id)
      setSelectedGeometry(pick.id)
      viewport?.setSelectedPart(pick.id)
      target = { kind: 'part', id: pick.id, label: geometry?.name ?? pick.id }
    } else if (pick?.kind === 'stock') {
      const state = useCamStore.getState()
      const fixed = (state.project.sceneStock.fixedStocks ?? []).find((item) => item.id === pick.id)
      const auto = (state.project.sceneStock.autoStocks ?? []).find((item) => item.id === pick.id)
      viewport?.setSelectedPart(null)
      setSelectedStock(pick.id)
      target = { kind: 'stock', id: pick.id, label: fixed?.name ?? auto?.name ?? pick.id }
    }

    setContextMenu({ at: { x: event.clientX, y: event.clientY }, target })
  }, [
    interactionMode,
    setSelectedGeometry,
    setSelectedStock,
    suspended,
    viewer.mode,
  ])

  const handleViewportContextAction = useCallback((action: ViewportContextAction) => {
    const target = contextMenu?.target
    const viewport = viewportRef.current

    switch (action) {
      case 'open-properties':
        setActivePanel('properties')
        break
      case 'hide-part':
        if (target?.kind === 'part') {
          patchGeometry(target.id, { hidden: true })
          viewport?.setSTLVisible(target.id, false)
          setSelectedGeometry(null)
          viewport?.setSelectedPart(null)
        }
        break
      case 'clear-selection':
        if (target?.kind === 'part') {
          setSelectedGeometry(null)
          viewport?.setSelectedPart(null)
        } else if (target?.kind === 'stock') {
          setSelectedStock(null)
        }
        break
      case 'fit-all':
        viewport?.fitAll()
        break
      case 'view-iso':
        viewport?.setCameraView('iso')
        break
      case 'view-top':
        viewport?.setCameraView('top')
        break
      case 'toggle-stock':
        toggleViewerFlag('showStock')
        break
      case 'toggle-workpiece':
        toggleViewerFlag('showWorkpiece')
        break
      case 'toggle-toolpath':
        toggleViewerFlag('showToolpath')
        break
      case 'toggle-grid':
        toggleViewerFlag('showGrid')
        break
    }
  }, [
    contextMenu?.target,
    patchGeometry,
    setActivePanel,
    setSelectedGeometry,
    setSelectedStock,
    toggleViewerFlag,
  ])

  const handleEnterLayOnFace = useCallback(() => {
    setInteractionMode('lay-on-face')
    viewportRef.current?.enterLayOnFaceMode(() => setInteractionMode('normal'))
  }, [])

  const handleExitLayOnFace = useCallback(() => {
    setInteractionMode('normal')
    viewportRef.current?.exitLayOnFaceMode()
  }, [])

  const PROJ_COLORS = ['#00e5ff', '#ff8c00', '#44ff88', '#ff44ff', '#ffd700', '#4488ff']

  const handleEnterProjectPlane = useCallback(() => {
    const geoId = useCamStore.getState().viewer.selectedGeometryId
    const vp = viewportRef.current
    if (!vp || !geoId) return

    setInteractionMode('project-plane')

    // Step 1 — Z-slider: user sets the horizontal slice height to define the 2D profile
    vp.enterSlicePlaneMode(
      geoId,
      (sliceZ) => {
        const worldPos = vp.collectWorldPositions(geoId)
        if (!worldPos) { setInteractionMode('normal'); return }

        const { project, appSettings } = useCamStore.getState()
        const geo = project.geometry.find(g => g.id === geoId)
        if (!geo) { setInteractionMode('normal'); return }

        const tol = geo.projectionTolerance ?? appSettings.projectionToleranceDefault ?? 0.02
        const sliceResult = projectSTLToLoopsInPlane(worldPos, {
          planeNormal: { x: 0, y: 0, z: 1 },
          planeOrigin: { x: 0, y: 0, z: sliceZ },
          simplificationTolerance: tol,
          minPerimeter: Math.max(0.1, tol * 6),
        })

        if (!sliceResult.loops.length) { setInteractionMode('normal'); return }

        // Step 2 — Target plane: user picks where to place the sliced geometry
        vp.enterTargetPlaneMode(
          geoId,
          (normal, centroid) => {
            const N = { x: normal.x, y: normal.y, z: normal.z }
            const { xAxis, yAxis } = buildPlaneFrame(N)
            const targetFrame: ProjectionPlane = {
              origin: { x: centroid.x, y: centroid.y, z: centroid.z },
              xAxis, yAxis, normal: N,
            }

            // Count existing projection layers to name this one
            const { project: currentProject, appendGeometryProjection } = useCamStore.getState()
            const currentGeo = currentProject.geometry.find(g => g.id === geoId)
            const projCount = (currentGeo?.layers2d ?? []).filter(l => l.projectionPlane).length
            const newLayerId = crypto.randomUUID()
            const newLayer: Layer2D = {
              id: newLayerId,
              name: tx('Viewport.Census_STL_Projection', { p1: projCount + 1 }),
              color: PROJ_COLORS[projCount % PROJ_COLORS.length],
              visible: true,
              projectionPlane: targetFrame,
            }
            // Re-tag loops to the new layer
            const taggedLoops = sliceResult.loops.map(l => ({ ...l, layerId: newLayerId }))
            appendGeometryProjection(geoId, taggedLoops, newLayer)
            // stlLoopsKey effect will handle the viewport update
            setInteractionMode('normal')
          },
          () => setInteractionMode('normal')
        )
      },
      () => setInteractionMode('normal')
    )
  }, [])

  const handleExitProjectPlane = useCallback(() => {
    setInteractionMode('normal')
    viewportRef.current?.exitProjectPlaneMode()
    viewportRef.current?.exitSlicePlaneMode()  // also cleans up if still in step 1
  }, [])

  // Escape cancels face-selection modes.
  // WO INT-15 (F-2): DISARM this window listener while the CAM host is suspended. `suspended`
  // is App's workspace signal (App.tsx: `<Viewport suspended={workspace !== 'cam'} />`), so a
  // face-select mode left armed under the hidden CAM host must not answer Escape pressed in the
  // Model workspace. Gated at the effect (detach-on-suspend, the INT-13B idiom) rather than an
  // event-time flag: when suspended the listener is not attached at all; leaving CAM re-runs the
  // effect and re-arms it. A no-op when no mode is armed either way.
  useEffect(() => {
    if (suspended) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (interactionMode === 'lay-on-face') handleExitLayOnFace()
        else if (interactionMode === 'project-plane') handleExitProjectPlane()
        // PP-MOVE-PICK: Escape clears a picked toolpath move, falling back to the
        // operation's own properties (the cascade below MoveProperties).
        else if (useCamStore.getState().viewer.selectedMove) setSelectedMove(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [suspended, interactionMode, handleExitLayOnFace, handleExitProjectPlane, setSelectedMove])

  // Initialize viewport once — also restores geometry from cache on first load
  useEffect(() => {
    if (!containerRef.current) return
    const vp = new CNCViewport(
      containerRef.current,
      handleFaceSelect,
      handlePartTransformChange,
      handlePartSelect,
      handleStockSelect
    )
    viewportRef.current = vp
    // Reference images are an optional scene capability; older/lightweight hosts
    // must still mount the viewport and its ordinary selection/key listeners.
    setReferenceHost(typeof vp.referenceImageHost === 'function' ? vp.referenceImageHost() : null)
    setSectionDragElement(containerRef.current.querySelector('canvas'))

    // PP-MOVE-PICK: wire the toolpath move-pick callbacks. onSelect updates the
    // shared selection (the Properties panel renders MoveProperties from it) and
    // logs a named console line; onHover drives the transient hover readout and,
    // when a pick refuses (ADR-0003), logs the refusal BY NAME to the console.
    vp.setMoveSelectCallback(
      (sel) => {
        setSelectedMove(sel)
        if (sel) {
          const op = useCamStore.getState().project.setups
            .flatMap((st) => st.operations).find((o) => o.id === sel.operationId)
          addConsoleEvent({
            severity: 'info',
            source: 'toolpath',
            message: tx('Viewport.Census_Selected_move_of_in', { p1: sel.moveIndex + 1, p2: sel.moveCount, p3: sel.role, p4: op?.name ?? tx('Viewport.Census_operation') }),
            entityRef: { kind: 'op', id: sel.operationId },
          })
        }
      },
      (_sel, refused) => {
        // Hover feedback itself is drawn in the viewport (segment highlight +
        // pointer cursor). This callback only needs to surface a refusal BY NAME
        // to the console (ADR-0003) when a click could not resolve a move.
        if (refused) {
          addConsoleEvent({
            severity: 'warning',
            source: 'toolpath',
            message: tx('Viewport.Census_Toolpath_pick_could_not_resolve_a_move_segment_has'),
          })
        }
      },
    )

    // The DOM surface the component attaches its overlay gestures to (dimension value labels,
    // right-button context menu). A mount hands over an element; it decides nothing.
    vp.setSketchOverlayHost(rootElRef.current)

    // WO SKC-14C: the PROJECTION the package's overlay DOM reads each frame (world mm -> screen px,
    // plus the live sketch cursor). CNCViewport structurally satisfies the package's surface type,
    // so nothing adapts it. Published to the module-const port; cleared on dispose below.
    setCamOverlaySurface(vp)

    // Context-menu PRESENTATION sink. WO SKC-14C: the anchor moved INTO the package (it is the
    // last scrap of sketch presentation state a mount held), so this hands the component its own
    // store. <SketcherOverlays/> renders the menu when the port says there is one.
    vp.setSketchMenuPort(sketcherMenuPort)

    // Undo ADAPTER (WO SKC-14, plan R3): CAM's flat sketchHistory snapshot stack is the
    // SINK. The component owns the semantics -- one undoable step per gesture -- and calls
    // beginGesture() once, before the first mutation of a gesture it drives. WO SKC-14-R1: the
    // store's own pushHistory calls for those gestures are GONE; every commit operation below
    // takes the component's `beforeMutate` latch instead.
    vp.setSketchUndoSink({
      beginGesture: () => useCamStore.getState().pushHistory(),
    })

    // THE mount contract, in one line (WO SKC-14B). What used to be a ~55-line adapter -- a
    // getToolState window onto the CAM sketch slice, a getSnap, a getOverlay, a getSwipeOverlay,
    // a getWakeRefs and a lockCursor, all of them the mount answering questions only the tool
    // machine should be asking -- is now a single document/commit/undo sink that the STORE owns
    // and exports (camSketchDocumentPort). There is no tool state here to read, so there is no
    // file here in which a second version of the felt behaviour could be written.
    vp.setSketchDocumentPort(camSketchDocumentPort)

    // Apply the persisted 3D-view navigation preset (and invert toggles) on
    // mount so the viewport opens in the user's chosen mouse scheme. A
    // dedicated effect below re-applies on any later settings change.
    {
      const a = useCamStore.getState().appSettings
      vp.applyNavPreset(a.navPreset, a.invertZoom, a.invertPan)
    }

    // Restore any previously imported parts from IndexedDB. Stock follows the
    // PROJECT's sceneStock once the parts are in (same end-state as the undo
    // and File>Open reload paths - B2 parity).
    const { project, viewer: v } = useCamStore.getState()
    vp.setMachineTravel?.(project.machine.travel)
    vp.setGridSpacing?.(v.gridSpacing)

    // Refresh-restore camera. Install the debounced persist callback (writes the
    // pose to uiPrefs), then restore the last saved pose now so the scene loads
    // into the user's last framing (no default-then-jump flicker — done before the
    // first frame and before geometry loads).
    //
    // Refresh vs File>New/Open: this restore lives ONLY in the Viewport MOUNT
    // effect, which fires on a real page load/refresh but NOT on File>New or
    // File>Open (those are store actions on the already-mounted component and run
    // their own framing). So the mount boundary alone distinguishes a refresh from
    // New/Open. (We can't gate on project.id: this app regenerates project.id on
    // every page load, so an id match would never hold across a refresh.) The
    // saved pose still records its project id for diagnostics / future use.
    vp.setCameraChangeHandler((pose) =>
      useUiPrefs.getState().setSavedCamera(
        useCamStore.getState().project.id,
        serializeCamera(pose),
      ),
    )
    {
      const savedCam = useUiPrefs.getState().savedCamera
      const pose = savedCam ? deserializeCamera(savedCam.camera) : null
      if (pose) {
        vp.restoreCameraState(pose)
        // Refresh case: the async geometry restore below auto-fits the camera on
        // the FIRST part added — and on a real GPU a SECOND/late STEP-load fit can
        // follow it — which would clobber the pose we just restored. Mark the camera
        // user-positioned (PERSISTENT flag) so EVERY model-load auto-fit is
        // suppressed and the restored framing survives regardless of async timing
        // (this is the T15 fix; the old one-shot guard only caught the first fit).
        //
        // Armed WHENEVER a valid pose restores, INDEPENDENT of project.geometry
        // length: a saved camera means the user positioned the view, and gating on
        // geometry.length made the suppression depend on the metadata being present
        // at this exact mount tick. If that read were ever 0 (or a STEP loaded late)
        // the flag stayed disarmed and the async addBrepModel fit snapped the view
        // back to ISO — the reported "resets to iso on every refresh with a STEP
        // model" symptom. New/Open still auto-fit: clearScene drops this flag.
        vp.markCameraUserPositioned()
        // Diagnostic (real-GPU refresh trace): report the restore decision in one
        // line so the reset path is confirmable in the console on the next refresh.
        console.info(
          `[camera-restore] restored pose (geometry=${project.geometry.length}, ` +
            `frustumSize=${pose.frustumSize ?? 'default(old-data)'}, zoom=${pose.zoom}) ` +
            'flag ARMED — model-load auto-fit suppressed',
        )
      } else if (savedCam) {
        // FAIL-LOUD (ADR-0003): a persisted camera existed but deserializeCamera
        // REJECTED it (non-finite position/target, or zoom <= 0). That silent
        // rejection means the restore is skipped and the model-load auto-fit then
        // frames to ISO — exactly the "view resets on refresh" symptom. Do not
        // swallow it: name that the persisted camera was discarded and why.
        console.warn(
          '[camera-restore] Persisted camera DISCARDED (non-finite position/target or ' +
            'zoom <= 0); flag NOT armed, falling back to default model framing.',
          savedCam.camera,
        )
      } else {
        // No persisted camera at all (first-ever load / cleared prefs): normal
        // model framing. Logged so an absent pose is distinguishable from a
        // rejected one when reading the refresh trace.
        console.info('[camera-restore] no persisted camera — default model framing')
      }
    }

    // WO-243: OPFS-backed Zustand hydration is asynchronous. The viewport can
    // mount against the fresh default project before the persisted project is
    // merged; restoring at that mount tick leaves an empty scene forever even
    // though the later hydration populates the tree and operation state. Run
    // the one startup restore only after hydration, and re-read the project at
    // that boundary. File -> Open remains owned by loadProjectFromFile.
    let startupRestoreDisposed = false
    const stopStartupRestore = onCamStoreHydrated(() => {
      const hydrated = useCamStore.getState()
      vp.setMachineTravel?.(hydrated.project.machine.travel)
      vp.setGridSpacing?.(hydrated.viewer.gridSpacing)
      if (hydrated.project.geometry.length === 0) return
      // WO-353 audit fix: this IS the boot restore -- the one-time,
      // post-hydration reload this whole effect exists for (see the WO-243
      // comment above).
      void restoreGeometry(vp, hydrated.project.geometry, true).then(() => {
        if (startupRestoreDisposed || viewportRef.current !== vp) return
        vp.rebuildStock(hydrated.project.sceneStock)
      })
    })

    // Signal the app-shell splash that the renderer + scene host are interactive.
    // Durable project hydration and its startup restore continue through the
    // gate above. rAF defers this to after the first painted frame. ready() is
    // idempotent (StrictMode double-invokes this effect in dev), and the splash
    // also has its own dismiss/8s safety net.
    // TODO: could move into CNCViewport's first render-loop tick for an exact
    // first-frame signal instead of this one-rAF proxy.
    requestAnimationFrame(() => window.LienSplash?.ready())

    return () => {
      startupRestoreDisposed = true
      stopStartupRestore()
      setCamOverlaySurface(null)
      setSectionDragElement(null)
      vp.dispose()
      viewportRef.current = null
    }
  }, [handleFaceSelect, handlePartTransformChange, handlePartSelect, handleStockSelect, restoreGeometry])

  // NOTE (B2): the old "reload when project.id changes" effect lived here. It
  // missed same-id reopens (save -> reload page -> File>Open the same file)
  // and skipped the stock rebuild. Project open now drives the full reload
  // from the store action itself (loadProjectFromFile -> reloadProjectScene);
  // File>New clears the scene directly in TopToolbar.

  // When undo is performed, fully reload the viewport from the restored project state
  const isFirstUndoMount = useRef(true)
  useEffect(() => {
    if (isFirstUndoMount.current) {
      isFirstUndoMount.current = false
      return
    }
    const vp = viewportRef.current
    if (!vp) return
    const cameraState = vp.saveCameraState()
    vp.clearScene()
    const { project } = useCamStore.getState()
    const reload = async () => {
      if (project.geometry.length > 0) {
        // WO-353 audit fix: NOT a boot restore -- this effect rebuilds from an
        // in-session undo/redo or sketch-bake trigger (viewportRefreshTrigger),
        // never a fresh load. See restoreGeometry's own comment above for why
        // this must stay false.
        await restoreGeometry(vp, project.geometry, false)
      }
      vp.rebuildStock(project.sceneStock)
      vp.restoreCameraState(cameraState)
    }
    reload()
  }, [viewportRefreshTrigger, restoreGeometry])

  // Reactively re-render nest seed slots when an owned seed's CONTENT changes.
  // The owned seed is suppressed from the standalone render, so any edit to it
  // must re-drive restoreNestsToViewport — that is where the seed-slot loops are
  // read (live) and filtered by layer visibility. A stable primitive key drives
  // the effect; it changes only when something the slot must reflect changes, so
  // no render loop. The key folds in, per nest source geometry:
  //   - per-layer id:visible  (visibility eye)
  //   - the layer-id set       (add / delete layer)
  //   - loopsVersion           (delete-layer recenters loops + bumps it; sketch
  //                             bake / loop edits bump it too)
  // The mount + undo paths already restore nests, so skip the first run. (A full
  // sketch bake also fires viewportRefreshTrigger, which is left intact.)
  const nestSeedContentKey = useCamStore(s => {
    const nests = s.project.nests ?? []
    if (nests.length === 0) return ''
    const srcIds = new Set<string>()
    for (const n of nests) for (const src of n.sources) srcIds.add(src.geometryId)
    return s.project.geometry
      .filter(g => srcIds.has(g.id))
      .map(g => {
        const layers = (g.layers2d ?? []).map(l => `${l.id}=${l.visible ? 1 : 0}`).join(',')
        return `${g.id}#${g.loopsVersion ?? 0}:${layers}`
      })
      .join('|')
  })
  const isFirstNestVisMount = useRef(true)
  useEffect(() => {
    if (isFirstNestVisMount.current) {
      isFirstNestVisMount.current = false
      return
    }
    const vp = viewportRef.current
    if (!vp) return
    const { project } = useCamStore.getState()
    restoreNestsToViewport(vp, project.nests, project.geometry)
  }, [nestSeedContentKey])

  // Reactively rebuild the stock box whenever the project's stock-relevant
  // state changes (FIX A+B). addGeometry (and other store actions) update
  // project.stocks / sceneStock / geometry in the store but never call the
  // viewport's rebuildStock, and nothing else watched these — so the FIRST
  // imported part's auto-stock box did not appear until a later stock action
  // triggered a rebuild, and moving stock-tied geometry did not live-refresh
  // the box. A stable primitive key drives the effect (a new object reference
  // each render would loop); rebuildStock is viewport-only (no store write) so
  // there is no render loop. Coexists with the mount + undo rebuild effects.
  const sceneStockRebuildKey = useCamStore(s => buildSceneStockRebuildKey(s.project))
  const isFirstStockMount = useRef(true)
  useEffect(() => {
    // Mount already rebuilds stock inside the init effect after restore; skip
    // the first run so we don't race that async restore with an empty rebuild.
    if (isFirstStockMount.current) {
      isFirstStockMount.current = false
      return
    }
    const vp = viewportRef.current
    if (!vp) return
    vp.rebuildStock(useCamStore.getState().project.sceneStock)
  }, [sceneStockRebuildKey])

  // Re-render the active sketch whenever the document changes (entities are
  // rewritten by every solve, so the activeSketch reference is the reactive
  // key). Renders only in sketch mode; cleared otherwise.
  const activeSketch = useCamStore((s) => s.activeSketch)
  const sketchGlyphsVisible = useCamStore((s) => s.sketchGlyphsVisible)
  const sketchSelectedIds = useCamStore((s) => s.sketchSelectedIds)
  const sketchTextEditId = useCamStore((s) => s.sketchTextEditId)
  // Caret-index-only changes (arrow keys move the caret without mutating the
  // entity) must ALSO rebuild the sketch layer -- the in-canvas caret (M1b)
  // is drawn by the layer from this index. Subscribing here rides the SAME
  // effect the text mutations ride (updateSketch -> layer rebuild).
  const sketchTextCaretIndex = useCamStore((s) => s.sketchTextCaretIndex)
  // SKC-BLOCKS Stage 4: block edit-in-place session. While open, the OUTER
  // entities (everything not a member) render as a dim, unpickable ghost
  // backdrop -- the injected origin/axis anchors are excluded (they are not
  // real sketch content and are never part of any block).
  const sketchBlockEditId = useCamStore((s) => s.sketchBlockEditId)
  const sketchBlockEditOuterIds = useCamStore((s) => s.sketchBlockEditOuterIds)
  const sketchChainForHighlight = useSketcherTool((s) => s.chain)
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    // Entities accumulated in a PICK tool's set highlight like a selection
    // — without this the set is invisible while it is being built. Mirror /
    // pattern chains carry `ids`; the smart-dimension chain carries
    // `operandIds` (different field name, same intent) — both must light up
    // the picked entities amber (the angle-dim repro finding: a picked
    // first line gave no selected indication).
    const chainIds: string[] =
      sketchChainForHighlight && 'ids' in sketchChainForHighlight
        ? sketchChainForHighlight.ids
        : sketchChainForHighlight && 'operandIds' in sketchChainForHighlight
          // Operands may be whole-entity ids OR explicit-point { entityId, site }
          // objects; highlight the owning entity either way.
          ? sketchChainForHighlight.operandIds.map((o) =>
              typeof o === 'string' ? o : o.entityId)
          : []
    // Display offset: pose the sketch layer at the edited part's own placement,
    // the pose the CAM view draws that part at, so an opened layer sits exactly
    // where it lives (the loops stay in the clean LOCAL frame; the offset is
    // display-only and is inverse-applied to picking). WO-2854 replaced the
    // 2026-07-22 nest-only rule, which drew every other part at the origin.
    const sk = viewer.mode === 'sketch' ? activeSketch : null
    const offset: SketchOffset | undefined = sk
      ? resolveSketchEditorPose(useCamStore.getState().project.geometry, sk)
      : undefined
    vp.updateSketch(sk, {
      selectedIds: new Set<string>([...sketchSelectedIds, ...chainIds]),
      glyphsVisible: sketchGlyphsVisible,
      editingId: sketchTextEditId,
      caretIndex: sketchTextCaretIndex,
      originAnchorId: SKETCH_ORIGIN_ENTITY_ID,
      originAnchorFixId: SKETCH_ORIGIN_FIX_ID,
      axisEntityIds: CAM_AXIS_ENTITY_IDS,
      axisFixIds: CAM_AXIS_FIX_IDS,
      blockEditGhostIds: sketchBlockEditId
        ? new Set(
            (sketchBlockEditOuterIds ?? []).filter(
              (id) => id !== SKETCH_ORIGIN_ENTITY_ID && !CAM_AXIS_ENTITY_IDS.has(id),
            ),
          )
        : undefined,
    }, offset)
  }, [
    activeSketch, viewer.mode, sketchGlyphsVisible, sketchSelectedIds,
    sketchChainForHighlight, sketchTextEditId, sketchTextCaretIndex,
    sketchBlockEditId, sketchBlockEditOuterIds,
  ])

  // While a sketch document is OPEN, hide its layer's baked loop rendering —
  // the live sketch entities are the truth (a deleted line must disappear
  // immediately, not at the next Finish). Other layers stay visible as
  // reference. Restores on finish/cancel/doc-switch (selector goes null or
  // changes layer). viewportRefreshTrigger/project-open rebuilds are covered
  // inside the viewport: add2DGeometry consults the stored editing layer id.
  const editingLayerId = useCamStore(sketchEditingLayerId)
  useEffect(() => {
    viewportRef.current?.setSketchEditingLayer(editingLayerId)
  }, [editingLayerId])

  // Enter/exit the sketch view state when the mode crosses the sketch boundary.
  // Must run BEFORE the visibility sync below so the entry snapshot captures
  // the flag-driven visibility and the exit restore happens before re-sync.
  const wasSketchRef = useRef(false)
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const isSketch = viewer.mode === 'sketch'
    if (isSketch && !wasSketchRef.current) vp.enterSketchView()
    else if (!isSketch && wasSketchRef.current) vp.exitSketchView()
    wasSketchRef.current = isSketch
  }, [viewer.mode])

  // Sync visibility flags
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    if (viewer.mode === 'sketch') return  // sketch view owns stock/machine/toolpath visibility
    vp.setStockVisible(viewer.showStock)
    vp.setWorkpieceVisible(
      viewer.mode === 'simulation'
        ? viewer.showWorkpiece && viewer.stockSimDisplayMode !== 'stock'
        : viewer.showWorkpiece,
    )
    // Feature A: inside the simulation view the user can hide the toolpath so the
    // busy path stops obscuring the receding stock. simHideToolpath only narrows
    // sim-view visibility — it must NOT change toolpath-mode visibility. Default
    // false = visible. The effect dep array is [viewer], so simHideToolpath + mode
    // are already covered.
    vp.setToolpathVisible(
      viewer.mode === 'simulation'
        ? viewer.showToolpath && !viewer.simHideToolpath
        : viewer.showToolpath,
    )
    vp.setGridVisible(viewer.showGrid)
    vp.setAxesVisible(viewer.showAxes)
    vp.setSeedOutlineVisible(viewer.showSeedOutline)
    vp.setMachineVisible(viewer.showMachine)
    vp.setShadingMode(viewer.shadingMode)
    vp.setSectionView({ enabled: viewer.sectionEnabled, axis: viewer.sectionAxis, position: viewer.sectionPosition, flip: viewer.sectionFlip })
  }, [viewer])

  // Sync grid spacing
  useEffect(() => {
    viewportRef.current?.setGridSpacing?.(viewer.gridSpacing)
  }, [viewer.gridSpacing])

  // Sync machine travel boundary
  const machineTravelKey = useCamStore(s => {
    const { x, y, z } = s.project.machine.travel
    return `${x}|${y}|${z}`
  })
  useEffect(() => {
    const { project } = useCamStore.getState()
    viewportRef.current?.setMachineTravel?.(project.machine.travel)
  }, [machineTravelKey])

  // Sync the 3D-view navigation preset + invert toggles. Re-applies the
  // OrbitControls button mapping whenever the user changes the scheme in
  // Settings (mirrors how grid spacing / machine travel are pushed to the
  // viewport). applyNavPreset only sets .mouseButtons/.touches, so it does not
  // disturb sketch-mode's enableRotate state or an in-flight gizmo drag.
  const navPreset  = useCamStore((s) => s.appSettings.navPreset)
  const invertZoom = useCamStore((s) => s.appSettings.invertZoom)
  const invertPan  = useCamStore((s) => s.appSettings.invertPan)
  useEffect(() => {
    viewportRef.current?.applyNavPreset(navPreset, invertZoom, invertPan)
  }, [navPreset, invertZoom, invertPan])

  // F3: live B-rep re-tessellation on a render-fidelity (quality) change.
  // When the user picks a different brepTessellationQuality tier in Settings,
  // re-run tessellation for every ALREADY-LOADED STEP part at the new deflection
  // and swap its geometry in place (restoreScene's reload machinery), preserving
  // each part's world placement, color, hidden state, and selection. STL parts
  // are untouched; no-op when no B-rep parts are loaded. The setter only mutates
  // the tier value (no feedback loop), and the effect runs ONLY on an actual tier
  // change (the selector is the primitive value). A monotonic run-id guards
  // against stale async results when the user flips tiers quickly: a newer change
  // bumps the id, and any in-flight run drops its superseded result.
  const brepTessellationQuality = useCamStore((s) => s.appSettings.brepTessellationQuality)
  const isFirstQualityMount = useRef(true)
  const qualityRunIdRef = useRef(0)
  useEffect(() => {
    if (isFirstQualityMount.current) {
      // Mount already tessellates parts at the current quality (init restore);
      // skip so we don't redundantly re-tessellate on first render.
      isFirstQualityMount.current = false
      return
    }
    const vp = viewportRef.current
    if (!vp) return
    const runId = ++qualityRunIdRef.current
    const isCurrent = () => qualityRunIdRef.current === runId
    const s = useCamStore.getState()
    retessellateBrepParts(
      vp,
      s.project.geometry,
      { patchGeometry: s.patchGeometry, setBrepImportError: s.setBrepImportError },
      s.project?.stocks ?? [],
      nestOwnedGeometryIds(s.project),
      isCurrent,
    )
  }, [brepTessellationQuality])

  // Active operation selector (for height planes).
  // Falls back to the first enabled op so planes show even without an explicit selection.
  const activeOp = useCamStore(s => {
    const setup = s.project.setups.find(st => st.id === s.project.activeSetupId)
    if (!setup) return null
    return (
      setup.operations.find(o => o.id === s.project.activeOperationId) ??
      setup.operations.find(o => o.enabled) ??
      setup.operations[0] ??
      null
    )
  })

  const activeSetup = useCamStore(s =>
    s.project.setups.find(st => st.id === s.project.activeSetupId) ?? null
  )

  // Returns a stable primitive so Zustand's Object.is comparison doesn't infinite-loop
  const activeSetupWCSKey = useCamStore(s => {
    const setup = s.project.setups.find(st => st.id === s.project.activeSetupId)
    if (!setup) return null
    const { x, y, z } = setup.wcs.origin
    return `${x}|${y}|${z}|${setup.wcs.label}`
  })

  const activeSetupSupportPlaneKey = useCamStore((s) => {
    const setup = s.project.setups.find((candidate) => candidate.id === s.project.activeSetupId)
    if (!setup) return ''
    const stockId = wcsBoundStockId(setup.wcs)
    const stock = stockId ? s.project.stocks?.find((candidate) => candidate.id === stockId) : undefined
    const stockBottomZ = stock ? stockWorldBounds(stock).min.z : null
    return JSON.stringify({
      wcs: setup.wcs,
      fixtureStack: setup.fixtureStack ?? [],
      supportPlane: setup.supportPlane ?? null,
      stockBottomZ,
    })
  })

  const activeSetupSupportPlane = useMemo(() => {
    if (!activeSetupSupportPlaneKey) return null
    const { project } = useCamStore.getState()
    const setup = project.setups.find((candidate) => candidate.id === project.activeSetupId)
    if (!setup) return null
    const stockId = wcsBoundStockId(setup.wcs)
    const stock = stockId ? project.stocks?.find((candidate) => candidate.id === stockId) : undefined
    return resolveSetupSupportPlane(setup, stock ? stockWorldBounds(stock).min.z : undefined)
  }, [activeSetupSupportPlaneKey])

  // Render toolpath whenever the active selection or mode changes.
  // Reads current store state directly to avoid a new-array-each-render selector.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return

    // PP-MOVE-PICK: any toolpath rebuild (regen, active-op change, mode change)
    // invalidates a previously picked move — the drawn segments it referenced are
    // replaced. Clear it so the panel/overlay never show a stale pick. Safe from
    // churn: picking a move does NOT run this effect (selectedMove is not a dep
    // and setSelectedMove does not change activeOperationId/toolpathKey).
    if (useCamStore.getState().viewer.selectedMove) setSelectedMove(null)

    if (viewer.mode !== 'toolpath' && viewer.mode !== 'simulation') {
      vp.renderToolpath([], true)
      vp.clearCarvedStock() // C3: carved preview is a Toolpath-only overlay
      return
    }

    const { project } = useCamStore.getState()
    const setup = project.setups.find(st => st.id === project.activeSetupId)
    if (!setup) { vp.renderToolpath([], true); vp.clearCarvedStock(); return }

    // Build the ordered render sections (P7, ADR 0024 Amendment 1). A normal op
    // -> one section (renderMovesForGeo: pass-through, or seed-slot offset for an
    // owned seed). A NEST seed op -> the nest's FULL multi-copy expansion (all
    // copies + inter-copy travel), emitted ONCE for the whole nest. With no
    // nests this is one section per op, byte-identical to the prior behavior.
    const opsToRender = selectEnabledOperations(
      setup.operations,
      project.activeOperationId,
    )

    // Chunk C3: drive the diagnostic carved-stock preview off the SAME key as
    // the Toolpath render. Simulation has its own heightmap/voxel display
    // authority, so switching there clears and disposes this preview.
    let shownCarved = false
    if (viewer.showRoughingPreview && shouldDisplayAdaptiveCarvedStock(viewer.mode)) {
      for (const op of opsToRender) {
        if (op.type !== 'adaptive_3d') continue
        const carved = op.status === 'ready' ? getAdaptive3dCarvedStock(op.id) : undefined
        if (carved) {
          vp.showCarvedStock(op.id, carved.positions, carved.indices, carved.position, carved.rotationZDeg)
          shownCarved = true
        } else {
          vp.clearCarvedStock(op.id)
        }
      }
    }
    if (!shownCarved) vp.clearCarvedStock()

    const sections = collectToolpathSections(opsToRender, project.geometry, project.nests)

    // Concatenate sections in order, inserting a rapid travel move between
    // consecutive sections (the within-nest inter-copy travel is already in the
    // section moves; this links section-to-section, as the prior per-op concat
    // did). Single-op mode yields one section -> no leading rapid (unchanged).
    const moves: ToolpathMove[] = []
    // PP-MOVE-PICK: owner tag per move, aligned 1:1 to `moves`, so a viewport
    // click on a drawn segment resolves to (operationId, in-op index). The
    // synthetic inter-section rapid links below get a null owner (not pickable).
    const moveOwners: (MoveOwner | null)[] = []
    for (const sec of sections) {
      if (sec.moves.length === 0) continue
      if (moves.length > 0) {
        const first = sec.moves[0]
        moves.push({ type: 'rapid', x: first.x, y: first.y, z: first.z, role: 'rapid' })
        moveOwners.push(null) // inter-section travel link: no owning move
      }
      // Append iteratively, NOT `push(...sec.moves)`: a dense op (full-stock
      // adaptive = 100k+ moves) spreads every move as a call argument and
      // overflows the stack when rendering the toolpath. Same fix as the AC
      // engine emit + the simulation frame accumulator.
      for (let i = 0; i < sec.moves.length; i++) {
        moves.push(sec.moves[i])
        moveOwners.push({ operationId: sec.opId, indexInOp: i, moveCount: sec.moves.length })
      }
    }

    if (moves.length === 0) { vp.renderToolpath([], true); return }

    vp.renderToolpath(moves, true, moveOwners)
    vp.setHiddenToolpathRoles(new Set(viewer.hiddenToolpathRoles))
  }, [toolpathKey, viewer.mode, viewer.showRoughingPreview]) // eslint-disable-line react-hooks/exhaustive-deps

  // Visibility-only toggle — just flips Three.js .visible, no geometry rebuild
  useEffect(() => {
    viewportRef.current?.setHiddenToolpathRoles(new Set(viewer.hiddenToolpathRoles))
  }, [viewer.hiddenToolpathRoles])

  // Update height planes when showHeightPlanes or activeOp changes
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    if (!viewer.showHeightPlanes || !activeOp) {
      vp.updateHeightPlanes(null)
      return
    }
    const wcsZ = activeSetup?.wcs?.origin.z ?? 0
    const resolved = operationHeightPlaneDisplay(activeOp, wcsZ)
    if (!resolved) {
      vp.updateHeightPlanes(null)
      return
    }
    const displayedPlanes = operationHeightPlaneNames(activeOp.type)
    vp.updateHeightPlanes({
      clearance: resolved.clearance,
      retract:   resolved.retract,
      feed:      displayedPlanes.includes('feed') ? resolved.feed : undefined,
      top:       resolved.top,
      bottom:    resolved.bottom,
      hidden:    viewer.hiddenHeightPlanes,
    })
    vp.setHeightPlanesVisible(true)
  }, [viewer.showHeightPlanes, activeOp, viewer.hiddenHeightPlanes, activeSetup])

  // Contour holding-tab markers (Tabs v2): when the EXPLICITLY selected op is a
  // contour with tabs enabled and a computed tab preview, render a square
  // marker at every tab center on the finish contour. Fractions come from the
  // op's custom tabLocations when present, else the evenly-spaced defaults, so
  // the markers always show exactly what the engine will cut. The edit mode
  // itself (add/drag/remove) is entered from the Properties panel; this effect
  // only keeps marker data in sync with the store.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const { project } = useCamStore.getState()
    const op = activeOp
    if (
      !op ||
      op.id !== project.activeOperationId ||
      op.type !== 'contour_2d' ||
      (viewer.mode !== 'toolpath' && viewer.mode !== 'simulation')
    ) {
      vp.setContourTabMarkers?.(null)
      return
    }
    const params = op.params as unknown as ContourParams
    const preview = op.contourTabPreview
    // CAM-12-R3 census fix: `.loops` must be checked as an actual array before
    // `.length` -- a malformed persisted preview (a hand-edited/corrupted file
    // carrying a wrong-shaped truthy value) previously threw here unguarded.
    if (params.tabs !== true || !preview || !Array.isArray(preview.loops) || preview.loops.length === 0) {
      vp.setContourTabMarkers?.(null)
      return
    }
    const width = params.tabWidth ?? DEFAULT_CONTOUR_TABS.width
    const count = params.tabCount ?? DEFAULT_CONTOUR_TABS.count
    vp.setContourTabMarkers?.({
      z: preview.tabTopZ,
      loops: preview.loops
        .filter(l => l.path.length >= 3 && l.perimeter > 1e-6)
        .map(l => {
          const custom = params.tabLocations?.[l.loopId]
          return {
            loopId: l.loopId,
            path: l.path,
            fractions: custom && custom.length > 0 ? custom : evenTabFractions(count),
            minSeparationFraction: width / l.perimeter,
          }
        }),
    })
  }, [activeOp, viewer.mode])

  // Keep the WCS indicator (gold sphere) in sync with the active setup's origin
  useEffect(() => {
    if (!activeSetupWCSKey) return
    const { project } = useCamStore.getState()
    const setup = project.setups.find(st => st.id === project.activeSetupId)
    if (!setup) return
    viewportRef.current?.setWCSOrigin(setup.wcs.origin, setup.wcs.label)
  }, [activeSetupWCSKey])

  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    if (!activeSetupSupportPlane) {
      vp.setSetupSupportPlane(null)
      return
    }
    const setup = useCamStore.getState().project.setups.find(
      (candidate) => candidate.id === useCamStore.getState().project.activeSetupId,
    )
    if (!setup) return
    const relative = activeSetupSupportPlane.wcsOffsetZ
    vp.setSetupSupportPlane({
      origin: { x: setup.wcs.origin.x, y: setup.wcs.origin.y },
      z: activeSetupSupportPlane.z,
      label: tx('Viewport.Z', { p1: activeSetupSupportPlane.name, p2: activeSetupSupportPlane.wcsLabel, p3: relative >= 0 ? '+' : '', p4: relative.toFixed(3) }),
      resolved: activeSetupSupportPlane.resolved,
    })
  }, [activeSetupSupportPlane])

  // Tracks which STL geo IDs were present in the previous render so deletions can be cleaned up
  const prevStlGeoIdsRef = useRef<Set<string>>(new Set())

  // Stable key string: fires effect whenever any STL geometry's loop state changes (including clears/deletes)
  // 'step' included: B-rep derived-loop layers (Stage 3) land exactly like STL
  // projection layers and render through the same world-plane loop pipeline.
  const stlLoopsKey = useCamStore(s =>
    s.project.geometry
      .filter(g => g.format === 'stl' || g.format === 'step')
      .map(g => `${g.id}:${g.loops?.length ?? 0}:${g.loopsVersion ?? 0}`)
      .join(',')
  )

  // When STL geometries get projected loops, route to the correct renderer.
  // Layers with projectionPlane → world-space; layers without → local part-space.
  // Also clears renderers when loops are removed or the geometry is deleted.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const { project } = useCamStore.getState()
    const currentStlGeos = project.geometry.filter(g => g.format === 'stl' || g.format === 'step')
    const currentIds = new Set(currentStlGeos.map(g => g.id))

    // Clean up any geometries that were removed entirely
    prevStlGeoIdsRef.current.forEach(id => {
      if (!currentIds.has(id)) {
        vp.clearPartLoopsOnFacePlane(id)
        vp.setPartProjectedLoops(id, [], [])
      }
    })
    prevStlGeoIdsRef.current = currentIds

    currentStlGeos.forEach(geo => {
      const layers = geo.layers2d ?? []
      const loops  = geo.loops ?? []

      if (loops.length === 0) {
        vp.clearPartLoopsOnFacePlane(geo.id)
        vp.setPartProjectedLoops(geo.id, [], [])
        return
      }

      // Split loops into world-plane (layer has projectionPlane) vs local-space
      const worldLayerIds = new Set(layers.filter(l => l.projectionPlane).map(l => l.id))
      const worldLoops = loops.filter(l => worldLayerIds.has(l.layerId))
      const localLoops = loops.filter(l => !worldLayerIds.has(l.layerId))

      if (worldLoops.length > 0) {
        vp.setPartLoopsOnFacePlane(geo.id, worldLoops, layers)
      } else {
        vp.clearPartLoopsOnFacePlane(geo.id)
      }

      vp.setPartProjectedLoops(geo.id, localLoops, layers.filter(l => !l.projectionPlane))
    })
  }, [stlLoopsKey])

  // INT-17A Stage 1 (B4): live-reconcile model-workbench body meshes in the CAM
  // viewport. Fires whenever the model-backed geometry entries change - a body
  // added/edited (version bump)/renamed/deleted while the Model tab is live. The
  // CAM host stays mounted (INT-13A suspend/resume) so this effect runs even
  // while the user is on the Model tab; when they switch back the mesh is already
  // drawn. The full-reload draw is handled separately by restoreGeometryToViewport
  // (both call addModelBody with the same persisted payload; the replace-in-place
  // is idempotent). The key includes the complete tessellation identity
  // `(bodyId, version)` so an edit re-pushes the fresh tessellation, and
  // `hidden`/`color` so those user toggles apply live. `version` alone is not
  // sufficient: an appended feature advances F3 -> F4 while each leaf-local
  // GeometryCache generation may validly be 1. Omitting bodyId made those two
  // different displays compare equal and left Setup showing F3 until reload.
  //
  // WO INT-17C Stage C2: also folds in `project.modelItemPlacements` (every
  // record, not just this item's) so a Placement commit -- gizmo drag-end OR
  // a typed Properties Panel field -- re-fires this effect and every body of
  // the moved item (not just the one whose group the gizmo was attached to)
  // re-resolves and re-draws at its new pose. This is what keeps a
  // multi-body Model Item's siblings in sync: they don't animate live during
  // a drag (only the grabbed body's THREE group moves during the gesture),
  // but they snap to the correct final pose the instant the drag commits.
  const modelBodiesKey = useCamStore(s => {
    const geoKey = s.project.geometry
      .filter(g => g.format === 'model')
      // INT-17A-R1 C1: `display ? 1 : 0` is part of the key. A refresh-rehydrated
      // entry arrives with a ref but NO display and then gains one (recovered
      // from the durable cache, or re-derived by the Part tab) WITHOUT a version
      // bump - keyed on version alone, that transition was invisible and the body
      // never drew until something else happened to change the key.
      .map(g => `${g.id}:${g.modelBody?.ref.bodyId ?? ''}:${g.modelBody?.ref.version ?? 0}:${g.modelBody?.display ? 1 : 0}:${g.hidden ? 1 : 0}:${g.color ?? ''}`)
      .join(',')
    const placementKey = (s.project.modelItemPlacements ?? [])
      .map(p => `${p.modelItemId}:${p.bodyId ?? ''}:${p.position.x},${p.position.y},${p.position.z}:${p.rotation.x},${p.rotation.y},${p.rotation.z}`)
      .join(',')
    return `${geoKey}|${placementKey}`
  })
  const prevModelGeoIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const { project } = useCamStore.getState()
    // Only entries with a DISPLAY payload are drawable. An entry that rehydrated
    // from localStorage without one (display stripped for quota) draws once the
    // Part tab remounts and re-derives it; it is not torn down here (it is not in
    // currentIds until it has display), and it is not an orphan.
    const modelGeos = project.geometry.filter(g => g.format === 'model' && g.modelBody?.display)
    const currentIds = new Set(modelGeos.map(g => g.id))

    // Tear down meshes for model entries that vanished (a deleted body). removeSTL
    // is the shared partGroups remover addModelBody registers into (no 2D leak).
    prevModelGeoIdsRef.current.forEach(id => {
      if (!currentIds.has(id)) vp.removeSTL(id)
    })
    prevModelGeoIdsRef.current = currentIds

    // INT-17C Stage C1 step 3a / Stage C2 (Placement Composition Contract
    // invariant 1): the draw path resolves world pose through the seam
    // function, reading the REAL per-project Placement registry -- the
    // call site itself is unchanged shape from Stage C1 (only the lookup's
    // source changed), exactly as invariant 5 promised. `bodyId` is passed
    // so a legacy row with its own body-filtered record resolves to THAT
    // pose; a Stage-C2-native item's rows fall back to its one whole-item
    // record (resolveModelItemPlacement's own precedence, unchanged here).
    for (const geo of modelGeos) {
      const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
      try {
        const { position, rotation } = resolveModelReferenceFrame(
          project.modelItemPlacements ?? [], itemId, geo.modelBody?.ref.bodyId,
        )
        vp.addModelBody(geo.id, geo.modelBody!.display!, geo.name, position, rotation, geo.color)
        if (geo.hidden) vp.setSTLVisible(geo.id, false)
      } catch (err) {
        // Fail LOUD (ADR-0003, Placement Composition Contract invariant 4):
        // never silently substitute identity for a missing Placement record.
        // This should not be reachable in practice (syncModelBodies seeds a
        // resolvable record the moment an item's first body appears), so
        // surfacing it loudly here -- without crashing the rest of the draw
        // loop for OTHER, healthy model bodies -- is the correct behavior if
        // it ever is.
        console.error(`INT-17C: model body "${geo.id}" (item "${itemId}") could not be drawn:`, err)
      }
    }
    // WO-2172: a Model body in a vise is drawn where the vise has it, not at its item placement.
    applyViseDrawPoses(vp)
    void applyClampDrawings(vp)
  }, [modelBodiesKey])

  // WO-2172: re-place the vise bodies whenever the vise, its opening, the
  // active setup or a component row changes, and once a File > Open scene
  // restore has finished (projectOpen returns to null).
  const viseDrawKey = useCamStore((s) => {
    const model = s.project.workholding
    if (!model?.definitions.length && !model?.instances.length) return ''
    const ids = new Set(model.definitions.flatMap((d) => d.components.map((c) => c.geometryId)))
    const rows = s.project.geometry
      .filter((g) => ids.has(g.id))
      .map((g) => [g.id, g.position, g.rotation, g.hidden ? 1 : 0, g.loaded ? 1 : 0])
    return JSON.stringify([model, s.project.activeSetupId, rows, s.projectOpen?.phase ?? null])
  })
  const lastViseDrawKey = useRef('')
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || (viseDrawKey === '' && lastViseDrawKey.current === '')) return
    lastViseDrawKey.current = viseDrawKey
    applyViseDrawPoses(vp)
    // WO-2192: placed clamps follow the same key (the model, the active setup, the shape rows).
    void applyClampDrawings(vp)
  }, [viseDrawKey])

  // Expose viewport instance globally for other components
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__cncViewport = viewportRef.current
    // Dev/test hook (Stage 2 visual gate): drive brep face/edge pick modes and
    // read back selections without UI chrome. The wizard (Stage 4) will call
    // setBrepPickMode with its own callback instead of this store wiring.
    w.__camDebug = {
      setBrepPickMode: (kind: 'face' | 'edge' | null, allowedGeoId?: string | null) => {
        const vp = viewportRef.current
        if (!vp) return
        if (!kind) {
          vp.setBrepPickMode(null)
          useCamStore.getState().setBrepSelections([])
          return
        }
        vp.setBrepPickMode(
          kind,
          (sel) => useCamStore.getState().toggleBrepSelection(sel),
          allowedGeoId ?? null
        )
      },
      getBrepSelections: () => useCamStore.getState().viewer.brepSelections,
      getGeometryIds: () =>
        useCamStore.getState().project.geometry.map((g) => ({ id: g.id, name: g.name })),
      // Stage 3 visual gate: trigger the derivation store action without UI chrome.
      deriveBrepLayer: (
        geoId: string,
        kind: 'face' | 'edges' | 'holes' | 'cylinder' | 'section',
        args?: { faceIndex?: number; edgeIndices?: number[]; faceIndices?: number[]; z?: number },
      ) => useCamStore.getState().deriveBrepLayer(geoId, kind, args),
      getLayers: (geoId: string) =>
        useCamStore.getState().project.geometry.find((g) => g.id === geoId)?.layers2d ?? [],
      partPointToScreen: (geoId: string, x: number, y: number, z: number) =>
        viewportRef.current?.partPointToScreen(geoId, { x, y, z }) ?? null,
      // Move-fix gate helper: apply a geometry transform exactly like the
      // PropertiesPanel path (store action + live viewport group). Rotation
      // values are DEGREES (house convention).
      setGeometryTransform: (
        id: string,
        pos: { x: number; y: number; z: number },
        rot: { x: number; y: number; z: number },
      ) => {
        useCamStore.getState().updateGeometryTransform(id, pos, rot)
        viewportRef.current?.setPartTransform(id, pos, rot)
      },
      // Stage 4 gate helpers. seedToolAndSetup creates the wizard PREREQUISITES
      // (a tool + a setup at WCS origin 0,0,0) that are outside Stage 4 scope;
      // the operation itself is driven through the real modal UI.
      seedToolAndSetup: () => {
        const st = useCamStore.getState()
        let toolId = st.toolLibrary[0]?.id
        if (!toolId) {
          toolId = crypto.randomUUID()
          st.addTool({
            id: toolId, name: 'Gate 6mm Flat', type: 'flat_end_mill',
            diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 50,
            numberOfFlutes: 2, toolNumber: 1, material: 'carbide', coating: 'none',
            notes: '',
            feedsAndSpeeds: {
              default: { rpm: 18000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 },
            },
          })
        }
        let setupId = st.project.setups[0]?.id
        if (!setupId) {
          setupId = crypto.randomUUID()
          st.addSetup({
            id: setupId, name: 'Gate Setup', notes: '',
            wcs: {
              id: crypto.randomUUID(), label: 'G54', fixtureOffset: 54,
              origin: { x: 0, y: 0, z: 0 },
              xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
            },
            stock: {
              type: 'rectangular', material: 'aluminum',
              offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
            },
            operations: [],
          })
        }
        useCamStore.getState().setActiveSetup(setupId)
        return { toolId, setupId }
      },
      openNewOperation: () => useCamStore.getState().openModal('new-operation'),
      getOpMoves: (opId: string) =>
        useCamStore.getState().project.setups
          .flatMap((s) => s.operations)
          .find((o) => o.id === opId)?.toolpathMoves ?? [],
      getOps: () =>
        useCamStore.getState().project.setups.flatMap((s) =>
          s.operations.map((o) => {
            const moves = o.toolpathMoves ?? []
            let minZ: number | null = null
            for (const m of moves) minZ = minZ === null || m.z < minZ ? m.z : minZ
            return {
              id: o.id, name: o.name, type: o.type, status: o.status,
              error: o.errorMessage ?? null,
              heights: o.heights, wcsZ: s.wcs.origin.z,
              nMoves: moves.length, minZ,
            }
          })
        ),
    }
  })

  // Leaving sketch mode closes any open context menu -- the COMPONENT does it, on session exit,
  // through the menu port (it opened the menu, so it closes it). No mount effect needed.

  /** WO INT-13B (spec 3.2 step 5 "stop rendering" + step 4 "unsubscribe the
   *  Sketcher tool-overlay subscription"): quiesce/revive the CAM host across a
   *  workspace switch. Suspending never disposes or rebuilds the viewport -- D1
   *  retention means the camera pose and selection survive BY not being disturbed
   *  (D3.1), so this is strictly a render/subscription gate.
   *
   *  DECLARED AFTER the mount effect ON PURPOSE: React runs a component's effects
   *  in declaration order, so by the time this first runs, the mount effect above
   *  has already constructed viewportRef.current and an initial `suspended={true}`
   *  is honored rather than silently dropped on a null ref.
   *
   *  Both CNCViewport methods are idempotent, so a re-run that does not change
   *  `suspended` is a no-op. Nothing is reattached on unmount -- dispose() cancels
   *  the loop itself. */
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    if (suspended) vp.suspendRender()
    else vp.resumeRender()
  }, [suspended])

  return (
    <ViewportContextMenuSurface rootRef={rootElRef} onOpenMenu={handleModelContextMenu}>
      <div ref={containerRef} className="viewport-canvas" />
      {/* WO-404 (Operator, 2026-08-20): the 'CAM grid: <plane> | <WCS> Z<offset>' badge that sat
          bottom-left here was removed - it has no utility in the CAM/setup view. The support
          plane still drives the grid itself (activeSetupSupportPlane above). */}
      <ViewportOverlay interactionMode={interactionMode} />
      {/* WO SKC-14C: eight named sketch overlays and a context-menu `useState` used to sit here.
          The package renders all of them from one port; this mount draws no sketch DOM. The
          Fragment inside preserves the exact sibling order app.css positions against. */}
      <SketcherOverlays port={camOverlaysPort} />
      <ReferenceImage2dScene host={referenceHost} active={!suspended && viewer.mode === 'sketch'} />
      {/* WO INT-13B (D1.3 + spec 3.2 step 6): the cube takes CAM's camera as a
          PROP (no window.__cncViewport read), and the SUSPENDED workspace's cube
          is UNMOUNTED rather than hidden -- unmounting is what runs ViewCube's
          own cleanup (cancelAnimationFrame + renderer.dispose), which is what
          actually returns the WebGL context to the browser and brings the D1.1
          budget from 4 peak to 3 steady. `display:none` would keep the context
          live and blow the budget the B1 gate measures. */}
      {!suspended && <ViewCube camera={cubeCamera} />}
      <DisplayModeControl />
      <SimulationPanel />
      <DeviationPanel onOverlay={showDeviation} />
      <ViewportToolbar
        viewport={viewportRef}
        interactionMode={interactionMode}
        onEnterLayOnFace={handleEnterLayOnFace}
        onExitLayOnFace={handleExitLayOnFace}
        onEnterProjectPlane={handleEnterProjectPlane}
        onExitProjectPlane={handleExitProjectPlane}
      />
      {/* WO-1586: re-hosted from WO-1574's mounted-nowhere modal. Renders
          nothing until the Properties panel's Workholding row opens it. */}
      <SeatInViseStrip />
      {/* WO-2192: the clamp placer - nothing until placing clamps starts. */}
      <ClampPlacer />
      {contextMenu && (
        <ViewportContextMenu
          at={contextMenu.at}
          target={contextMenu.target}
          visibility={{
            stock: viewer.showStock,
            workpiece: viewer.showWorkpiece,
            toolpath: viewer.showToolpath,
            grid: viewer.showGrid,
          }}
          onAction={handleViewportContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </ViewportContextMenuSurface>
  )
}
