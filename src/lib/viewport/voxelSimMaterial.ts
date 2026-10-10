// voxelSimMaterial.ts -- raymarched isosurface ShaderMaterial for the voxel stock
// simulation (ADR-0028). Renders a VoxelField (via its Data3DTexture) as a solid
// isosurface that composites with the existing Three.js scene through gl_FragDepth.
//
// CNCViewport wiring is a SEPARATE item; this module is self-contained.
//
// Scene facts replicated (verified against CNCViewport / ADR-0028):
//   - OrthographicCamera: ALL view rays are PARALLEL, so a single per-frame
//     uRayDir (camera world direction) drives every fragment. No per-fragment
//     ray-origin reconstruction is needed.
//   - Stock lives in RAW WORLD MM at the scene origin (no parent transform); the
//     box mesh is positioned at the field-AABB centre in world space.
//   - Lighting: the CAM accent rig. Its key/fill/rim POSITIONS + INTENSITIES now
//     come from the ONE shared source (lighting/rigDescriptors.ts CAM_ACCENT_
//     LIGHTS) that CNCViewport.setupLighting also builds from, so this shader and
//     the MeshStandard bodies can never desync on a rig retune (GEO-23 AMENDMENT
//     1). Light DIRECTIONS are normalize(position) (surface -> light). Intensities
//     are folded into the colour uniforms by the caller; colours default to white.
//   - The MeshStandard bodies additionally receive an IBL base (GEO-23 L1,
//     scene.environment) that this raymarch shader has no envmap path to sample;
//     the caller folds CAM_SIM_IBL_AMBIENT into uAmbient as a flat stand-in so the
//     carved sim surface stays brightness-matched to the IBL-lit bodies.
//   - ACESFilmicToneMapping, exposure 1.2, output SRGBColorSpace -- replicated in
//     the fragment shader so the raymarched surface matches lit meshes.
//
// Field value convention: value > 0 = solid, value < 0 = air (clamped signed
// distance mm). The surface is the uIso (=0) crossing; f INCREASES going INTO
// solid, so the outward normal is normalize(-grad(f)).

import * as THREE from 'three'
import type { ShadingMode } from '../../types'
import { stockSimDisplayStyle } from './displayModes'
import { resolveModeledBodyEdgeModeStyle } from './lighting/bodyVisualStyle'
import { CAM_ACCENT_LIGHTS, accentDirection } from './lighting/rigDescriptors.ts'

export interface VoxelSimMaterialOpts {
  texture: THREE.Data3DTexture
  fieldMin: THREE.Vector3 // world min corner (x0,y0,z0)
  fieldMax: THREE.Vector3 // world max corner
  voxelSize: number
  baseColor?: THREE.Color // linear; default a mid grey
  ambient?: THREE.Color
  keyColor?: THREE.Color
  fillColor?: THREE.Color
  rimColor?: THREE.Color
  edgeColor?: THREE.Color
}

export const VOXEL_SIM_DISPLAY_MODE: Readonly<Record<ShadingMode, number>> = {
  'shaded-no-edges': 0,
  'shaded-edges': 1,
  unshaded: 2,
  translucent: 3,
}

/** Keep the displayed voxel topology coarse enough to leave visible air
 * between lines. Without this screen-space LOD, a sub-pixel native voxel grid
 * aliases into full surface coverage and "Wireframe" becomes a solid block. */
export const VOXEL_SIM_GRID_TARGET_PIXELS = 12

export function voxelSimGridStride(
  nativeGridFootprintPerPixel: number,
  targetPixels = VOXEL_SIM_GRID_TARGET_PIXELS,
): number {
  const footprint = Number.isFinite(nativeGridFootprintPerPixel)
    ? Math.max(0, nativeGridFootprintPerPixel)
    : 0
  const target = Number.isFinite(targetPixels) ? Math.max(1, targetPixels) : 1
  return 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(footprint * target, 1))))
}

// Light DIRECTIONS = normalize(position), derived from the ONE shared CAM rig
// descriptor (GEO-23 AMENDMENT 1) instead of a hand-copy of the positions. If a
// rig retune moves a CAM light, this shader's baked direction follows.
function camAccentDir(role: 'key' | 'fill' | 'rim'): THREE.Vector3 {
  const desc = CAM_ACCENT_LIGHTS.find((l) => l.role === role)
  if (desc === undefined) throw new Error(`GEO-23: CAM accent light '${role}' missing from rig descriptors`)
  const [x, y, z] = accentDirection(desc.position)
  return new THREE.Vector3(x, y, z)
}
const KEY_DIR = camAccentDir('key')
const FILL_DIR = camAccentDir('fill')
const RIM_DIR = camAccentDir('rim')

