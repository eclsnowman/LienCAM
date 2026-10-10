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
import { parkCarrierMachine, saveParkMachineRecord } from '../../store/machineActionsStore'
import { checkMacroBody, MACRO_API, machineMacros } from '../../lib/machine/macros/macroRuntime'
import { ACTION_COLORS, type ActionColor } from '../../lib/machine/machineActions'
import { publishMacroDraft } from '../../lib/exportCenter'
import { newMachineMacroId, type MachineMacro } from '../../types'
import { API_HELP, MacroHelp } from './MacroHelp'
import './MacroEditor.css'

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
  }
}

const EMPTY_DRAFT: Draft = { id: null, name: '', mCodeText: '', body: '', color: 'neutral', confirm: false, hidden: false }

function macroFromDraft(next: Draft, id: string, carried: MachineMacro | undefined): MachineMacro {
  const macro: MachineMacro = {
    id,
    name: next.name.trim() || 'Unnamed macro',
    ...(draftMCode(next.mCodeText) === undefined ? {} : { mCode: draftMCode(next.mCodeText) }),
    body: next.body,
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
  const machine = useCamStore(controlMachine)
  const parkMachine = useCamStore(parkCarrierMachine)
  const macros = machineMacros(parkMachine)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
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
    if (!open || !draft) {
      if (published.current) publishMacroDraft(null)
      published.current = false
      return
    }
    const carried = macros.find((m) => m.id === draft.id)
    publishMacroDraft(macroFromDraft(draft, draft.id ?? 'macro-draft', carried))
    published.current = true
  }, [open, draft, macros])
  useEffect(() => () => {
    if (published.current) publishMacroDraft(null)
  }, [])

  if (!open) return null

  // WO-1714: an example's body replaces whatever macro is being edited; with
  // none open, it starts a new one (rule 11 - it does the thing, never
  // refuses for lack of a selection).
  const insertExample = (body: string) => {
    if (draft) {
      setDraft({ ...draft, body })
    } else {
      setSelected(null)
      setDraft({ ...EMPTY_DRAFT, body })
    }
    setHelpOpen(false)
  }

  const save = (next: Draft) => {
    const id = next.id ?? newMachineMacroId()
    const withCarried = macroFromDraft(next, id, macros.find((m) => m.id === id))
    const existing = macros.some((m) => m.id === withCarried.id)
    const nextMacros = existing
      ? macros.map((m) => (m.id === withCarried.id ? withCarried : m))
      : [...macros, withCarried]
    saveParkMachineRecord({ ...parkMachine, macros: nextMacros })
    setSelected(withCarried.id)
    setDraft(draftFromMacro(withCarried))
  }

  const remove = (id: string) => {
    saveParkMachineRecord({ ...parkMachine, macros: macros.filter((m) => m.id !== id) })
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
    saveParkMachineRecord({ ...parkMachine, macros: next })
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
          <span className="modal-title">Edit macros - {machine?.name ?? 'machine'}</span>
          <button
            className="modal-btn modal-btn-ghost"
            onClick={() => setHelpOpen(!helpOpen)}
            data-testid="macro-editor-help"
            data-tooltip="Macro help and examples"
            aria-label="Macro help"
            aria-pressed={helpOpen}
          >
            <CircleHelp size={14} /> Help
          </button>
          <button className="modal-close-btn" onClick={onClose} data-tooltip="Close" aria-label="Close">
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
                    <div key={code} data-testid={`macro-editor-conflict-M${code}`}>
                      M{code} is bound to {list.map((m) => `"${m.name}"`).join(' and ')} - typing M{code} runs "{list[0].name}" (the first one in the list).
                    </div>
                  ))}
                </div>
              )}

              {macros.length === 0 && !draft && (
                <div className="panel-empty macro-editor-empty" data-testid="macro-editor-empty">No macros yet.</div>
              )}

              <div className="macro-editor-list" data-testid="macro-editor-list">
                {macros.map((m, index) => {
                  const isSelected = selected === m.id && draft !== null
                  return (
                    <div key={m.id} className="macro-editor-item" data-testid={`macro-editor-item-${m.id}`} data-selected={isSelected ? 'true' : undefined}>
                      <div className="macro-editor-row">
                        <span className="macro-editor-name" data-testid={`macro-editor-item-${m.id}-name`}>{m.name}</span>
                        <span className="control-actions-default" data-testid={`macro-editor-item-${m.id}-mcode`}>
                          {m.mCode === undefined ? 'no M-code' : `M${m.mCode}`}
                        </span>
                        <span className="control-actions-rowbtns">
                          <button
                            className="panel-action-btn"
                            disabled={index === 0}
                            onClick={() => move(m.id, -1)}
                            data-testid={`macro-editor-item-${m.id}-up`}
                            data-tooltip="Move up"
                            aria-label={`Move ${m.name} up`}
                          >
                            <ArrowUp size={13} />
                          </button>
                          <button
                            className="panel-action-btn"
                            disabled={index === macros.length - 1}
                            onClick={() => move(m.id, 1)}
                            data-testid={`macro-editor-item-${m.id}-down`}
                            data-tooltip="Move down"
                            aria-label={`Move ${m.name} down`}
                          >
                            <ArrowDown size={13} />
                          </button>
                          <button
                            className="panel-action-btn"
                            onClick={() => (isSelected ? closeEditor() : startEdit(m))}
                            data-testid={`macro-editor-item-${m.id}-edit`}
                            data-tooltip="Edit"
                            aria-label={`Edit ${m.name}`}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="panel-action-btn"
                            onClick={() => remove(m.id)}
                            data-testid={`macro-editor-item-${m.id}-delete`}
                            data-tooltip="Delete this macro"
                            aria-label={`Delete ${m.name}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      </div>
                      {isSelected && draft && (
                        <MacroDraftForm
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
                  <Plus size={13} /> Add macro
                </button>
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
  setDraft,
  bodyCheck,
  conflictWith,
  onSave,
  onCancel,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  bodyCheck: ReturnType<typeof checkMacroBody> | null
  conflictWith: MachineMacro | undefined
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="control-actions-editor macro-editor-form" data-testid="macro-editor-form">
      <div className="control-actions-editor-row">
        <input
          className="mform-input macro-editor-name-input"
          placeholder="Macro name"
          value={draft.name}
          data-testid="macro-editor-name"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <label className="macro-editor-mcode-label">
          M-code
          <input
            className="mform-input mform-input-mono macro-editor-mcode-input"
            placeholder="none"
            inputMode="numeric"
            value={draft.mCodeText}
            data-testid="macro-editor-mcode"
            onChange={(e) => setDraft({ ...draft, mCodeText: e.target.value })}
          />
        </label>
      </div>
      {conflictWith && (
        <div className="control-error-text" data-testid="macro-editor-mcode-conflict">
          M{draftMCode(draft.mCodeText)} is already bound to "{conflictWith.name}" - both will run from that M-code, first in the list.
        </div>
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
              aria-label={`Color: ${c.label}`}
              aria-pressed={draft.color === c.id}
              onClick={() => setDraft({ ...draft, color: c.id })}
            />
          ))}
        </span>
        <label className="control-actions-confirm">
          <input
            type="checkbox"
            checked={draft.confirm}
            data-testid="macro-editor-confirm"
            onChange={(e) => setDraft({ ...draft, confirm: e.target.checked })}
          />
          ask twice
        </label>
        <label className="control-actions-confirm">
          <input
            type="checkbox"
            checked={!draft.hidden}
            data-testid="macro-editor-shown"
            onChange={(e) => setDraft({ ...draft, hidden: !e.target.checked })}
          />
          on the panel
          {/* WO-2657: a macro off the panel is off - no button, no M-code. */}
          <span className="control-actions-default" data-testid="macro-editor-shown-note">(off: does not run)</span>
        </label>
      </div>
      <textarea
        className="mform-input mform-input-mono macro-editor-code"
        placeholder="line('M7')"
        rows={8}
        value={draft.body}
        data-testid="macro-editor-body"
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
      />
      {bodyCheck && !bodyCheck.ok && (
        <div className="control-error-text" data-testid="macro-editor-body-error">
          Line {bodyCheck.line}, column {bodyCheck.column}: {bodyCheck.message}.
        </div>
      )}
      <div className="macro-editor-api" data-testid="macro-editor-api-list">
        <span className="control-actions-label">Macro API</span>
        <ul>
          {MACRO_API.map((name) => (
            <li key={name} data-testid={`macro-editor-api-${name}`}>{API_HELP[name]}</li>
          ))}
        </ul>
      </div>
      <div className="control-actions-editor-row">
        <span className="control-actions-rowbtns">
          <button className="modal-btn modal-btn-primary" data-testid="macro-editor-save" onClick={onSave}>Save</button>
          <button className="modal-btn modal-btn-ghost" data-testid="macro-editor-cancel" onClick={onCancel}>Cancel</button>
        </span>
      </div>
    </div>
  )
}
