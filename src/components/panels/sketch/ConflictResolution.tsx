import { useText } from '../../../i18n'
import { useEffect, useMemo } from 'react'
import { useCamStore } from '../../../store'
import { rowsForIds, type BrowserRow } from '../../../lib/sketch/browserModel'
import { BrowserRowView } from './ConstraintBrowser'
import { AlertTriangle, Info } from 'lucide-react'

// Over-defined conflict resolution flow (Stage 4, PLAN 3.5: "over-defined
// banner with conflict resolution (delete one of the named set)").
//
// Opened from the solve banner's "Resolve..." button. Lists the
// SOLVER-NAMED conflicting set as browser rows (same component: glyph,
// operand labels, hover-highlight of bound entities); each row's Remove
// deletes THAT constraint/dimension (pushHistory + re-solve through
// deleteSketchItems). The panel tracks the live status: removing one
// member refreshes the list with the remaining named set, and the flow
// closes itself once nothing is left to resolve.
//
// REDUNDANT constraints surface the same way in a separate amber list —
// advisory, not an error (the geometry solves; the constraint adds no
// information). Removal is offered but optional.

export function ConflictResolutionPanel({ onClose }: { onClose: () => void }) {
  const workbenchText = useText('sketch-and-model-workbench')
  const activeSketch = useCamStore((s) => s.activeSketch)
  const liveStatus = useCamStore((s) => s.sketchSolveStatus)
  const selectedIds = useCamStore((s) => s.sketchSelectedIds)
  const setSketchSelection = useCamStore((s) => s.setSketchSelection)
  const deleteSketchItems = useCamStore((s) => s.deleteSketchItems)

  // Same status precedence as the banner that opened us.
  const status = liveStatus ?? activeSketch?.solveStatus ?? null

  const conflictRows = useMemo<BrowserRow[]>(
    () =>
      activeSketch && status
        ? rowsForIds(activeSketch, status.conflicting).map((r) => ({
            ...r, status: 'conflicting' as const,
          }))
        : [],
    [activeSketch, status],
  )
  const redundantRows = useMemo<BrowserRow[]>(
    () =>
      activeSketch && status
        ? rowsForIds(activeSketch, status.redundant).map((r) => ({
            ...r, status: 'redundant' as const,
          }))
        : [],
    [activeSketch, status],
  )

  // Close the flow once there is nothing left to resolve. A null status
  // mid-flow means a solve is in flight — hold until its verdict lands
  // (closing on "solving..." would hide a conflict that is still there).
  const done =
    !activeSketch ||
    (status !== null && conflictRows.length === 0 && redundantRows.length === 0)
  useEffect(() => {
    if (done) onClose()
  }, [done, onClose])
  if (done) return null

  const onSelect = (row: BrowserRow, additive: boolean) => {
    if (additive) {
      setSketchSelection(
        selectedIds.includes(row.id)
          ? selectedIds.filter((id) => id !== row.id)
          : [...selectedIds, row.id],
      )
    } else {
      setSketchSelection([row.id])
    }
  }

  return (
    <div className="sketch-resolve-panel">
      {conflictRows.length > 0 && (
        <>
          <div className="sketch-resolve-title sketch-resolve-title-conflict">
            <AlertTriangle size={11} />
            <span>
              {workbenchText('ConflictResolution.conflictingSetRemoveOneToResolve', { length: String((conflictRows.length) ?? '') })}</span>
          </div>
          {conflictRows.map((row) => (
            <BrowserRowView
              key={row.id}
              row={row}
              selected={selectedIds.includes(row.id)}
              onSelect={onSelect}
              actionTitle="Remove this constraint/dimension to resolve the conflict"
              onAction={(r) => deleteSketchItems([r.id])}
            />
          ))}
        </>
      )}
      {redundantRows.length > 0 && (
        <>
          <div className="sketch-resolve-title sketch-resolve-title-redundant">
            <Info size={11} />
            <span>
              {workbenchText('ConflictResolution.redundantAdvisoryRemovalOptional', { length: String((redundantRows.length) ?? '') })}</span>
          </div>
          {redundantRows.map((row) => (
            <BrowserRowView
              key={row.id}
              row={row}
              selected={selectedIds.includes(row.id)}
              onSelect={onSelect}
              actionTitle="Remove this redundant constraint (optional)"
              onAction={(r) => deleteSketchItems([r.id])}
            />
          ))}
        </>
      )}
      <button className="sketch-resolve-close" onClick={onClose}>
        {workbenchText('ConflictResolution.close')}</button>
    </div>
  )
}