const DEFAULT_BASE = new THREE.Color(0.6, 0.6, 0.62)
const WHITE = (): THREE.Color => new THREE.Color(1, 1, 1)

const VERTEX_SHADER = /* glsl */ `
out vec3 vWorldPos;

void main() {
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// The crux. See the algorithm comment block inline. GLSL3.
const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp sampler3D;

in vec3 vWorldPos;
out vec4 fragColor;

uniform sampler3D uField;
uniform vec3 uFieldMin;
uniform vec3 uFieldMax;
uniform float uVoxelSize;
uniform float uIso;
uniform vec3 uRayDir;     // world view direction (into scene), updated per frame
uniform float uStepScale; // march step = uVoxelSize * uStepScale

uniform vec3 uBaseColor;
uniform vec3 uAmbient;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform vec3 uEdgeColor;
uniform float uExposure;
uniform float uAlpha;     // stock-sim opacity (Feature B); 1.0 = fully opaque
// 0 = shaded-no-edges, 1 = shaded-edges, 2 = wireframe, 3 = translucent
uniform float uDisplayMode;
// NOTE: THREE auto-declares projectionMatrix only in the VERTEX prefix, not the
// fragment one, so we supply projection*view ourselves for the depth write.
uniform mat4 uProjView;

const int MAX_STEPS = 2048;

// world point -> normalized texcoord in [0,1]^3
vec3 toTexcoord(vec3 p) {
  return (p - uFieldMin) / (uFieldMax - uFieldMin);
}

float sampleField(vec3 p) {
  return texture(uField, toTexcoord(p)).r;
}

// Narkowicz ACES filmic approximation (matches three.js ACESFilmicToneMapping).
vec3 acesNarkowicz(vec3 c) {
  return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
}

// linear -> sRGB encode (precise transfer; matches SRGBColorSpace output).
vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

void main() {
  // 1. Ray direction into the scene (parallel for ortho); the back-face
  //    fragment world position is the ray EXIT point.
  vec3 rd = normalize(uRayDir);
  vec3 exitP = vWorldPos;

  // 2. Find the FRONT entry by marching BACKWARD (-rd) to the far AABB slab.
  //    Slab intersection of ray (origin=exitP, dir=-rd) with [uFieldMin,uFieldMax].
  vec3 bdir = -rd;
  // Harden against axis-aligned views: an rd component of exactly 0 makes the
  // matching bdir component 0, so 1.0/bdir is Inf and the slab math produces NaN
  // at box-edge pixels. Clamp each component away from zero, preserving sign
  // (sign(0) maps to +). |bdir| >= ~1e-7 afterward.
  bdir = mix(bdir, vec3(1e-7) * sign(sign(bdir) + 0.5), lessThan(abs(bdir), vec3(1e-7)));
  vec3 invD = 1.0 / bdir;
  vec3 t0 = (uFieldMin - exitP) * invD;
  vec3 t1 = (uFieldMax - exitP) * invD;
  vec3 tsmall = min(t0, t1);
  vec3 tbig = max(t0, t1);
  float tFar = min(tbig.x, min(tbig.y, tbig.z));
  vec3 entryP = exitP + bdir * tFar;

  // 3. March forward from entry toward exit, step = uVoxelSize * uStepScale.
  float step = uVoxelSize * uStepScale;
  float segLen = length(exitP - entryP);
  int nSteps = int(floor(segLen / step)) + 1;
  if (nSteps > MAX_STEPS) nSteps = MAX_STEPS;

  bool hit = false;
  vec3 phit = entryP;
  vec3 pPrev = entryP;
  float fPrev = sampleField(entryP); // first solid hit = first f >= uIso

  // If we ENTER already inside solid, the entry itself is the surface.
  if (fPrev >= uIso) {
    hit = true;
    phit = entryP;
  } else {
    for (int i = 1; i <= MAX_STEPS; i++) {
      if (i > nSteps) break;
      vec3 p = entryP + rd * (step * float(i));
      float f = sampleField(p);
      if (f >= uIso) {
        // 3b. Bisect between last-air (pPrev) and first-solid (p) for a crisp
        //     surface position.
        vec3 a = pPrev; // air side  (f < uIso)
        vec3 b = p;     // solid side (f >= uIso)
        for (int k = 0; k < 4; k++) {
          vec3 m = 0.5 * (a + b);
          if (sampleField(m) >= uIso) b = m; else a = m;
        }
        phit = b;
        hit = true;
        break;
      }
      pPrev = p;
      fPrev = f;
    }
  }

  // 4. No crossing along the whole segment -> nothing here; let the scene show
  //    through (depthTest discard).
  if (!hit) discard;

  // 5. Normal from central differences in TEXCOORD space at phit. f increases
  //    INTO solid, so the OUTWARD normal is normalize(-grad).
  vec3 e = (uFieldMax - uFieldMin);
  vec3 hstep = vec3(uVoxelSize) / e; // one-voxel offset in texcoord units
  vec3 tc = toTexcoord(phit);
  float dfx = texture(uField, tc + vec3(hstep.x, 0.0, 0.0)).r
            - texture(uField, tc - vec3(hstep.x, 0.0, 0.0)).r;
  float dfy = texture(uField, tc + vec3(0.0, hstep.y, 0.0)).r
            - texture(uField, tc - vec3(0.0, hstep.y, 0.0)).r;
  float dfz = texture(uField, tc + vec3(0.0, 0.0, hstep.z)).r
            - texture(uField, tc - vec3(0.0, 0.0, hstep.z)).r;
  vec3 grad = vec3(dfx, dfy, dfz);
  vec3 N = normalize(-grad);

  // 6. Surface-edge coverage from the ACTUAL raymarched isosurface. The field's
  //    voxel lattice is the voxel engine's real topology; deriving the grid at
  //    phit avoids the false AABB-box wireframe that a second BoxGeometry pass
  //    would produce. At distant zooms the native lattice is sub-pixel, so it
  //    would alias into 100% coverage (the former solid-white "wireframe").
  //    Choose a power-of-two lattice stride whose cells stay at least
  //    ${VOXEL_SIM_GRID_TARGET_PIXELS}.0px wide. The grid remains field-anchored
  //    and stable while leaving visible air between screen-space strokes.
  vec3 nativeGridPos = (phit - uFieldMin) / uVoxelSize;
  vec3 nativeFootprint = fwidth(nativeGridPos);
  float maxNativeFootprint = max(
    nativeFootprint.x,
    max(nativeFootprint.y, nativeFootprint.z)
  );
  float gridStride = exp2(max(
    0.0,
    ceil(log2(max(maxNativeFootprint * ${VOXEL_SIM_GRID_TARGET_PIXELS}.0, 1.0)))
  ));
  vec3 gridPos = nativeGridPos / gridStride;
  vec3 gridFrac = fract(gridPos);
  vec3 gridDist = min(gridFrac, vec3(1.0) - gridFrac);
  vec3 aa = max(fwidth(gridPos), vec3(1e-4));
  vec3 gridLine = vec3(1.0) - smoothstep(aa * 0.55, aa * 1.55, gridDist);
  vec3 tangentWeight = vec3(1.0) - abs(N);
  float gridCoverage = max(
    gridLine.x * tangentWeight.x,
    max(gridLine.y * tangentWeight.y, gridLine.z * tangentWeight.z)
  );
  // Keep the outside contour readable even when it falls between voxel planes.
  float silhouette = 1.0 - smoothstep(0.04, 0.18, abs(dot(N, -rd)));
  float wireCoverage = max(gridCoverage, silhouette);

  // Wireframe: preserve only the real surface-grid and silhouette fragments.
  if (uDisplayMode > 1.5 && uDisplayMode < 2.5 && wireCoverage < 0.16) discard;

  // 7. Lambert lighting. Light dir uniforms point FROM scene TOWARD the light.
  vec3 col = uBaseColor * uAmbient;
  col += uBaseColor * uKeyColor * max(dot(N, uKeyDir), 0.0);
  col += uBaseColor * uFillColor * max(dot(N, uFillDir), 0.0);
  col += uBaseColor * uRimColor * max(dot(N, uRimDir), 0.0);
  if (uDisplayMode > 1.5 && uDisplayMode < 2.5) {
    col = uEdgeColor;
  } else if (uDisplayMode > 0.5) {
    // Normal shaded views show only the stock silhouette. The voxel-cell
    // lattice is an explicit wireframe diagnostic, not a default surface edge.
    col = mix(col, uEdgeColor, clamp(silhouette * 0.9, 0.0, 0.9));
  }

  // 8. Tone map (ACES) + sRGB encode to match the scene's output pipeline.
  vec3 c = col * uExposure;
  c = acesNarkowicz(c);
  c = linearToSRGB(c);
  fragColor = vec4(c, uAlpha);

  // 9. Write depth at the hit so the volume composites with opaque meshes.
  vec4 clip = uProjView * vec4(phit, 1.0);
  float ndcZ = clip.z / clip.w;
  gl_FragDepth = ndcZ * 0.5 + 0.5;
}
`

