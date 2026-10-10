// Zebra display: reflection stripes on a body's surface, to judge its
// smoothness by eye. A stripe is a band of the reflected view direction, so the
// stripes run on unbroken across a curvature-continuous join, kink where two
// faces meet at an angle (a G1 break), and bend sharply where curvature jumps.
//
// Every modeled-body material (createModeledBodyMaterial) carries the stripe
// code from the start, switched by a per-material uniform: turning zebra on or
// off never recompiles a program and never changes a program cache key (the
// vertex-AO patch pins its own, and chains onto this one).
//
// Curvature display rides in the same hook, switched by a second uniform: each
// vertex carries its curvedness (1 / mm, the `aCurvature` attribute that
// curvature.ts computes from the mesh's own vertex normals - exact on a
// sphere, whatever the triangles), interpolated across the triangle and
// coloured on a log ramp from blue (flat: radius CURVATURE_FLAT_MM or more) to
// red (tight: CURVATURE_TIGHT_MM or less). With zebra on as well, the stripes
// darken the colours. setMeshCurvature keeps the attribute up to date.
//
// setCurvatureDisplay changes, for every body at once, the range (the flat and
// tight radii) and the measure: curvedness, or Gaussian curvature (the
// `aGauss` attribute: saddles toward blue, flat and ruled faces - planes,
// cylinders, cones - green, domes toward red, the same radii read off
// 1 / sqrt(|K|)). Shared uniform objects: no program recompiles.

import type * as THREE from 'three'
import { ensureCurvatureAttribute } from './curvature'

/** Stripe pairs across the half-turn of reflected directions. */
export const ZEBRA_STRIPES = 12

const ZEBRA_FLAG = 'zebraUniform'
const CURV_FLAG = 'curvatureUniform'

interface ZebraUserData { [ZEBRA_FLAG]?: { value: number }; [CURV_FLAG]?: { value: number } }

/** Radius (mm) at and above which the curvature display shows a surface as flat (blue). */
export const CURVATURE_FLAT_MM = 200
/** Radius (mm) at and below which the curvature display shows red. */
export const CURVATURE_TIGHT_MM = 3
/** The ramp, flat to tight, evenly spaced in log radius. */
export const CURVATURE_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0.12, 0.3, 0.95],
  [0.0, 0.78, 0.9],
  [0.15, 0.8, 0.25],
  [0.95, 0.85, 0.1],
  [0.92, 0.18, 0.12],
]

/** What the curvature display shows, and over which radii (mm): flat at flatMm or more, tight at tightMm or less. */
export interface CurvatureDisplay { mode: 'curvedness' | 'gaussian'; flatMm: number; tightMm: number }

/** Shared by every body material (the shader reads them live). */
const DISPLAY = { mode: { value: 0 }, flat: { value: CURVATURE_FLAT_MM }, tight: { value: CURVATURE_TIGHT_MM } }

export function curvatureDisplay(): CurvatureDisplay {
  return { mode: DISPLAY.mode.value === 1 ? 'gaussian' : 'curvedness', flatMm: DISPLAY.flat.value, tightMm: DISPLAY.tight.value }
}

/**
 * Change what the curvature display shows, for every body at once (a render request still shows it). A range
 * that cannot be one (a radius not above zero or not finite) keeps that radius as it was; flat and tight the
 * wrong way round are swapped.
 */
export function setCurvatureDisplay(next: Partial<CurvatureDisplay>): CurvatureDisplay {
  if (next.mode !== undefined) DISPLAY.mode.value = next.mode === 'gaussian' ? 1 : 0
  const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0
  let flat = ok(next.flatMm) ? next.flatMm : DISPLAY.flat.value
  let tight = ok(next.tightMm) ? next.tightMm : DISPLAY.tight.value
  if (tight > flat) [flat, tight] = [tight, flat]
  if (tight === flat) flat = tight * 2
  DISPLAY.flat.value = flat
  DISPLAY.tight.value = tight
  return curvatureDisplay()
}

/** The radius (mm) at each ramp stop, flat to tight, rounded for the legend. */
export function curvatureLegendMm(display: CurvatureDisplay = curvatureDisplay()): number[] {
  return CURVATURE_STOPS.map((_, i) => {
    const r = display.flatMm * Math.pow(display.tightMm / display.flatMm, i / (CURVATURE_STOPS.length - 1))
    return r >= 10 ? Math.round(r) : Math.round(r * 10) / 10
  })
}

/** The default legend (the default range). */
export const CURVATURE_LEGEND_MM: readonly number[] = curvatureLegendMm({ mode: 'curvedness', flatMm: CURVATURE_FLAT_MM, tightMm: CURVATURE_TIGHT_MM })

/** Where a radius falls on the ramp: 0 flat (>= the flat radius) .. 1 tight (<= the tight radius). */
export function curvatureRampT(radiusMm: number, display: CurvatureDisplay = curvatureDisplay()): number {
  const k = radiusMm > 0 ? 1 / radiusMm : Infinity
  const t = Math.log(Math.max(k * display.flatMm, 1)) / Math.log(display.flatMm / display.tightMm)
  return Math.min(1, Math.max(0, t))
}

/** Where a Gaussian curvature (1 / mm^2) falls on the ramp: 0.5 flat or ruled, toward 0 a saddle, toward 1 a dome. */
export function gaussianRampT(gaussian: number, display: CurvatureDisplay = curvatureDisplay()): number {
  const radius = gaussian === 0 ? Infinity : 1 / Math.sqrt(Math.abs(gaussian))
  return 0.5 + 0.5 * Math.sign(gaussian) * curvatureRampT(radius, display)
}

