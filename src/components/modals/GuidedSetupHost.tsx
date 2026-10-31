import { useEffect, useRef, useState } from 'react'
import { useCamStore } from '../../store'
import { useProjectPicker } from '../../lib/projectOpen/picker'
import { GuidedSetupModal, useGuidedSetup, type GuidedSetupChild } from './GuidedSetupModal'

/**
 * WO-3256: the one ephemeral return intent of the Guided setup. It is never
 * serialized. It exists from the moment the guide hands over to an editor until
 * that exact editor closes to no modal; anything else that happens first
 * (another modal, a replaced project, an open in flight, the Open picker, a
 * workspace change) clears it instead, so a stale guide can never reopen. The
 * required machine choice keeps precedence: the guide waits for it.
 */
interface GuidedSetupIntent { originProjectId: string; originWorkspace: string; child: GuidedSetupChild; closed: boolean }

function useGuidedSetupReturn(workspace: string, intent: GuidedSetupIntent | null, setIntent: (next: GuidedSetupIntent | null) => void): void {
  const activeModal = useCamStore((s) => s.activeModal)
  const projectId = useCamStore((s) => s.project.id)
  const required = useCamStore((s) => s.machineChoiceRequired)
  const opening = useCamStore((s) => s.projectOpen !== null)
  const pickerOpen = useProjectPicker((s) => s.section !== null)
  const open = useGuidedSetup((s) => s.open)
  const origin = useRef<{ projectId: string; workspace: string } | null>(null)
  // A guide that is showing belongs to the project and workspace it opened in.
  useEffect(() => {
    if (!open) { origin.current = null; return }
    if (!origin.current) origin.current = { projectId, workspace }
    else if (origin.current.projectId !== projectId || origin.current.workspace !== workspace || pickerOpen) {
      useGuidedSetup.getState().hide()
    }
  }, [open, projectId, workspace, pickerOpen])
  useEffect(() => {
    if (!intent) return
    if (intent.originProjectId !== projectId || intent.originWorkspace !== workspace || opening || pickerOpen) {
      setIntent(null)
    } else if (activeModal !== null && activeModal !== intent.child) {
      setIntent(null)
    } else if (activeModal === null && !required) {
      setIntent(null)
      useGuidedSetup.getState().show()
    } else if (activeModal === null && !intent.closed) {
      setIntent({ ...intent, closed: true })
    }
  }, [intent, setIntent, activeModal, projectId, workspace, required, opening, pickerOpen])
}

/**
 * The Guided setup window with its return intent. Both shells mount it beside
 * ProjectStartupFlow; it takes no props, so the picker-to-guide hand-off works
 * the same wherever it is mounted.
 */
export function GuidedSetupHost() {
  const [intent, setIntent] = useState<GuidedSetupIntent | null>(null)
  const workspace = useCamStore((s) => s.workspace)
  useGuidedSetupReturn(workspace, intent, setIntent)
  const required = useCamStore((s) => s.machineChoiceRequired)
  return required ? null : <GuidedSetupModal onOpenChild={(child) => {
    const state = useCamStore.getState()
    setIntent({ originProjectId: state.project.id, originWorkspace: state.workspace, child, closed: false })
    useGuidedSetup.getState().hide()
    state.openModal(child)
  }} />
}
