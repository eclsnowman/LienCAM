// WO-3301 (UI M2 W2-8): keeps the registry's active mode of Model in step with the sessions the Model page runs.
// Form and Relief are open while their session says so; Drawing while a sheet editor is mounted. Opening one by
// any route (the Modes group, today's panels, an agent) swaps the ribbon; closing it by any route restores it.
// Mounted once at the root of the New UI as a registered window; it draws nothing.
import { useEffect } from 'react'
import { useModePortSession } from '../../components/model3d/form/modePort'
import { formModePort } from '../../components/model3d/form/formModePort'
import { reliefModePort } from '../../components/model3d/relief/reliefModePort'
import { drawingEditorPort, drawingsModelPort } from '../../components/model3d/drawing/drawingModePort'
import { useWorkspaceRegistry } from '../registry'
import { logoExportRegistration } from './logoExport'
import type { WorkspaceRegistration } from '../registry'
import { MODE_IDS, type ModeId } from './toolTable'

/** Registers nothing; adding and withdrawing it is how a lane tells the shell its buttons changed (the shell redraws the ribbon on
 *  the registry's version and on store changes, and the sessions here live in ports, not the store). */
const REDRAW: WorkspaceRegistration = { owner: 'model-modes-redraw' }

export function ModeSync() {
  const registry = useWorkspaceRegistry()
  const form = useModePortSession(formModePort)
  const relief = useModePortSession(reliefModePort)
  const editor = useModePortSession(drawingEditorPort)
  useModePortSession(drawingsModelPort)
  // the ports' versions, not the sessions (a session object is new on every page render; a version moves only when a button changes)
  const stamp = [formModePort, reliefModePort, drawingEditorPort, drawingsModelPort].map(port => port.version()).join('.')
  const wanted: ModeId | null = editor !== null ? 'drawing' : form?.active === true ? 'form' : relief?.active === true ? 'relief' : null
  useEffect(() => {
    const current = registry.activeMode('model')?.id
    if (wanted !== null) {
      if (current !== wanted) registry.enterMode(wanted)
    } else if (current !== undefined && (MODE_IDS as readonly string[]).includes(current)) {
      registry.exitMode('model')
    }
  }, [registry, wanted])
  const showLogo = editor?.hasSheet === true && editor.hasLogo
  useEffect(() => {
    if (!showLogo) return
    return registry.register(logoExportRegistration)
  }, [registry, showLogo])
  useEffect(() => {
    registry.register(REDRAW)()
  }, [registry, stamp])
  return null
}
