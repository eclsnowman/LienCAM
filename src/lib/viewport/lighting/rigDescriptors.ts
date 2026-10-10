// GEO-23: ONE source of truth for both viewport light rigs.
//
// Before GEO-23 the CAM key/fill/rim positions+intensities existed as THREE
// hand-copies (CNCViewport.setupLighting, CNCViewport.initVoxelSim's colour
// derivation, and voxelSimMaterial.ts's KEY_DIR/FILL_DIR/RIM_DIR constants), and
// the WORKBENCH accent lights existed as a hand-mirrored copy inside
// geo22-blind-hole-render-truth.test.ts (LIGHTS + HEMI_INTENSITY). Retuning one
// rig (GEO-23 L3) silently desynced the others (preflight AMENDMENT 1) and the
// test asserted against a frozen rig (WO L5). This module is the single place
// those numbers live; every consumer reads FROM here so they cannot drift again.
//
// Pure data only (no `three` import) so the Node vitest suite can import the
// WORKBENCH constants without pulling a WebGL-shaped dependency. Consumers build
// THREE.DirectionalLight / THREE.Vector3 from the tuples themselves.

/** A directional accent light expressed as data: a world-space POSITION the
 *  light travels from toward the scene origin (so the surface->light direction,
 *  the Lambert L vector, is normalize(position)), an intensity, and a colour. */
export interface AccentLightDescriptor {
  readonly role: 'key' | 'fill' | 'rim'
  /** World position; direction toward the light = normalize(position). */
  readonly position: readonly [number, number, number]
  readonly intensity: number
}

// ---------------------------------------------------------------------------
// MODELED BODY STATIC STUDIO RIG.
//
// The PMREM environment carries broad reflection while these world-space
// directionals shape faces. No light follows the camera in either host.
// ---------------------------------------------------------------------------

/** Hemisphere fill: sky colour (up, +Z), ground colour (down, -Z), intensity.
 *  The ground colour is deliberately dark -- with the IBL base present it is a
 *  gentle downward tint, no longer the ONLY thing lighting a -Z face (the
 *  GEO-22/23 root cause: a bottom face used to receive only this dark term).
 *
 *  The restrained ground term keeps downward faces readable without flattening
 *  the fixed key/fill/rim response. */
export const WORKBENCH_HEMISPHERE = {
  sky: 0xffffff,
  ground: 0x5b6572,
  intensity: 0.22,
} as const

export const WORKBENCH_KEY_COLOR = 0xfff8f0
export const WORKBENCH_FILL_COLOR = 0xb0d4ff
export const WORKBENCH_RIM_COLOR = 0xffffff

export const WORKBENCH_ACCENT_LIGHTS: readonly AccentLightDescriptor[] = [
  { role: 'key', position: [600, -300, 800], intensity: 0.60 },
  { role: 'fill', position: [-400, 400, 200], intensity: 0.30 },
  { role: 'rim', position: [0, 0, -600], intensity: 0.22 },
] as const

// ---------------------------------------------------------------------------
// CAM viewport (CNCViewport.ts) rig. Colours are THEME TOKENS resolved at
// runtime (asNumber('--vp-light-*')), so only positions + intensities live here.
// The voxel stock-sim shader (voxelSimMaterial.ts) reads the SAME positions for
// its baked light directions and the SAME intensities folded into its colour
// uniforms (preflight AMENDMENT 1) -- one rig, one set of numbers.
//
// GEO-23 L3: retuned DOWN from (ambient 0.4, key 1.4, fill 0.5, rim 0.3) for the
// same reason as the workbench rig -- the IBL base + headlight now carry the
// scene, these shape form.
// ---------------------------------------------------------------------------

export const CAM_AMBIENT = { token: '--vp-light-ambient', intensity: 0.22 } as const

export interface CamAccentLightDescriptor extends AccentLightDescriptor {
  /** CSS custom property resolved to the light colour at runtime. */
  readonly token: string
}

export const CAM_ACCENT_LIGHTS: readonly CamAccentLightDescriptor[] = [
  { role: 'key', token: '--vp-light-key', position: [600, -300, 800], intensity: 0.60 },
  { role: 'fill', token: '--vp-light-fill', position: [-400, 400, 200], intensity: 0.30 },
  { role: 'rim', token: '--vp-light-rim', position: [0, 0, -600], intensity: 0.22 },
] as const

/** Flat white ambient the VOXEL stock-sim raymarch shader adds to stand in for
 *  the IBL base the MeshStandard bodies now receive (preflight AMENDMENT 1). The
 *  raymarched SDF shader (voxelSimMaterial.ts) has no envmap sampling path, so it
 *  cannot read scene.environment; without this term the carved sim surface would
 *  read markedly darker than the IBL-lit bodies around it once L3 retunes the
 *  analytic accents DOWN. Tuned to keep the sim's overall level close to the
 *  IBL-lit bodies; the accent DIRECTIONS + INTENSITIES are shared from
 *  CAM_ACCENT_LIGHTS above so the two can never desync on a future retune. */
export const CAM_SIM_IBL_AMBIENT = 0.35

