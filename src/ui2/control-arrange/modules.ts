// WO-3308: the words and sizes of each Control module in the Arrange window.
import type { ControlColumn, ControlModuleId, LockedPartId } from './layout'

export const MODULE_LABEL_KEY = {
  machine: 'moduleMachine', position: 'modulePosition', offsets: 'moduleOffsets', tool: 'moduleTool',
  program: 'moduleProgram', console: 'moduleConsole', jog: 'moduleJog', overrides: 'moduleOverrides',
  spindle: 'moduleSpindle', macros: 'moduleMacros', cycleLog: 'moduleCycleLog', simulatedPart: 'moduleSimulatedPart',
} as const satisfies Record<ControlModuleId, string>

export const LOCKED_LABEL_KEY = { stateChip: 'stateChip', runSection: 'runSection' } as const satisfies Record<LockedPartId, string>

export const COLUMN_LABEL_KEY = { left: 'columnLeft', centre: 'columnCentre', right: 'columnRight' } as const satisfies Record<ControlColumn, string>
