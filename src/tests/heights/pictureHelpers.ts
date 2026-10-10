// WO-1608: drawing helpers shared by the picture-report test files in this
// directory. Not a test file itself - the picture report is split one
// scenario kind per FILE (never one describe per file with shared state)
// because vitest's default per-file isolation is what actually keeps two
// unrelated scenarios' `useCamStore` state from bleeding into each other; two
// solid scenarios run back to back in ONE file were observed to corrupt each
// other's tool/operation resolution (a real store-state hazard, traced as far
// as this order's owned paths allow - see pictureReportDrill.wo1608.test.ts's
// header for the specific symptom). Splitting files is the fix within reach
// here; nothing below works around it, it just avoids triggering it.

import {
  isCutting, isRapid, type HeightReading, type ScenarioOperation, type ScenarioStock, type SolidOperation,
} from '../helpers/heightScenario'
import type { PathKind, PathPoint, ToolPlacement } from '../helpers/sideViewEvidence'
import type { Tool, ToolHolder, ToolpathMove, Vec3 } from '../../types'

export const DIR = 'src/tests/evidence/WO-1608'
export const RAISE = 50
export const TOL = 0.01

// ─── tool + holder fixtures for drawing (the same shapes heightScenario's own
// scenarioTool/solidTool build; not exported, so redrawn here plainly) ───────

export const HOLDER: ToolHolder = { id: 'holder-1', name: 'ER32 collet chuck', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }

export function tool2D(name: string, diameter: number): Tool {
  return {
    id: 'tool-1', name, type: 'flat_end_mill', diameter,
    fluteLength: 30, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', toolNumber: 1,
  } as unknown as Tool
}

export function toolSolid(name: string, diameter: number, type: 'flat_end_mill' | 'ball_end_mill' | 'drill'): Tool {
  return {
    id: 'tool-1', name, type, diameter,
    fluteLength: 40, shankDiameter: diameter, overallLength: 80, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', toolNumber: 1,
  } as unknown as Tool
}

// ─── drawing helpers shared by every picture ────────────────────────────────

export function toPath(moves: readonly ToolpathMove[], cap = 1500): PathPoint[] {
  const step = Math.max(1, Math.floor(moves.length / cap))
  const out: PathPoint[] = []
  for (let i = 0; i < moves.length; i += step) {
    const m = moves[i]
    const kind: PathKind = m.type === 'rapid' || m.role === 'rapid' ? 'traverse' : m.role === 'plunge' ? 'plunge' : 'cut'
    out.push({ x: m.x, y: m.y, z: m.z, kind })
  }
  return out
}

/** The tool at its deepest cutting move: where a height verdict is read. */
export function deepestPlacement(moves: readonly ToolpathMove[], op?: ScenarioOperation): ToolPlacement {
  const cutting = moves.filter(m => isCutting(m, op))
  const deepest = cutting.reduce((a, b) => (b.z < a.z ? b : a))
  return { x: deepest.x, tipZ: deepest.z }
}

/** Rapids strictly between the first and last feed move: the links a rough or
 * finish plans between separate cuts (mirrors solids3d.wo1606.test.ts's own). */
export function interiorRapids(moves: readonly ToolpathMove[]): ToolpathMove[] {
  const firstFeed = moves.findIndex(m => !isRapid(m))
  let lastFeed = -1
  moves.forEach((m, i) => { if (!isRapid(m)) lastFeed = i })
  return moves.filter((m, i) => isRapid(m) && i > firstFeed && i < lastFeed)
}

function boxFrom(min: Vec3, max: Vec3): readonly [number, number, number, number, number, number] {
  return [min.x, min.y, min.z, max.x, max.y, max.z]
}

/** Stock as an obstacle in the harness's own WCS frame (XY from stockXY, Z from
 * the stock top/bottom readings) - every field already computed by the harness,
 * nothing recomputed here. */
export function stockObstacle(r: { stockXY: HeightReading['stockXY']; stockTopWcs: number; stockBottomWcs: number }) {
  return {
    columns: [[r.stockXY.minX, r.stockXY.maxX, r.stockBottomWcs, r.stockTopWcs] as const],
    yRange: [r.stockXY.minY, r.stockXY.maxY] as const,
    colour: '#2980b9', label: 'stock', showLabel: true,
  }
}

export function workholdingObstacle(wcs: { min: Vec3; max: Vec3 }) {
  const [x0, y0, z0, x1, y1, z1] = boxFrom(wcs.min, wcs.max)
  return { columns: [[x0, x1, z0, z1] as const], yRange: [y0, y1] as const, colour: '#c0392b', label: 'workholding' }
}

export const TABLE_REF = (wcsOriginMachineZ: number) => ({ z: -wcsOriginMachineZ, label: 'table (machine Z 0)' })

export function pass(finding?: string): string {
  return finding ? `finding ${finding}` : 'pass'
}

// ─── the closed-box rough (pictures 7, 8, 9): docs/testing/SMART-HEIGHTS-CAMPAIGN.md,
// BOX_FRAME.fixed and slice 3's sequence section ───────────────────────────

export const BOX_FIXED_STOCK: ScenarioStock = { kind: 'fixed', width: 50, height: 40, depth: 15, position: { x: -10, y: -10, z: 0 } }
export const BOX_AUTO_STOCK: ScenarioStock = { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }
export const BOX_FIXED_BOTTOM = -15 // WCS, closed_box on fixed stock
export const ROUGH_LEFT_TOP = -4.5 // WCS: the box top -5 + the rough's 0.5 mm axial stock to leave

export function roughOp(): SolidOperation {
  return { kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5, params: { useStockBoundary: true } }
}
