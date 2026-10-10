// Workplan P0 (POST-MERGE-WORKPLAN "Move gizmo pivot ... at the WORKSPACE
// origin") -- the 3D half of the pivot bug UI-75 fixed for 2D geometry.
//
// WHY THIS SUITE EXISTS
//   setSelectedPart attaches TransformControls DIRECTLY to any 3D part group,
//   which draws the gizmo at the group's world origin. That is correct ONLY
//   for addSTL groups, whose mesh is recentred at load (xy centre on the
//   origin, bottom on z=0) so the group origin IS the visible pivot. B-rep
//   (STEP) and Model-workbench meshes keep NATIVE authoring coordinates --
//   recentring them is forbidden (OCCT derives faces in shape space; the
//   Model kernel's ElementMap is the identity source) -- so a body whose
//   sketch was drawn away from the origin landed its move gizmo at the
//   WORKSPACE ORIGIN, far from the geometry. The fix routes native-frame 3D
//   groups through the same bounds-derived pivot proxy UI-75 built for 2D,
//   with the 3D pivot convention matching what addSTL bakes in: visible xy
//   bounds centre, at the bounds' BOTTOM z.
//
//   The pivot must also be RECOMPUTED when the geometry is edited:
//   addModelBody / addBrepModel / addSTL all replace a same-id group IN
//   PLACE (a Part-studio re-derive, a STEP re-tessellation, a re-import),
//   which orphans the group the gizmo was attached to. Pre-fix the gizmo
//   silently stayed on the dead group.
//
// The behaviour-defining assertions here fail against the pre-fix
// setSelectedPart / add*-replace paths (RED evidence captured before the fix).

import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { seatedPositionFromBounds } from '../../lib/import/seatGeometry'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { ModelBodyDisplay } from '../../types'

vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

class FakeTransformControls {
  object: THREE.Object3D | undefined
  attach(object: THREE.Object3D) { this.object = object; return this }
  detach() { this.object = undefined; return this }
  setMode(): void {}
}

interface VpUnderTest {
  addSTL: CNCViewport['addSTL']
  addBrepModel: CNCViewport['addBrepModel']
  addModelBody: CNCViewport['addModelBody']
  setSelectedPart: CNCViewport['setSelectedPart']
  setPartTransform: CNCViewport['setPartTransform']
  setSTLVisible: CNCViewport['setSTLVisible']
  partGroups: Map<string, THREE.Group>
  geometry2dGizmoProxy: THREE.Object3D | null
  selectedPartId: string | null
  transformControls: FakeTransformControls
  handleTransformControlsChange: () => void
  handleTransformDraggingChanged: (event: { value: boolean }) => void
}

// Same Object.create harness as geometryMoveGizmoPivot.test.ts: real prototype
// methods over hand-assigned instance state (class-field initializers are
// bypassed, so every field a driven method dereferences must be listed here).
function makeVp(onTransform?: (...args: unknown[]) => void): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    selectedPartId: null,
    geometry2dGizmoProxy: null,
    geometry2dGizmoGroup: null,
    geometry2dGizmoLastWorld: new THREE.Matrix4(),
    workpieceGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    // add* / paintPartHighlight material colors (DARK_COLORS is module-private).
    colors: { workpiece: 0x8899aa, workpieceEdge: 0x223344, selectedPart: 0xffaa00 },
    // GEO-25: viewport display theme bookkeeping addSTL/addBrepModel/
    // addModelBody now write unconditionally (resolvePartTheme() itself
    // degrades a missing/invalid viewportThemeId to classic on its own; only
    // these two Maps are hard-required by the `.set()` calls).
    viewportThemeId: 'classic',
    partUsesThemeColor: new Map<string, boolean>(),
    partEdgePositions: new Map<string, Float32Array>(),
    // paintPartHighlight -> nest-membership branch state
    partPickPresentation: 'standard',
    partPickSelectedIds: new Set<string>(),
    partPickGlowGroups: new Map<string, THREE.Group>(),
    partPickHoverId: null,
    // clearBrepStateFor state (replace-in-place paths)
    pickedBrepKeys: new Set<string>(),
    brepHighlights: new Map<string, THREE.Object3D>(),
    brepHoverKey: null,
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    transformControls: new FakeTransformControls(),
    controls: { enabled: true },
    interactionMode: 'normal',
    sketcher: { isActive: () => false },
    wcsGizmoSphere: null,
    stockGizmoSphere: null,
    stockGizmoId: null,
    rebuildStock: () => {},
    updateSelectableObjects: () => {},
    maybeAutoFit: () => {},
    highlight2D: () => {},
    highlightProjectedLoops: () => {},
    onPartTransformChange: onTransform,
  })
  vp.scene.add(vp.workpieceGroup)
  return vp as VpUnderTest
}

