// WO-3308: the view-model hook of Control's layout. The Run layout (WO-3298) and the Arrange
// window read and change the layout only through this, so one set of rules answers everywhere.
import { useCallback, useMemo } from 'react'
import { machineKey, selectMachineLayouts, useControlLayouts, type MachineLayouts } from '../../store/slices/controlLayouts'
import {
  DEFAULT_RUN_LAYOUT, columnModules, moveModule, nudgeModule, setFolded, setShown,
  type ControlColumn, type ControlLayout, type ControlModuleId, type ModulePlacement,
} from './layout'

export interface ControlLayoutApi {
  readonly layout: ControlLayout
  readonly record: MachineLayouts
  readonly arranging: boolean
  /** True when the screen differs from the saved layout it started from. */
  readonly changed: boolean
  columns(column: ControlColumn): readonly ModulePlacement[]
  enter(): void
  leave(): void
  move(id: ControlModuleId, column: ControlColumn, index: number): void
  nudge(id: ControlModuleId, delta: -1 | 1): void
  show(id: ControlModuleId, shown: boolean): void
  fold(id: ControlModuleId, folded: boolean): void
}

export function useControlLayout(machineId: string | null | undefined): ControlLayoutApi {
  const key = machineKey(machineId)
  const record = useControlLayouts(s => selectMachineLayouts(s, key))
  const arranging = useControlLayouts(s => s.arranging)
  const layout = record.current
  const apply = useCallback((next: ControlLayout) => {
    if (useControlLayouts.getState().arranging) useControlLayouts.getState().setCurrent(key, next)
  }, [key])
  const saved = record.saved.find(s => s.id === record.activeId)
  return useMemo<ControlLayoutApi>(() => ({
    layout, record, arranging,
    changed: JSON.stringify(layout.placements) !== JSON.stringify((saved ?? DEFAULT_RUN_LAYOUT).placements),
    columns: column => columnModules(layout, column),
    enter: () => useControlLayouts.getState().setArranging(true),
    leave: () => useControlLayouts.getState().setArranging(false),
    move: (id, column, index) => apply(moveModule(layout, id, column, index)),
    nudge: (id, delta) => apply(nudgeModule(layout, id, delta)),
    show: (id, shown) => apply(setShown(layout, id, shown)),
    fold: (id, folded) => apply(setFolded(layout, id, folded)),
  }), [layout, record, arranging, saved, apply])
}
