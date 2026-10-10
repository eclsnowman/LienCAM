import type { StockState } from '../stockState'

/** A plan-view rectangle in the stock state's frame (the moves' world XY). */
export interface MaterialRegionXY {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * WO-1609: the highest material a replayed stock state still holds anywhere
 * over a region. Every column the rectangle touches counts, so a region that
 * reaches one column an earlier operation missed reads the height of that
 * column: the answer can be too high (cutting some air), never too low.
 * A column cut through reads as the stock bottom. Undefined when the region
 * lies wholly outside the stock.
 */
export function highestMaterialOver(stock: StockState, region: MaterialRegionXY): number | undefined {
  const values = [region.minX, region.minY, region.maxX, region.maxY]
  if (values.some(value => !Number.isFinite(value))) return undefined
  if (region.maxX < region.minX || region.maxY < region.minY) return undefined
  const cell = stock.resolutionMm
  const i0 = Math.max(0, Math.floor((region.minX - stock.bounds.minX) / cell))
  const i1 = Math.min(stock.nx - 1, Math.ceil((region.maxX - stock.bounds.minX) / cell) - 1)
  const j0 = Math.max(0, Math.floor((region.minY - stock.bounds.minY) / cell))
  const j1 = Math.min(stock.ny - 1, Math.ceil((region.maxY - stock.bounds.minY) / cell) - 1)
  // A zero-width region still names the column it sits in.
  const iHi = Math.max(i0, i1)
  const jHi = Math.max(j0, j1)
  if (i0 >= stock.nx || j0 >= stock.ny || iHi < 0 || jHi < 0) return undefined
  let highest = stock.bottomZ
  for (let j = j0; j <= Math.min(jHi, stock.ny - 1); j++) {
    for (let i = i0; i <= Math.min(iHi, stock.nx - 1); i++) {
      const top = stock.topZ[j * stock.nx + i]
      if (top > highest) highest = top
    }
  }
  return highest
}