/** The ramp colour (0..1 RGB) at `t`, as the shader computes it. */
export function curvatureColor(t: number): [number, number, number] {
  const n = CURVATURE_STOPS.length - 1
  const x = Math.min(1, Math.max(0, t)) * n
  const i = Math.min(n - 1, Math.floor(x))
  const f = x - i
  const a = CURVATURE_STOPS[i], b = CURVATURE_STOPS[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

const glv = (c: readonly number[]) => `vec3( ${c.map((v) => v.toFixed(3)).join(', ')} )`
/** The GLSL ramp, from the same stops. */
const CURV_RAMP_GLSL = `vec3 curvRamp( float t ) {
	float x = clamp( t, 0.0, 1.0 ) * ${(CURVATURE_STOPS.length - 1).toFixed(1)};
${CURVATURE_STOPS.slice(0, -1).map((c, i) => `	if ( x <= ${(i + 1).toFixed(1)} ) return mix( ${glv(c)}, ${glv(CURVATURE_STOPS[i + 1])}, x - ${i.toFixed(1)} );`).join('\n')}
	return ${glv(CURVATURE_STOPS[CURVATURE_STOPS.length - 1])};
}`

/** Shared (never a per-material closure), so every body material compiles the same program text. */
function zebraOnBeforeCompile(this: THREE.Material, shader: THREE.WebGLProgramParametersWithUniforms): void {
  const data = this.userData as ZebraUserData
  const uniform = data[ZEBRA_FLAG]
  if (uniform === undefined) return
  shader.uniforms.uZebra = uniform
  shader.uniforms.uCurv = data[CURV_FLAG] ?? { value: 0 }
  shader.uniforms.uCurvMode = DISPLAY.mode
  shader.uniforms.uCurvFlat = DISPLAY.flat
  shader.uniforms.uCurvTight = DISPLAY.tight
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aCurvature;\nattribute float aGauss;\nvarying float vCurv;\nvarying float vGauss;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvCurv = aCurvature;\n\tvGauss = aGauss;')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform float uZebra;\nuniform float uCurv;\nuniform float uCurvMode;\nuniform float uCurvFlat;\nuniform float uCurvTight;\nvarying float vCurv;\nvarying float vGauss;\n${CURV_RAMP_GLSL}`)
    .replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
	float zebraS = 1.0;
	if ( uZebra > 0.5 ) {
		// view space: vViewPosition points from the surface to the eye
		vec3 zebraR = reflect( - normalize( vViewPosition ), normalize( normal ) );
		float zebraT = acos( clamp( zebraR.y, - 1.0, 1.0 ) ) * ${ZEBRA_STRIPES.toFixed(1)} / PI;
		float zebraBand = abs( fract( zebraT ) - 0.5 ) * 2.0;
		float zebraW = max( fwidth( zebraT ) * 2.0, 1e-4 );
		zebraS = smoothstep( 0.5 - zebraW, 0.5 + zebraW, zebraBand );
		gl_FragColor.rgb = mix( vec3( 0.06 ), vec3( 0.96 ), zebraS );
	}
	if ( uCurv > 0.5 ) {
		// curvedness (1 / mm) or Gaussian curvature (1 / mm^2) at the vertices (curvature.ts), interpolated;
		// the range from the shared uniforms (setCurvatureDisplay)
		float curvRange = log( uCurvFlat / uCurvTight );
		float curvT;
		if ( uCurvMode < 0.5 ) {
			curvT = log( max( max( vCurv, 0.0 ) * uCurvFlat, 1.0 ) ) / curvRange;
		} else {
			float gaussT = clamp( log( max( sqrt( abs( vGauss ) ) * uCurvFlat, 1.0 ) ) / curvRange, 0.0, 1.0 );
			curvT = 0.5 + 0.5 * sign( vGauss ) * gaussT;
		}
		gl_FragColor.rgb = curvRamp( curvT ) * ( uZebra > 0.5 ? mix( 0.3, 1.0, zebraS ) : 1.0 );
	}`,
    )
}

/** Give a MeshStandardMaterial the (switched-off) stripe code. Idempotent. */
export function installZebra(material: THREE.MeshStandardMaterial): void {
  const data = material.userData as ZebraUserData
  if (data[ZEBRA_FLAG] !== undefined) return
  data[ZEBRA_FLAG] = { value: 0 }
  data[CURV_FLAG] = { value: 0 }
  material.onBeforeCompile = zebraOnBeforeCompile
}

/** Stripes on or off for one material (no-op for a material without the stripe code). */
export function setZebra(material: THREE.Material, on: boolean): void {
  const uniform = (material.userData as ZebraUserData)[ZEBRA_FLAG]
  if (uniform !== undefined) uniform.value = on ? 1 : 0
}

export function zebraOn(material: THREE.Material): boolean {
  return (material.userData as ZebraUserData)[ZEBRA_FLAG]?.value === 1
}

/** Curvature colours on or off for one material (no-op for a material without the code). */
export function setCurvature(material: THREE.Material, on: boolean): void {
  const uniform = (material.userData as ZebraUserData)[CURV_FLAG]
  if (uniform !== undefined) uniform.value = on ? 1 : 0
}

export function curvatureOn(material: THREE.Material): boolean {
  return (material.userData as ZebraUserData)[CURV_FLAG]?.value === 1
}

/** Curvature colours on or off for a mesh: its material's switch, and (when on) its geometry's per-vertex values. */
export function setMeshCurvature(mesh: THREE.Mesh, on: boolean): void {
  for (const m of [mesh.material].flat()) setCurvature(m, on)
  if (on) ensureCurvatureAttribute(mesh.geometry)
}
