// Pure geometry helpers for the instanced nest renderer (P3.2, ADR 0024).
//
// The Three.js render itself is not headlessly unit-testable, but the
// placement -> scene-pose math is. A placement's pose is the 2D rigid
// transform M(p) = translate(p.x, p.y) . rotate(p.rotationDeg) applied to the
// source part's LOCAL loop coordinates (ADR 0024 instance transform). The
// renderer realises this as a child THREE.Group with position=(x,y) and a
// Z-rotation of rotationDeg; this module exposes the same math as plain
// functions so it can be tested without a WebGL context.

/** A 2D placement pose: where (and how rotated) a source part instance sits on
 *  the sheet. Mirrors the relevant fields of nesting `Placement`. */
export interface NestPose {
  x: number
  y: number
  rotationDeg: number
}

/** Scene pose for one placement: the child group's position (sheet XY at the
 *  given Z2D plane) and its Z-rotation in radians. The renderer feeds these
 *  straight into THREE.Group.position.set / rotation.z. */
export function placementToScenePose(
  p: NestPose,
  z2d: number,
): { position: { x: number; y: number; z: number }; rotationZ: number } {
  return {
    position: { x: p.x, y: p.y, z: z2d },
    rotationZ: degToRad(p.rotationDeg),
  }
}

/** Apply the placement's 2D rigid transform to a source-LOCAL point, returning
 *  its sheet-world (x, y). translate(p.x, p.y) . rotate(p.rotationDeg):
 *  rotate the local point about the origin first, then translate. This is the
 *  same map the child-group transform applies to every loop vertex; exposing it
 *  as a pure function lets later phases (toolpath instancing, P6) reuse and the
 *  test assert the convention is correct. */
export function applyPlacementTransform(
  point: { x: number; y: number },
  p: NestPose,
): { x: number; y: number } {
  const a = degToRad(p.rotationDeg)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return {
    x: p.x + point.x * cos - point.y * sin,
    y: p.y + point.x * sin + point.y * cos,
  }
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Resolve the effective geometry id of a loop-pick ray hit, used to gate the
 *  pick to the op's target geometry (loopPickAllowedGeoId). Standalone 2D loops
 *  carry their geoId as the parent group's name (with `__proj__` /
 *  `__wplane_<geoId>` special cases). A NEST SEED-SLOT loop line instead carries
 *  `userData.geometryId` (the owned-seed geoId) because its parent group is the
 *  unnamed placement child group, so a seed-slot hit is identified by userData,
 *  not by parent name. Returning the seed userData FIRST keeps standalone picking
 *  byte-identical (non-seed lines have no `geometryId` userData) while making a
 *  seed-slot loop resolvable to its owned-seed geoId. Pure so the gating rule is
 *  unit-tested without a WebGL context. */
export function resolveLoopPickGeoId(hit: {
  userData?: { geometryId?: unknown; seedPlacement?: unknown }
  parentName?: string
  grandparentName?: string
}): string | null {
  const ud = hit.userData
  if (ud && ud.seedPlacement === true && typeof ud.geometryId === 'string') {
    return ud.geometryId
  }
  const parentName = hit.parentName ?? ''
  const grandparentName = hit.grandparentName ?? ''
  if (parentName === '__proj__') return grandparentName || null
  // B-rep geometry-LOCAL derived loops (drill holes, sections, face loops) live in a
  // group named `__wplane_local_<geoId>` (setPartLoopsOnFacePlane). Check this MORE
  // SPECIFIC prefix BEFORE the generic `__wplane_` branch - otherwise that branch
  // returns "local_<geoId>", which never equals the op's target geoId, so the
  // loop-pick geo-gate rejects every hit and the holes are unselectable in the
  // viewport (regression report 2026-06-25; they only worked via modal checkboxes).
  if (parentName.startsWith('__wplane_local_')) return parentName.slice('__wplane_local_'.length) || null
  if (parentName.startsWith('__wplane_')) return parentName.slice('__wplane_'.length) || null
  return parentName || null
}
