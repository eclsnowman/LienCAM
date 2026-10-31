// WO-3280: one example per action part and state. The H lane's kit gallery route mounts this list,
// and the proof sheets draw it in the three M1 themes. Labels are fixed English: the gallery is
// a developer sheet, not a screen.
import type { ReactElement } from 'react'
import type { Availability } from '../../../commands/types'
import type { KitPart } from '../types'
import { AnchoredValue, Button, PromptBar, RibbonGroup, ShowCard, ViewCube } from './index'

export interface GalleryEntry {
  readonly part: KitPart
  readonly state: string
  readonly node: ReactElement
}

const noop = () => {}
// An existing catalogue reason, so the sheet shows a real sentence.
const WAIT: Availability = { ready: false, reason: 'sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber' }
const LOCKED: Availability = { ...WAIT, lock: true }
const FACES = { top: 'Top', bottom: 'Bottom', front: 'Front', back: 'Back', left: 'Left', right: 'Right', iso: 'Isometric' }
const SHOW = [
  { id: 'cut', label: 'Cut moves', visible: true, swatchVar: '--mv-cut' as const },
  { id: 'rapid', label: 'Rapid moves', visible: true, swatchVar: '--mv-rapid' as const },
  { id: 'plunge', label: 'Plunges', visible: false, swatchVar: '--mv-plunge' as const },
]

export const ACTION_GALLERY: readonly GalleryEntry[] = [
  { part: 'Button', state: 'momentary rest', node: <Button kind="momentary" label="Step" onPress={noop} /> },
  { part: 'Button', state: 'momentary held', node: <span data-held-example><Button kind="momentary" label="X+" onPress={noop} onRelease={noop} /></span> },
  { part: 'Button', state: 'latched off', node: <Button kind="latched" label="Coolant" on={false} onToggle={noop} /> },
  { part: 'Button', state: 'latched on', node: <Button kind="latched" label="Vacuum" on onToggle={noop} /> },
  { part: 'Button', state: 'choice idle', node: <Button kind="choice" label="1 mm" selected={false} onSelect={noop} /> },
  { part: 'Button', state: 'choice selected', node: <Button kind="choice" label="10 mm" selected onSelect={noop} /> },
  { part: 'Button', state: 'transport start', node: <Button kind="transport" transport="start" label="Start" onPress={noop} /> },
  { part: 'Button', state: 'transport hold', node: <Button kind="transport" transport="hold" label="Feed hold" active onPress={noop} /> },
  { part: 'Button', state: 'transport stop', node: <Button kind="transport" transport="stop" label="Stop" onPress={noop} /> },
  { part: 'Button', state: 'unavailable', node: <Button kind="momentary" label="Generate" onPress={noop} availability={WAIT} /> },
  { part: 'Button', state: 'unavailable lock', node: <Button kind="momentary" label="Jog" onPress={noop} availability={LOCKED} /> },
  { part: 'Button', state: 'form big', node: <Button kind="momentary" form="big" icon="pocket" label="Pocket" onPress={noop} /> },
  { part: 'Button', state: 'form small', node: <Button kind="momentary" form="small" icon="line" label="Line" onPress={noop} /> },
  { part: 'Button', state: 'form icon', node: <Button kind="momentary" form="icon" icon="zoom-fit" label="Zoom to fit" onPress={noop} /> },
  { part: 'Button', state: 'form text', node: <Button kind="momentary" label="Rename" onPress={noop} /> },
  { part: 'Button', state: 'emphasis primary', node: <Button kind="momentary" emphasis="primary" label="Generate" onPress={noop} /> },
  { part: 'Button', state: 'emphasis ghost', node: <Button kind="momentary" emphasis="ghost" label="Reset" onPress={noop} /> },
  { part: 'Button', state: 'emphasis danger', node: <Button kind="momentary" emphasis="danger" label="Delete" onPress={noop} /> },
  {
    part: 'RibbonGroup',
    state: 'big and small tools',
    node: (
      <RibbonGroup caption="Draw" onOpenMenu={noop}>
        <Button kind="momentary" form="big" icon="line" label="Line" onPress={noop} />
        <Button kind="momentary" form="small" icon="arc" label="Arc" onPress={noop} />
        <Button kind="momentary" form="small" icon="circle" label="Circle" onPress={noop} />
        <Button kind="momentary" form="small" icon="rect" label="Rectangle" onPress={noop} />
      </RibbonGroup>
    ),
  },
  { part: 'PromptBar', state: 'step with Cancel and Done', node: <PromptBar prompt="Pick the floor face" step={{ index: 1, count: 2 }} onCancel={noop} actions={<Button kind="momentary" emphasis="primary" label="Done" onPress={noop} />} /> },
  { part: 'AnchoredValue', state: 'value', node: <div className="kit-gallery-anchor"><AnchoredValue anchor={{ x: 8, y: 8 }} value={25} quantity="length" ariaLabel="Distance" onCommit={noop} onCancel={noop} /></div> },
  { part: 'ShowCard', state: 'folded', node: <ShowCard title="Show" items={SHOW} onToggle={noop} open={false} /> },
  { part: 'ShowCard', state: 'open', node: <ShowCard title="Show" items={SHOW} onToggle={noop} open /> },
  { part: 'ViewCube', state: 'shaded', node: <ViewCube onView={noop} faceLabels={FACES} style="shaded" onStyle={noop} /> },
]
