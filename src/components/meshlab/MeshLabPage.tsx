// WO INT-3 (GATE M3 Mesh Shop): standalone diagnostic/demo lab, mirroring INT-1/INT-2's
// query-param lab pattern (?meshlab=1, see App.tsx) -- wires the merged src/mesh facade
// (MSH-1 import/repair/export/measure + MSH-2 boolean/planeCut/hollow/decimate) into a
// user-drivable surface: import a real STL, see an honest repair report, combine two loaded
// meshes with a boolean, cut with a live plane, hollow with a wall-thickness input, decimate,
// export STL + 3MF. Every op shows real numbers (triangle count, elapsed ms) -- never a canned
// or precomputed value.
//
// Two injection points, same convention as Lab3DView/Sketch3dLabPage:
//  1. `createClient` -- defaults to the real worker-backed MeshClient (createMeshClient);
//     tests inject a fake that never spawns a real Worker or loads wasm.
//  2. `createSceneRuntime` -- reused UNCHANGED from src/components/model3d/sceneRuntime.ts (no
//     section/pick features needed here, just renderer+camera+orbit+frameBox).
import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createDefaultSceneRuntime, type CreateSceneRuntime, type SceneRuntime } from '../model3d/sceneRuntime'
import { createMeshClient, type MeshClient } from './meshClient'
import { cloneMesh, cloneTess, hollowGuardMessage, weldByPosition } from './meshWiring'
import { createGeomOperandClient, type BrepPrimitiveShape, type BuiltBrepOperand, type GeomOperandClient } from './geomOperand'
import { export3mf, import3mf } from './threeMf'
import { brepOperand, meshOperand } from '../../mesh'
import type {
  MeshBooleanOperation,
  MeshBuffers,
  MeshHealthReport,
  MeshMeasureResult,
  MeshPlaneCutKeep,
  Vec3,
} from '../../mesh'
import { saveFile } from '../../lib/saveFile'

export interface MeshLabPageProps {
  createClient?: () => MeshClient
  createSceneRuntime?: CreateSceneRuntime
  /** MSH-4: injectable source for the tessellated-brep operand builder -- defaults to the real
   *  createLocalGeomService-backed client (real occt-wasm kernel, no Worker). Tests inject a fake
   *  that never loads real wasm. */
  createGeomOperand?: () => GeomOperandClient
}

type SlotKey = 'primary' | 'secondary'
type PlaneAxis = 'x' | 'y' | 'z'

interface MeshSlot {
  mesh: MeshBuffers
  name: string
  report: MeshHealthReport
  measures: MeshMeasureResult
}

interface LastOp {
  name: string
  ms: number
  triangleCount: number
}

interface RepairSummary {
  filledHoleCount: number
  droppedDegenerateTriangleCount: number
  /** WO-1453: triangles repair re-oriented. */
  flippedTriangleCount: number
  watertightAfter: boolean
  /** WO-1453: winding-conflict edges remaining after repair (0 = consistently wound). */
  windingConflictAfter: number
}

/** MSH-4: the currently-built brep operand, ready to feed a cross-domain boolean. Carries the
 *  tolerance it was tessellated at alongside the raw buffers (BuiltBrepOperand itself does not --
 *  see geomOperand.ts -- brepOperand() needs the tolerance value separately). */
interface BrepOperandState extends BuiltBrepOperand {
  tolerance: number
}

/** MSH-4: honest-labeling readout for the last cross-domain boolean (WO ruling 2) -- always shown
 *  alongside the ordinary lastOp line, never folded into it, so `approximate`/tolerance stay
 *  plainly visible regardless of what the terse lastOp status string says. */
interface CrossDomainSummary {
  operation: MeshBooleanOperation
  brepShape: BrepPrimitiveShape
  approximate: boolean
  tessellationTolerance: number | null
  triangleCount: number
  watertight: boolean
  volume: number
  ms: number
}

interface ExportSummary {
  kind: 'stl' | '3mf'
  bytes: number
  ms: number
  /** Raw exported face count (mesh.indices.length / 3 at export time) -- NOT necessarily equal
   *  to the health panel's analyzed-good-triangle count; see analyzedTriangleCount. */
  exportedFaceCount: number
  /** The primary health report's triangleCount (analyzed GOOD triangles) at the moment of
   *  export, so a viewer can see when the two disagree instead of assuming they match. */
  analyzedTriangleCount: number
  reimportOk: boolean
}

/** Test/e2e-only seam (mirrors Lab3DView's __lab3dTestHooks / Sketch3dLabPage's
 *  __sketch3dlabTestHooks) -- a plain serializable snapshot, refreshed on every state change a
 *  driver would care about, so a Playwright script (or a jsdom test) can assert real numbers
 *  without re-deriving them from the DOM. */
export interface MeshLabSnapshot {
  status: string
  busy: boolean
  primary: { name: string; triangleCount: number; watertight: boolean; holeCount: number } | null
  secondary: { name: string; triangleCount: number; watertight: boolean; holeCount: number } | null
  lastOp: LastOp | null
  repairResult: RepairSummary | null
  exportResult: ExportSummary | null
  opError: string | null
  /** MSH-4: geom-kernel status line for the brep-operand builder (separate lifecycle from the
   *  mesh kernel's own `status`). */
  geomStatus: string
  brepOperand: { shape: BrepPrimitiveShape; triangleCount: number; tolerance: number; ms: number } | null
  crossDomainResult: CrossDomainSummary | null
}

declare global {
  interface Window {
    __meshlabSnapshot?: MeshLabSnapshot
  }
}

