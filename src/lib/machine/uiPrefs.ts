// WO-1122 - the hide-empty toggle's read/write seam.
//
// Operator ruling 2026-08-29, at the machine, on a Definition page that was 76% empty
// boxes: "I also want a toggle to hide any fields not defined for UCCNC. So at
// the top you can untoggle to see everything, and then retoggle to hide
// anything not defined/blank to improve first order retrievability of your
// configured settings."
//
// WHY THIS FILE EXISTS WHEN THE STATE LIVES IN src/store/uiPrefs.ts. The
// choice persists per OPERATOR - it follows the person across machines and
// projects, so it belongs in the `liencam-ui-prefs` record, not on a machine
// and not in a project. A standalone store here cannot join that record:
// `persistRegistered` only accepts a key from the persisted-user-data
// registry, the registry's key inventory is pinned by an exact-equality test
// (src/tests/store/persistedKeys.wo245.test.ts), and writing browser storage
// outside that registry is what the WO-245 boundary exists to stop. So the
// boolean is one validated field on the existing store, and THIS module is
// what the feature imports - the seam a future machine-definition UI
// preference joins, named after the thing it configures rather than the store
// it is stored in.

import { useUiPrefs } from '../../store/uiPrefs'

/** The shipped state: empty settings HIDDEN. "First order retrievability of
 *  your configured settings" is the point of the toggle, and that is the
 *  state Operator wants to land on - he should not have to set it every time. */
export const MACHINE_DEF_HIDE_EMPTY_DEFAULT = true

/** The Machine Definition page's hide-empty preference, as [value, setter].
 *  Two selectors, so a flip re-renders exactly the subscribers and nothing
 *  else on the page moves. */
export function useMachineDefHideEmptySettings(): [boolean, (hide: boolean) => void] {
  const hide = useUiPrefs((s) => s.machineDefHideEmptySettings)
  const setHide = useUiPrefs((s) => s.setMachineDefHideEmptySettings)
  return [hide, setHide]
}
