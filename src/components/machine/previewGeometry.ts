// WO-2217: the Control preview draws a program run in a rotated work offset
// where the machine runs it (Operator ruling 2026-09-29: "It depends upon which viewpoint
// you're in. If you're in machine coordinates or the work ordinance, determine
// whether it should be rotated.").
//
// The rotation is the CONTROLLER's report (machineSession.workRotations,
// docs/design/WCS-ROTATION.md: machine = O + Rot(R)(work)). This file only
// decides how the preview DRAWS it - it never touches the program, the file or
// the CAM screens; the controller rotates what it runs, the app never rotates a
// program as well.
//
// The preview scene is one frame, chosen by the grid select:
// - Machine, Off, or a grid whose own offset is not rotated: the scene is the
//   machine frame. The program is turned by its offset's rotation about that
//   offset's origin; the table and travel box stay square.
// - A rotated work offset (e.g. G55 at 30 deg): the scene is that work frame.
//   Everything machine-fixed is turned by -R about that offset's origin, so the
//   grid (drawn along the scene axes) is square to G55 and the travel box is
//   drawn turned; a G55 program ends up square to its grid.
// With no rotation anywhere nothing here changes a single call.

import * as THREE from 'three'
import type { MachinePreviewCoordinateFrameInput } from '../../lib/viewport/CNCViewport'
import type { ProgramPreviewGridSelection } from './ProgramPreviewGridControl'

type XY = { x: number; y: number }
type XYZ = { x: number; y: number; z: number }
type Range = { min: number; max: number }

export interface PreviewRotationFrame {
  /** The program offset's reported rotation, degrees CCW seen from +Z. */
  programDeg: number
  /** The rotation of the frame the view is drawn in (the chosen grid's offset);
   *  0 = the machine frame. */
  viewDeg: number
  /** Where the view frame turns about: the chosen grid offset's origin. */
  viewPivot: XY
}

export const NO_PREVIEW_ROTATION: PreviewRotationFrame = Object.freeze({
  programDeg: 0,
  viewDeg: 0,
  viewPivot: Object.freeze({ x: 0, y: 0 }),
})

function reported(rotations: Readonly<Record<string, number>>, wcs: string | null): number {
  const deg = wcs ? rotations[wcs] : undefined
  return typeof deg === 'number' && Number.isFinite(deg) ? deg : 0
}

/**
 * The program is drawn at the ACTIVE offset (resolveProgramPreviewGrid's
 * programOriginMachine), so it turns by the active offset's rotation - the
 * same offset whose origin places it. The view follows the chosen grid only
 * when that grid is a work offset the preview can actually draw.
 */
export function resolvePreviewRotation(input: {
  gridSelection: ProgramPreviewGridSelection
  gridAvailable: boolean
  gridOriginMachine: XYZ | null
  activeWcs: string | null
  rotations: Readonly<Record<string, number>>
}): PreviewRotationFrame {
  const programDeg = reported(input.rotations, input.activeWcs)
  const workGrid = input.gridSelection !== 'off' && input.gridSelection !== 'machine'
  const viewDeg = workGrid && input.gridAvailable && input.gridOriginMachine
    ? reported(input.rotations, input.gridSelection)
    : 0
  if (programDeg === 0 && viewDeg === 0) return NO_PREVIEW_ROTATION
  return {
    programDeg,
    viewDeg,
    viewPivot: viewDeg !== 0 && input.gridOriginMachine
      ? { x: input.gridOriginMachine.x, y: input.gridOriginMachine.y }
      : { x: 0, y: 0 },
  }
}

export function isPreviewRotated(frame: PreviewRotationFrame): boolean {
  return frame.programDeg !== 0 || frame.viewDeg !== 0
}

/** Rot(deg)(x, y), CCW positive seen from +Z. */
export function rotateXY(point: XY, deg: number): XY {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: point.x * c - point.y * s, y: point.x * s + point.y * c }
}

/** A machine point in the preview scene: turned by -viewDeg about the pivot. */
export function sceneFromMachine<T extends XY>(point: T, frame: PreviewRotationFrame): T {
  if (frame.viewDeg === 0) return point
  const turned = rotateXY({ x: point.x - frame.viewPivot.x, y: point.y - frame.viewPivot.y }, -frame.viewDeg)
  return { ...point, x: frame.viewPivot.x + turned.x, y: frame.viewPivot.y + turned.y }
}

/** Where a work point of the program is drawn in the scene: its machine
 *  position O + Rot(R)(work), then into the view frame. */
export function scenePointOfWork(work: XYZ, origin: XYZ, frame: PreviewRotationFrame): XYZ {
  const turned = rotateXY(work, frame.programDeg)
  return sceneFromMachine({ x: origin.x + turned.x, y: origin.y + turned.y, z: origin.z + work.z }, frame)
}

/** The turn the viewport's program group carries (its children are in work
 *  coordinates): the program's rotation, less the view frame's. */
export function programGroupTurnDeg(frame: PreviewRotationFrame): number {
  return frame.programDeg - frame.viewDeg
}

function rectCorners(x: Range, y: Range): XY[] {
  return [
    { x: x.min, y: y.min },
    { x: x.max, y: y.min },
    { x: x.max, y: y.max },
    { x: x.min, y: y.max },
  ]
}

