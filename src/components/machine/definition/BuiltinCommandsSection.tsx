import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

// WO-2102 - BUILT-IN COMMANDS: what each stock spindle / coolant button SENDS
// on this machine, with the controller default shown and a per-row Reset.
//
// Operator, 2026-09-27 (card Q-REMOVE-THE-ACTIONS-TAB-YOUR-09-1): "Fold into
// Definition and remove the tab". These rows were the body of the Control
// tab's Machine > Actions door (MachineActionsModal); they live in the machine
// Definition now and the Actions tab is gone. The modal still opens from the
// spindle and macro gear buttons and draws these SAME rows - one editor, two
// doors, one store - so nothing an operator overrode is lost or copied.
//
// Storage is unchanged: overrides stay per MACHINE in `machineActionsStore`
// (keyed by machine id), committed on blur exactly as the modal always did.
// They are LienCAM's own record, acted on here (the buttons send them) and
// never written to the controller - `data-drives-this-app`.

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useMachineActions } from '../../../store/machineActionsStore'
import {
  BUILTIN_ACTION_LABELS,
  builtinDefaultLines,
  validateActionLines,
  type BuiltinActionId,
} from '../../../lib/machine/machineActions'
import { controllerDisplayName, resolveDeclaredController } from '../../../lib/machine/machineChoice'
import type { ControllerType, MachineConfig } from '../../../types'
import { MacroEditor } from '../MacroEditor'
import { SectionHead } from './DefinitionFields'

const BUILTIN_IDS = Object.keys(BUILTIN_ACTION_LABELS) as BuiltinActionId[]

function BuiltinRow({
  machineId,
  controller,
  action,
  testIdPrefix,
  labelSize,
}: {
  machineId: string
  controller: ControllerType | null
  action: BuiltinActionId
  testIdPrefix: string
  labelSize?: string
}) {
  useText('control-screens-not-probing')
  const config = useMachineActions((s) => s.byMachine[machineId])
  const setOverride = useMachineActions((s) => s.setOverride)
  const clearOverride = useMachineActions((s) => s.clearOverride)
  const override = config?.overrides[action]
  const defaults = controller ? builtinDefaultLines(controller, action) : null
  const effective = override ?? defaults ?? []
  const effectiveText = effective.join('\n')
  const [text, setText] = useState(effectiveText)
  const [error, setError] = useState<string | null>(null)
  // The Definition page stays mounted while the gear buttons' modal edits the
  // same store - two live doors onto one value. When the stored value changes
  // and this box is not being typed in, show the stored value; otherwise a
  // focus-and-blur here would commit the stale text over his override.
  const [editing, setEditing] = useState(false)
  const [shown, setShown] = useState(effectiveText)
  if (shown !== effectiveText) {
    setShown(effectiveText)
    if (!editing) {
      setText(effectiveText)
      setError(null)
    }
  }

  const commit = () => {
    const v = validateActionLines(text)
    if (!v.ok) {
      setError(v.reason)
      return
    }
    setError(null)
    if (defaults && v.lines.join('\n') === defaults.join('\n')) clearOverride(machineId, action)
    else setOverride(machineId, action, v.lines)
  }

  return (
    <div className="control-actions-row">
      <span className="control-actions-label" style={labelSize ? { fontSize: labelSize } : undefined}>
        {BUILTIN_ACTION_LABELS[action]}
      </span>
      <div className="control-actions-code-wrap">
        <textarea
          className="mform-input mform-input-mono control-actions-code"
          rows={Math.max(1, text.split('\n').length)}
          value={text}
          data-testid={`${testIdPrefix}-${action}`}
          aria-label={controlText('BuiltinCommandsSection.text001', { value1: String(BUILTIN_ACTION_LABELS[action]) })}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false)
            commit()
          }}
        />
        {error && <div className="control-error-text">{error}</div>}
      </div>
      <span className="control-actions-default">
        {override ? (
          <button
            className="control-chip-btn"
            data-testid={`${testIdPrefix}-${action}-reset`}
            onClick={() => {
              clearOverride(machineId, action)
              setText(defaults?.join('\n') ?? '')
              setError(null)
            }}
            data-tooltip={controller ? controlText('BuiltinCommandsSection.text002', { value1: String(controllerDisplayName(controller)) }) : controlText('BuiltinCommandsSection.text003')}
          >{controlText('BuiltinCommandsSection.text004')}</button>
        ) : (
          <span data-tooltip={controlText('BuiltinCommandsSection.text005')}>{controlText('BuiltinCommandsSection.text006')}</span>
        )}
      </span>
    </div>
  )
}

/** The built-in rows for one machine. `testIdPrefix` keeps the modal's
 *  long-standing `control-action-<id>` ids while the Definition page gets its
 *  own. Keyed on the controller so a controller change redraws the defaults
 *  instead of keeping the previous controller's text in the box. */
export function BuiltinCommandRows({
  machineId,
  controller,
  testIdPrefix,
  labelSize,
}: {
  machineId: string
  controller: ControllerType | null
  testIdPrefix: string
  /** The Definition page sets its field-label size; the modal keeps its own. */
  labelSize?: string
}) {
  return (
    <>
      {BUILTIN_IDS.map((id) => (
        <BuiltinRow
          key={`${machineId}:${controller ?? 'none'}:${id}`}
          machineId={machineId}
          controller={controller}
          action={id}
          testIdPrefix={testIdPrefix}
          labelSize={labelSize}
        />
      ))}
    </>
  )
}

/** Definition > Built-in commands. Mounted in the Controller area (a defined
 *  machine) and on the setup page of a machine with no controller definition
 *  yet - the Actions tab reached these whatever the machine's state. */
export function BuiltinCommandsSection({ machine }: { machine: MachineConfig }) {
  useText('control-screens-not-probing')
  const resolution = resolveDeclaredController(machine)
  const controller = resolution.ok ? resolution.controller : null
  // The Actions modal's own "Add / edit macros" door, kept with the rows it
  // sat beside (WO-1707: user buttons are macros, one editor for all of them).
  const [macroEditorOpen, setMacroEditorOpen] = useState(false)

  return (
    <div data-testid="machine-def-builtin-commands" data-drives-this-app="" style={{ marginTop: 12 }}>
      <SectionHead
        title={controlText('BuiltinCommandsSection.text007')}
        summary={`What each stock spindle and coolant button sends${controller ? ` (${controllerDisplayName(controller)})` : ''}.`}
        testId="machine-def-builtin-commands-head"
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <BuiltinCommandRows
          machineId={machine.id}
          controller={controller}
          testIdPrefix="machine-def-command"
          labelSize="var(--font-size-sm)"
        />
      </div>
      <button
        type="button"
        className="control-chip-btn"
        data-testid="machine-def-builtin-commands-macros"
        style={{ marginTop: 8 }}
        onClick={() => setMacroEditorOpen(true)}
      >
        <Plus size={12} />{controlText('BuiltinCommandsSection.text008')}</button>
      <MacroEditor open={macroEditorOpen} onClose={() => setMacroEditorOpen(false)} />
    </div>
  )
}
