export * from './types';
export * from './analysis';
export { exportBinaryStl, exportStl, importStl, parseStl } from './stl';
export {
  convertPrismaticMesh,
  type PrismaticConversionResult,
  type PrismaticConfidenceReport,
  type PlanarFaceReport,
  type CurvedRegion,
  type PrismaticOptions,
} from './prismatic';
// WO-1845 / ADR-0051: the STL edit journal (id view, records, registry,
// replay, and THE resolver every route that needs an STL's shape goes through).
export * from './edit';
// WO-1846: the round features an imported STL can PROVE - holes, blind holes,
// bosses, counterbores, countersinks, chamfered holes - each with its axis,
// diameters, depth and the worst facet's deviation from the fitted surface.
// Read-only: it never edits the mesh and never feeds prismatic promotion.
export * from './recognition';
export { ManifoldKernel } from './manifoldKernel';
export * from './manifoldOps';
export {
  meshFromTessBuffers,
  meshOperand,
  brepOperand,
  crossDomainBooleanMesh,
  CrossDomainBooleanRefusedError,
  type TessellatedBrepBuffers,
  type CrossDomainOperandSource,
  type CrossDomainOperand,
  type CrossDomainBooleanResult,
} from './crossDomainBoolean';
export { MeshWorkerClient } from './worker/client';
export { Comlink, isTransferEnvelope } from './worker/comlink';
export { exposeMeshWorker, handleMeshWorkerCall } from './worker/host';
export { createMeshWorkerApi, MeshService } from './worker/mesh-service';
