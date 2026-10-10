import { Algorithm, SolveStatus as PlanegcsSolveStatus } from '@salusoft89/planegcs'
import type { GcsWrapper } from '@salusoft89/planegcs'
import {
  Sketch3dMappingError,
  mapDiagnosticIds,
  positionsFromEntities,
  sketch3dEntitiesFromSolved,
  sketch3dEntityHandles,
  sketch3dToPrimitives,
} from './solveBridge'
import { createSketch3dGcsWrapper } from '../lib/planegcs/planegcsLoader'
import type { Sketch3dDocument, Sketch3dSolveOptions, Sketch3dSolveResult } from './types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cloneEntities(document: Sketch3dDocument): Sketch3dDocument['entities'] {
  return document.entities.map((entity) => ({ ...entity }))
}

function failedResult(
  status: Sketch3dSolveResult['status'],
  error: string,
  document: Sketch3dDocument,
): Sketch3dSolveResult {
  return {
    status,
    rawStatus: null,
    dof: 0,
    conflicting: [],
    redundant: [],
    handles: sketch3dEntityHandles(document),
    updatedPositions: positionsFromEntities(document.entities),
    entities: cloneEntities(document),
    error,
  }
}

export class Sketch3dSolveService {
  private disposed = false
  private readonly wrapper: GcsWrapper

  private constructor(wrapper: GcsWrapper) {
    this.wrapper = wrapper
  }

  // Optional wrapper injection exists for the dispose-contract test, which must
  // observe the underlying wasm object's delete() being called. Production
  // callers pass nothing.
  static async create(wrapper?: GcsWrapper): Promise<Sketch3dSolveService> {
    return new Sketch3dSolveService(wrapper ?? await createSketch3dGcsWrapper())
  }

  solve(document: Sketch3dDocument, options: Sketch3dSolveOptions = {}): Sketch3dSolveResult {
    if (this.disposed) {
      return failedResult('failed', 'sketch3d solver service has been disposed', document)
    }

    try {
      // Route the SKC solve through the ONE surviving 2D mapping (WO SKC-6B):
      // translate the SKC document into the 2D Sketch model and build primitives
      // via gcsMapping.sketchToGcsPrimitives. The solve loop below is unchanged
      // from the pre-route SKC service (same DogLeg call, same status/dof and
      // conflicting/redundant reporting, same one-GcsSystem-per-service reuse).
      const { sketch, primitives } = sketch3dToPrimitives(document)
      this.wrapper.clear_data()
      this.wrapper.push_primitives_and_params(primitives)

      const rawStatus = this.wrapper.solve(options.algorithm ?? Algorithm.DogLeg)
      const dof = this.wrapper.gcs.dof()
      const conflicting = mapDiagnosticIds(this.wrapper.get_gcs_conflicting_constraints())
      const redundant = mapDiagnosticIds([
        ...this.wrapper.get_gcs_redundant_constraints(),
        ...this.wrapper.get_gcs_partially_redundant_constraints(),
      ])

      if (conflicting.length > 0) {
        return {
          status: 'conflicting',
          rawStatus,
          dof,
          conflicting,
          redundant,
          handles: sketch3dEntityHandles(document),
          updatedPositions: positionsFromEntities(document.entities),
          entities: cloneEntities(document),
          error: 'solver reported conflicting constraints: ' + conflicting.join(', '),
        }
      }

      if (rawStatus !== PlanegcsSolveStatus.Success && rawStatus !== PlanegcsSolveStatus.Converged) {
        return {
          status: 'failed',
          rawStatus,
          dof,
          conflicting,
          redundant,
          handles: sketch3dEntityHandles(document),
          updatedPositions: positionsFromEntities(document.entities),
          entities: cloneEntities(document),
          error: 'planegcs solve returned status ' + rawStatus,
        }
      }

      this.wrapper.apply_solution()
      const entities = sketch3dEntitiesFromSolved(document, sketch, this.wrapper)
      return {
        status: redundant.length > 0 ? 'redundant' : 'success',
        rawStatus,
        dof,
        conflicting,
        redundant,
        handles: sketch3dEntityHandles(document),
        updatedPositions: positionsFromEntities(entities),
        entities,
      }
    } catch (error) {
      return failedResult(
        error instanceof Sketch3dMappingError ? 'invalid_sketch' : 'failed',
        errorMessage(error),
        document,
      )
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.wrapper.destroy_gcs_module()
    this.disposed = true
  }
}

export async function createSketch3dSolveService(): Promise<Sketch3dSolveService> {
  return Sketch3dSolveService.create()
}