const AXIS_VECTORS: Record<PlaneAxis, Vec3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

const SLOT_COLOR: Record<SlotKey, number> = {
  primary: 0x4a90d9,
  secondary: 0xd98a3e,
}

function buildGeometry(mesh: MeshBuffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
  geometry.computeVertexNormals()
  return geometry
}

function healthLine(label: string, slot: MeshSlot | null): string {
  if (slot === null) return `${label}: (empty)`
  const r = slot.report
  return (
    `${label}: "${slot.name}" -- ${r.triangleCount.toLocaleString()} tris, ` +
    `${r.watertight ? 'watertight' : `NOT watertight (${r.holeCount} hole(s), ${r.boundaryEdgeCount} boundary edges)`}` +
    (r.nonManifoldEdgeCount > 0 ? `, ${r.nonManifoldEdgeCount} non-manifold edges` : '') +
    (r.degenerateTriangleCount > 0 ? `, ${r.degenerateTriangleCount} degenerate tris` : '') +
    (r.duplicateTriangleCount > 0 ? `, ${r.duplicateTriangleCount} duplicate tris` : '') +
    (r.windingConflictEdgeCount > 0 ? `, ${r.windingConflictEdgeCount} winding conflict edges` : '')
  )
}

/** Best-effort browser download -- jsdom (component tests) has no URL.createObjectURL, and the
 *  export's actual proof (bytes non-empty + re-importable, asserted by the caller BEFORE this
 *  runs) does not depend on the download mechanism succeeding, so a missing API here is not
 *  treated as an op failure. */
function triggerDownload(bytes: ArrayBuffer, filename: string, mimeType: string): void {
  if (typeof URL.createObjectURL !== 'function') return
  void saveFile(filename, new Blob([bytes], { type: mimeType }), mimeType)
}

