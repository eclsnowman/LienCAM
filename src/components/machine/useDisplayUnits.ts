// useDisplayUnits - the Control tab's effective display units (Operator
// 2026-07-30): defaults to Settings > Display units, overridable per the
// machineDisplayUnits pref. All machine values arrive from GRBL in mm
// (status reports are mm regardless of G20/G21); presentation converts at
// the edge through the shared ADR-0022 unitFormat seam.

import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import type { Units } from '../../lib/ui/unitFormat'

export function useDisplayUnits(): Units {
  const appUnits = useCamStore((s) => s.appSettings.displayUnits)
  const override = useUiPrefs((s) => s.machineDisplayUnits)
  return override === 'default' ? appUnits : override
}
