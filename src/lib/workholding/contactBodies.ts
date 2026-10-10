// WO-2177 (workholding assemblies, slice 3): the workholding simulation checks
// contact with, for one setup.
//
// A vise or clamp placed as an instance comes from the ONE resolver
// (./resolveWorkholding.ts) the screen draws from: each component's display
// bounding box carried to the world by the pose the resolver gives it, so a
// jaw moved to a new opening is checked at its new place, and a setup outside
// the instance's scope never sees it. The panel builds frames synchronously and
// cannot wait for a shape read, so a box stands in for the exact shape - the
// same box CAM falls back to - which can only ever over-report a contact, never
// miss one (WO-1578).
//
// Every other marked row is boxed exactly as the simulation always has
// (workholdingBoxMesh on the row's box and pose), so a project with no instance
// gets the same contacts as before. A row that is a vise's shape data is that
// vise's body, not also a body of its own.

import type { Project } from '../../types'
import type { ClearanceMesh } from '../cam/holderClearance'
import { workholdingBoxMesh } from '../simulation/workholdingContact'
import { placedBoundingBox, resolveInstancePlacements, workholdingComponentGeometryIds } from './resolveWorkholding'

export function workholdingContactBodies(
  project: Pick<Project, 'geometry' | 'workholding'>,
  setupId: string | null | undefined,
): ClearanceMesh[] {
  const rows = new Map(project.geometry.map((g) => [g.id, g]))
  const meshes: ClearanceMesh[] = []
  for (const placement of resolveInstancePlacements(project, setupId).placements) {
    const box = placedBoundingBox(placement, rows.get(placement.geometryId)!)
    if (box) meshes.push(box)
  }
  const componentRows = workholdingComponentGeometryIds(project.workholding)
  for (const g of project.geometry) {
    if (g.workholding !== true || componentRows.has(g.id)) continue
    meshes.push(workholdingBoxMesh(g.boundingBox, g.position, g.rotation))
  }
  return meshes
}