export function MeshLabPage({
  createClient = createMeshClient,
  createSceneRuntime = createDefaultSceneRuntime,
  createGeomOperand = createGeomOperandClient,
}: MeshLabPageProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const runtimeRef = useRef<SceneRuntime | null>(null)
  const clientRef = useRef<MeshClient | null>(null)
  // MSH-4: lazily created on first "Build brep operand" click -- never eagerly at mount, so the
  // lab's initial paint doesn't pay for a second (occt-wasm) kernel load nobody asked for yet.
  const geomClientRef = useRef<GeomOperandClient | null>(null)
  const objectsRef = useRef<Map<SlotKey, THREE.Mesh>>(new Map())
  const mountedRef = useRef(true)

  const [status, setStatus] = useState('initializing mesh kernel...')
  const [busy, setBusy] = useState(false)
  const [primary, setPrimary] = useState<MeshSlot | null>(null)
  const [secondary, setSecondary] = useState<MeshSlot | null>(null)
  const [lastOp, setLastOp] = useState<LastOp | null>(null)
  const [repairResult, setRepairResult] = useState<RepairSummary | null>(null)
  const [exportResult, setExportResult] = useState<ExportSummary | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [opError, setOpError] = useState<string | null>(null)

  const [booleanOp, setBooleanOp] = useState<MeshBooleanOperation>('union')
  const [planeAxis, setPlaneAxis] = useState<PlaneAxis>('z')
  const [planeOffset, setPlaneOffset] = useState(0)
  const [planeKeep, setPlaneKeep] = useState<MeshPlaneCutKeep>('positive')
  const [hollowThickness, setHollowThickness] = useState(1)
  const [decimateTarget, setDecimateTarget] = useState(2000)

  // --- MSH-4: cross-domain boolean (mesh vs tessellated brep) -----------------------------
  const [geomStatus, setGeomStatus] = useState('brep kernel: not loaded')
  const [geomBuilding, setGeomBuilding] = useState(false)
  const [brepShape, setBrepShape] = useState<BrepPrimitiveShape>('box')
  const [brepBoxX, setBrepBoxX] = useState(10)
  const [brepBoxY, setBrepBoxY] = useState(10)
  const [brepBoxZ, setBrepBoxZ] = useState(10)
  const [brepCylRadius, setBrepCylRadius] = useState(5)
  const [brepCylHeight, setBrepCylHeight] = useState(10)
  const [brepTolerance, setBrepTolerance] = useState(0.1)
  const [brepOperandState, setBrepOperandState] = useState<BrepOperandState | null>(null)
  const [brepError, setBrepError] = useState<string | null>(null)
  const [crossDomainOp, setCrossDomainOp] = useState<MeshBooleanOperation>('difference')
  const [crossDomainResult, setCrossDomainResult] = useState<CrossDomainSummary | null>(null)

  // --- scene bootstrap -------------------------------------------------------------------
  useEffect(() => {
    // StrictMode (see main.tsx) double-invokes this effect in dev: mount -> cleanup -> mount
    // again, WITHOUT recreating the component's refs. The cleanup below sets mountedRef.current
    // to false; without this reset at the top, the SECOND (real, surviving) mount would leave
    // mountedRef.current permanently false, and every op handler below (`if
    // (!mountedRef.current) return`, `if (mountedRef.current) setBusy(false)`) would silently
    // no-op forever -- `busy` never clears and every op appears to hang. Reset here, every time
    // this effect body runs, so it always reflects "is the CURRENTLY active instance mounted".
    mountedRef.current = true
    let cancelled = false
    const canvas = canvasRef.current
    if (canvas === null) return
    const runtime = createSceneRuntime(canvas)
    runtimeRef.current = runtime
    const client = createClient()
    clientRef.current = client

    async function boot(): Promise<void> {
      try {
        setStatus('initializing manifold-3d kernel...')
        const info = await client.init({ requireManifold: true })
        if (cancelled) return
        setStatus(info.available ? `ready (manifold-3d ${info.version})` : `ready -- WARNING: ${info.warning ?? 'kernel unavailable'}`)
      } catch (err) {
        if (cancelled) return
        setStatus(`FAILED to init mesh kernel: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    void boot()

    return () => {
      cancelled = true
      mountedRef.current = false
      delete window.__meshlabSnapshot
      runtime.dispose()
      // R1.3: terminate the Worker unconditionally and immediately -- dispose() is a best-effort
      // postMessage RPC (may never resolve if the worker is unresponsive), so it must not gate
      // the actual thread-kill. StrictMode double-invokes this effect in dev; without this, the
      // FIRST worker/wasm kernel survives past its own cleanup.
      client.dispose().catch(() => {})
      client.terminate()
      // MSH-4: the geom-operand client is created lazily (first "Build brep operand" click), so it
      // may never exist -- only terminate it if it does. Same unconditional-teardown discipline as
      // the mesh client above (no wasm kernel should outlive this component).
      geomClientRef.current?.terminate()
      geomClientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createClient, createSceneRuntime])

  // --- paint a slot's mesh into the scene whenever it changes ----------------------------
  function paintSlot(key: SlotKey, mesh: MeshBuffers): void {
    const runtime = runtimeRef.current
    if (runtime === null) return
    const existing = objectsRef.current.get(key)
    const geometry = buildGeometry(mesh)
    if (existing === undefined) {
      const material = new THREE.MeshStandardMaterial({
        color: SLOT_COLOR[key],
        metalness: 0.1,
        roughness: 0.8,
        transparent: key === 'secondary',
        opacity: key === 'secondary' ? 0.55 : 1,
      })
      const meshObj = new THREE.Mesh(geometry, material)
      objectsRef.current.set(key, meshObj)
      runtime.addObject(meshObj)
    } else {
      existing.geometry.dispose()
      existing.geometry = geometry
    }
    geometry.computeBoundingBox()
    const bb = geometry.boundingBox
    if (bb !== null) runtime.frameBox(bb.min, bb.max)
    runtime.requestRender()
  }

  // --- window test/e2e snapshot -----------------------------------------------------------
  useEffect(() => {
    window.__meshlabSnapshot = {
      status,
      busy,
      primary: primary === null ? null : { name: primary.name, triangleCount: primary.report.triangleCount, watertight: primary.report.watertight, holeCount: primary.report.holeCount },
      secondary: secondary === null ? null : { name: secondary.name, triangleCount: secondary.report.triangleCount, watertight: secondary.report.watertight, holeCount: secondary.report.holeCount },
      lastOp,
      repairResult,
      exportResult,
      opError,
      geomStatus,
      brepOperand:
        brepOperandState === null
          ? null
          : { shape: brepOperandState.shape, triangleCount: brepOperandState.triangleCount, tolerance: brepOperandState.tolerance, ms: brepOperandState.ms },
      crossDomainResult,
    }
  }, [status, busy, primary, secondary, lastOp, repairResult, exportResult, opError, geomStatus, brepOperandState, crossDomainResult])

  // --- import ------------------------------------------------------------------------------
  const importFile = useCallback(async (slotKey: SlotKey, file: File) => {
    const client = clientRef.current
    if (client === null) return
    setImportError(null)
    setBusy(true)
    setStatus(`importing "${file.name}"...`)
    try {
      const bytes = await file.arrayBuffer()
      const t0 = performance.now()
      const imported = await client.importStl(bytes)
      const ms = performance.now() - t0
      if (!mountedRef.current) return
      // Weld by position BEFORE showing any health/repair state -- see meshWiring.ts's
      // weldByPosition doc: raw STL import has no shared-vertex topology, so an unwelded report
      // is meaningless (every real solid looks "100% holes").
      const welded = weldByPosition(imported.mesh)
      const report = await client.analyze(welded, { checkSelfIntersections: false })
      const measures = await client.measure(welded)
      const slot: MeshSlot = { mesh: welded, name: file.name, report, measures }
      if (slotKey === 'primary') {
        setPrimary(slot)
        // R1.1: repairResult/exportResult describe the OLD primary mesh -- a new import (even
        // reusing this same slot for an unrelated file) invalidates both, or the UI can show a
        // past export's bytes/tri-count under a mesh that never produced them.
        setRepairResult(null)
        setExportResult(null)
      } else {
        setSecondary(slot)
      }
      paintSlot(slotKey, welded)
      setLastOp({ name: `import "${file.name}"`, ms, triangleCount: report.triangleCount })
      setStatus(`imported "${file.name}": ${report.triangleCount.toLocaleString()} tris in ${ms.toFixed(0)}ms`)
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setImportError(msg)
      setStatus(`import FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // NOTE (BK-17b): the import path above calls analyze()+measure() as TWO separate worker calls
  // deliberately -- this is the ONE place the app must inspect a mesh BEFORE it has been through
  // any op/repair (which would each bundle report+measures in ONE call already). Every op result
  // and every repair result below reuses its own bundled {report, measures} and never re-calls
  // analyze()/measure() a second time for the same mesh state (see meshWiring.ts's
  // bundleFromResult doc for the full BK-17b accounting).

  const handleImportChange = useCallback(
    (slotKey: SlotKey) => (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0]
      ev.target.value = ''
      if (file === undefined) return
      void importFile(slotKey, file)
    },
    [importFile],
  )

  // --- repair --------------------------------------------------------------------------------
  const runRepair = useCallback(async () => {
    const client = clientRef.current
    if (client === null || primary === null) return
    setBusy(true)
    setOpError(null)
    setStatus('repairing...')
    try {
      const t0 = performance.now()
      const result = await client.repair(cloneMesh(primary.mesh))
      const ms = performance.now() - t0
      if (!mountedRef.current) return
      const slot: MeshSlot = { mesh: result.mesh, name: primary.name, report: result.report, measures: result.measures }
      setPrimary(slot)
      paintSlot('primary', result.mesh)
      setRepairResult({
        filledHoleCount: result.filledHoleCount,
        droppedDegenerateTriangleCount: result.droppedDegenerateTriangleCount,
        flippedTriangleCount: result.flippedTriangleCount,
        watertightAfter: result.report.watertight,
        windingConflictAfter: result.report.windingConflictEdgeCount,
      })
      // R1.1: the primary mesh just changed shape -- any prior export result no longer
      // describes what's currently loaded.
      setExportResult(null)
      setLastOp({ name: 'repair', ms, triangleCount: result.report.triangleCount })
      setStatus(`repair: filled ${result.filledHoleCount} hole(s), dropped ${result.droppedDegenerateTriangleCount} degenerate tri(s), re-oriented ${result.flippedTriangleCount} tri(s) in ${ms.toFixed(0)}ms -- ${result.report.watertight ? 'now watertight' : 'still not watertight'}, ${result.report.windingConflictEdgeCount > 0 ? `${result.report.windingConflictEdgeCount} winding conflict(s) remain` : 'winding consistent'}`)
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setOpError(msg)
      setStatus(`repair FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [primary])

  // --- boolean -------------------------------------------------------------------------------
  const runBoolean = useCallback(async () => {
    const client = clientRef.current
    if (client === null || primary === null || secondary === null) return
    setBusy(true)
    setOpError(null)
    setStatus(`boolean ${booleanOp}...`)
    try {
      const t0 = performance.now()
      const result = await client.boolean(cloneMesh(primary.mesh), cloneMesh(secondary.mesh), { operation: booleanOp })
      const ms = performance.now() - t0
      if (!mountedRef.current) return
      const slot: MeshSlot = { mesh: result.mesh, name: `${primary.name} ${booleanOp} ${secondary.name}`, report: result.report, measures: result.measures }
      setPrimary(slot)
      paintSlot('primary', result.mesh)
      // R1.1: boolean replaced the primary mesh -- neither result describes it anymore.
      setRepairResult(null)
      setExportResult(null)
      setLastOp({ name: `boolean ${booleanOp}`, ms, triangleCount: result.report.triangleCount })
      setStatus(`boolean ${booleanOp}: ${result.report.triangleCount.toLocaleString()} tris, volume ${result.measures.volume.toFixed(3)} in ${ms.toFixed(0)}ms`)
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setOpError(msg)
      setStatus(`boolean ${booleanOp} FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [primary, secondary, booleanOp])

  // --- MSH-4: cross-domain boolean (mesh vs tessellated brep) ----------------------------------
  const buildBrepOperand = useCallback(async () => {
    setBusy(true)
    setGeomBuilding(true)
    setBrepError(null)
    setGeomStatus(geomClientRef.current === null ? 'loading brep kernel (occt-wasm)...' : `building ${brepShape}...`)
    try {
      if (geomClientRef.current === null) {
        geomClientRef.current = createGeomOperand()
        await geomClientRef.current.init()
      }
      setGeomStatus(`building ${brepShape}...`)
      const built = await geomClientRef.current.buildPrimitive(
        {
          shape: brepShape,
          box: { x: brepBoxX, y: brepBoxY, z: brepBoxZ },
          cylinderRadius: brepCylRadius,
          cylinderHeight: brepCylHeight,
        },
        brepTolerance,
      )
      if (!mountedRef.current) return
      setBrepOperandState({ ...built, tolerance: brepTolerance })
      // A fresh operand invalidates any prior cross-domain result -- it described the OLD operand.
      setCrossDomainResult(null)
      setGeomStatus(`ready -- ${brepShape} tessellated at ${brepTolerance}mm: ${built.triangleCount.toLocaleString()} tris in ${built.ms.toFixed(0)}ms`)
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setBrepError(msg)
      setGeomStatus(`brep build FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) {
        setBusy(false)
        setGeomBuilding(false)
      }
    }
  }, [createGeomOperand, brepShape, brepBoxX, brepBoxY, brepBoxZ, brepCylRadius, brepCylHeight, brepTolerance])

  const runCrossDomainBoolean = useCallback(async () => {
    const client = clientRef.current
    if (client === null || primary === null || brepOperandState === null) return
    setBusy(true)
    setOpError(null)
    setStatus(`cross-domain boolean ${crossDomainOp} (brep ${brepOperandState.shape})...`)
    try {
      const left = meshOperand(cloneMesh(primary.mesh))
      const right = brepOperand(cloneTess(brepOperandState.tess), brepOperandState.tolerance)
      const t0 = performance.now()
      const result = await client.crossDomainBoolean(left, right, { operation: crossDomainOp })
      const ms = performance.now() - t0
      if (!mountedRef.current) return
      const slot: MeshSlot = {
        mesh: result.mesh,
        name: `${primary.name} X-domain-${crossDomainOp} ${brepOperandState.shape}`,
        report: result.report,
        measures: result.measures,
      }
      setPrimary(slot)
      paintSlot('primary', result.mesh)
      // R1.1: the primary mesh just changed shape -- any prior repair/export result no longer
      // describes what's currently loaded.
      setRepairResult(null)
      setExportResult(null)
      const summary: CrossDomainSummary = {
        operation: crossDomainOp,
        brepShape: brepOperandState.shape,
        approximate: result.approximate,
        tessellationTolerance: result.tessellationTolerance,
        triangleCount: result.report.triangleCount,
        watertight: result.report.watertight,
        volume: result.measures.volume,
        ms,
      }
      setCrossDomainResult(summary)
      setLastOp({ name: `cross-domain boolean ${crossDomainOp} (brep ${brepOperandState.shape})`, ms, triangleCount: result.report.triangleCount })
      setStatus(
        `cross-domain boolean ${crossDomainOp}: ${result.report.triangleCount.toLocaleString()} tris, volume ${result.measures.volume.toFixed(3)} in ${ms.toFixed(0)}ms -- ` +
          `APPROXIMATE (tessellation tolerance ${result.tessellationTolerance ?? 'n/a'}mm) -- ${result.report.watertight ? 'watertight' : 'NOT watertight'}`,
      )
    } catch (err) {
      if (!mountedRef.current) return
      // FAIL-LOUD: surface the module's own error (e.g. CrossDomainBooleanRefusedError) by name,
      // never swallowed or replaced with a generic message.
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setOpError(msg)
      setStatus(`cross-domain boolean ${crossDomainOp} FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [primary, brepOperandState, crossDomainOp])

  // --- plane cut -----------------------------------------------------------------------------
  const runPlaneCut = useCallback(async () => {
    const client = clientRef.current
    if (client === null || primary === null) return
    setBusy(true)
    setOpError(null)
    setStatus('plane cut...')
    try {
      const t0 = performance.now()
      const result = await client.planeCut(cloneMesh(primary.mesh), { normal: AXIS_VECTORS[planeAxis], offset: planeOffset, keep: planeKeep })
      const ms = performance.now() - t0
      if (!mountedRef.current) return
      // INT-3-R2: keep mode decides which side(s) replace which slot(s).
      //  - keep positive: Primary = positive (unchanged behavior).
      //  - keep negative: Primary = negative -- the facade (manifoldOps.ts planeCutMesh)
      //    returns ONLY result.negative in this mode, so Secondary must NOT be touched.
      //  - keep both: Primary = positive, Secondary = negative (explicit, not incidental).
      if (planeKeep === 'negative') {
        if (result.negative !== undefined) {
          const slot: MeshSlot = { mesh: result.negative.mesh, name: `${primary.name} (cut-)`, report: result.negative.report, measures: result.negative.measures }
          setPrimary(slot)
          paintSlot('primary', result.negative.mesh)
        }
      } else {
        if (result.positive !== undefined) {
          const slot: MeshSlot = { mesh: result.positive.mesh, name: `${primary.name} (cut+)`, report: result.positive.report, measures: result.positive.measures }
          setPrimary(slot)
          paintSlot('primary', result.positive.mesh)
        }
        if (result.negative !== undefined) {
          const slot: MeshSlot = { mesh: result.negative.mesh, name: `${primary.name} (cut-)`, report: result.negative.report, measures: result.negative.measures }
          setSecondary(slot)
          paintSlot('secondary', result.negative.mesh)
        }
      }
      // R1.1: the primary mesh just changed (whichever branch above ran) -- neither
      // result describes it anymore. Applies to every keep mode.
      setRepairResult(null)
      setExportResult(null)
      const triCount = (result.positive?.report.triangleCount ?? 0) + (result.negative?.report.triangleCount ?? 0)
      setLastOp({ name: `plane cut (${planeKeep})`, ms, triangleCount: triCount })
      setStatus(`plane cut (${planeAxis}=${planeOffset}, keep ${planeKeep}) in ${ms.toFixed(0)}ms`)
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setOpError(msg)
      setStatus(`plane cut FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [primary, planeAxis, planeOffset, planeKeep])

  // --- hollow --------------------------------------------------------------------------------
  const runHollow = useCallback(async () => {
    const client = clientRef.current
    if (client === null || primary === null) return
    if (hollowGuardMessage(primary.report.triangleCount) !== null) return
    setBusy(true)
    setOpError(null)
    setStatus('hollowing (this can take several seconds)...')
    try {
      const t0 = performance.now()
      const result = await client.hollow(cloneMesh(primary.mesh), { thickness: hollowThickness })
      const ms = performance.now() - t0
      if (!mountedRef.current) return
      const slot: MeshSlot = { mesh: result.mesh, name: `${primary.name} (hollow ${hollowThickness})`, report: result.report, measures: result.measures }
      setPrimary(slot)
      paintSlot('primary', result.mesh)
      // R1.1: hollow replaced the primary mesh -- neither result describes it anymore.
      setRepairResult(null)
      setExportResult(null)
      setLastOp({ name: `hollow (wall ${hollowThickness})`, ms, triangleCount: result.report.triangleCount })
      setStatus(`hollow wall=${hollowThickness}: ${result.report.triangleCount.toLocaleString()} tris, volume ${result.measures.volume.toFixed(3)} in ${ms.toFixed(0)}ms -- ${result.report.watertight ? 'watertight' : 'NOT watertight (see M3 report: erosion is only exact on convex shapes)'}`)
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setOpError(msg)
      setStatus(`hollow FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [primary, hollowThickness])

  // --- decimate ------------------------------------------------------------------------------
  const runDecimate = useCallback(async () => {
    const client = clientRef.current
    if (client === null || primary === null) return
    setBusy(true)
    setOpError(null)
    setStatus('decimating...')
    try {
      const t0 = performance.now()
      const result = await client.decimate(cloneMesh(primary.mesh), { targetTriangleCount: decimateTarget })
      const ms = performance.now() - t0
      if (!mountedRef.current) return
      const slot: MeshSlot = { mesh: result.mesh, name: `${primary.name} (decimated)`, report: result.report, measures: result.measures }
      setPrimary(slot)
      paintSlot('primary', result.mesh)
      // R1.1: decimate replaced the primary mesh -- neither result describes it anymore.
      setRepairResult(null)
      setExportResult(null)
      setLastOp({ name: `decimate (target ${decimateTarget})`, ms, triangleCount: result.report.triangleCount })
      setStatus(`decimate target=${decimateTarget}: ${result.report.triangleCount.toLocaleString()} tris in ${ms.toFixed(0)}ms`)
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setOpError(msg)
      setStatus(`decimate FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [primary, decimateTarget])

  // --- export --------------------------------------------------------------------------------
  const runExportStl = useCallback(async () => {
    const client = clientRef.current
    if (client === null || primary === null) return
    setBusy(true)
    setOpError(null)
    setStatus('exporting STL...')
    try {
      const analyzedTriangleCount = primary.report.triangleCount
      const t0 = performance.now()
      const exported = await client.exportStl(cloneMesh(primary.mesh))
      const reimported = await client.importStl(exported.bytes.slice(0))
      const ms = performance.now() - t0
      const reimportOk = reimported.mesh.indices.length / 3 === exported.triangleCount
      triggerDownload(exported.bytes, primary.name.replace(/\.stl$/i, '') + '-export.stl', 'model/stl')
      if (!mountedRef.current) return
      setExportResult({ kind: 'stl', bytes: exported.bytes.byteLength, ms, exportedFaceCount: exported.triangleCount, analyzedTriangleCount, reimportOk })
      setLastOp({ name: 'export stl', ms, triangleCount: exported.triangleCount })
      setStatus(
        `exported STL: ${exported.bytes.byteLength.toLocaleString()} bytes, ${exported.triangleCount.toLocaleString()} exported faces ` +
          `(health: ${analyzedTriangleCount.toLocaleString()} analyzed good tris) in ${ms.toFixed(0)}ms, re-import ${reimportOk ? 'OK' : 'MISMATCH'}`,
      )
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setOpError(msg)
      setStatus(`export STL FAILED: ${msg}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [primary])

  const runExport3mf = useCallback(() => {
    if (primary === null) return
    setOpError(null)
    try {
      const analyzedTriangleCount = primary.report.triangleCount
      const t0 = performance.now()
      const exported = export3mf(primary.mesh)
      const reimported = import3mf(exported.bytes)
      const ms = performance.now() - t0
      const reimportOk = reimported.indices.length / 3 === exported.triangleCount
      triggerDownload(exported.bytes, primary.name.replace(/\.stl$/i, '') + '-export.3mf', 'model/3mf')
      setExportResult({ kind: '3mf', bytes: exported.bytes.byteLength, ms, exportedFaceCount: exported.triangleCount, analyzedTriangleCount, reimportOk })
      setLastOp({ name: 'export 3mf', ms, triangleCount: exported.triangleCount })
      setStatus(
        `exported 3MF: ${exported.bytes.byteLength.toLocaleString()} bytes, ${exported.triangleCount.toLocaleString()} exported faces ` +
          `(health: ${analyzedTriangleCount.toLocaleString()} analyzed good tris) in ${ms.toFixed(0)}ms, re-import ${reimportOk ? 'OK' : 'MISMATCH'}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      setOpError(msg)
      setStatus(`export 3MF FAILED: ${msg}`)
    }
  }, [primary])

  const hollowGuard = primary === null ? null : hollowGuardMessage(primary.report.triangleCount)

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
        <canvas ref={canvasRef} data-testid="meshlab-canvas" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        <div data-testid="meshlab-status" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2, padding: '6px 10px', background: 'rgba(16,20,24,0.85)', borderBottom: '1px solid #2a3540', whiteSpace: 'pre' }}>
          {status}
          {busy ? ' [busy]' : ''}
        </div>
        {importError !== null && (
          <div data-testid="meshlab-import-error" style={{ position: 'absolute', top: 32, left: 8, zIndex: 2, color: '#ff6b6b', background: 'rgba(16,20,24,0.9)', padding: '4px 8px' }}>
            {importError}
          </div>
        )}
        {opError !== null && (
          <div data-testid="meshlab-error" style={{ position: 'absolute', top: 32, left: 8, zIndex: 2, color: '#ff6b6b', background: 'rgba(16,20,24,0.9)', padding: '4px 8px' }}>
            {opError}
          </div>
        )}
        {lastOp !== null && (
          <div data-testid="meshlab-last-op" style={{ position: 'absolute', bottom: 8, left: 8, zIndex: 2, background: 'rgba(16,20,24,0.85)', border: '1px solid #2a3540', padding: '4px 8px' }}>
            last op: {lastOp.name} -- {lastOp.ms.toFixed(0)}ms -- {lastOp.triangleCount.toLocaleString()} tris
          </div>
        )}
      </div>
      <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid #2a3540', padding: 10, overflowY: 'auto', background: '#161b20' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Primary</div>
        <label style={{ display: 'block', marginBottom: 4 }}>
          Import STL:
          <input type="file" accept=".stl" data-testid="meshlab-import-primary" disabled={busy} onChange={handleImportChange('primary')} />
        </label>
        <div data-testid="meshlab-primary-health" style={{ marginBottom: 8, opacity: 0.9 }}>{healthLine('Primary', primary)}</div>

        <div style={{ fontWeight: 600, marginBottom: 4 }}>Secondary</div>
        <label style={{ display: 'block', marginBottom: 4 }}>
          Import STL:
          <input type="file" accept=".stl" data-testid="meshlab-import-secondary" disabled={busy} onChange={handleImportChange('secondary')} />
        </label>
        <div data-testid="meshlab-secondary-health" style={{ marginBottom: 8, opacity: 0.9 }}>{healthLine('Secondary', secondary)}</div>

        <hr style={{ border: 'none', borderTop: '1px solid #2a3540', margin: '8px 0' }} />

        <div style={{ fontWeight: 600, marginBottom: 4 }}>Repair (Primary)</div>
        <button type="button" data-testid="meshlab-repair" disabled={busy || primary === null} onClick={() => void runRepair()}>
          Repair
        </button>
        {repairResult !== null && (
          <div data-testid="meshlab-repair-result" style={{ marginTop: 2 }}>
            filled {repairResult.filledHoleCount} hole(s), dropped {repairResult.droppedDegenerateTriangleCount} degenerate tri(s), re-oriented {repairResult.flippedTriangleCount} tri(s) -- {repairResult.watertightAfter ? 'watertight' : 'still not watertight'}, {repairResult.windingConflictAfter > 0 ? `${repairResult.windingConflictAfter} winding conflict(s) remain` : 'winding consistent'}
          </div>
        )}

        <hr style={{ border: 'none', borderTop: '1px solid #2a3540', margin: '8px 0' }} />

        <div style={{ fontWeight: 600, marginBottom: 4 }}>Boolean (Primary op Secondary)</div>
        <select data-testid="meshlab-boolean-op" value={booleanOp} onChange={(ev) => setBooleanOp(ev.target.value as MeshBooleanOperation)}>
          <option value="union">union</option>
          <option value="difference">difference (cut)</option>
          <option value="intersect">intersect</option>
        </select>
        <button type="button" data-testid="meshlab-boolean-run" disabled={busy || primary === null || secondary === null} onClick={() => void runBoolean()}>
          Run
        </button>

        <hr style={{ border: 'none', borderTop: '1px solid #2a3540', margin: '8px 0' }} />

        <div style={{ fontWeight: 600, marginBottom: 4 }}>Cross-domain boolean (Primary op brep) -- MSH-4</div>
        <div data-testid="meshlab-geom-status" style={{ marginBottom: 4, opacity: 0.9 }}>{geomStatus}</div>
        <label style={{ display: 'block', marginBottom: 4 }}>
          brep shape:
          <select data-testid="meshlab-brep-shape" value={brepShape} onChange={(ev) => setBrepShape(ev.target.value as BrepPrimitiveShape)}>
            <option value="box">box</option>
            <option value="cylinder">cylinder</option>
          </select>
        </label>
        {brepShape === 'box' ? (
          <div style={{ marginBottom: 4 }}>
            <input type="number" data-testid="meshlab-brep-box-x" value={brepBoxX} step="1" min="0.1" onChange={(ev) => setBrepBoxX(Number(ev.target.value))} style={{ width: 50 }} />
            {' x '}
            <input type="number" data-testid="meshlab-brep-box-y" value={brepBoxY} step="1" min="0.1" onChange={(ev) => setBrepBoxY(Number(ev.target.value))} style={{ width: 50 }} />
            {' x '}
            <input type="number" data-testid="meshlab-brep-box-z" value={brepBoxZ} step="1" min="0.1" onChange={(ev) => setBrepBoxZ(Number(ev.target.value))} style={{ width: 50 }} />
            {' mm'}
          </div>
        ) : (
          <div style={{ marginBottom: 4 }}>
            r=<input type="number" data-testid="meshlab-brep-cyl-radius" value={brepCylRadius} step="0.5" min="0.1" onChange={(ev) => setBrepCylRadius(Number(ev.target.value))} style={{ width: 50 }} />
            {' h='}
            <input type="number" data-testid="meshlab-brep-cyl-height" value={brepCylHeight} step="0.5" min="0.1" onChange={(ev) => setBrepCylHeight(Number(ev.target.value))} style={{ width: 50 }} />
            {' mm'}
          </div>
        )}
        <label style={{ display: 'block', marginBottom: 4 }}>
          tessellation tolerance (mm):
          <input
            type="number"
            data-testid="meshlab-brep-tolerance"
            value={brepTolerance}
            step="0.01"
            min="0.001"
            onChange={(ev) => setBrepTolerance(Number(ev.target.value))}
            style={{ width: 70 }}
          />
        </label>
        <button type="button" data-testid="meshlab-brep-build" disabled={busy} onClick={() => void buildBrepOperand()}>
          {geomBuilding ? 'Building...' : 'Build brep operand'}
        </button>
        {brepError !== null && (
          <div data-testid="meshlab-brep-error" style={{ color: '#ff6b6b', marginTop: 2 }}>
            {brepError}
          </div>
        )}
        {brepOperandState !== null && (
          <div data-testid="meshlab-brep-operand-summary" style={{ marginTop: 2 }}>
            brep operand: {brepOperandState.shape} @ {brepOperandState.tolerance}mm tolerance -- {brepOperandState.triangleCount.toLocaleString()} tris ({brepOperandState.ms.toFixed(0)}ms)
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <select data-testid="meshlab-crossdomain-op" value={crossDomainOp} onChange={(ev) => setCrossDomainOp(ev.target.value as MeshBooleanOperation)}>
            <option value="union">union</option>
            <option value="difference">difference (cut)</option>
            <option value="intersect">intersect</option>
          </select>
          <button
            type="button"
            data-testid="meshlab-crossdomain-run"
            disabled={busy || primary === null || brepOperandState === null}
            onClick={() => void runCrossDomainBoolean()}
          >
            Run (Primary {crossDomainOp} brep)
          </button>
        </div>
        {crossDomainResult !== null && (
          <div data-testid="meshlab-crossdomain-result" style={{ marginTop: 4, padding: '4px 6px', border: '1px solid #e0a030', background: 'rgba(224,160,48,0.08)' }}>
            <strong>APPROXIMATE: {String(crossDomainResult.approximate)}</strong>
            {' -- tessellation tolerance: '}
            {crossDomainResult.tessellationTolerance === null ? 'n/a' : `${crossDomainResult.tessellationTolerance}mm`}
            <br />
            {crossDomainResult.operation} vs brep {crossDomainResult.brepShape}: {crossDomainResult.triangleCount.toLocaleString()} tris, volume{' '}
            {crossDomainResult.volume.toFixed(3)}, {crossDomainResult.watertight ? 'watertight' : 'NOT watertight'} in {crossDomainResult.ms.toFixed(0)}ms
          </div>
        )}

        <hr style={{ border: 'none', borderTop: '1px solid #2a3540', margin: '8px 0' }} />

        <div style={{ fontWeight: 600, marginBottom: 4 }}>Plane cut (Primary)</div>
        <select data-testid="meshlab-planecut-axis" value={planeAxis} onChange={(ev) => setPlaneAxis(ev.target.value as PlaneAxis)}>
          <option value="x">x</option>
          <option value="y">y</option>
          <option value="z">z</option>
        </select>
        <input
          type="number"
          data-testid="meshlab-planecut-offset"
          value={planeOffset}
          step="0.1"
          onChange={(ev) => setPlaneOffset(Number(ev.target.value))}
          style={{ width: 70 }}
        />
        <select data-testid="meshlab-planecut-keep" value={planeKeep} onChange={(ev) => setPlaneKeep(ev.target.value as MeshPlaneCutKeep)}>
          <option value="positive">keep +</option>
          <option value="negative">keep -</option>
          <option value="both">keep both</option>
        </select>
        <button type="button" data-testid="meshlab-planecut-run" disabled={busy || primary === null} onClick={() => void runPlaneCut()}>
          Cut
        </button>

        <hr style={{ border: 'none', borderTop: '1px solid #2a3540', margin: '8px 0' }} />

        <div style={{ fontWeight: 600, marginBottom: 4 }}>Hollow (Primary)</div>
        <label>
          wall thickness:
          <input
            type="number"
            data-testid="meshlab-hollow-thickness"
            value={hollowThickness}
            step="0.1"
            min="0"
            onChange={(ev) => setHollowThickness(Number(ev.target.value))}
            style={{ width: 70 }}
          />
        </label>
        <button type="button" data-testid="meshlab-hollow-run" disabled={busy || primary === null || hollowGuard !== null} onClick={() => void runHollow()}>
          Hollow
        </button>
        {hollowGuard !== null && <div data-testid="meshlab-hollow-guard" style={{ color: '#e0a030', marginTop: 2 }}>{hollowGuard}</div>}

        <hr style={{ border: 'none', borderTop: '1px solid #2a3540', margin: '8px 0' }} />

        <div style={{ fontWeight: 600, marginBottom: 4 }}>Decimate (Primary)</div>
        <label>
          target tris:
          <input
            type="number"
            data-testid="meshlab-decimate-target"
            value={decimateTarget}
            step="100"
            min="4"
            onChange={(ev) => setDecimateTarget(Number(ev.target.value))}
            style={{ width: 90 }}
          />
        </label>
        <button type="button" data-testid="meshlab-decimate-run" disabled={busy || primary === null} onClick={() => void runDecimate()}>
          Decimate
        </button>

        <hr style={{ border: 'none', borderTop: '1px solid #2a3540', margin: '8px 0' }} />

        <div style={{ fontWeight: 600, marginBottom: 4 }}>Export (Primary)</div>
        <button type="button" data-testid="meshlab-export-stl" disabled={busy || primary === null} onClick={() => void runExportStl()}>
          Export STL
        </button>
        <button type="button" data-testid="meshlab-export-3mf" disabled={primary === null} onClick={runExport3mf}>
          Export 3MF
        </button>
        {exportResult !== null && (
          <div data-testid="meshlab-export-result" style={{ marginTop: 2 }}>
            {exportResult.kind.toUpperCase()}: {exportResult.bytes.toLocaleString()} bytes, {exportResult.exportedFaceCount.toLocaleString()} exported faces
            {exportResult.exportedFaceCount !== exportResult.analyzedTriangleCount ? ` (health: ${exportResult.analyzedTriangleCount.toLocaleString()} analyzed good tris)` : ''} in{' '}
            {exportResult.ms.toFixed(0)}ms, re-import {exportResult.reimportOk ? 'OK' : 'MISMATCH'}
          </div>
        )}
      </div>
    </div>
  )
}
