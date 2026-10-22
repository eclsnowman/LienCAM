import { catalogChildren } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

// MacroEditor - WO-1706: make, edit, remove and reorder macros in the app.
//
// One editor, opened from the Macros panel's "Edit macros" control, listing
// the machine's macros in their saved order (ADR-0049: the same machine
// record every other lens edits, through the same save path the Macros
// panel's tool-change flag already uses - `saveParkMachineRecord`). A park
// macro (WO-1681) is just a macro here, same as any other.
//
// Nothing here refuses (rule 11): a body that does not parse still saves,
// and the editor shows the sandbox's own error text for it - the same
// words `runUserMacro` prints to the console. Two macros sharing an
// M-code are both kept; the editor says which two, and which one runs
// (the run path's own rule - `boundMacro` takes the first match, so the
// first macro in the list with that code is the one a typed word runs).

import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CircleHelp, Pencil, Plus, Trash2, X } from 'lucide-react'
import { controlMachine, useCamStore } from '../../store'
import { parkCarrierMachine, saveParkMachineRecord, useMachineActions } from '../../store/machineActionsStore'
import { checkMacroBody, MACRO_API, machineMacros } from '../../lib/machine/macros/macroRuntime'
import { machineOutputList } from '../../lib/machine/machineOutputs'
import { macroOutputLabel, macroOutputSelection, selectedMacroOutput } from '../../lib/machine/macros/macroOutputSelection'
import { ACTION_COLORS, EMPTY_ACTION_CONFIG, machineParkList, machineSafeZValue, parkMacroPositions, buildParkSequence, type MachineActionConfig, type ParkPosition, type ActionColor } from '../../lib/machine/machineActions'
import { publishMacroDraft } from '../../lib/exportCenter'
import { newMachineMacroId, type MachineConfig, type MachineMacro } from '../../types'
import { API_HELP, MacroHelp } from './MacroHelp'
import './MacroEditor.css'

// WO-2841: presentation belongs to the existing per-machine action settings.
// Do not turn fallback parks into position macros: that would replace G30's
// reference table and alter tool-change/clamp-pause/pendant resolution.
interface ParkButtonDisplay {
  name: string
  color: ActionColor
  hidden: boolean
}
interface MacroButtonDisplay {
  order: string[]
  parks: Record<string, ParkButtonDisplay>
  removed: string[]
}
type DisplayConfig = MachineActionConfig & { macroButtons?: MacroButtonDisplay }
export interface EditableMacroButton { macro: MachineMacro; park?: ParkPosition }

export function macroButtonDisplay(config: MachineActionConfig | undefined): MacroButtonDisplay {
  return (config as DisplayConfig | undefined)?.macroButtons ?? { order: [], parks: {}, removed: [] }
}

function saveButtonDisplay(machineId: string, display: MacroButtonDisplay) {
  useMachineActions.setState((state) => {
    const config: DisplayConfig = { ...(state.byMachine[machineId] ?? EMPTY_ACTION_CONFIG), macroButtons: display }
    return { byMachine: { ...state.byMachine, [machineId]: config } }
  })
}

/** Both editor doors and the panel resolve exactly this list. Hidden rows stay
 *  editable; removal is a display tombstone, never deletion of a G30 point. */
export function editableMacroButtons(machine: MachineConfig, config: MachineActionConfig | undefined): EditableMacroButton[] {
  const display = macroButtonDisplay(config)
  const safeZ = machineSafeZValue(machine, config)
  const parks = parkMacroPositions(machine).length > 0 ? [] : machineParkList(machine, config)
  const buttons: EditableMacroButton[] = parks.flatMap((park) => {
    const id = `fallback-park:${park.id}`
    if (display.removed.includes(id)) return []
    const saved = display.parks[id]
    const sequence = buildParkSequence(park, safeZ)
    return [{ park, macro: { id, name: saved?.name ?? park.label,
      color: saved?.color ?? 'green', hidden: saved?.hidden ?? false,
      body: sequence.ok ? sequence.lines.join('\n') : sequence.reason } }]
  })
  buttons.push(...machineMacros(machine).map((macro) => ({ macro })))
  const byId = new Map(buttons.map((button) => [button.macro.id, button]))
  const ordered: EditableMacroButton[] = []
  for (const id of display.order) {
    const button = byId.get(id)
    if (button) { ordered.push(button); byId.delete(id) }
  }
  return [...ordered, ...byId.values()]
}

