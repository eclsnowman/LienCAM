import { textFor, useText } from '../../i18n'
import type { ChamferHeightReference } from '../../lib/cam/types'

const shellText = textFor('app-shell-settings-menus')

// The UI-offered reference-plane options, in one place so the NewOperationModal
// (3 sites) and the PropertiesPanel Heights quick-edit render the IDENTICAL list.
// 'absolute' / 'model_top' / 'selected_face' are legacy/smart values that are not
// offered here (a stored legacy value simply shows the browser default until the
// user picks one of these) — this matches the modal's pre-extraction behavior.
export const REF_PLANE_OPTIONS: ReadonlyArray<{ value: ChamferHeightReference; label: string }> = [
  { value: 'geometry_face', get label() { return shellText('RefPlaneSelect.geometryWhereItSitsWasProjected') } },
  { value: 'stock_top', get label() { return shellText('RefPlaneSelect.stockTop') } },
  { value: 'stock_bottom', get label() { return shellText('RefPlaneSelect.stockBottom') } },
  { value: 'machine_floor', get label() { return shellText('RefPlaneSelect.floorMachineZ0') } },
  { value: 'wcs_plane', get label() { return shellText('RefPlaneSelect.wCSOriginPlaneZ0') } },
  { value: 'picked_plane', get label() { return shellText('RefPlaneSelect.pickedSurfaceClickAFace') } },
]

/** Shared reference-plane dropdown. Used by the operation modal and the panel so
 *  the option set can never diverge (UI-STANDARD sec 11.6). */
export function RefPlaneSelect({
  value, onChange, className = 'mform-select', disabled, testId,
}: {
  value: ChamferHeightReference
  onChange: (ref: ChamferHeightReference) => void
  className?: string
  disabled?: boolean
  testId?: string
}) {
  useText('app-shell-settings-menus')
  return (
    <select
      className={className}
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ChamferHeightReference)}
    >
      {REF_PLANE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
