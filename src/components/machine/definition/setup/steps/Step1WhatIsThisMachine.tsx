import { textFor, useText } from '../../../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useRef, useState } from 'react'
import type { ControllerType, MachineConfig, MachineKind } from '../../../../../types'
import { AXIS_NAMES, createDefaultControllerDefinition } from '../../../../../types'
import {
  importUccncProfile,
  withImportedUccncToolSetter,
} from '../../../../../lib/machine/uccncProfileImport'
import { readConnectedGrblSettings } from '../../../../../lib/machine/machineSession'
import { recordGrblSettings } from '../../../../../lib/machine/grbl/settings'
import { MACHINE_KIND_OPTIONS, MACHINE_CONTROLLER_OPTIONS } from '../../../MachineDefinitionPanel'

// WO-1696 step 1 (v2/SLICES.md T13) - name, kind, controller, and the three
// ways to start: import a `.pro` (ADR-0044: the file is read only, never
// written back), read a connected GRBL board's $$ table, or start blank.
// Whichever path runs, every later step is reachable and none is required -
// "start blank" alone must leave a usable, if empty, machine record.

export interface Step1Props {
  draft: MachineConfig
  editDraft: (mut: (m: MachineConfig) => MachineConfig) => void
  onFilled: (stepKeys: string[]) => void
}

function ensureDefinition(editDraft: Step1Props['editDraft']): void {
  editDraft((m) => (m.controllerDefinition
    ? m
    : { ...m, controllerDefinition: createDefaultControllerDefinition(AXIS_NAMES) }))
}

export function Step1WhatIsThisMachine({ draft, editDraft, onFilled }: Step1Props) {
  useText('control-screens-not-probing')
  const fileRef = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleProFile = (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setMessage(null)
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const imported = importUccncProfile(text)
      if (!imported.definition) {
        setBusy(false)
        setMessage(controlText('Step1WhatIsThisMachine.text001', { value1: String(file.name) }))
        return
      }
      editDraft((m) => withImportedUccncToolSetter({
        ...m,
        name: imported.profileName?.trim() || m.name,
        controller: 'uccnc',
        travel: imported.travel ?? m.travel,
        controllerDefinition: imported.definition!,
        unsentSettings: imported.unsent,
      }, imported.toolSetter))
      setBusy(false)
      setMessage(controlText('Step1WhatIsThisMachine.text002', { value1: String(file.name), value2: String(imported.issues.length), value3: String(imported.issues.length === 1 ? '' : 's') }))
      onFilled(['axes', 'home', 'spindle', 'outputs', 'probing'])
    }
    reader.onerror = () => {
      setBusy(false)
      setMessage(controlText('Step1WhatIsThisMachine.text003', { value1: String(file.name) }))
    }
    reader.readAsText(file)
  }

  const handleReadBoard = async () => {
    setBusy(true)
    setMessage(controlText('Step1WhatIsThisMachine.text004'))
    try {
      ensureDefinition(editDraft)
      const result = await readConnectedGrblSettings()
      const readback = Object.fromEntries(result)
      editDraft((m) => recordGrblSettings(m, readback))
      setMessage(controlText('Step1WhatIsThisMachine.text005', { value1: String(result.size) }))
      onFilled(['axes'])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleStartBlank = () => {
    ensureDefinition(editDraft)
    setMessage(controlText('Step1WhatIsThisMachine.text006'))
  }

  return (
    <div data-testid="setup-step-what" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 420 }}>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{controlText('Step1WhatIsThisMachine.text007')}</p>

      <label className="mform-label" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{controlText('Step1WhatIsThisMachine.text008')}<input
          type="text"
          className="mform-input"
          aria-label={controlText('Step1WhatIsThisMachine.text009')}
          data-testid="setup-step-what-name"
          value={draft.name}
          onChange={(e) => { editDraft((m) => ({ ...m, name: e.target.value })) }}
        />
      </label>

      <label className="mform-label" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{controlText('Step1WhatIsThisMachine.text010')}<select
          className="mform-select"
          aria-label={controlText('Step1WhatIsThisMachine.text011')}
          data-testid="setup-step-what-kind"
          value={draft.kind ?? 'router'}
          onChange={(e) => { editDraft((m) => ({ ...m, kind: e.target.value as MachineKind })) }}
        >
          {MACHINE_KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </label>

      <label className="mform-label" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{controlText('Step1WhatIsThisMachine.text012')}<select
          className="mform-select"
          aria-label={controlText('Step1WhatIsThisMachine.text013')}
          data-testid="setup-step-what-controller"
          value={draft.controller}
          onChange={(e) => { editDraft((m) => ({ ...m, controller: e.target.value as ControllerType })) }}
        >
          {MACHINE_CONTROLLER_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="control-chip-btn"
          data-testid="setup-step-what-import-pro"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >{controlText('Step1WhatIsThisMachine.text014')}</button>
        <input
          ref={fileRef}
          type="file"
          accept=".pro"
          data-testid="setup-step-what-import-pro-input"
          style={{ display: 'none' }}
          onChange={(e) => { handleProFile(e.target.files?.[0]); e.target.value = '' }}
        />
        <button
          type="button"
          className="control-chip-btn"
          data-testid="setup-step-what-read-board"
          disabled={busy}
          onClick={() => { void handleReadBoard() }}
        >{controlText('Step1WhatIsThisMachine.text015')}</button>
        <button
          type="button"
          className="control-chip-btn"
          data-testid="setup-step-what-start-blank"
          disabled={busy}
          onClick={handleStartBlank}
        >{controlText('Step1WhatIsThisMachine.text016')}</button>
      </div>

      {message && (
        <p data-testid="setup-step-what-message" style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
          {message}
        </p>
      )}
    </div>
  )
}
