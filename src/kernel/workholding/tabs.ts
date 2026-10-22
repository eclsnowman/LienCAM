// The one tab block (A3-19 algorithm steps 5 and 6), at parity with the holding
// tabs in src/lib/cam/contour2d.ts (resolveContourTabs, buildContourTabPlan).
// Tab stock bottom comes from the caller's planning stock record, never the 3D
// viewport, so a headless compute gets exactly the tabs the app does (BL-098).

import { DEFAULT_CONTOUR_TABS, type ContourParams } from '../../lib/cam/types'
import type { LinkingParams } from '../../types'
import type { Point } from '../geometry/contracts'
import type { WorkholdingPolicy } from './contracts'

export interface TabRequest {
  readonly params: Pick<ContourParams, 'tabs' | 'tabWidth' | 'tabHeight' | 'tabCount' | 'tabShape'>
  readonly entryType: LinkingParams['entryType']
  /** The contour's top of cut, machine Z. */
  readonly topZ: number
  /** Stock bottom from the planning stock record, WCS-relative (undefined: unresolved). */
  readonly stockBottomWcsZ: number | undefined
  readonly wcsOriginZ: number
  /** The operation has a finish/profile pass. */
  readonly doFinish: boolean
}

export interface ResolvedTabs {
  readonly width: number
  readonly count: number
  readonly tabTopZ: number
  readonly stockBottomZ: number
  readonly shape: 'box' | 'triangular'
}

export interface TabPlan extends ResolvedTabs {
  readonly path: Point[]
  readonly cumulative: number[]
  readonly perimeter: number
  readonly intervals: Array<{ start: number; end: number }>
}

export type TabOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly line: string }

/** Contour routes as the engine has them today. */
export type ContourRoute = 'offset-rough' | 'trochoidal-rough' | 'finish' | 'multi-region' | 'split-finish' | 'open-chain'
export type RouteTabs = 'honoured' | 'not-honoured' | 'refused'

const ok = <T>(value: T): TabOutcome<T> => ({ ok: true, value })
const refuse = <T>(line: string): TabOutcome<T> => ({ ok: false, line })

function modDistance(value: number, modulus: number): number {
  const result = value % modulus
  return result < 0 ? result + modulus : result
}

function cumulativeOf(path: Point[]): { cumulative: number[]; perimeter: number } {
  const cumulative = [0]
  let perimeter = 0
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    perimeter += Math.hypot(b.x - a.x, b.y - a.y)
    cumulative.push(perimeter)
  }
  return { cumulative, perimeter }
}

function reseamPath(path: Point[], cumulative: number[], d0: number): Point[] {
  const n = path.length
  let i = 0
  while (i < n - 1 && cumulative[i + 1] < d0 - 1e-9) i++
  const segLen = cumulative[i + 1] - cumulative[i]
  const t = segLen <= 1e-9 ? 0 : Math.max(0, Math.min(1, (d0 - cumulative[i]) / segLen))
  const a = path[i]
  const b = path[(i + 1) % n]
  const seam = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  const out: Point[] = [seam]
  for (let k = 1; k <= n; k++) {
    const p = path[(i + k) % n]
    const prev = out[out.length - 1]
    if (Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-9) continue
    if (Math.hypot(p.x - seam.x, p.y - seam.y) < 1e-9) continue
    out.push(p)
  }
  return out
}

/** Tab settings for one operation; the same words as today's engine when it cannot. */
export function resolveTabs(request: TabRequest): TabOutcome<ResolvedTabs | null> {
  const { params } = request
  if (params.tabs !== true) return ok(null)
  const width = params.tabWidth ?? DEFAULT_CONTOUR_TABS.width
  const height = params.tabHeight ?? DEFAULT_CONTOUR_TABS.height
  const count = params.tabCount ?? DEFAULT_CONTOUR_TABS.count
  const shape = params.tabShape ?? 'box'
  if (!Number.isFinite(width) || width <= 0) return refuse('Contour tabs: tab width must be a finite value greater than 0 mm.')
  if (!Number.isFinite(height) || height <= 0) return refuse('Contour tabs: tab height must be a finite value greater than 0 mm.')
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1) return refuse('Contour tabs: tab count must be a positive whole number.')
  if (shape === 'triangular' && width < 2 * height - 1e-9) {
    return refuse(
      `Contour tabs: triangular tabs ramp at 45 deg from both ends, so the tab width must be ` +
      `at least 2 x the tab height. Height ${height.toFixed(3)} mm needs width >= ` +
      `${(2 * height).toFixed(3)} mm (or reduce the tab height).`,
    )
  }
  if (!request.doFinish) {
    return refuse('Contour tabs: a finish/profile pass is required. Roughing-only contours leave wall stock and cannot create holding tabs.')
  }
  if (request.entryType !== 'plunge' && request.entryType !== 'ramp_linear') {
    return refuse(`Contour tabs: entry type "${request.entryType}" is not supported with tabs. Use Plunge or Ramp (linear).`)
  }
  if (!Number.isFinite(request.stockBottomWcsZ)) {
    return refuse('Contour tabs: stock bottom could not be resolved. Bind the setup to visible stock before computing tabs.')
  }
  const stockBottomZ = (request.stockBottomWcsZ as number) + request.wcsOriginZ
  const tabTopZ = stockBottomZ + height
  if (tabTopZ >= request.topZ - 1e-6) {
    return refuse(`Contour tabs: tab height ${height.toFixed(3)} mm does not fit below the contour top ${request.topZ.toFixed(3)} mm.`)
  }
  return ok({ width, count, tabTopZ, stockBottomZ, shape })
}

