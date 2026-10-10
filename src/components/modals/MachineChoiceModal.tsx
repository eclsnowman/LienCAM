import { useText } from '../../i18n'
import { useState, useEffect } from 'react'
import { Cpu, Check } from 'lucide-react'
import { useCamStore } from '../../store'
import { choosableMachines } from '../../lib/machine/machineChoice'
import { useDialogFocus } from '../../hooks/useDialogFocus'

// Focused, FORCED-CHOICE machine picker. Raised by the App-level load-prompt
// effect (App.tsx) when the active project's machine needs an active choice
// (machineNeedsChoice: missing / unknown-id / generic placeholder) on cold-start
// reload OR after opening a .camproject file. Distinct from the full
// MachineLibraryModal editor: this only lists the library, pre-selects the
// user's default (appSettings.defaultMachineId), and on confirm binds the chosen
// profile to the project via setProjectMachine (which makes project.machine a
// known machine, so the effect will not re-open).
//
// Dismissable ONLY by choosing (no backdrop click, no X) per the forced-choice
// requirement. Graceful fallback: if the library is empty there is nothing to
// pick, so the effect never raises the flag and this modal never shows; the
// project keeps its existing (generic) machine.
export function MachineChoiceModal() {
  const words = useText('setup-stock-tools-machine-post')
  const required          = useCamStore((s) => s.machineChoiceRequired)
  const setRequired       = useCamStore((s) => s.setMachineChoiceRequired)
  const machineLibrary    = useCamStore((s) => s.machineLibrary)
  const defaultMachineId  = useCamStore((s) => s.appSettings.defaultMachineId)
  const setProjectMachine = useCamStore((s) => s.setProjectMachine)
  const currentMachine    = useCamStore((s) => s.project.machine)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // Only REAL machines are pickable; the generic placeholder is excluded (picking
  // it would re-trip the forced choice). The App effect only raises this modal when
  // choosableMachines is non-empty, but filtering here too keeps the picker honest.
  // WO-2690: the operator's default leads the list, so the row already chosen
  // for him is the first one he reads.
  const choices = choosableMachines(machineLibrary)
    .sort((a, b) => Number(b.id === defaultMachineId) - Number(a.id === defaultMachineId))

  // On open, pre-select the user's default if it resolves, else the first
  // pickable machine. Re-runs when the modal opens or the library/default change.
  useEffect(() => {
    if (!required) return
    const preferred =
      (defaultMachineId && choices.find((m) => m.id === defaultMachineId)) ||
      choices[0]
    setSelectedId(preferred ? preferred.id : null)
    // choices is derived from machineLibrary; depend on the source to avoid a new
    // array identity re-running this every render.
  }, [required, defaultMachineId, machineLibrary])

  if (!required) return null

  const chosen = choices.find((m) => m.id === selectedId) ?? null

  const handleConfirm = () => {
    if (!chosen) return
    setProjectMachine({ ...chosen })
    setRequired(false)
  }

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div className="modal-backdrop" data-ui78-sanctioned="">
      <div className="modal-container machine-choice-modal" ref={dialogFocusRef}>
        <div className="modal-header">
          <Cpu size={14} className="modal-header-icon" />
          <span className="modal-title">{words("MachineChoiceModal.choose_a_machine_for_this_project")}</span>
        </div>

        <div className="modal-body machine-choice-body">
          <p className="machine-choice-note">{words("MachineChoiceModal.this_project_is_not_bound_to_one", { value1: currentMachine?.name ? words("MachineChoiceModal.currently", { name: currentMachine.name }) : '' })}</p>

          <div className="machine-choice-list">
            {choices.map((m) => {
              const isSel = m.id === selectedId
              const isDefault = m.id === defaultMachineId
              return (
                <div
                  key={m.id}
                  className={`machine-choice-item${isSel ? ' machine-choice-item-active' : ''}`}
                  onClick={() => setSelectedId(m.id)}
                >
                  <div className="machine-choice-item-main">
                    <div className="machine-choice-name">{m.name}</div>
                    <div className="machine-choice-meta">
                      {words(`MachineChoiceModal.machineTypes.${m.type}`)}{words("MachineChoiceModal.symbol")}{m.controller.toUpperCase()}
                    </div>
                  </div>
                  {isDefault && <span className="badge badge-warning">{words("MachineChoiceModal.default")}</span>}
                  {isSel && <Check size={14} className="machine-choice-check" />}
                </div>
              )
            })}
            {choices.length === 0 && (
              <div className="machine-choice-empty">{words("MachineChoiceModal.no_machines_in_your_library_add_one")}</div>
            )}
          </div>
        </div>

        <div className="modal-footer machine-choice-footer">
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleConfirm}
            disabled={!chosen}
            data-tooltip={chosen ? words("MachineChoiceModal.use_this_machine_for_the_project") : words("MachineChoiceModal.select_a_machine_first")}
          >{words("MachineChoiceModal.use_this_machine")}</button>
        </div>
      </div>
    </div>
  )
}
