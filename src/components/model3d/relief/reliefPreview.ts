// Relief - the live 3D preview on the part (docs/design/IMAGE-RELIEF-PLAN.md
// section 3: "a displaced grid drawn on the GPU - instant, never touches the
// kernel"; RELIEF-WHAT-GOOD-LOOKS-LIKE.md S9-S11).
//
// A 512 x 512 grid over the relief rectangle, displaced in its vertex shader:
//   - live (while a control moves): the adjusted picture is the texture and
//     depth / zero plane / invert / base / Raise-Cut in / step-downs are uniforms, so a
//     slider drag redraws without touching a vertex (S9);
//   - settled (a moment after it stops): the texture holds the APPLIED
//     surface's heights (the exact face's poles evaluated at every grid
//     vertex, reliefHeights.previewHeightsFromPoles), so what is seen is what
//     Apply builds (S10).
// The owner body's face is clipped away inside the rectangle so the relief
// (raised or cut in) shows in its place. Studio light (S11): the preview's own
// shading is scaled by a raking light from the picture's upper left at 35 deg
// (the standard's renders), relative to how that light falls on the flat face -
// so the flat face looks as the part does and every slope reads, terraces and
// grain included, before cutting. The material is a modelled-body material, so
// the Zebra display works on it.

import * as THREE from 'three'
import { createModeledBodyMaterial } from '../../../lib/viewport/lighting/bodyVisualStyle'
import type { ReliefFrame, ReliefSettings } from '../../../relief/reliefHeights'

export interface ReliefPreviewHost {
  addObject(o: THREE.Object3D): void
  removeObject(o: THREE.Object3D): void
  requestRender(): void
}

/** Grid cells per side of the 3D preview (S9: 512 x 512). */
export const RELIEF_PREVIEW_CELLS = 512

/** The light's elevation above the face (S11: 30-40 deg). */
export const RELIEF_LIGHT_ELEVATION_DEG = 35

const EDGE_EPS_MM = 0.01

export class ReliefPreview {
  readonly group = new THREE.Group()
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshStandardMaterial
  private readonly uniforms = {
    reliefMode: { value: 0 },
    reliefN: { value: RELIEF_PREVIEW_CELLS },
    reliefInvert: { value: 0 },
    reliefZero: { value: 0 },
    reliefDepth: { value: 1 },
    reliefBase: { value: 0 },
    reliefSign: { value: 1 },
    // WO-2216: 'cut' with this on is Emboss (the subject stays at the face, the rest cuts to the depth)
    reliefEmboss: { value: 0 },
    // WO-2174 step-downs, live: 0 off, 1 N levels, 2 fixed step (drafted walls show once the preview settles)
    reliefStepMode: { value: 0 },
    reliefStepLevels: { value: 5 },
    reliefStepMm: { value: 1 },
    reliefLightView: { value: new THREE.Vector3(0, 0, 1) },
    reliefFlatShade: { value: 1 },
  }
  private readonly lightWorld = new THREE.Vector3(0, 0, 1)
  private liveTexture: THREE.DataTexture | null = null
  private liveSource: Float32Array | null = null
  private settledTexture: THREE.DataTexture | null = null
  private clipped: Array<{ material: THREE.Material; planes: THREE.Plane[] | null; intersection: boolean }> = []
  private readonly clipPlanes = Array.from({ length: 5 }, () => new THREE.Plane())
  private readonly host: ReliefPreviewHost