// ---------------------------------------------------------------------------
// Camera-following HEADLIGHT (GEO-23 L2), shared tuning for both viewports.
// A directional light that tracks the camera every render so the surface being
// looked at always receives direct light -- Operator's "rotating should expose light
// to the bottom" made literal. Intensity is a COMPLEMENT to the IBL base, tuned
// (via the G1 render matrix) not to flatten form.
// ---------------------------------------------------------------------------

export const HEADLIGHT = {
  color: 0xffffff,
  intensity: 0.30,
} as const

/** Q-48 soft-studio: the Model workspace's camera headlight is dimmer than
 *  the shared HEADLIGHT default above (createCameraHeadlight's fallback,
 *  still used unchanged by CAM/CNCViewport.ts). Passed explicitly at the
 *  Model-workspace call site (sceneRuntime.ts) so CAM's headlight brightness
 *  cannot silently drift with this retune. */
export const WORKBENCH_HEADLIGHT_INTENSITY = 0.14

// ---------------------------------------------------------------------------
// Image-based-lighting (RoomEnvironment PMREM) base intensity per viewport
// (GEO-23 L1). Drives scene.environmentIntensity (-> envMapIntensity on every
// MeshStandardMaterial). Tuned so nothing the user can orbit to reads black.
// ---------------------------------------------------------------------------

export const MODELED_BODY_STUDIO_ENV_INTENSITY = 0.40
export const WORKBENCH_ENV_INTENSITY = MODELED_BODY_STUDIO_ENV_INTENSITY
export const CAM_ENV_INTENSITY = MODELED_BODY_STUDIO_ENV_INTENSITY

/** Shared ACES exposure for CAM and Model. */
export const MODELED_BODY_STUDIO_EXPOSURE = 1.2
export const WORKBENCH_EXPOSURE = MODELED_BODY_STUDIO_EXPOSURE

// ---------------------------------------------------------------------------
// AMBIENT OCCLUSION (GEO-23 L4, mandated by GEO-23-R1 audit cure C2).
//
// L1+L2+L3 (IBL + headlight + retuned accents) guarantee no face is ever black,
// but the IBL fills a bored cavity almost as brightly as the surrounding flat
// face, so a side/bottom hole read as a "bright flat disk" (audit MAJOR). AO is
// the physical cure: a recessed interior sees LESS of the environment, so it is
// darker with depth. We bake a per-vertex occlusion factor into a geometry
// attribute (see lighting/vertexAO.ts) and multiply it into each body's
// MeshStandardMaterial indirect (and a fraction of direct) light via
// onBeforeCompile. It is baked into BODY geometry only, so unlit overlay
// materials (LineBasicMaterial / MeshBasicMaterial) are pixel-untouched by
// construction (G2). ONE source of truth here so both viewports + the mutation
// proofs read the same numbers.
// ---------------------------------------------------------------------------

/** GEO-23-R1 C3(c) mutation seam: the single source-level switch that disables
 *  the L4 occlusion cue. Set false and re-run the render matrix -> every hole's
 *  interior reads as bright as its face and the interior-contrast assertion
 *  (mean interior <= 0.8 x face) goes RED on the side-bore cell (the AO-only
 *  mutation proof). Restored to true byte-identically for the green run. */
export const AO_ENABLED = true

/** Rays cast over each vertex's hemisphere to estimate occlusion. A fixed
 *  deterministic set (Fibonacci hemisphere, see vertexAO.ts) so the baked AO --
 *  and therefore the matrix -- is reproducible run to run (no Math.random). */
export const AO_RAYS = 32

/** Max occlusion distance as a fraction of the body's bounding-sphere radius.
 *  Local AO: only nearby geometry occludes, so a bore's own walls darken its
 *  interior while distant faces do not wash it out. Tuned via the render matrix. */
export const AO_RADIUS_FACTOR = 0.30

/** How strongly full occlusion darkens a vertex: baked factor =
 *  1 - occludedFraction * AO_STRENGTH, then clamped to [AO_MIN, 1]. */
export const AO_STRENGTH = 1.0

/** Floor for the baked AO factor: a fully-occluded vertex never goes below this,
 *  so an AO'd cavity is darker-with-depth but never the pitch black Operator rejected
 *  (the "no face may render black" gate, G1a, still holds inside holes). */
export const AO_MIN = 0.12
/** AO is persisted as Float32Array, so validation must use the representable
 * lower bound rather than comparing a quantized sample to the double literal. */
export const AO_MIN_F32 = Math.fround(AO_MIN)

/** Fraction of DIRECT diffuse also dimmed by AO (indirect is fully AO-scaled).
 *  The camera-following headlight rakes light straight into whatever bore you look
 *  at, which fights the "holes read dark" cue; dimming most of the direct term in
 *  occluded interiors is what keeps a bore reading as a recess. 0 = AO touches
 *  only indirect. */
export const AO_DIRECT_DIM = 0.8

/** normalize(position) as a plain tuple -- the surface->light (Lambert L)
 *  direction for an accent whose light travels position -> origin. Pure, so both
 *  the runtime rigs and the Node test share one definition of "which way the
 *  light points". */
export function accentDirection(
  position: readonly [number, number, number],
): [number, number, number] {
  const m = Math.hypot(position[0], position[1], position[2]) || 1
  return [position[0] / m, position[1] / m, position[2] / m]
}
