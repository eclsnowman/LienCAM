import { findModelBodyGeometryRow } from '../lib/cam/modelBodyAdapter'
import { useCamStore } from './index'
import { useModelSelectionBridge } from './modelSelectionBridge'

/**
 * NAV-BODY-ROW (path 3, select-then-mode-switch): leaving the Model workspace for a CAM tab
 * carries the BODY selected there into viewer.selectedGeometryId, through the same forward
 * lookup the context-menu and inline-icon paths use (findModelBodyGeometryRow). Nothing
 * selected, a non-body DAG node, or a body with no CAM row yet leaves the CAM selection
 * untouched: never a dead end. Shared by the shipped tab strip and the New UI tabs.
 */
export function carryModelBodySelectionToCam(): void {
  const bridge = useModelSelectionBridge.getState()
  if (bridge.selectedBodyId === null) return
  const st = useCamStore.getState()
  const row = findModelBodyGeometryRow(st.project.geometry, bridge.selectedBodyId, bridge.selectedBodyModelItemId)
  if (row !== undefined) st.setSelectedGeometry(row.id)
}
