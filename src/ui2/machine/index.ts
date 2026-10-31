// WO-3303: the Machine lane's public surface.
export { MachinePill, MachineChoiceCard } from './MachinePill'
export { MachineWindow } from './MachineWindow'
export { GantryDrawing } from './GantryDrawing'
export { fixingItems, fixingCounts, type FixingItem } from './fixing'
export { capabilityRows } from './capabilities'
export {
  openMachineWindow, openMachineDefinition, closeMachineWindow, getMachineWindowState, MACHINE_PAGES,
  type MachinePage, type DefinitionArea,
} from './windowState'
export { registration } from './registration'
