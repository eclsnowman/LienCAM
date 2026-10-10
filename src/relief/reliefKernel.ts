// Image relief - lay an exact relief face into a planar face of a solid, on
// the occt-wasm kernel (the geometry worker's kernel; this module holds no
// kernel of its own). docs/design/IMAGE-RELIEF-PLAN.md section 3, route (b):
// the face is split by the relief's boundary, the inside piece is dropped,
// and the relief face is sewn in its place (split + sewAndSolidify).

import type { OcctKernel, ShapeHandle } from 'occt-wasm'
import { reliefFaceStep, type ReliefPoles } from './reliefStep'

export interface ReliefPlacement {
  /** low corner of the relief rectangle on the face, mm */
  origin: { x: number; y: number }
  /** the face's plane, z = baseZ (a +Z planar face) */
  baseZ: number
}

export interface ReliefBuildTimes {
  /** poles -> STEP text */
  writeMs: number
  /** STEP text -> kernel face */
  readMs: number
  splitMs: number
  sewMs: number
}

export interface ReliefBuild {
  solid: ShapeHandle
  times: ReliefBuildTimes
  stepBytes: number
}

/** The relief face alone, read into the kernel from its explicit poles. */
export function importReliefFace(k: OcctKernel, poles: ReliefPoles, at: ReliefPlacement): { face: ShapeHandle; writeMs: number; readMs: number; stepBytes: number } {
  let t = performance.now()
  const text = reliefFaceStep(poles, at.origin, at.baseZ)
  const writeMs = performance.now() - t
  t = performance.now()
  const read = k.importStep(text)
  const faces = k.getSubShapes(read, 'face')
  const readMs = performance.now() - t
  if (faces.length !== 1) throw new Error(`relief STEP read back ${faces.length} faces, expected 1`)
  return { face: faces[0], writeMs, readMs, stepBytes: text.length }
}

/**
 * The solid with the relief face sewn into its +Z planar face at z = baseZ.
 * The relief rectangle must lie inside that face.
 */
export function sewReliefIntoSolid(k: OcctKernel, solid: ShapeHandle, relief: ShapeHandle, at: ReliefPlacement, reliefArea: number, sewTolerance = 1e-4): { solid: ShapeHandle; splitMs: number; sewMs: number } {
  const faces = k.getSubShapes(solid, 'face')
  const target = faces.find((f) => {
    if (k.surfaceType(f) !== 'plane') return false
    const c = k.getSurfaceCenterOfMass(f)
    const b = k.uvBounds(f)
    const nrm = k.surfaceNormal(f, (b.uMin + b.uMax) / 2, (b.vMin + b.vMax) / 2)
    const up = k.shapeOrientation(f) === 'reversed' ? -nrm.z : nrm.z
    return Math.abs(c.z - at.baseZ) < 1e-6 && up > 0.999
  })
  if (!target) throw new Error(`no +Z planar face at z = ${at.baseZ}`)
  let t = performance.now()
  const pieces = k.getSubShapes(k.split(target, k.getSubShapes(relief, 'edge')), 'face')
  const splitMs = performance.now() - t
  if (pieces.length !== 2) throw new Error(`the face split into ${pieces.length} pieces, expected 2`)
  // the piece inside the relief outline has the relief rectangle's area
  const inside = Math.abs(k.getSurfaceArea(pieces[0]) - reliefArea) < Math.abs(k.getSurfaceArea(pieces[1]) - reliefArea) ? 0 : 1
  const keep = pieces[1 - inside]
  t = performance.now()
  const sewn = k.sewAndSolidify([...faces.filter((f) => f !== target), keep, relief], sewTolerance)
  const sewMs = performance.now() - t
  if (!k.isSolid(sewn) || !k.isValid(sewn)) throw new Error('sewing the relief into the face did not give a valid solid')
  return { solid: sewn, splitMs, sewMs }
}

/** Import + split + sew: the whole exact-route build. */
export function buildExactRelief(k: OcctKernel, solid: ShapeHandle, poles: ReliefPoles, at: ReliefPlacement): ReliefBuild {
  const imp = importReliefFace(k, poles, at)
  const sewn = sewReliefIntoSolid(k, solid, imp.face, at, poles.widthMm * poles.depthMm)
  return { solid: sewn.solid, stepBytes: imp.stepBytes, times: { writeMs: imp.writeMs, readMs: imp.readMs, splitMs: sewn.splitMs, sewMs: sewn.sewMs } }
}
