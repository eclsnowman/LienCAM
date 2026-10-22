import type { OperationType } from '../../types'
import type { Point } from '../geometry/contracts'
import type { createGeometryService } from '../geometry'
import {
  PARITY_POLICY, type DepthBand, type DepthBandRequest, type IslandRouting, type KeepOutLevel, type Obstacle,
  type ObstacleColumns, type ObstacleMesh, type ObstacleOmission, type ObstacleTop, type ReducedRegion,
  type SetupInput, type SetupRecord, type WorkholdingPolicy,
} from './contracts'
import { createKeepOuts } from './keepout'
import { planTabs, resolveTabs, tabRoutes, type ResolvedTabs, type TabOutcome, type TabPlan, type TabRequest } from './tabs'

export * from './contracts'
export { planTabs, resolveTabs, tabRoutes } from './tabs'
export type { ContourRoute, ResolvedTabs, RouteTabs, TabOutcome, TabPlan, TabRequest } from './tabs'

/** The composition root supplies the existing authorities: the WO-2931 geometry
 * service on the Face backend (after ensureClipperReady) and today's
 * buildSolidColumns, so the keep-out reads the same grid the reach trim tests. */
export interface WorkholdingAuthorities {
  readonly geometry: ReturnType<typeof createGeometryService>
  readonly solidColumns: (mesh: ObstacleMesh) => ObstacleColumns | null
}

/** Families that plan around workholding in today's engine (WO-1579/1623). Every
 * other family is planned through it and trimmed afterwards by the reach trim. */
const PLAN_AROUND_TODAY: ReadonlySet<OperationType> = new Set<OperationType>(['pocket_2d', 'adaptive_clearing_2d'])

export interface TabBlockLoop {
  readonly loopId: string
  /** The loop's closed finish contour in cut direction (seam at path[0]). */
  readonly path: readonly Point[]
}

export interface TabBlock {
  readonly tabs: ResolvedTabs
  /** One entry per loop in the caller's order; tab k of loop i has stable index `${loopId}#${k}`. */
  readonly loops: readonly { readonly loopId: string; readonly plan: TabPlan; readonly tabIds: readonly string[] }[]
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !ArrayBuffer.isView(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as object)) deepFreeze(child)
  }
  return value
}

function columnBounds(columns: ObstacleColumns): Pick<Obstacle, 'footprint' | 'bottomZ' | 'topZ'> | null {
  let bottomZ = Number.POSITIVE_INFINITY
  let topZ = Number.NEGATIVE_INFINITY
  for (let k = 0; k + 1 < columns.spanZ.length; k += 2) {
    bottomZ = Math.min(bottomZ, columns.spanZ[k])
    topZ = Math.max(topZ, columns.spanZ[k + 1])
  }
  if (!Number.isFinite(bottomZ) || !Number.isFinite(topZ)) return null
  return {
    footprint: { minX: columns.originX, minY: columns.originY,
      maxX: columns.originX + columns.nx * columns.cell, maxY: columns.originY + columns.ny * columns.cell },
    bottomZ, topZ,
  }
}

/**
 * Headless workholding and setup-tabs service (alpha.3 A3-19, P2 parity slice).
 * Nothing in the app calls it yet; the engine selector stays `current`.
 */
export function createWorkholdingService(authorities: WorkholdingAuthorities, policyIn: WorkholdingPolicy = PARITY_POLICY) {
  if (typeof authorities?.solidColumns !== 'function') throw new Error('Workholding kernel: a solid column builder is required.')
  const keepOuts = createKeepOuts(authorities.geometry)
  const policy: WorkholdingPolicy = Object.freeze({
    keepout_in_planning: policyIn.keepout_in_planning === true,
    tabs_all_routes: policyIn.tabs_all_routes === true,
  })

  return {
    policy,

    /** Step 1: the setup record, plus the keep-out queries that read its obstacles. */
    setup<Frame, Envelope>(input: SetupInput<Frame, Envelope>) {
      const obstacles: Obstacle[] = []
      const omissions: ObstacleOmission[] = []
      // Index-aligned with input.obstacles: a null entry is skipped, as the engine skips it.
      const columns: (ObstacleColumns | null)[] = []
      for (const item of input.obstacles) {
        const name = item.name ?? item.id
        const built = item.mesh ? authorities.solidColumns(item.mesh) : null
        const bounds = built ? columnBounds(built) : null
        columns.push(bounds ? built : null)
        if (bounds) {
          obstacles.push({ id: item.id, name, kind: item.kind ?? 'other', ...bounds })
          continue
        }
        const reason = item.mesh ? 'unreadable-mesh' : 'no-mesh'
        omissions.push({ id: item.id, reason,
          line: `${name}: the workholding has no readable shape, so planning goes ahead without keeping clear of it.` })
      }
      const record: SetupRecord<Frame, Envelope> = deepFreeze(structuredClone({
        setupId: input.setupId,
        frame: input.frame,
        ...(input.flipOf !== undefined ? { flipOf: input.flipOf } : {}),
        ...(input.envelope !== undefined ? { envelope: input.envelope } : {}),
        obstacles, omissions,
      }))

      return {
        record,
        /** Step 2: footprint islands for one cutting window (grown by allowance + grid slack). */
        keepOuts(level: KeepOutLevel): Point[][] {
          return keepOuts.atLevel(columns, level)
        },
        /** Step 2 over an operation's depths: bands sharing one footprint (WO-1618). */
        depthBands(request: DepthBandRequest): DepthBand[] {
          return keepOuts.depthBands(columns, request)
        },
        reduceRegion(regionLoops: readonly Point[][], islands: readonly Point[][]): ReducedRegion | null {
          return keepOuts.reduceRegion(regionLoops, islands)
        },
        /** Step 2: where the tool centre may not go (islands grown by the tool radius). */
        toolCentreKeepOuts(islands: readonly Point[][], toolRadiusMm: number): Point[][] {
          return keepOuts.toolCentre(islands, toolRadiusMm)
        },
        /** Step 4: obstacle tops for the heights service, highest first. */
        obstacleTops(): ObstacleTop[] {
          return record.obstacles.map(o => ({ id: o.id, topZ: o.topZ })).sort((a, b) => b.topZ - a.topZ || a.id.localeCompare(b.id))
        },
      }
    },

    /** Step 3: how a family receives the keep-outs. The reach trim stays the backstop. */
    islandRouting(family: OperationType): IslandRouting {
      const route = policy.keepout_in_planning || PLAN_AROUND_TODAY.has(family) ? 'plan-around' : 'trim-after'
      return { family, route, backstop: 'reach-trim' }
    },

    /** Steps 5-6: the one tab block for a contour operation. */
    tabBlock(request: TabRequest, loops: readonly TabBlockLoop[], tabLocations?: Readonly<Record<string, readonly number[]>>): TabOutcome<TabBlock | null> {
      const resolved = resolveTabs(request)
      if (!resolved.ok) return resolved
      if (!resolved.value) return { ok: true, value: null }
      const planned: { loopId: string; plan: TabPlan; tabIds: string[] }[] = []
      for (const loop of loops) {
        const custom = tabLocations?.[loop.loopId]
        const plan = planTabs(loop.path, resolved.value, custom && custom.length > 0 ? custom : undefined)
        if (!plan.ok) return plan
        planned.push({ loopId: loop.loopId, plan: plan.value, tabIds: plan.value.intervals.map((_, k) => `${loop.loopId}#${k}`) })
      }
      return { ok: true, value: { tabs: resolved.value, loops: planned } }
    },

    tabRoutes() {
      return tabRoutes(policy)
    },
  }
}