  constructor(host: ReliefPreviewHost) {
    this.host = host
    const n = RELIEF_PREVIEW_CELLS
    const geometry = new THREE.PlaneGeometry(1, 1, n, n)
    geometry.translate(0.5, 0.5, 0)
    this.material = createModeledBodyMaterial({ color: 0xd9dee6 })
    this.material.flatShading = true
    this.material.polygonOffset = true
    this.material.polygonOffsetFactor = -1
    this.material.polygonOffsetUnits = -2
    // a placeholder so the displacement code compiles in; replaced by the live / settled textures
    this.material.displacementMap = this.placeholder()
    const uniforms = this.uniforms
    const previous = this.material.onBeforeCompile
    this.material.onBeforeCompile = (shader, renderer) => {
      previous.call(this.material, shader, renderer)
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform float reliefMode;
uniform float reliefN;
uniform float reliefInvert;
uniform float reliefZero;
uniform float reliefDepth;
uniform float reliefBase;
uniform float reliefSign;
uniform float reliefEmboss;
uniform float reliefStepMode;
uniform float reliefStepLevels;
uniform float reliefStepMm;`)
        .replace('#include <displacementmap_vertex>', `#ifdef USE_DISPLACEMENTMAP
  float reliefH;
  if ( reliefMode > 0.5 ) {
    reliefH = texture2D( displacementMap, ( uv * reliefN + 0.5 ) / ( reliefN + 1.0 ) ).x;
  } else {
    float rv = texture2D( displacementMap, vec2( uv.x, 1.0 - uv.y ) ).x;
    rv = reliefInvert > 0.5 ? 1.0 - rv : rv;
    float rt = clamp( ( rv - reliefZero ) / max( 1.0 - reliefZero, 1e-6 ), 0.0, 1.0 );
    // WO-2216 Emboss: the subject (high rt) lands at the face, everything else at the depth - the mirror of Engrave
    rt = reliefEmboss > 0.5 ? 1.0 - rt : rt;
    float rh = reliefDepth * rt;
    // step-downs: anything above the zero plane stands at least one floor up (reliefHeights.stepPlan)
    if ( reliefStepMode > 1.5 ) rh = min( reliefStepMm * ceil( rh / reliefStepMm - 1e-6 ), reliefDepth );
    else if ( reliefStepMode > 0.5 ) rh = reliefDepth * max( ceil( rt * reliefStepLevels - 1e-6 ), 0.0 ) / reliefStepLevels;
    reliefH = reliefSign * ( reliefBase + rh );
  }
  float reliefEdge = step( 0.5 / reliefN, min( min( uv.x, uv.y ), min( 1.0 - uv.x, 1.0 - uv.y ) ) );
  transformed += normalize( objectNormal ) * reliefH * reliefEdge;
#endif`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 reliefLightView;
uniform float reliefFlatShade;`)
        .replace('#include <opaque_fragment>', `outgoingLight *= ( 0.12 + 0.88 * max( dot( normal, reliefLightView ), 0.0 ) ) / reliefFlatShade;
#include <opaque_fragment>`)
    }
    const previousKey = this.material.customProgramCacheKey
    this.material.customProgramCacheKey = () => `${previousKey.call(this.material)}|relief-preview`
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.matrixAutoUpdate = false
    this.mesh.frustumCulled = false
    this.mesh.name = 'relief-preview'
    this.mesh.userData.reliefPreview = true
    // the raking light, in the camera's frame for this draw
    const view = new THREE.Vector3()
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      view.copy(this.lightWorld).transformDirection(camera.matrixWorldInverse)
      this.uniforms.reliefLightView.value.copy(view)
    }
    this.group.name = 'relief-preview-group'
    this.group.add(this.mesh)
    this.group.visible = false
    host.addObject(this.group)
  }

  private renderQueued = false
  private disposed = false
  /** One draw per frame however many controls moved (the host draws at once when asked). */
  private render(): void {
    if (this.renderQueued) return
    this.renderQueued = true
    const draw = () => { this.renderQueued = false; if (!this.disposed) this.host.requestRender() }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw)
    else draw()
  }

  private placeholder(): THREE.DataTexture {
    const t = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType)
    t.needsUpdate = true
    return t
  }

  /** Where the relief sits: the rectangle's frame (low corner, turned axes, size). */
  setPlacement(frame: ReliefFrame): void {
    const { origin: o, xDir: x, yDir: y, normal: n, widthMm: w, heightMm: h } = frame
    this.mesh.matrix.set(
      x.x * w, y.x * h, n.x, o.x,
      x.y * w, y.y * h, n.y, o.y,
      x.z * w, y.z * h, n.z, o.z,
      0, 0, 0, 1,
    )
    this.mesh.matrixWorldNeedsUpdate = true
    // S11: studio light from the picture's upper left, 35 deg above the face
    const el = (RELIEF_LIGHT_ELEVATION_DEG * Math.PI) / 180
    const k = Math.cos(el) / Math.SQRT2
    const s = Math.sin(el)
    this.lightWorld.set(k * (-x.x + y.x) + s * n.x, k * (-x.y + y.y) + s * n.y, k * (-x.z + y.z) + s * n.z).normalize()
    this.uniforms.reliefFlatShade.value = 0.12 + 0.88 * s
    this.group.visible = true
    this.render()
  }

  /** Live mode: the adjusted picture (row 0 = top) with the height controls as uniforms. */
  setLive(adjusted: Float32Array, cols: number, rows: number, s: ReliefSettings): void {
    if (this.liveSource !== adjusted) {
      this.liveTexture?.dispose()
      // the 512-cell grid reads no finer than 1024 texels a side: a big picture is averaged down first (a quarter of the upload)
      const small = shrinkForLive(adjusted, cols, rows)
      const t = new THREE.DataTexture(small.data, small.cols, small.rows, THREE.RedFormat, THREE.FloatType)
      t.minFilter = THREE.LinearFilter
      t.magFilter = THREE.LinearFilter
      t.needsUpdate = true
      this.liveTexture = t
      this.liveSource = adjusted
    }
    this.uniforms.reliefInvert.value = s.invert ? 1 : 0
    this.uniforms.reliefZero.value = Math.min(Math.max(s.zeroPlane, 0), 0.99)
    this.uniforms.reliefDepth.value = s.depthMm
    this.uniforms.reliefBase.value = s.baseMm
    this.uniforms.reliefSign.value = s.direction === 'cut' ? -1 : 1
    this.uniforms.reliefEmboss.value = s.emboss === true ? 1 : 0
    const steps = s.steps
    this.uniforms.reliefStepMode.value = steps === undefined || steps.mode === 'off' ? 0 : steps.mode === 'levels' ? 1 : 2
    this.uniforms.reliefStepLevels.value = Math.min(Math.max(Math.round(steps?.levels ?? 5), 1), 50)
    this.uniforms.reliefStepMm.value = Math.max(steps?.stepMm ?? 1, 1e-3)
    this.uniforms.reliefMode.value = 0
    this.material.displacementMap = this.liveTexture
    this.render()
  }

  /** Settled mode: the applied surface's heights (mm, signed) at the (n+1)^2 grid vertices, row 0 at the low-Y edge. */
  setSettled(heights: Float32Array, n: number): void {
    this.settledTexture?.dispose()
    const t = new THREE.DataTexture(heights, n + 1, n + 1, THREE.RedFormat, THREE.FloatType)
    t.minFilter = THREE.NearestFilter
    t.magFilter = THREE.NearestFilter
    t.needsUpdate = true
    this.settledTexture = t
    this.uniforms.reliefN.value = n
    this.uniforms.reliefMode.value = 1
    this.material.displacementMap = t
    this.render()
  }

  /** Clip the owner body's face away inside the rectangle, so the preview shows in its place (raised or cut in). */
  /**
   * Clip the owner body's face away inside the rectangle, so the preview shows
   * in its place (raised or cut in). The planes are updated in place while the
   * same body stays clipped: changing their count recompiles a program, moving
   * them does not - so a drag never recompiles the body's shader.
   */
  clipOwner(owner: THREE.Mesh | undefined, frame: ReliefFrame): void {
    const materials = owner === undefined ? [] : Array.isArray(owner.material) ? owner.material : [owner.material]
    const same = materials.length === this.clipped.length && materials.every((m, i) => this.clipped[i].material === m && m.clippingPlanes === this.clipPlanes)
    if (!same) {
      this.unclipOwner()
      if (owner === undefined) return
      this.material.color.copy(bodyColorOf(owner))
      for (const m of materials) {
        this.clipped.push({ material: m, planes: m.clippingPlanes, intersection: m.clipIntersection })
        m.clippingPlanes = this.clipPlanes
        m.clipIntersection = true
        m.needsUpdate = true
      }
    }
    const { origin: o, xDir: x, yDir: y, normal: n, widthMm: w, heightMm: h } = frame
    const O = new THREE.Vector3(o.x, o.y, o.z)
    const X = new THREE.Vector3(x.x, x.y, x.z)
    const Y = new THREE.Vector3(y.x, y.y, y.z)
    const N = new THREE.Vector3(n.x, n.y, n.z)
    const [left, right, low, high, above] = this.clipPlanes
    left.set(X.clone().negate(), X.dot(O))
    right.set(X, -(X.dot(O) + w))
    low.set(Y.clone().negate(), Y.dot(O))
    high.set(Y, -(Y.dot(O) + h))
    above.set(N.clone().negate(), N.dot(O) - EDGE_EPS_MM)
    this.render()
  }

  unclipOwner(): void {
    for (const c of this.clipped) {
      c.material.clippingPlanes = c.planes
      c.material.clipIntersection = c.intersection
      c.material.needsUpdate = true
    }
    this.clipped = []
  }

  hide(): void {
    this.group.visible = false
    this.unclipOwner()
    this.render()
  }

  dispose(): void {
    this.unclipOwner()
    this.host.removeObject(this.group)
    this.mesh.geometry.dispose()
    this.material.displacementMap?.dispose()
    this.liveTexture?.dispose()
    this.settledTexture?.dispose()
    this.material.dispose()
    this.disposed = true
    this.host.requestRender()
  }
}

