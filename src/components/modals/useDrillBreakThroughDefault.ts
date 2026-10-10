import { textFor } from '../../i18n'
import { useLayoutEffect, useRef, useState } from 'react'
import { setupProvenStockId, smartHeightStockBounds } from '../../store'
import { fmtMachineLength, unitLabel } from '../../lib/ui/unitFormat'
import {
  DRILL_BREAK_THROUGH_DEFAULT_MM, drillBreakThroughDefault, drillPickedHolesThrough, type DrillBreakThroughDefault,
} from '../../lib/cam/smartHeights/drillBore'
import type { OperatorPlaneOverrides } from '../../lib/cam/smartHeights'
import type { HeightPlaneName, HeightReference, ImportedGeometry, Setup } from '../../types'
import type { useNewOperationModalState } from './useNewOperationModalState'

const tx = textFor('cam-operations-new-operation')

type ModalState = Pick<ReturnType<typeof useNewOperationModalState>,
  'opType' | 'project' | 'displayUnits' | 'drill' | 'setDrill' | 'drillBoreHeightDraft' |
  'drillBreakthroughSetByUser' | 'setDrillBreakthroughSetByUser'>

/** WO-2516: why Break through starts on or off, in plain words. */
function drillBreakThroughReason(start: DrillBreakThroughDefault, displayUnits: ModalState['displayUnits']): string {
  const p1 = fmtMachineLength(DRILL_BREAK_THROUGH_DEFAULT_MM, displayUnits)
  const p2 = unitLabel(displayUnits)
  switch (start.reason) {
    case 'through_holes': return tx('NewOperationModalBody.Break_through_default_through_hole', { p1, p2 })
    case 'blind_holes': return tx('NewOperationModalBody.Break_through_default_hole_with_floor')
    case 'mixed_holes': return tx('NewOperationModalBody.Break_through_default_mixed_holes', {
      p1: String(start.throughHoles), p2: String(start.holes),
    })
    case 'bottom_at_stock_bottom': return tx('NewOperationModalBody.Break_through_default_bottom_at_stock_bottom', { p1, p2 })
    case 'bottom_above_stock_bottom': return tx('NewOperationModalBody.Break_through_default_bottom_above_stock_bottom')
  }
}

/** WO-2516: the Break through a Drill starts with, from the hole it drills.
 * Detected floors ask the picked holes whether they run through; an explicit
 * Target End (or a Bottom row) is compared with the stock bottom. A default,
 * never an override: a new Drill follows its holes until the operator sets
 * Break through; an opened saved Drill keeps its saved value. */
export function useDrillBreakThroughDefault(state: ModalState, input: {
  isEditMode: boolean
  setup: Setup
  bottomRow: OperatorPlaneOverrides['bottom']
  sourceGeometries: readonly ImportedGeometry[]
  loopIds: readonly string[]
  rowReferenceWcs: (reference: HeightReference, resolving: ReadonlySet<HeightPlaneName>) => number | undefined
}) {
  const { opType, project, displayUnits, drill, setDrill, drillBoreHeightDraft } = state
  const { drillBreakthroughSetByUser, setDrillBreakthroughSetByUser } = state
  const { isEditMode, setup, bottomRow } = input
  const isDrill = opType === 'drill'
  const start: DrillBreakThroughDefault | undefined = (() => {
    if (!isDrill) return undefined
    if (drillBoreHeightDraft.mode === 'detected_features' && !bottomRow) {
      return drillBreakThroughDefault({
        mode: 'detected_features',
        holesThrough: drillPickedHolesThrough(input.sourceGeometries, input.loopIds),
      })
    }
    const stockId = setupProvenStockId(setup, project)
    const bounds = stockId ? smartHeightStockBounds(project, stockId) : null
    const rowBase = bottomRow ? input.rowReferenceWcs(bottomRow.reference, new Set(['bottom'])) : undefined
    return drillBreakThroughDefault({
      mode: 'explicit_depth',
      bottomWcsMm: !bottomRow
        ? drillBoreHeightDraft.explicitEndWcsMm
        : rowBase === undefined ? undefined : rowBase + bottomRow.offsetMm,
      stockBottomWcsMm: bounds ? bounds.min.z - setup.wcs.origin.z : undefined,
    })
  })()
  const startMm = start?.breakthroughMm
  const fieldRef = useRef<HTMLDivElement>(null)
  const [fieldKey, setFieldKey] = useState(0)
  const refocusRef = useRef(false)
  useLayoutEffect(() => {
    if (!isDrill || isEditMode || drillBreakthroughSetByUser || startMm === undefined) return
    if ((drill.breakthroughMm ?? 0) === startMm) return
    // Tab from Target End lands in Break through before the new default does;
    // a focused field keeps its old text and would commit it on blur as the
    // operator's own. Show the default in a fresh field, focus kept.
    const field = fieldRef.current
    if (field && document.activeElement && field.contains(document.activeElement)) {
      refocusRef.current = true
      setFieldKey(key => key + 1)
    }
    setDrill(current => ({ ...current, breakthroughMm: startMm }))
  }, [isDrill, isEditMode, drillBreakthroughSetByUser, startMm, drill.breakthroughMm, setDrill])
  useLayoutEffect(() => {
    if (!refocusRef.current) return
    refocusRef.current = false
    fieldRef.current?.querySelector('input')?.focus()
  }, [fieldKey])
  return {
    /** The plain-words note under Break through; undefined when no default applies. */
    reason: start ? drillBreakThroughReason(start, displayUnits) : undefined,
    fieldRef,
    fieldKey,
    /** The operator's own Break through - kept from here on. */
    setByUser(breakthroughMm: number) {
      setDrill(current => ({ ...current, breakthroughMm }))
      setDrillBreakthroughSetByUser(true)
    },
  }
}