type V3 = [number, number, number]

/** 8-corner box tessellation payload for addModelBody. Bounds are what matter
 *  (the pivot derives from Box3), so two triangles suffice. No edges. */
function boxDisplay(min: V3, max: V3): ModelBodyDisplay {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const positions = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]
  return {
    positions,
    normals: new Array(positions.length).fill(0),
    indices: [0, 1, 2, 4, 5, 6],
    edgePositions: [],
    edgeOffsets: [],
    bbox: { min, max },
  }
}

/** Same box as a minimal one-face B-rep payload for addBrepModel. */
function boxBrepPayload(min: V3, max: V3): BrepModelPayload {
  const d = boxDisplay(min, max)
  return {
    faceCount: 1,
    edgeCount: 0,
    solidCount: 1,
    bbox: { min, max },
    mesh: {
      positions: new Float32Array(d.positions),
      normals: new Float32Array(d.normals),
      indices: new Uint32Array(d.indices),
      faceRanges: new Uint32Array([0, d.indices.length]),
    },
    edges: { positions: new Float32Array(0), edgeRanges: new Uint32Array(0) },
    faceTypes: new Uint8Array([0]),
  }
}

/** Minimal binary STL: two triangles spanning the given box. */
function boxStlBuffer(min: V3, max: V3): ArrayBuffer {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const tris: V3[][] = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0]],
    [[x0, y0, z0], [x1, y1, z1], [x0, y1, z1]],
  ]
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, tris.length, true)
  let o = 84
  for (const tri of tris) {
    o += 12 // zero facet normal; addSTL recomputes vertex normals anyway
    for (const [x, y, z] of tri) {
      dv.setFloat32(o, x, true)
      dv.setFloat32(o + 4, y, true)
      dv.setFloat32(o + 8, z, true)
      o += 12
    }
    o += 2 // attribute byte count
  }
  return buf
}

