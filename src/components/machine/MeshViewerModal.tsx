import { catalogChildren } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { fmtMachineLength, unitLabel } from '../../lib/ui/unitFormat'
import { useDisplayUnits } from './useDisplayUnits'
// WO-416: the flatness viewer Operator asked for. "I want a visualization of the
// flatness plane from the mesh. It should popup in a modal to look at. Review
// how this is done to visualize the flatness probed in mainsail for Klipper
// printers." (2026-08-21) - an orbitable 3D surface of the probed points,
// colored by height (blue low -> red high), with min/max/range readouts.
//
// Replaces the full-width "MESH COMPENSATION ACTIVE" banner that used to sit
// under the Control tab row (Operator, same day: "Do not ever apply a huge
// vertical pixel stealing banner across the entire screen ... Don't do that
// again"). The chip that opens this modal lives in ProgramPanel.tsx's
// existing controls row - zero new rows on the always-visible surface.
//
// Self-gates on activeModal === 'mesh-viewer', same pattern as every other
// modal (SettingsModal, ToolLibraryModal, ...): mounted unconditionally in
// App.tsx, renders null while closed.
//
// The numeric readouts (points, min/max/range/reference Z, exaggeration
// factor) are plain DOM text - they render regardless of WebGL. The 3D scene
// is the enhancement: if the environment cannot get a WebGL context (jsdom in
// tests, or a software-only sandbox), a flat top-view heatmap SVG stands in
// for it so the surface shape is still visible. Real GPU capture is what
// proves the 3D path (see the reference-driven-ui skill).

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { observeRendererDpr, rendererDpr } from '../../lib/ui/zoomDpr'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Mountain, X } from 'lucide-react'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import type { SurfaceMeshMap, SurfaceMeshSample } from '../../lib/machine/zSurfaceMesh'

/** Same probe used by WorkbenchViewCube.tsx - a throwaway canvas asks for a
 *  context and immediately hands it back (WEBGL_lose_context) rather than
 *  holding a real renderer against the browser's context budget. jsdom has no
 *  WebGL at all, so this reliably tells tests from real browsers. */