/** The body's own colour, so the preview reads as part of it: the commonest vertex colour (a selected face's tint is the minority), else its material's. */
function bodyColorOf(mesh: THREE.Mesh): THREE.Color {
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
  const base = material?.color instanceof THREE.Color ? material.color.clone() : new THREE.Color(0xd9dee6)
  const colors = mesh.geometry.getAttribute('color')
  if (colors === undefined || material?.vertexColors !== true) return base
  const count = new Map<string, number>()
  const step = Math.max(1, Math.floor(colors.count / 2000))
  let best = '', bestN = 0
  for (let i = 0; i < colors.count; i += step) {
    const key = `${colors.getX(i).toFixed(2)},${colors.getY(i).toFixed(2)},${colors.getZ(i).toFixed(2)}`
    const n = (count.get(key) ?? 0) + 1
    count.set(key, n)
    if (n > bestN) { bestN = n; best = key }
  }
  const [r, g, b] = best.split(',').map(Number)
  return new THREE.Color(r, g, b).multiply(base)
}

/** Texels a side the live texture needs at most (twice the preview grid). */
const LIVE_TEXTURE_CAP = 2 * RELIEF_PREVIEW_CELLS

/** A box-averaged copy no larger than LIVE_TEXTURE_CAP a side (the picture itself when it already fits). */
function shrinkForLive(a: Float32Array, cols: number, rows: number): { data: Float32Array; cols: number; rows: number } {
  const f = Math.ceil(Math.max(cols, rows) / LIVE_TEXTURE_CAP)
  if (f <= 1) return { data: a, cols, rows }
  const c2 = Math.ceil(cols / f), r2 = Math.ceil(rows / f)
  const data = new Float32Array(c2 * r2)
  for (let r = 0; r < r2; r++) {
    const y1 = Math.min(rows, (r + 1) * f)
    for (let c = 0; c < c2; c++) {
      const x1 = Math.min(cols, (c + 1) * f)
      let sum = 0, n = 0
      for (let y = r * f; y < y1; y++) for (let x = c * f; x < x1; x++) { sum += a[y * cols + x]; n++ }
      data[r * c2 + c] = sum / n
    }
  }
  return { data, cols: c2, rows: r2 }
}