export function createVoxelSimMaterial(opts: VoxelSimMaterialOpts): THREE.ShaderMaterial {
  const base = opts.baseColor ? opts.baseColor.clone() : DEFAULT_BASE.clone()
  const ambient = opts.ambient ? opts.ambient.clone() : WHITE()
  const key = opts.keyColor ? opts.keyColor.clone() : WHITE()
  const fill = opts.fillColor ? opts.fillColor.clone() : WHITE()
  const rim = opts.rimColor ? opts.rimColor.clone() : WHITE()
  const edge = opts.edgeColor ? opts.edgeColor.clone() : new THREE.Color(0.08, 0.1, 0.12)

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide, // renders even when the camera is inside the box
    depthTest: true,
    depthWrite: true,
    transparent: false,
    uniforms: {
      uField: { value: opts.texture },
      uFieldMin: { value: opts.fieldMin.clone() },
      uFieldMax: { value: opts.fieldMax.clone() },
      uVoxelSize: { value: opts.voxelSize },
      uIso: { value: 0.0 },
      uRayDir: { value: new THREE.Vector3(0, 0, -1) },
      uStepScale: { value: 0.5 },
      uBaseColor: { value: base },
      uAmbient: { value: ambient },
      uKeyDir: { value: KEY_DIR.clone() },
      uKeyColor: { value: key },
      uFillDir: { value: FILL_DIR.clone() },
      uFillColor: { value: fill },
      uRimDir: { value: RIM_DIR.clone() },
      uRimColor: { value: rim },
      uEdgeColor: { value: edge },
      uExposure: { value: 1.2 },
      uAlpha: { value: 1.0 },
      uDisplayMode: { value: VOXEL_SIM_DISPLAY_MODE['shaded-edges'] },
      uProjView: { value: new THREE.Matrix4() },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  })
}

