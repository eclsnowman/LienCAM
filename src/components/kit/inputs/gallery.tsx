// WO-3278 (UI M2 W1-A): one example per input part and state, for the W1-H gallery to pick up.
import type { ReactElement } from 'react'
import { InvalidNumberDemo, NumberDemo, PickDemo, SegDemo, SliDemo, TextDemo, TogDemo } from './gallery-demos'
import type { Availability } from '../../../commands/types'
import type { MessageKey, MessageParams } from '../../../notices'

export interface InputExample {
  readonly part: string
  readonly state: string
  readonly element: ReactElement
}

// Each unavailable example gives a reason that fits its own control (WO-3293). All are existing
// catalogue messages; the sample label beside each is chosen to match its reason.
const why = (reason: MessageKey, params?: MessageParams): Availability => ({ ready: false, reason, params })
const MAX_RATE = why('control-screens-not-probing:MachineArea.text004')
const ROUTINE = why('probing-screens:probeRoutineEditor97')
const NO_SOLID = why('cam-operations-new-operation:NewOperationModalBody.No_3D_solid_loaded')
const NEST_FIXED = why('cam-operations-new-operation:NestModal.Orientation_locked_solver_will_not_rotate_this_part')
const ENGRAVE_TABS = why('engrave-vcarve-fields.wo3199:tabs')
const FILLET = why('sketch-and-model-workbench:dressUpDeadClick.filletNotChangeable', { face: 'face' })
const FREE_FIXED = [{ value: 'free', label: 'Free' }, { value: 'fixed', label: 'Fixed' }] as const

export const INPUT_GALLERY: readonly InputExample[] = [
  { part: 'NumberField', state: 'default', element: <NumberDemo quantity="length" start={12.5} /> },
  { part: 'NumberField', state: 'angle', element: <NumberDemo quantity="angle" start={45} /> },
  { part: 'NumberField', state: 'empty', element: <NumberDemo quantity="length" start={null} optional /> },
  { part: 'NumberField', state: 'invalid', element: <InvalidNumberDemo /> },
  { part: 'NumberField', state: 'unavailable', element: <NumberDemo quantity="feed" start={1200} availability={MAX_RATE} label="Max rate" /> },
  { part: 'TextField', state: 'default', element: <TextDemo /> },
  { part: 'TextField', state: 'mono', element: <TextDemo mono /> },
  { part: 'TextField', state: 'unavailable', element: <TextDemo availability={ROUTINE} label="Routine name" start="Probe corner" /> },
  { part: 'Select', state: 'default', element: <PickDemo /> },
  { part: 'Select', state: 'unavailable', element: <PickDemo availability={NO_SOLID} label="Source body" /> },
  { part: 'Segmented', state: 'default', element: <SegDemo /> },
  { part: 'Segmented', state: 'unavailable', element: <SegDemo availability={NEST_FIXED} label="Orientation" options={FREE_FIXED} start="fixed" /> },
  { part: 'Toggle', state: 'default', element: <TogDemo start={false} /> },
  { part: 'Toggle', state: 'on', element: <TogDemo start /> },
  { part: 'Toggle', state: 'unavailable', element: <TogDemo start availability={ENGRAVE_TABS} /> },
  { part: 'Slider', state: 'default', element: <SliDemo /> },
  { part: 'Slider', state: 'unavailable', element: <SliDemo availability={FILLET} label="Fillet radius" quantity="length" /> },
]