interface Draft {
  id: string | null // null = a new macro, not yet saved
  name: string
  mCodeText: string
  body: string
  /** WO-1707: carried over from a folded custom button, or set fresh here -
   *  the one editor for both now. */
  color: ActionColor
  confirm: boolean
  /** WO-1707: kept off the Macros panel (a hidden custom button moved across).
   *  WO-2657: and so it does not run, from any route. */
  hidden: boolean
  drivesOutput: string
}

function draftFromMacro(m: MachineMacro): Draft {
  return {
    id: m.id,
    name: m.name,
    mCodeText: m.mCode === undefined ? '' : String(m.mCode),
    body: m.body,
    color: m.color ?? 'neutral',
    confirm: m.confirm ?? false,
    hidden: m.hidden ?? false,
    drivesOutput: m.drivesOutput ?? '',
  }
}

const EMPTY_DRAFT: Draft = { id: null, name: '', mCodeText: '', body: '', color: 'neutral', confirm: false, hidden: false, drivesOutput: '' }

function macroFromDraft(next: Draft, id: string, carried: MachineMacro | undefined): MachineMacro {
  const macro: MachineMacro = {
    id,
    name: next.name.trim() || controlText('MacroEditor.text001'),
    ...(draftMCode(next.mCodeText) === undefined ? {} : { mCode: draftMCode(next.mCodeText) }),
    body: next.body,
    ...(next.drivesOutput ? { drivesOutput: next.drivesOutput } : {}),
    ...(next.color === 'neutral' ? {} : { color: next.color }),
    ...(next.confirm ? { confirm: true as const } : {}),
    ...(next.hidden ? { hidden: true as const } : {}),
  }
  // Keep any flag the macro already carries (usedForToolChange) - this
  // editor never touches it, that stays the Macros panel's TC control.
  return carried?.usedForToolChange ? { ...macro, usedForToolChange: true } : macro
}

