// WO-3285 (UI M2 W1-H): the shell's layout rules as pure functions (spec 5.1). The class is read
// from the window AFTER interface scale, so a 1024 x 600 panel at 75 % lays out as 1365 x 800.
// Everything the stylesheet needs per class reaches it through data attributes set from this
// result; nothing in the CSS repeats a threshold.
import { LAYOUT, SCALE, sizeClassFor, type SizeClass } from '../../theme/tokens'

export interface FrameMetrics {
  readonly sizeClass: SizeClass
  /** Browser card width; in the compact class this is the icon rail (the card opens over the view). */
  readonly browserWidth: number
  readonly propertiesWidth: number
  readonly browserRailed: boolean
  readonly groupBand: number
  readonly strip: number
  /** Group captions show unless the window is short. */
  readonly groupCaptions: boolean
  /** Command search folds to its icon in the compact class. */
  readonly searchFolded: boolean
}

export function frameMetrics(windowWidth: number, windowHeight: number, scale = 1): FrameMetrics {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const sizeClass = sizeClassFor(windowWidth / s, windowHeight / s)
  const compact = sizeClass.width === 'compact'
  const wide = sizeClass.width === 'wide'
  return {
    sizeClass,
    browserWidth: compact ? LAYOUT.compact.rail : wide ? LAYOUT.wide.browser : SCALE.width.browser,
    propertiesWidth: compact ? LAYOUT.compact.properties : wide ? LAYOUT.wide.properties : SCALE.width.properties,
    browserRailed: compact,
    groupBand: sizeClass.short ? LAYOUT.short.groupBand : SCALE.height.groupBand,
    strip: sizeClass.short ? LAYOUT.short.strip : SCALE.height.strip,
    groupCaptions: !sizeClass.short,
    searchFolded: compact,
  }
}
