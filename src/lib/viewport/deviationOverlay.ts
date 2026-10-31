import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, SRGBColorSpace, type Object3D } from 'three'
import type { DeviationKind, DeviationResult } from '../simulation/deviationComparison'

/** WO-3096 colour round (owner 2026-10-23 12:52 PM: "highly contrasting vibrant
 * colors"): fully saturated hues far from the light-blue simulated stock
 * (--vp-sim-mesh) and from each other; unknown is a neutral grey. */
export const DEVIATION_COLORS: Readonly<Record<DeviationKind, string>> = Object.freeze({
  gouge: '#ff1a4b', residual: '#ff7a00', match: '#00e000', 'possible-residual': '#f2e600', unknown: '#9e9e9e',
})
/** Isolated mesh; no stock/trail material or visibility changes. WO-3096: the
 * colours lie on the uppermost of the final stock and the intended surface.
 * Drawn at the intended surface alone, every excess cell sat under the
 * simulated stock and the operator saw plain blue stock. */
export function createDeviationOverlay(result: DeviationResult, opacity: number, scaleMm: number) {
  const positions: number[] = [], colors: number[] = [], hsl = { h: 0, s: 0, l: 0 }
  // On whichever surface is uppermost: excess on the remaining stock, a gouge
  // on the part surface where material is missing (the part would hide it
  // drawn at the cut). Half a cell above that: the simulator's own heightmap
  // meshes the same surface at its own resolution and, on a slope, sits up to
  // about that much higher, which would bury the colours under the stock.
  const heights = result.cells.map(cell => {
    const stock = Number.isFinite(cell.stockZ) ? cell.stockZ : null
    const top = stock === null ? cell.targetZ : cell.targetZ === null ? stock : Math.max(stock, cell.targetZ)
    return (top ?? NaN) + Math.min(cell.width, cell.height) / 2
  })
  // Colour round: flat terraces left their risers open on a slope (the domed
  // knob top), and the blue stock showed between them. Neighbouring cells meet
  // at a shared corner height - the highest of the cells at that corner within
  // two cells of this one's height, so a real wall is never bridged.
  const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`
  const corners = new Map<string, number[]>()
  result.cells.forEach((cell, k) => {
    if (!Number.isFinite(heights[k])) return
    for (const [x, y] of [[cell.x, cell.y], [cell.x + cell.width, cell.y], [cell.x + cell.width, cell.y + cell.height], [cell.x, cell.y + cell.height]]) {
      const id = key(x, y), list = corners.get(id)
      if (list) list.push(heights[k]); else corners.set(id, [heights[k]])
    }
  })
  for (const [k, cell] of result.cells.entries()) {
    const z = heights[k]
    if (!Number.isFinite(z)) continue
    const join = 2 * Math.min(cell.width, cell.height)
    const at = (x: number, y: number) => (corners.get(key(x, y)) ?? []).reduce((top, h) => Math.abs(h - z) <= join ? Math.max(top, h) : top, z)
    const color = new Color(DEVIATION_COLORS[cell.kind])
    // WO-3096: within tolerance reads solid green; excess and gouge pale toward
    // white as they shrink, so the colour scale shows how far off a cell is -
    // at most a third of the way in display (sRGB) lightness, hue and
    // saturation kept, so the smallest still reads vivid.
    if (cell.upperMm !== null && (cell.kind === 'residual' || cell.kind === 'gouge')) {
      const pale = 0.33 * (1 - Math.min(1, Math.abs(cell.upperMm) / Math.max(0.001, scaleMm)))
      color.getHSL(hsl, SRGBColorSpace)
      color.setHSL(hsl.h, hsl.s, hsl.l + (1 - hsl.l) * pale, SRGBColorSpace)
    }
    const x1 = cell.x + cell.width, y1 = cell.y + cell.height
    const z00 = at(cell.x, cell.y), z10 = at(x1, cell.y), z11 = at(x1, y1), z01 = at(cell.x, y1)
    positions.push(cell.x, cell.y, z00, x1, cell.y, z10, x1, y1, z11, cell.x, cell.y, z00, x1, y1, z11, cell.x, y1, z01)
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