/** The M-code a draft's text states, or undefined for "no M-code" / unparsable text. */
function draftMCode(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

export function MacroEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  useText('control-screens-not-probing')
  const machine = useCamStore(controlMachine)
  const parkMachine = useCamStore(parkCarrierMachine)
  const storedActions = useMachineActions((state) => state.byMachine[machine.id])
  const buttons = editableMacroButtons(parkMachine, storedActions)
  const macros = buttons.map((button) => button.macro)
  const display = macroButtonDisplay(storedActions)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const parkDraft = buttons.find((button) => button.macro.id === draft?.id)?.park
  const [helpOpen, setHelpOpen] = useState(false)

  // WO-2010: Escape does what the X does, for this (topmost) dialog only. Window
  // capture + stopImmediatePropagation so the modal beneath it never sees the key.
  const backdropRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const own = backdropRef.current
      const all = document.querySelectorAll('.modal-backdrop')
      if (!own || all[all.length - 1] !== own) return
      if (document.querySelector('.help-image-lightbox')) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // The Export window reads the open draft from here, so unsaved edits and new
  // macros export without a machine-record save. The draft is still private to
  // this editor; only a snapshot is published, and it is cleared with the draft.
  // A closed editor keeps its draft but publishes none, and only an instance that
  // published clears, so a idle editor never clobbers another's draft.
  const published = useRef(false)
  useEffect(() => {
    if (!open || !draft || parkDraft) {
      if (published.current) publishMacroDraft(null)
      published.current = false
      return
    }
    const carried = macros.find((m) => m.id === draft.id)
    publishMacroDraft(macroFromDraft(draft, draft.id ?? 'macro-draft', carried))
    published.current = true
  }, [open, draft, macros, parkDraft])
  useEffect(() => () => {
    if (published.current) publishMacroDraft(null)
  }, [])

  if (!open) return null

  // WO-1714: an example's body replaces whatever macro is being edited; with
  // none open, it starts a new one (rule 11 - it does the thing, never
  // refuses for lack of a selection).
  const insertExample = (body: string) => {
    if (draft && !parkDraft) {
      setDraft({ ...draft, body })
    } else {
      setSelected(null)
      setDraft({ ...EMPTY_DRAFT, body })
    }
    setHelpOpen(false)
  }

  const save = (next: Draft) => {
    const park = buttons.find((button) => button.macro.id === next.id)?.park
    if (park && next.id) {
      const name = next.name.trim() || park.label
      saveButtonDisplay(machine.id, { ...display, parks: { ...display.parks,
        [next.id]: { name, color: next.color, hidden: next.hidden } } })
      setDraft({ ...next, name })
      return
    }
    const id = next.id ?? newMachineMacroId()
    const withCarried = macroFromDraft(next, id, macros.find((m) => m.id === id))
    const existing = macros.some((m) => m.id === withCarried.id)
    const nextMacros = existing
      ? machineMacros(parkMachine).map((m) => (m.id === withCarried.id ? withCarried : m))
      : [...machineMacros(parkMachine), withCarried]
    saveParkMachineRecord({ ...parkMachine, macros: nextMacros })
    setSelected(withCarried.id)
    setDraft(draftFromMacro(withCarried))
  }

  const remove = (id: string) => {
    if (buttons.find((button) => button.macro.id === id)?.park) {
      saveButtonDisplay(machine.id, { ...display, removed: [...display.removed, id] })
    } else {
      saveParkMachineRecord({ ...parkMachine, macros: machineMacros(parkMachine).filter((m) => m.id !== id) })
    }
    if (selected === id) {
      setSelected(null)
      setDraft(null)
    }
  }

  const move = (id: string, delta: number) => {
    const index = macros.findIndex((m) => m.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= macros.length) return
    const next = [...macros]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    saveButtonDisplay(machine.id, { ...display, order: next.map((macro) => macro.id) })
    // Keep the existing M-code precedence and native position-macro ordering.
    const ownIds = new Set(machineMacros(parkMachine).map((macro) => macro.id))
    saveParkMachineRecord({ ...parkMachine, macros: next.filter((macro) => ownIds.has(macro.id)) })
  }

  const startEdit = (m: MachineMacro) => {
    setSelected(m.id)
    setDraft(draftFromMacro(m))
  }

  const startAdd = () => {
    setSelected(null)
    setDraft({ ...EMPTY_DRAFT })
  }

  const closeEditor = () => {
    setSelected(null)
    setDraft(null)
  }

  // Every M-code bound to more than one macro, so the conflict can be
  // stated instead of resolved for the operator - both stay, the run path
  // already has the rule for which one a typed word reaches.
  const byMCode = new Map<number, MachineMacro[]>()
  for (const m of macros) {
    if (m.mCode === undefined) continue
    byMCode.set(m.mCode, [...(byMCode.get(m.mCode) ?? []), m])
  }
  const conflicts = Array.from(byMCode.entries()).filter(([, list]) => list.length > 1)

  const bodyCheck = draft ? checkMacroBody(draft.body) : null
  const draftConflict = draft
    ? macros.find((m) => m.id !== draft.id && m.mCode !== undefined && m.mCode === draftMCode(draft.mCodeText))
    : undefined

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={onClose}>
      <div
        className="modal-container macro-editor-modal"
        data-testid="macro-editor-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">{catalogChildren(controlText('MacroEditor.text002', { value1: '\u0000value1\u0000' }), { value1: machine?.name ?? controlText('MacroEditor.machine') })}</span>
          <button
            className="modal-btn modal-btn-ghost"
            onClick={() => setHelpOpen(!helpOpen)}
            data-testid="macro-editor-help"
            data-tooltip={controlText('MacroEditor.text003')}
            aria-label={controlText('MacroEditor.text004')}
            aria-pressed={helpOpen}
          >
            <CircleHelp size={14} />{controlText('MacroEditor.text005')}</button>
          <button className="modal-close-btn" onClick={onClose} data-tooltip={controlText('MacroEditor.text006')} aria-label={controlText('MacroEditor.text007')}>
            <X size={15} />
          </button>
        </div>

        {/* WO-1714 fix round: Help is a pane SWAP inside this same, unchanged
            `.macro-editor-body` (the pre-WO scrolling container - overflow-y:
            auto in MacroEditor.css) rather than a second column beside it.
            Two audit rounds found that widening/splitting this box (a) grew
            the centered modal past the Stop/Reset and E-STOP transport
            controls at 1680x900, and (b) wrapped this box in a plain div that
            had no overflow handling with Help closed, clipping the list past
            ~16 macros with no scroll. Swapping content in place keeps the
            modal at its original `min(720px, 92vw)` width and this box's
            original scroll behaviour in every state.

            A later fix round also tried never letting this modal cover the
            Control page's Stop/Reset and E-STOP controls (moving/anchoring/
            capping it, then raising the controls above the backdrop). Operator
            overruled that (2026-09-19 11:14 CDT): "Just go over the estop...
            No-one is editing macro definitions during active cutting... if
            the user does they take on that risk." The modal is back to
            main's plain centered `.modal-container`/`.macro-editor-modal`
            placement and sizing (`width: min(720px, 92vw); max-height: 86vh`
            in MacroEditor.css) - covering the Stop controls is accepted. */}
        <div className="macro-editor-body">
          {helpOpen ? (
            <MacroHelp onInsertExample={insertExample} onClose={() => setHelpOpen(false)} />
          ) : (
            <>
              {conflicts.length > 0 && (
                <div className="macro-editor-conflicts" data-testid="macro-editor-conflicts">
                  {conflicts.map(([code, list]) => (
                    <div key={code} data-testid={`macro-editor-conflict-M${code}`}>{catalogChildren(controlText('MacroEditor.text008', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000', value4: '\u0000value4\u0000' }), { value1: code, value2: list.map((m) => `"${m.name}"`).join(' and '), value3: code, value4: list[0].name })}</div>
                  ))}
                </div>
              )}

              {macros.length === 0 && !draft && (
                <div className="panel-empty macro-editor-empty" data-testid="macro-editor-empty">{controlText('MacroEditor.text009')}</div>
              )}

              <div className="macro-editor-list" data-testid="macro-editor-list">
                {macros.map((m, index) => {
                  const isSelected = selected === m.id && draft !== null
                  return (
                    <div key={m.id} className="macro-editor-item" data-testid={`macro-editor-item-${m.id}`} data-selected={isSelected ? 'true' : undefined}>
                      <div className="macro-editor-row">
                        <span className="macro-editor-name" data-testid={`macro-editor-item-${m.id}-name`}>{m.name}</span>
                        <span className="control-actions-default" data-testid={`macro-editor-item-${m.id}-mcode`}>
                          {m.mCode === undefined ? controlText('MacroEditor.text010') : `M${m.mCode}`}
                        </span>
                        <span className="control-actions-rowbtns">
                          <button
                            className="panel-action-btn"
                            disabled={index === 0}
                            onClick={() => move(m.id, -1)}
                            data-testid={`macro-editor-item-${m.id}-up`}
                            data-tooltip={controlText('MacroEditor.text011')}
                            aria-label={controlText('MacroEditor.text012', { value1: String(m.name) })}
                          >
                            <ArrowUp size={13} />
                          </button>
                          <button
                            className="panel-action-btn"
                            disabled={index === macros.length - 1}
                            onClick={() => move(m.id, 1)}
                            data-testid={`macro-editor-item-${m.id}-down`}
                            data-tooltip={controlText('MacroEditor.text013')}
                            aria-label={controlText('MacroEditor.text014', { value1: String(m.name) })}
                          >
                            <ArrowDown size={13} />
                          </button>
                          <button
                            className="panel-action-btn"
                            onClick={() => (isSelected ? closeEditor() : startEdit(m))}
                            data-testid={`macro-editor-item-${m.id}-edit`}
                            data-tooltip={controlText('MacroEditor.text015')}
                            aria-label={controlText('MacroEditor.text016', { value1: String(m.name) })}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="panel-action-btn"
                            onClick={() => remove(m.id)}
                            data-testid={`macro-editor-item-${m.id}-delete`}
                            data-tooltip={controlText('MacroEditor.text017')}
                            aria-label={controlText('MacroEditor.text018', { value1: String(m.name) })}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      </div>
                      {isSelected && draft && (
                        <MacroDraftForm
                          parkButton={!!parkDraft}
                          draft={draft}
                          setDraft={setDraft}
                          bodyCheck={bodyCheck}
                          conflictWith={draftConflict}
                          onSave={() => save(draft)}
                          onCancel={closeEditor}
                        />
                      )}
                    </div>
                  )
                })}
              </div>

              {draft && selected === null ? (
                <div className="macro-editor-item macro-editor-item-new" data-testid="macro-editor-new">
                  <MacroDraftForm
                    draft={draft}
                    setDraft={setDraft}
                    bodyCheck={bodyCheck}
                    conflictWith={draftConflict}
                    onSave={() => save(draft)}
                    onCancel={closeEditor}
                  />
                </div>
              ) : (
                <button className="modal-btn modal-btn-ghost" data-testid="macro-editor-add" onClick={startAdd}>
                  <Plus size={13} />{controlText('MacroEditor.text019')}</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function MacroDraftForm({
  draft,
  parkButton = false,
  setDraft,
  bodyCheck,
  conflictWith,
  onSave,
  onCancel,
}: {
  draft: Draft
  parkButton?: boolean
  setDraft: (d: Draft) => void
  bodyCheck: ReturnType<typeof checkMacroBody> | null
  conflictWith: MachineMacro | undefined
  onSave: () => void
  onCancel: () => void
}) {
  const machine = useCamStore(parkCarrierMachine)
  const outputs = machineOutputList(machine)
  const selectedOutput = selectedMacroOutput(outputs, draft.drivesOutput)
  useText('control-screens-not-probing')
  return (
    <div className="control-actions-editor macro-editor-form" data-testid="macro-editor-form">
      <div className="control-actions-editor-row">
        <input
          className="mform-input macro-editor-name-input"
          placeholder={controlText('MacroEditor.text020')}
          value={draft.name}
          data-testid="macro-editor-name"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        {!parkButton && <label className="macro-editor-mcode-label">{controlText('MacroEditor.text021')}<input
            className="mform-input mform-input-mono macro-editor-mcode-input"
            placeholder={controlText('MacroEditor.text022')}
            inputMode="numeric"
            value={draft.mCodeText}
            data-testid="macro-editor-mcode"
            onChange={(e) => setDraft({ ...draft, mCodeText: e.target.value })}
          />
        </label>}
      </div>
      {conflictWith && (
        <div className="control-error-text" data-testid="macro-editor-mcode-conflict">{catalogChildren(controlText('MacroEditor.text023', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: draftMCode(draft.mCodeText), value2: conflictWith.name })}</div>
      )}
      <div className="control-actions-editor-row">
        <span className="control-color-picks">
          {ACTION_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`control-color-pick macro-${c.id} ${draft.color === c.id ? 'control-color-active' : ''}`}
              data-testid={`macro-editor-color-${c.id}`}
              data-tooltip={c.label}
              aria-label={controlText('MacroEditor.text024', { value1: String(c.label) })}
              aria-pressed={draft.color === c.id}
              onClick={() => setDraft({ ...draft, color: c.id })}
            />
          ))}
        </span>
        {!parkButton && <label className="control-actions-confirm">
          <input
            type="checkbox"
            checked={draft.confirm}
            data-testid="macro-editor-confirm"
            onChange={(e) => setDraft({ ...draft, confirm: e.target.checked })}
          />{controlText('MacroEditor.text025')}</label>}
        <label className="control-actions-confirm">
          <input
            type="checkbox"
            checked={!draft.hidden}
            data-testid="macro-editor-shown"
            onChange={(e) => setDraft({ ...draft, hidden: !e.target.checked })}
          />
          {controlText('MacroEditor.text026')}
          {/* WO-2657: a macro off the panel is off - no button, no M-code. */}
          {!parkButton && <span className="control-actions-default" data-testid="macro-editor-shown-note">{controlText('MacroEditor.hiddenNote')}</span>}
        </label>
      </div>
      {!parkButton && <label className="macro-editor-mcode-label">
        {controlText('MacroEditor.drivesOutput')}
        <select
          className="mform-input"
          data-testid="macro-editor-output"
          value={selectedOutput ? macroOutputSelection(selectedOutput) : draft.drivesOutput}
          onChange={(e) => setDraft({ ...draft, drivesOutput: e.target.value })}
        >
          <option value="">{controlText('MacroEditor.outputNone')}</option>
          {draft.drivesOutput && !selectedOutput && (
            <option value={draft.drivesOutput}>{draft.drivesOutput}</option>
          )}
          {outputs.map((output, index) => (
            <option key={index} value={macroOutputSelection(output)}>{macroOutputLabel(output, outputs)}</option>
          ))}
        </select>
      </label>}
      {parkButton && <div className="control-actions-default">{controlText('MacroEditor.parkDisplayNote')}</div>}
      <textarea
        readOnly={parkButton}
        className="mform-input mform-input-mono macro-editor-code"
        placeholder="line('M7')"
        rows={8}
        value={draft.body}
        data-testid="macro-editor-body"
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
      />
      {!parkButton && bodyCheck && !bodyCheck.ok && (
        <div className="control-error-text" data-testid="macro-editor-body-error">{catalogChildren(controlText('MacroEditor.text027', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000' }), { value1: bodyCheck.line, value2: bodyCheck.column, value3: bodyCheck.message })}</div>
      )}
      {!parkButton && <div className="macro-editor-api" data-testid="macro-editor-api-list">
        <span className="control-actions-label">{controlText('MacroEditor.text028')}</span>
        <ul>
          {MACRO_API.map((name) => (
            <li key={name} data-testid={`macro-editor-api-${name}`}>{API_HELP[name]}</li>
          ))}
        </ul>
      </div>}
      <div className="control-actions-editor-row">
        <span className="control-actions-rowbtns">
          <button className="modal-btn modal-btn-primary" data-testid="macro-editor-save" onClick={onSave}>{controlText('MacroEditor.text029')}</button>
          <button className="modal-btn modal-btn-ghost" data-testid="macro-editor-cancel" onClick={onCancel}>{controlText('MacroEditor.text030')}</button>
        </span>
      </div>
    </div>
  )
}
