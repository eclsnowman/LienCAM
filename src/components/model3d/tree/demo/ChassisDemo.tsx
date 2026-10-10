// WO UI-3 evidence harness: NOT part of the production app -- a standalone
// page (see index.html/main.tsx alongside this file) proving the design-tree
// + property-dialog + gizmo framework sockets this WO builds actually work
// together, wired to the REAL geometry worker through the existing box op
// (GeomBridgeSession.createBox -- the "demo feature" the WO's ruling 1 calls
// for, since extrude/revolve dialogs are M4's INT-4 wiring, not this WO's).
// Real-GPU screenshots of this page are the WO's acceptance #3/#6 evidence.
//
// Reuses createDefaultSceneRuntime (sceneRuntime.ts, read-only reference) for
// the exact same renderer/camera/lighting bootstrap Lab3DView uses, and
// GeomBridgeSession (viewport3d, read-only reference) for the worker round
// trip -- neither file is edited by this WO.

import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createGeomService, type GeomClient } from '../../../../geom'
import type { Vec3 } from '../../../../geom/geom-service'
import { GeomBridgeSession, attachHighlightAttributes, DEFAULT_HIGHLIGHT_COLORS, type CachedBody } from '../../../../viewport3d'
import { CommandHistory, ElementMap, FeatureDag, RegenScheduler, type DagNodeSnapshot } from '../../../../doc'
import { createDefaultSceneRuntime, type CreateSceneRuntime, type SceneRuntime } from '../../sceneRuntime'
import { FeatureTree } from '../FeatureTree'
import { BoxSizeDialog } from '../../dialogs/BoxSizeDialog'
import { EditFeaturePayloadCommand } from '../../dialogs/EditFeaturePayloadCommand'
import { TranslateGizmo } from '../../gizmos/TranslateGizmo'

const FEATURE_ID = 'F1'
const INITIAL_SIZE: Vec3 = { x: 40, y: 20, z: 10 }

export interface ChassisDemoProps {
  /** Injection seam (mirrors Lab3DView's own createClient/createSceneRuntime
   *  contract) -- UI-3-R1 regression coverage for "apply commits exactly
   *  once" + "preview scale never survives Apply" drives this component
   *  with a real in-process kernel (createLocalGeomService) and a fake,
   *  WebGL-free scene runtime instead of the production defaults below. */
  createClient?: () => GeomClient
  createSceneRuntime?: CreateSceneRuntime
  /** Test-only seam: invoked once with the demo's own CommandHistory
   *  instance so a test can assert on undo-stack size directly (the demo
   *  itself never renders undo UI -- this is how UI-3-R1 finding 1's
   *  "commits exactly once per Apply" regression test observes it). */
  onHistoryReady?: (history: CommandHistory) => void
}