function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
    if (gl === null) return false
    ;(gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

export interface MeshViewerStats {
  pointsX: number
  pointsY: number
  minZ: number
  maxZ: number
  range: number
  referenceZ: number
  /** How many times the raw Z deviation is scaled for display, so a bow of a
   *  few hundredths of a millimeter is actually visible against a plane that
   *  may span hundreds of millimeters in X/Y. */
  exaggeration: number
}

/** Pure so it is testable and reusable without a DOM. */
export function computeMeshViewerStats(mesh: SurfaceMeshMap): MeshViewerStats {
  const zs = mesh.samples.map((s) => s.machineZ)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  const range = maxZ - minZ
  const width = mesh.bounds.maxX - mesh.bounds.minX
  const height = mesh.bounds.maxY - mesh.bounds.minY
  const planeSpan = Math.max(width, height, 1)
  // Target the exaggerated peak-to-peak bow at ~15% of the plane's largest
  // XY span, so it reads clearly without swamping the surface's real shape.
  const exaggeration = range > 1e-9 ? Math.max(1, Math.round((planeSpan * 0.15) / range)) : 1
  return { pointsX: mesh.pointsX, pointsY: mesh.pointsY, minZ, maxZ, range, referenceZ: mesh.referenceMachineZ, exaggeration }
}

// Same low/mid/high height convention the Probing tab's own mesh diagram
// already uses for measured points (app.css: .control-probe-mesh-point-done,
// data-height-level low/mid/high -> --blue-500/--role-live/--amber-400) -
// continuous here instead of three discrete bands, reusing the SAME colors
// (the default-theme hex each token resolves to) rather than inventing a new
// gradient for the same data. THREE materials cannot read CSS custom
// properties, so the values are copied literals, not a live binding.
const HEIGHT_LOW = new THREE.Color(0x4a90d9) // --blue-500
const HEIGHT_MID = new THREE.Color(0x00e5ff) // --role-live / --cyan-400
const HEIGHT_HIGH = new THREE.Color(0xffaa00) // --amber-400

/** Low -> mid -> high vertex color for a normalized 0..1 height. */
function heightColor(t: number): THREE.Color {
  const clamped = Math.min(1, Math.max(0, t))
  return clamped < 0.5
    ? HEIGHT_LOW.clone().lerp(HEIGHT_MID, clamped * 2)
    : HEIGHT_MID.clone().lerp(HEIGHT_HIGH, (clamped - 0.5) * 2)
}

/** row/column -> sample lookup, mirroring ProbingPanel's SurfaceMeshDiagram. */
function sampleGridOf(mesh: SurfaceMeshMap): Map<string, SurfaceMeshSample> {
  const grid = new Map<string, SurfaceMeshSample>()
  for (const s of mesh.samples) grid.set(`${s.row}:${s.column}`, s)
  return grid
}

function buildGeometry(mesh: SurfaceMeshMap, stats: MeshViewerStats): THREE.BufferGeometry | null {
  const grid = sampleGridOf(mesh)
  const { pointsX, pointsY } = mesh
  if (pointsX < 2 || pointsY < 2) return null
  const centerX = (mesh.bounds.minX + mesh.bounds.maxX) / 2
  const centerY = (mesh.bounds.minY + mesh.bounds.maxY) / 2
  const range = stats.range || 1

  const positions = new Float32Array(pointsX * pointsY * 3)
  const colors = new Float32Array(pointsX * pointsY * 3)
  for (let row = 0; row < pointsY; row++) {
    for (let col = 0; col < pointsX; col++) {
      const sample = grid.get(`${row}:${col}`)
      if (!sample) return null
      const i = row * pointsX + col
      const z = (sample.machineZ - stats.minZ) / range
      positions[i * 3 + 0] = sample.x - centerX
      positions[i * 3 + 1] = (sample.machineZ - stats.referenceZ) * stats.exaggeration
      positions[i * 3 + 2] = sample.y - centerY
      const c = heightColor(z)
      colors[i * 3 + 0] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
  }

  const indices: number[] = []
  for (let row = 0; row < pointsY - 1; row++) {
    for (let col = 0; col < pointsX - 1; col++) {
      const a = row * pointsX + col
      const b = a + 1
      const c = a + pointsX
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** Flat top-view heatmap - the fallback when WebGL is unavailable (jsdom
 *  tests, a software-only sandbox), and a perfectly honest reading of the
 *  same data either way. */
function HeatmapFallback({ mesh, stats }: { mesh: SurfaceMeshMap; stats: MeshViewerStats }) {
  useText('control-screens-not-probing')
  const grid = useMemo(() => sampleGridOf(mesh), [mesh])
  const range = stats.range || 1
  const cell = 100 / Math.max(mesh.pointsX, mesh.pointsY)
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      className="mesh-viewer-heatmap"
      data-testid="mesh-viewer-heatmap"
      role="img"
      aria-label={controlText('MeshViewerModal.text001')}
    >
      {Array.from({ length: mesh.pointsY }, (_, row) =>
        Array.from({ length: mesh.pointsX }, (_, col) => {
          const sample = grid.get(`${row}:${col}`)
          if (!sample) return null
          const t = (sample.machineZ - stats.minZ) / range
          const color = heightColor(t)
          return (
            <rect
              key={`${row}:${col}`}
              x={col * cell}
              // Row 0 is the -Y edge; draw it at the bottom so the heatmap
              // reads the same orientation as the 3D view (X right, Y up-screen).
              y={(mesh.pointsY - 1 - row) * cell}
              width={cell}
              height={cell}
              fill={`#${color.getHexString()}`}
            />
          )
        }),
      )}
    </svg>
  )
}

export function MeshViewerModal() {
  useText('control-screens-not-probing')
  const units = useDisplayUnits()
  const activeModal = useCamStore((s) => s.activeModal)
  const closeModal = useCamStore((s) => s.closeModal)
  const surfaceMesh = useMachineControl((s) => s.surfaceMesh)
  const open = activeModal === 'mesh-viewer'

  const mountRef = useRef<HTMLDivElement>(null)
  const [webgl] = useState(webglAvailable)

  const stats = useMemo(() => (surfaceMesh ? computeMeshViewerStats(surfaceMesh) : null), [surfaceMesh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeModal])

  useEffect(() => {
    if (!open || !webgl || !surfaceMesh || !stats) return
    const mount = mountRef.current
    if (!mount) return

    const geometry = buildGeometry(surfaceMesh, stats)
    if (!geometry) return

    const width = mount.clientWidth || 640
    const height = mount.clientHeight || 420
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x11151c)

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000)
    const spanX = surfaceMesh.bounds.maxX - surfaceMesh.bounds.minX
    const spanY = surfaceMesh.bounds.maxY - surfaceMesh.bounds.minY
    const span = Math.max(spanX, spanY, 10)
    camera.position.set(span * 0.8, span * 0.7, span * 0.9)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(rendererDpr())
    mount.appendChild(renderer.domElement)

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0.02,
    })
    const surface = new THREE.Mesh(geometry, material)
    scene.add(surface)

    const wireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 }),
    )
    scene.add(wireframe)

    scene.add(new THREE.AmbientLight(0xffffff, 0.65))
    const dir = new THREE.DirectionalLight(0xffffff, 0.9)
    dir.position.set(span, span * 1.5, span)
    scene.add(dir)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.target.set(0, 0, 0)

    let raf = 0
    const animate = () => {
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()

    const resize = () => {
      const w = mount.clientWidth || width
      const h = mount.clientHeight || height
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    const stopObservingRendererDpr = observeRendererDpr(() => {
      renderer.setPixelRatio(rendererDpr())
      resize()
    })

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      stopObservingRendererDpr()
      controls.dispose()
      geometry.dispose()
      material.dispose()
      wireframe.geometry.dispose()
      ;(wireframe.material as THREE.Material).dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, webgl, surfaceMesh, stats])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal() }}
    >
      <div
        className="modal-container mesh-viewer-modal"
        data-testid="mesh-viewer-modal"
        style={{ width: 'min(760px, calc(100vw - 32px))' }}
      >
        <div className="modal-header">
          <Mountain size={15} className="modal-header-icon" />
          <span className="modal-title">{controlText('MeshViewerModal.text002')}</span>
          <button className="modal-close-btn" onClick={closeModal} data-tooltip={controlText('MeshViewerModal.text003')} aria-label={controlText('MeshViewerModal.text004')}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body mesh-viewer-body">
          {!surfaceMesh || !stats ? (
            <div className="panel-empty" data-testid="mesh-viewer-empty">{controlText('MeshViewerModal.text005')}</div>
          ) : (
            <>
              <div className="mesh-viewer-readouts" data-testid="mesh-viewer-readouts">
                <div>
                  <span className="mesh-viewer-readout-label">{controlText('MeshViewerModal.text006')}</span>
                  <span data-testid="mesh-viewer-points">{catalogChildren(controlText('MeshViewerModal.text007', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: stats.pointsX, value2: stats.pointsY })}</span>
                </div>
                <div>
                  <span className="mesh-viewer-readout-label">{controlText('MeshViewerModal.text008')}</span>
                  <span data-testid="mesh-viewer-min-z">{fmtMachineLength(stats.minZ, units)} {unitLabel(units)}</span>
                </div>
                <div>
                  <span className="mesh-viewer-readout-label">{controlText('MeshViewerModal.text009')}</span>
                  <span data-testid="mesh-viewer-max-z">{fmtMachineLength(stats.maxZ, units)} {unitLabel(units)}</span>
                </div>
                <div>
                  <span className="mesh-viewer-readout-label">{controlText('MeshViewerModal.text010')}</span>
                  <span data-testid="mesh-viewer-range">{fmtMachineLength(stats.range, units)} {unitLabel(units)}</span>
                </div>
                <div>
                  <span className="mesh-viewer-readout-label">{controlText('MeshViewerModal.text011')}</span>
                  <span data-testid="mesh-viewer-reference-z">{fmtMachineLength(stats.referenceZ, units)} {unitLabel(units)}</span>
                </div>
                <div>
                  <span className="mesh-viewer-readout-label">{controlText('MeshViewerModal.text012')}</span>
                  <span data-testid="mesh-viewer-exaggeration">{catalogChildren(controlText('MeshViewerModal.text013', { value1: '\u0000value1\u0000' }), { value1: stats.exaggeration })}</span>
                </div>
              </div>
              <div className="mesh-viewer-scene" data-testid="mesh-viewer-scene">
                {webgl ? (
                  <div ref={mountRef} className="mesh-viewer-canvas-mount" data-testid="mesh-viewer-canvas-mount" />
                ) : (
                  <HeatmapFallback mesh={surfaceMesh} stats={stats} />
                )}
              </div>
              <div className="mesh-viewer-legend" aria-hidden="true">
                <span className="mesh-viewer-legend-swatch mesh-viewer-legend-low" />{controlText('MeshViewerModal.text014')}<span className="mesh-viewer-legend-swatch mesh-viewer-legend-high" />{controlText('MeshViewerModal.text015')}{webgl && <span className="mesh-viewer-hint">{controlText('MeshViewerModal.text016')}</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
