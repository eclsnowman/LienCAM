import type { FrameRef } from '../../lib/geometry/coordinateFrames'
import type { FaceWorkerPayload } from '../../lib/cam/types'
import type { Tool, ToolpathMove } from '../../types'
import type { createGeometryService } from '../geometry'
import type { EngineId, KernelPlan, KernelPlanner, PlanningInput } from '../planning'
import type { DeepReadonly } from '../tools/model'

/** Composition supplies WO-2931/2932 services with the existing native authorities. */
export interface FacePlanningServices {
  geometry: ReturnType<typeof createGeometryService>
  tools: { describe(tool: Tool): { readonly record: DeepReadonly<Tool> } }
}

/** Frame is the caller's WO-2945 token, not another kernel frame definition.
 * All loops are already W/mm; height numbers retain the worker's WCS-relative
 * convention. This adapter neither transforms coordinates nor derives stock. */
export interface ResolvedFaceInput<Frame> {
  frame: Frame
  payload: Omit<FaceWorkerPayload, 'opId' | 'setupId' | 'tool'>
  resolvedHeights: KernelPlan['resolvedHeights']
  resolvedHeightPlan: KernelPlan['resolvedHeightPlan']
}

export interface FacePlannerDependencies<Frame> extends FacePlanningServices {
  resolve(input: PlanningInput, services: FacePlanningServices): Promise<ResolvedFaceInput<Frame>>
  /** Assert W/mm, frame identity/revision and current request dependencies.
   * Required at every asynchronous boundary; throw on stale/unsupported inputs. */
  assertCurrent(resolved: ResolvedFaceInput<Frame>, input: PlanningInput): void
  ready(): Promise<void>
  /** Reuse the existing builder; production composition must also retain the
   * worker's reach/workholding postprocessing before publishing any moves. */
  build(payload: FaceWorkerPayload): ToolpathMove[] | Promise<ToolpathMove[]>
  now?: () => number
}

/** Executable pilot, never globally registered with a partial store resolver.
 * No catch/fallback: an explicit kernel request must either succeed or refuse. */
export function createFacePlanner<Frame>(dependencies: FacePlannerDependencies<Frame>): KernelPlanner {
  const { geometry, tools, resolve, assertCurrent, ready, build } = dependencies
  if (geometry.profile.id !== 'face') throw new Error('Face kernel: the Face compatibility geometry profile is required.')
  if (typeof resolve !== 'function' || typeof assertCurrent !== 'function'
    || typeof ready !== 'function' || typeof build !== 'function') {
    throw new Error('Face kernel: a complete resolver, frame assertion, readiness and builder are required.')
  }
  const now = dependencies.now ?? (() => performance.now())
  return async input => {
    if (input.operation.type !== 'face') throw new Error('Face kernel: this planner only handles Face operations.')
    const started = now()
    // Preserve the explicitly selected tool, including hand, recipes and unknown
    // optional geometry. A resolver cannot silently substitute another cutter.
    const tool = structuredClone(tools.describe(input.tool).record) as Tool
    const resolved = await resolve(input, { geometry, tools })
    if (!resolved.resolvedHeights || !resolved.resolvedHeightPlan) {
      throw new Error('Face kernel: the resolver must supply both resolved height metadata objects.')
    }
    assertCurrent(resolved, input)
    const payload: FaceWorkerPayload = {
      ...structuredClone(resolved.payload), tool,
      opId: input.operation.id, setupId: input.setup.id,
    }
    const resolvedHeights = structuredClone(resolved.resolvedHeights)
    const resolvedHeightPlan = structuredClone(resolved.resolvedHeightPlan)
    await ready()
    assertCurrent(resolved, input)
    const moves = await build(payload)
    assertCurrent(resolved, input)
    return { moves, resolvedHeights, resolvedHeightPlan, computeTimeMs: now() - started }
  }
}

/** The store sends this only after its existing manifest preparation is complete.
 * Payload XY and move XYZ are world/mm; payload heights are WCS-relative mm.
 * This is not a stock contract or a controller coordinate token. */
export interface FacePilotEnvelope {
  engine: Exclude<EngineId, 'current'>
  frame: FrameRef<'world'>
  input: PlanningInput
  resolvedHeights: KernelPlan['resolvedHeights']
  resolvedHeightPlan: KernelPlan['resolvedHeightPlan']
}
