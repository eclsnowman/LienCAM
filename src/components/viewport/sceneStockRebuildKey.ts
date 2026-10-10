import type { Project } from '../../types'

/**
 * Pure builder for the viewport stock-rebuild reactive key.
 *
 * The stock box mesh is rebuilt by the Viewport effect ONLY when this key
 * changes (see Viewport.tsx). The key must therefore encode every piece of
 * store state that should move/resize a stock box on a typed Properties edit:
 *   - auto-stock ids
 *   - fixed-stock ids AND their POSITION (a typed updateFixedStock({position})
 *     changes only the FixedStockItem.position; the PhysicalStock twin `bounds`
 *     is always a 0-origin box, so position MUST be encoded here or a typed
 *     move never rebuilds the box -> it "reverts" to the old spot)
 *   - PhysicalStock bounds (size/extent of each twin)
 *   - member geometry id + stockId + position (a stock-tied part move re-wraps)
 *
 * Extracted to a pure, unit-testable function so the regression test can assert
 * the key changes on a typed fixed-stock position edit.
 */
export function buildSceneStockRebuildKey(project: Project): string {
  const ss = project.sceneStock
  const autos = (ss.autoStocks ?? []).map(a => a.id).join(',')
  // Fixed stocks contribute id + position so a TYPED position edit re-wraps live.
  const fixed = (ss.fixedStocks ?? [])
    .map(f => `${f.id}:${f.position.x},${f.position.y},${f.position.z}`)
    .join(',')
  const stocks = (project.stocks ?? [])
    .map(st => `${st.id}:${st.bounds?.min.x},${st.bounds?.min.y},${st.bounds?.min.z},${st.bounds?.max.x},${st.bounds?.max.y},${st.bounds?.max.z}`)
    .join('|')
  // Geometry contributes id + position so a stock-tied part MOVE re-wraps live.
  const geo = project.geometry
    .map(g => `${g.id}:${g.stockId ?? ''}:${g.position.x},${g.position.y},${g.position.z}`)
    .join('|')
  return `${autos}#${fixed}#${stocks}#${geo}`
}