/** The tab intervals on one closed finish contour: even spacing, or the operator's
 * centres (fractions of the perimeter from the seam) with a re-seam when one spans it. */
export function planTabs(pathIn: readonly Point[], tabs: ResolvedTabs, customFractions?: readonly number[]): TabOutcome<TabPlan> {
  let path = pathIn.map(p => ({ x: p.x, y: p.y }))
  if (path.length < 3) return refuse('Contour tabs: the finished contour has fewer than three points.')
  let { cumulative, perimeter } = cumulativeOf(path)
  if (!Number.isFinite(perimeter) || perimeter <= 1e-6) return refuse('Contour tabs: the finished contour has zero usable perimeter.')

  if (customFractions !== undefined) {
    const valid = customFractions.filter(f => Number.isFinite(f))
    if (valid.length === 0) {
      return refuse('Contour tabs: every custom tab location on this contour is invalid (non-numeric). ' +
        'Re-place the tabs in the viewport or reset to even spacing.')
    }
    let centers = valid.map(f => modDistance(f * perimeter, perimeter)).sort((a, b) => a - b)
    if (tabs.width * centers.length >= perimeter - 1e-6) {
      return refuse(`Contour tabs: ${centers.length} tabs at ${tabs.width.toFixed(3)} mm wide do not fit ` +
        `on the ${perimeter.toFixed(3)} mm contour perimeter.`)
    }
    for (let i = 0; i < centers.length; i++) {
      const next = centers[(i + 1) % centers.length]
      const spacing = i === centers.length - 1 ? next + perimeter - centers[i] : next - centers[i]
      if (centers.length > 1 && spacing < tabs.width - 1e-9) {
        return refuse(`Contour tabs: custom tabs at ${centers[i].toFixed(3)} mm and ` +
          `${modDistance(next, perimeter).toFixed(3)} mm along the contour overlap ` +
          `(tab width ${tabs.width.toFixed(3)} mm needs at least that much center spacing). ` +
          'Move them apart or reset to even spacing.')
      }
    }
    const seamCovered = centers[0] < tabs.width / 2 - 1e-9 || perimeter - centers[centers.length - 1] < tabs.width / 2 - 1e-9
    if (seamCovered) {
      let bestIdx = 0
      let bestSpacing = -Infinity
      for (let i = 0; i < centers.length; i++) {
        const next = centers[(i + 1) % centers.length]
        const spacing = i === centers.length - 1 ? next + perimeter - centers[i] : next - centers[i]
        if (spacing > bestSpacing) { bestSpacing = spacing; bestIdx = i }
      }
      const d0 = modDistance(centers[bestIdx] + bestSpacing / 2, perimeter)
      path = reseamPath(path, cumulative, d0)
      ;({ cumulative, perimeter } = cumulativeOf(path))
      centers = centers.map(c => modDistance(c - d0, perimeter)).sort((a, b) => a - b)
    }
    const intervals = centers.map(c => ({ start: c - tabs.width / 2, end: c + tabs.width / 2 }))
    return ok({ ...tabs, count: centers.length, path, cumulative, perimeter, intervals })
  }

  if (tabs.width * tabs.count >= perimeter - 1e-6) {
    return refuse(`Contour tabs: ${tabs.count} tabs at ${tabs.width.toFixed(3)} mm wide do not fit ` +
      `on the ${perimeter.toFixed(3)} mm contour perimeter.`)
  }
  const spacing = perimeter / tabs.count
  const intervals = Array.from({ length: tabs.count }, (_, i) => {
    const center = (i + 0.5) * spacing
    return { start: center - tabs.width / 2, end: center + tabs.width / 2 }
  })
  return ok({ ...tabs, path, cumulative, perimeter, intervals })
}

/** Which contour routes keep the tabs. Off is today's engine: the single-region
 * Offset and Trochoidal roughing and the finish keep them; a contour whose rough
 * offset splits into several regions (finish still one) is cut by the multi-region
 * branch, which has no tabs (BL-312/313); open chains and a split finish refuse. */
export function tabRoutes(policy: WorkholdingPolicy): Readonly<Record<ContourRoute, RouteTabs>> {
  if (policy.tabs_all_routes) {
    return Object.freeze({ 'offset-rough': 'honoured', 'trochoidal-rough': 'honoured', finish: 'honoured', 'multi-region': 'honoured', 'split-finish': 'honoured', 'open-chain': 'honoured' })
  }
  return Object.freeze({ 'offset-rough': 'honoured', 'trochoidal-rough': 'honoured', finish: 'honoured', 'multi-region': 'not-honoured', 'split-finish': 'refused', 'open-chain': 'refused' })
}
