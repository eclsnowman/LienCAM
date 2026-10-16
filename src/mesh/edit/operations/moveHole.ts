// WO-2804: one journal record carries the entire recognized void, including
// shoulders and cones. Reuse defeature's cap; never fit a replacement cylinder.
import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import type { MeshBuffers, Vec3 } from '../../types'
import { measureMesh } from '../../analysis'
import { booleanMeshWithAncestry, sharedManifoldModule, solidShellCount } from '../../manifoldOps'
import { facetVertices } from '../idView'
import { ancestryFromFacetOwners, composeMeshEditAncestry, mergeMeshEditAncestry } from '../ancestry'
import { registerMeshEditOperation } from '../registry'
import type { MeshEditApplyResult, MeshEditOperation } from '../types'
import { capExposedBoundary, facetSoup } from './boundaryCap'
import { removeRoundFeature } from './removeRoundFeature'
import { booleanAncestry } from './booleanBody'

export const MOVE_HOLE_KIND = 'move-hole'
interface MoveHoleParameters { translation: Vec3; axisDirection: Vec3 }

function vector(value: unknown): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('Move Hole needs finite XYZ coordinates.')
  }
  return value as Vec3
}
export function moveHole(mesh: MeshBuffers, facets: readonly number[], p: MoveHoleParameters): MeshEditApplyResult {
  const d = p.translation, axis = p.axisDirection
  const l = Math.hypot(...axis)
  if (l < 1e-9 || Math.abs(d.reduce((n,v,i) => n+v*axis[i],0))/l > 1e-6) {
    throw new Error('Move Hole stays on the same face: the delta must be perpendicular to the hole axis.')
  }
  if (Math.hypot(...d) < 1e-9) throw new Error('Move Hole needs a nonzero XYZ delta.')
  const module = sharedManifoldModule()
  if (!module) throw new Error('Move Hole is waiting for the geometry kernel.')
  const filled = removeRoundFeature(mesh, facets)
  // Feature walls point into the void. Reverse them, then close their own
  // openings with the same exact-rim cap as Defeature uses on the body.
  // Keep the source's adjacent facets available to the cap: it only closes
  // freshly exposed boundaries, deliberately ignoring pre-existing openings.
  const cap = capExposedBoundary(mesh, facets)
  const cutter = facetSoup([...facets.map(f => facetVertices(mesh,f)), ...cap.triangles].map(([a,b,c]) => [a,c,b]))
  for (let i=0;i<cutter.positions.length;i++) cutter.positions[i] += d[i%3]
  // The translated walls are descendants, while the temporary closing caps
  // are new geometry. Keep their owners through the RIGHT Boolean operand;
  // the filled body's LEFT ancestry alone deliberately lost these walls.
  const moved = ancestryFromFacetOwners(mesh, cutter, [...facets, ...cap.triangles.map(() => -1)], d)
  const step = booleanMeshWithAncestry(module, filled.mesh, cutter, { operation: 'difference' })
  const before = measureMesh(mesh).volume
  const hole = measureMesh(filled.mesh).volume-before
  const after = measureMesh(step.result.mesh).volume
  // A triangle-soup STL may already contain several disconnected solids.
  // Relocation must preserve that input topology, not require a single solid.
  const volumeTolerance = Math.max(1e-4, hole * 1e-5)
  const inputComponents = solidShellCount(mesh, volumeTolerance)
  const outputComponents = solidShellCount(step.result.mesh, volumeTolerance)
  if (!Number.isFinite(after) || outputComponents !== inputComponents || Math.abs(after-before) > volumeTolerance) {
    throw new Error('Move Hole target breaks through a wall or overlaps another hole.')
  }
  const cut = booleanAncestry(filled.mesh,step.result.mesh,step.leftTriangle)
  const walls = booleanAncestry(cutter,step.result.mesh,step.rightTriangle)
  return { mesh: step.result.mesh, ancestry: mergeMeshEditAncestry(
    composeMeshEditAncestry(filled.ancestry,cut),
    composeMeshEditAncestry(moved,walls),
  ) }
}
export const moveHoleOperation: MeshEditOperation<MoveHoleParameters> = {
  kind: MOVE_HOLE_KIND, version: 1, label: workbenchText('MoveHoleEntry.title'),
  describe: record => workbenchText('MoveHoleEntry.applied', { translation: (record.parameters.translation as number[]).join(', ') }),
  validate: p => ({ translation: vector(p.translation), axisDirection: vector(p.axisDirection) }),
  apply: ({mesh,facets,parameters}) => moveHole(mesh,facets,parameters),
}
registerMeshEditOperation(moveHoleOperation)