/**
 * Apply the same global display mode + Compare-opacity contract as the
 * heightmap engine. The shader selects its surface treatment through one
 * uniform; material blending/depth state follows the shared resolver.
 */
export function applyVoxelSimDisplayMode(
  material: THREE.ShaderMaterial,
  mode: ShadingMode,
  requestedOpacity: number,
): void {
  const style = stockSimDisplayStyle(mode, requestedOpacity)
  const edgeStyle = resolveModeledBodyEdgeModeStyle(mode)
  material.uniforms.uDisplayMode.value = VOXEL_SIM_DISPLAY_MODE[mode]
  material.uniforms.uEdgeColor.value.set(edgeStyle.color)
  material.uniforms.uAlpha.value = style.opacity
  material.transparent = style.transparent
  material.depthWrite = style.depthWrite
  material.needsUpdate = true
}

/**
 * Build the AABB box mesh the material raymarches. BoxGeometry sized to the
 * field extent; the mesh is positioned at the field-AABB centre in world space.
 * frustumCulled = false so the box never vanishes when the camera is inside it.
 */
export function buildVoxelSimMesh(
  material: THREE.ShaderMaterial,
  fieldMin: THREE.Vector3,
  fieldMax: THREE.Vector3,
): THREE.Mesh {
  const size = new THREE.Vector3().subVectors(fieldMax, fieldMin)
  const center = new THREE.Vector3().addVectors(fieldMin, fieldMax).multiplyScalar(0.5)
  const geom = new THREE.BoxGeometry(size.x, size.y, size.z)
  const mesh = new THREE.Mesh(geom, material)
  mesh.position.copy(center)
  mesh.frustumCulled = false
  return mesh
}

/**
 * Per-frame uniform update: refresh uRayDir (camera world direction; for an
 * OrthographicCamera every fragment shares it) and uProjView (projection*view)
 * used by the fragment depth write. Called once per frame before render.
 */
export function updateVoxelSimUniforms(material: THREE.ShaderMaterial, camera: THREE.Camera): void {
  camera.updateMatrixWorld()
  const dir = material.uniforms.uRayDir.value as THREE.Vector3
  camera.getWorldDirection(dir)
  // projection * view (view = inverse of the camera world matrix).
  const pv = material.uniforms.uProjView.value as THREE.Matrix4
  pv.copy(camera.matrixWorld).invert()
  pv.premultiply(camera.projectionMatrix)
}