/** Axis-aligned box of the machine rectangle once it is turned into the scene. */
export function sceneBoxOfMachineRect(x: Range, y: Range, frame: PreviewRotationFrame): { x: Range; y: Range } {
  const pts = rectCorners(x, y).map((p) => sceneFromMachine(p, frame))
  return {
    x: { min: Math.min(...pts.map((p) => p.x)), max: Math.max(...pts.map((p) => p.x)) },
    y: { min: Math.min(...pts.map((p) => p.y)), max: Math.max(...pts.map((p) => p.y)) },
  }
}

/** The travel box's four corners as drawn in the scene. */
export function sceneTravelCorners(x: Range, y: Range, frame: PreviewRotationFrame): XY[] {
  return rectCorners(x, y).map((p) => sceneFromMachine(p, frame))
}

/**
 * The coordinate-frame input for the viewport. Unrotated: the SAME object
 * (the preview is unchanged). Rotated: the program origin goes into the scene
 * frame; a turned view widens the grid to cover the turned travel box.
 */
export function rotatedPreviewFrameInput(
  input: MachinePreviewCoordinateFrameInput,
  frame: PreviewRotationFrame,
): MachinePreviewCoordinateFrameInput {
  if (!isPreviewRotated(frame) || frame.viewDeg === 0) return input
  const origin = input.programOriginMachine ? sceneFromMachine(input.programOriginMachine, frame) : null
  const grid = input.grid
  if (!grid) return { programOriginMachine: origin, grid: null }
  const extent = grid.extentMachine
  if (!extent) return { programOriginMachine: origin, grid }
  const box = sceneBoxOfMachineRect(extent.x, extent.y, frame)
  return {
    programOriginMachine: origin,
    grid: {
      travel: { x: box.x.max - box.x.min, y: box.y.max - box.y.min },
      originMachine: grid.originMachine,
      extentMachine: box,
    },
  }
}

/** Fit-machine bounds in the scene frame. */
export function sceneMachineBounds(
  bounds: { min: XYZ; max: XYZ } | null,
  frame: PreviewRotationFrame,
): { min: XYZ; max: XYZ } | null {
  if (!bounds || frame.viewDeg === 0) return bounds
  const box = sceneBoxOfMachineRect(
    { min: bounds.min.x, max: bounds.max.x },
    { min: bounds.min.y, max: bounds.max.y },
    frame,
  )
  return {
    min: { x: box.x.min, y: box.y.min, z: bounds.min.z },
    max: { x: box.x.max, y: box.y.max, z: bounds.max.z },
  }
}

/**
 * The affine map that carries the travel border the viewport builds (the
 * axis-aligned `drawn` box it was handed) onto the true travel box turned into
 * the scene: scale `drawn` onto `travel`, then turn it about the pivot.
 * Column-major-free: returned as the 2D affine x' = a x + b y + tx,
 * y' = c x + d y + ty.
 */
export function travelBorderAffine(
  drawn: { x: Range; y: Range },
  travel: { x: Range; y: Range },
  frame: PreviewRotationFrame,
): { a: number; b: number; c: number; d: number; tx: number; ty: number } {
  const sx = (travel.x.max - travel.x.min) / (drawn.x.max - drawn.x.min)
  const sy = (travel.y.max - travel.y.min) / (drawn.y.max - drawn.y.min)
  // S(p) = (travel.min + (p - drawn.min) * s); T(q) = pivot + Rot(-v)(q - pivot)
  const r = (-frame.viewDeg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const ox = travel.x.min - drawn.x.min * sx - frame.viewPivot.x
  const oy = travel.y.min - drawn.y.min * sy - frame.viewPivot.y
  return {
    a: cos * sx,
    b: -sin * sy,
    c: sin * sx,
    d: cos * sy,
    tx: frame.viewPivot.x + cos * ox - sin * oy,
    ty: frame.viewPivot.y + sin * ox + cos * oy,
  }
}

/** The two viewport groups the display turn rides on. CNCViewport keeps them
 *  private; the program group already carries the one work-to-machine
 *  translation (setMachinePreviewCoordinateFrame), this adds its turn. */
interface PreviewRotationGroups {
  programFrameGroup?: THREE.Object3D
  machineTravelBorderGroup?: THREE.Object3D
}

/**
 * Apply the display turn to a viewport AFTER setMachinePreviewCoordinateFrame
 * (which set the program group's position and rebuilt the border from
 * `drawnExtent`). Unrotated it restores identity turns - the state every
 * unrotated preview has always had.
 */
export function applyPreviewRotation(
  viewport: object,
  frame: PreviewRotationFrame,
  travelExtent: { x: Range; y: Range } | null,
  drawnExtent: { x: Range; y: Range } | null,
): void {
  const groups = viewport as PreviewRotationGroups
  const program = groups.programFrameGroup
  if (program) {
    program.rotation.z = (programGroupTurnDeg(frame) * Math.PI) / 180
    program.updateMatrixWorld(true)
  }
  const border = groups.machineTravelBorderGroup
  if (!border) return
  if (frame.viewDeg === 0 || !travelExtent || !drawnExtent) {
    if (!border.matrixAutoUpdate) {
      border.matrix.identity()
      border.matrixAutoUpdate = true
    }
    border.updateMatrixWorld(true)
    return
  }
  const m = travelBorderAffine(drawnExtent, travelExtent, frame)
  border.matrixAutoUpdate = false
  border.matrix.set(
    m.a, m.b, 0, m.tx,
    m.c, m.d, 0, m.ty,
    0, 0, 1, 0,
    0, 0, 0, 1,
  )
  border.matrixWorldNeedsUpdate = true
  border.updateMatrixWorld(true)
}
