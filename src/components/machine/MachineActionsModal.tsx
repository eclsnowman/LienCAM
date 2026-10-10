// MachineActionsModal - the ONE configuration surface for the machine action
// abstraction (MACHINE-CONTROL stage 9; Q-58 boundary: settings-dense config
// stays in a modal, the operating surface stays frictionless).
//
// Built-in actions only - what each stock button SENDS, per machine, with
// the controller default shown and a per-row Reset. WO-1707: user buttons
// (the former "Custom buttons" section here) are macros now, one editor
// (`MacroEditor`) for all of them; this modal's own add control opens that
// editor instead of a second, inline one.
// Everything is per-MACHINE (keyed by the project's machine id) so a machine
// keeps its wiring across projects.
// WO-2102: the rows live in the machine Definition now (Built-in commands);
// the Control tab's Actions sub-tab is gone. This modal remains the spindle
// and macro gear buttons' door and draws the SAME rows from that section.

import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { controlMachine, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { controllerDisplayName, resolveDeclaredController } from '../../lib/machine/machineChoice'
import { MacroEditor } from './MacroEditor'
import { BuiltinCommandRows } from './definition/BuiltinCommandsSection'

export function MachineActionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const machine = useCamStore(controlMachine)
  const machineId = machine?.id ?? 'default'
  const controllerResolution = resolveDeclaredController(machine)
  const controller = controllerResolution.ok ? controllerResolution.controller : null

  // WO-1707: user buttons are macros now - this modal's own add control
  // opens the one editor for them instead of a second, inline one.
  const [macroEditorOpen, setMacroEditorOpen] = useState(false)

  useEffect(() => {
    if (open && !controllerResolution.ok) {
      useMachineControl.getState().pushConsole('tx', controllerResolution.reason, 'error')
    }
  }, [open, controllerResolution.ok, controllerResolution.ok ? null : controllerResolution.reason])

  // WO-2010: Escape does what the X does - but only while this dialog's own
  // backdrop is the last one in the document. Anything stacked on top (the macro
  // editor, a macro's ask/confirm/choose dialog) answers its own Escape.
  const backdropRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const own = backdropRef.current
      const all = document.querySelectorAll('.modal-backdrop')
      if (!own || all[all.length - 1] !== own) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={onClose}>
      <div
        className="modal-container control-actions-modal"
        data-testid="control-actions-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">
            Machine actions - {machine?.name ?? 'machine'} ({controller ? controllerDisplayName(controller) : 'undeclared'})
          </span>
          <button className="modal-close-btn" onClick={onClose} data-tooltip="Close" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="control-actions-body">
          <div className="control-actions-section-title">Built-in buttons</div>
          {/* WO-2102: the same rows Definition > Built-in commands draws. */}
          <BuiltinCommandRows machineId={machineId} controller={controller} testIdPrefix="control-action" />

          {/* WO-1707: user buttons are macros now - "Custom buttons" opens
              the one macro editor instead of a second, inline one. */}
          <div className="control-actions-section-title control-actions-custom-title">
            Macros
            <button
              className="modal-btn modal-btn-ghost"
              data-testid="control-action-add"
              onClick={() => setMacroEditorOpen(true)}
            >
              <Plus size={13} /> Add / edit macros
            </button>
          </div>
        </div>
      </div>
      <MacroEditor open={macroEditorOpen} onClose={() => setMacroEditorOpen(false)} />
    </div>
  )
}
