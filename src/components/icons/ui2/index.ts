// The LienCAM New UI icon set (WO-3286). One drawing grammar, generated from the icon source in
// src/tests/evidence/WO-3286/icons; every colour is a theme role, so a theme change recolours it.
import { ICON_DATA } from './iconData'
import { ICON_INTENT } from './iconIntent'

export type Ui2IconFamily = 'Setup' | 'Sketch' | 'Model' | 'Toolpath' | 'Simulate' | 'Post' | 'Drawing'
export interface Ui2IconIntent {
  /** What the command does, in the operator's words. */
  readonly does: string
  /** What the drawing shows. */
  readonly shows: string
  /** Ids of the icons this one must not be mistaken for. */
  readonly notConfusedWith: readonly string[]
}

export const UI2_ICON_IDS: readonly string[] = Object.keys(ICON_DATA)
export const UI2_ICON_FAMILY: Readonly<Record<string, Ui2IconFamily>> =
  Object.fromEntries(UI2_ICON_IDS.map(id => [id, ICON_DATA[id][0]]))
export const UI2_ICON_INTENT: Readonly<Record<string, Ui2IconIntent>> = ICON_INTENT

/** The SVG body of an icon on the 48 grid (inside an `<svg viewBox="0 0 48 48">`); '' for an unknown id. */
export function ui2IconSvg(id: string): string {
  return ICON_DATA[id]?.[1] ?? ''
}

export { Ui2Icon } from './Ui2Icon'
