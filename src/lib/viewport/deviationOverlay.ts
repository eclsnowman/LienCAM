import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, type Object3D } from 'three'
import type { DeviationKind, DeviationResult } from '../simulation/deviationComparison'

export const DEVIATION_COLORS: Readonly<Record<DeviationKind, string>> = Object.freeze({
  gouge: '#ed5571', residual: '#f4a340', match: '#45c99a', 'possible-residual': '#e3c65b', unknown: '#8894a7',
})
/** Isolated mesh; no stock/trail material or visibility changes. Overlay at
 * intended surface (or known envelope for unknown target) shows missing stock
 * even when the remaining surface is below the target. */
export function createDeviationOverlay(result: DeviationResult, opacity: number, scaleMm: number) {
  const positions: number[] = [], colors: number[] = []
  for (const cell of result.cells) {
    const z = cell.targetZ ?? cell.stockZ
    if (!Number.isFinite(z)) continue
    const color = new Color(DEVIATION_COLORS[cell.kind])
    if (cell.upperMm !== null && cell.kind !== 'unknown' && cell.kind !== 'possible-residual') {
      color.lerp(new Color('#ffffff'), 0.45 * (1 - Math.min(1, Math.abs(cell.upperMm) / Math.max(0.001, scaleMm))))
    }
    const x1 = cell.x + cell.width, y1 = cell.y + cell.height
    positions.push(cell.x, cell.y, z, x1, cell.y, z, x1, y1, z, cell.x, cell.y, z, x1, y1, z, cell.x, y1, z)
    for (let i = 0; i < 6; i++) colors.push(color.r, color.g, color.b)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  const material = new MeshBasicMaterial({ vertexColors: true, transparent: true,
    opacity: Math.max(0, Math.min(1, opacity)), side: DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const mesh = new Mesh(geometry, material)
  mesh.name = 'simulation-deviation-overlay'
  mesh.renderOrder = 5
  mesh.raycast = () => {} // Diagnostic must never intercept part picking.
  return mesh
}
export function attachDeviationOverlay(scene: Object3D, result: DeviationResult, opacity: number, scaleMm: number): () => void {
  const mesh = createDeviationOverlay(result, opacity, scaleMm)
  scene.add(mesh)
  return () => { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose() }
}