function expectVector(actual: THREE.Vector3, expected: { x: number; y: number; z: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
  expect(actual.z).toBeCloseTo(expected.z, 6)
}

describe('3D move gizmo pivot for native-frame (sketch-origin) geometry', () => {
  // Operator's bug, current-era 3D shape: a body whose sketch was drawn away from
  // the origin. Its mesh keeps authoring coordinates and its group sits at
  // (0,0,0), so DIRECT attachment drew the gizmo at the WORKSPACE ORIGIN.
  it('pivots a model-workbench body at its rendered centre, not the workspace origin', () => {
    const vp = makeVp()
    vp.addModelBody('modelbody:B1', boxDisplay([40, -10, 0], [60, 0, 20]), 'Body',
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    vp.setSelectedPart('modelbody:B1')

    const group = vp.partGroups.get('modelbody:B1')!
    // The group really is pinned at the origin -- what made the gizmo land
    // there -- and must stay there (the fix must NOT move geometry).
    expectVector(group.position, { x: 0, y: 0, z: 0 })
    // Bounds-derived pivot proxy, at the visible xy centre on the bounds'
    // bottom z (the exact convention addSTL bakes into recentred groups).
    expect(vp.geometry2dGizmoProxy).not.toBeNull()
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
    expectVector(vp.geometry2dGizmoProxy!.position, { x: 50, y: -5, z: 0 })
  })

  it('recomputes the pivot when the body is re-derived in place (sketch edit)', () => {
    const vp = makeVp()
    vp.addModelBody('modelbody:B1', boxDisplay([40, -10, 0], [60, 0, 20]), 'Body',
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    vp.setSelectedPart('modelbody:B1')

    // Part-studio edit: same id, asymmetrically moved/grown mesh. The replace
    // orphans the old group, so the gizmo must be re-anchored on the LIVE one
    // at the NEW centre (120), not left on the dead group or the stale centre.
    vp.addModelBody('modelbody:B1', boxDisplay([100, -10, 0], [140, 0, 20]), 'Body',
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })

    expect(vp.selectedPartId).toBe('modelbody:B1')
    expect(vp.geometry2dGizmoProxy).not.toBeNull()
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
    expectVector(vp.geometry2dGizmoProxy!.position, { x: 120, y: -5, z: 0 })

    // Dragging the proxy must move the LIVE registered group, not the orphan.
    const live = vp.partGroups.get('modelbody:B1')!
    vp.geometry2dGizmoProxy!.position.x += 5
    vp.handleTransformControlsChange()
    expect(live.position.x).toBeCloseTo(5, 6)
  })

  it('pivots a seated off-origin STEP part on the part and persists the group transform', () => {
    const onTransform = vi.fn()
    const vp = makeVp(onTransform)
    const min: V3 = [90, -5, 0]
    const max: V3 = [110, 5, 20]
    // The import path seats a STEP flat via the group position (mesh coords
    // stay native): group.position = (-100, 0, 0) here.
    const seat = seatedPositionFromBounds(
      { x: min[0], y: min[1], z: min[2] }, { x: max[0], y: max[1], z: max[2] })
    vp.addBrepModel('step-part', boxBrepPayload(min, max), 'Step', seat, { x: 0, y: 0, z: 0 })
    vp.setSelectedPart('step-part')

    // Pre-fix the gizmo drew at the group origin (-100, 0, 0), a mirror-image
    // away from the visible part; the pivot belongs at the seated part itself.
    expect(vp.geometry2dGizmoProxy).not.toBeNull()
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
    expectVector(vp.geometry2dGizmoProxy!.position, { x: 0, y: 0, z: 0 })

    // Drag-end persists the GROUP transform, never the proxy's pivot position
    // (the double-offset trap the 2D suite also guards).
    const group = vp.partGroups.get('step-part')!
    vp.geometry2dGizmoProxy!.position.x += 5
    vp.handleTransformControlsChange()
    expect(group.position.x).toBeCloseTo(seat.x + 5, 6)
    vp.handleTransformDraggingChanged({ value: false })
    expect(onTransform).toHaveBeenCalledTimes(1)
    const [id, position] = onTransform.mock.lastCall!
    expect(id).toBe('step-part')
    expect(position).toEqual({ x: group.position.x, y: group.position.y, z: group.position.z })
  })

  it('re-centres the 3D proxy after a typed transform edit', () => {
    const vp = makeVp()
    vp.addModelBody('modelbody:B1', boxDisplay([40, -10, 0], [60, 0, 20]), 'Body',
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    vp.setSelectedPart('modelbody:B1')

    vp.setPartTransform('modelbody:B1', { x: 10, y: 0, z: 3 }, { x: 0, y: 0, z: 0 })
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
    expectVector(vp.geometry2dGizmoProxy!.position, { x: 60, y: -5, z: 3 })
  })

  // REGRESSION: imported STL behaviour is IDENTICAL to before. addSTL recentres
  // its mesh so the group origin already is the visible pivot -- it keeps the
  // established DIRECT attachment, no proxy.
  it('keeps imported STL on direct attachment with its origin pivot', async () => {
    const vp = makeVp()
    await vp.addSTL(boxStlBuffer([30, -10, 0], [50, 10, 8]), 'stl-part', 'Part',
      { x: 7, y: 3, z: 0 }, { x: 0, y: 0, z: 0 })
    vp.setSelectedPart('stl-part')

    const group = vp.partGroups.get('stl-part')!
    expect(vp.transformControls.object).toBe(group)
    expect(vp.geometry2dGizmoProxy).toBeNull()
    // Pivot (= group world origin) sits at the recentred part's xy centre /
    // bottom z, placed by the group transform.
    expectVector(group.getWorldPosition(new THREE.Vector3()), { x: 7, y: 3, z: 0 })

    // Re-import of the same id (imported-geometry edit) replaces the group in
    // place: the gizmo must land on the LIVE group, not stay on the orphan.
    await vp.addSTL(boxStlBuffer([0, 0, 0], [20, 20, 8]), 'stl-part', 'Part',
      { x: 7, y: 3, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(vp.transformControls.object).toBe(vp.partGroups.get('stl-part')!)
  })

  // ADR-0003 boundary, mirroring the 2D suite's documented degrade: with no
  // visible mesh there is no computable pivot, so the proxy falls back to the
  // group origin (pre-fix behaviour) instead of guessing.
  it('degrades to the group origin when every mesh is hidden', () => {
    const vp = makeVp()
    vp.addModelBody('modelbody:B1', boxDisplay([40, -10, 0], [60, 0, 20]), 'Body',
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    vp.setSTLVisible('modelbody:B1', false)
    vp.setSelectedPart('modelbody:B1')
    expect(vp.geometry2dGizmoProxy).not.toBeNull()
    expectVector(vp.geometry2dGizmoProxy!.position, { x: 0, y: 0, z: 0 })
  })
})
