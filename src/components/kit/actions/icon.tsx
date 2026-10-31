// WO-3318: keep the reserved slot for every id; draw only the shipped icon family.
import type { IconId } from '../../../commands/types'
import { UI2_ICON_IDS, ui2IconSvg } from '../../icons/ui2'

const knownIcons = new Set(UI2_ICON_IDS)

export function Icon({ id }: { id: IconId }) {
  const known = knownIcons.has(id)
  return (
    <span className="kit-icon" data-icon={id} data-glyph={known || undefined} aria-hidden="true">
      {known && <svg viewBox="0 0 48 48" width="100%" height="100%" fill="currentColor" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: ui2IconSvg(id) }} />}
    </span>
  )
}

/** The interlock glyph of an unavailable control that an interlock holds (spec 7). */
export function LockGlyph({ label }: { label: string }) {
  return (
    <svg className="kit-lock" viewBox="0 0 12 12" role="img" aria-label={label}>
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" fill="currentColor" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