export function ChassisDemo({
  createClient = createGeomService,
  createSceneRuntime = createDefaultSceneRuntime,
  onHistoryReady,
}: ChassisDemoProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const runtimeRef = useRef<SceneRuntime | null>(null)
  const sessionRef = useRef<GeomBridgeSession | null>(null)
  const groupRef = useRef<THREE.Group | null>(null)
  const meshRef = useRef<THREE.Mesh | null>(null)
  const edgeLinesRef = useRef<THREE.LineSegments | null>(null)
  const registeredRef = useRef(false)

  const [dagVersion, setDagVersion] = useState(0)
  const dagRef = useRef<FeatureDag | null>(null)
  if (dagRef.current === null) {
    const dag = new FeatureDag()
    dag.insertNode({
      id: FEATURE_ID,
      kind: 'feature',
      payload: { name: 'Demo Box', size: INITIAL_SIZE, position: { x: 0, y: 0, z: 0 } },
    })
    dagRef.current = dag
  }
  const dag = dagRef.current
  const schedulerRef = useRef<RegenScheduler | null>(null)
  if (schedulerRef.current === null) schedulerRef.current = new RegenScheduler(dag, new ElementMap())
  const scheduler = schedulerRef.current
  const historyRef = useRef<CommandHistory | null>(null)
  if (historyRef.current === null) {
    historyRef.current = new CommandHistory(dag)
    onHistoryReady?.(historyRef.current)
  }
  const history = historyRef.current

  const [selectedId, setSelectedId] = useState<string | null>(FEATURE_ID)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [status, setStatus] = useState('booting...')

  const paint = useCallback((cachedBody: CachedBody) => {
    const runtime = runtimeRef.current
    const group = groupRef.current
    if (!runtime || !group) return
    // Same "populate the vertex-color attribute before the material reads
    // it" contract Lab3DView's own paintBody follows (highlight.ts requires
    // attachHighlightAttributes to run first, or vertexColors:true reads an
    // absent attribute as black).
    attachHighlightAttributes(cachedBody, DEFAULT_HIGHLIGHT_COLORS)
    if (meshRef.current === null) {
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.8 })
      const mesh = new THREE.Mesh(cachedBody.geometry, material)
      const edgeLines = new THREE.LineSegments(cachedBody.edgeGeometry, new THREE.LineBasicMaterial({ vertexColors: true }))
      meshRef.current = mesh
      edgeLinesRef.current = edgeLines
      group.add(mesh, edgeLines)
      if (!registeredRef.current) {
        runtime.registerSectionable(mesh, edgeLines)
        registeredRef.current = true
      }
    } else {
      meshRef.current.geometry = cachedBody.geometry
      edgeLinesRef.current!.geometry = cachedBody.edgeGeometry
      // The committed body from the kernel is always ground truth at 1:1
      // scale -- any lingering preview scale (set by handlePreviewSize)
      // must never survive past a real regen (UI-3-R1 finding 2).
      meshRef.current.scale.set(1, 1, 1)
      edgeLinesRef.current!.scale.set(1, 1, 1)
      runtime.syncSectionGeometry(meshRef.current)
    }
    runtime.requestRender()
  }, [])

  const rebuildKernelBody = useCallback(
    async (size: Vec3): Promise<void> => {
      const session = sessionRef.current
      if (!session) return
      await session.disposeBody(FEATURE_ID)
      await session.createBox(FEATURE_ID, { featureId: FEATURE_ID, size })
      await session.tessellateProgressive(FEATURE_ID, (_phase, body) => paint(body))
    },
    [paint],
  )

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return
    const runtime = createSceneRuntime(canvas)
    runtimeRef.current = runtime
    const group = new THREE.Group()
    groupRef.current = group
    runtime.addObject(group)

    const client: GeomClient = createClient()
    const session = new GeomBridgeSession(client)
    sessionRef.current = session

    async function boot(): Promise<void> {
      setStatus('initializing geometry kernel...')
      await session.init((pct, phase) => setStatus(`init: ${phase} ${pct}%`))
      if (cancelled) return
      setStatus('creating demo box...')
      await rebuildKernelBody(INITIAL_SIZE)
      if (cancelled) return
      setStatus('ready')
    }
    void boot()

    return () => {
      cancelled = true
      runtime.dispose()
      void session.disposeAllBodies().catch(() => undefined)
    }
    // Mount-once bootstrap effect (mirrors Lab3DView's own contract).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The dialog already executed EditFeaturePayloadCommand once (its own
  // Apply handler) before calling onApplied -- this handler must NOT
  // execute a second command for the same click (UI-3-R1 finding 1). It
  // only regenerates from the payload the DAG already committed.
  const handleApplied = useCallback(async () => {
    setDagVersion((v) => v + 1)
    scheduler.markDirty(FEATURE_ID)
    await scheduler.run(async (n: DagNodeSnapshot) => {
      const s = (n.payload.size as Vec3 | undefined) ?? INITIAL_SIZE
      await rebuildKernelBody(s)
      return { ok: true, diagnostics: [] }
    })
    setDagVersion((v) => v + 1)
  }, [scheduler, rebuildKernelBody])

  const handlePreviewSize = useCallback((size: Vec3) => {
    const mesh = meshRef.current
    if (!mesh) return
    // Cheap three.js-only preview (architect ruling 1: "cheap and honest",
    // same precedent as the section-plane control) -- no kernel call until
    // Apply commits the real regen.
    mesh.scale.set(size.x / INITIAL_SIZE.x, size.y / INITIAL_SIZE.y, size.z / INITIAL_SIZE.z)
    if (edgeLinesRef.current) edgeLinesRef.current.scale.copy(mesh.scale)
    runtimeRef.current?.requestRender()
  }, [])

  const handleCancelPreview = useCallback(() => {
    meshRef.current?.scale.set(1, 1, 1)
    edgeLinesRef.current?.scale.set(1, 1, 1)
    runtimeRef.current?.requestRender()
  }, [])

  const handleGizmoCommit = useCallback(
    (position: { x: number; y: number; z: number }) => {
      const node = dag.getNode(FEATURE_ID)
      history.execute(new EditFeaturePayloadCommand(FEATURE_ID, { ...(node?.payload ?? {}), position }))
      setDagVersion((v) => v + 1)
    },
    [dag, history],
  )

  return (
    <div
      data-testid="chassis-demo-root"
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
        <canvas ref={canvasRef} data-testid="chassis-canvas" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        <div
          data-testid="chassis-status"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '6px 10px', background: 'rgba(16,20,24,0.85)' }}
        >
          {status}
        </div>
      </div>
      <div style={{ width: 300, flexShrink: 0, borderLeft: '1px solid var(--border-subtle, #2a3540)', padding: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Design tree</div>
        <FeatureTree
          key={dagVersion}
          dag={dag}
          scheduler={scheduler}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
        />
        <button
          type="button"
          data-testid="chassis-edit-size"
          disabled={selectedId !== FEATURE_ID}
          onClick={() => setDialogOpen(true)}
          className="modal-btn modal-btn-ghost"
          style={{ marginTop: 12 }}
        >
          Edit size...
        </button>
      </div>
      {dialogOpen && (
        <BoxSizeDialog
          dag={dag}
          history={history}
          featureId={FEATURE_ID}
          onPreview={handlePreviewSize}
          onCancelPreview={handleCancelPreview}
          onApplied={() => void handleApplied()}
          onClose={() => setDialogOpen(false)}
        />
      )}
      {runtimeRef.current && groupRef.current && canvasRef.current && (
        <TranslateGizmo
          scene={runtimeRef.current.scene}
          camera={runtimeRef.current.camera}
          domElement={canvasRef.current}
          target={selectedId === FEATURE_ID ? groupRef.current : null}
          onCommit={handleGizmoCommit}
        />
      )}
    </div>
  )
}
