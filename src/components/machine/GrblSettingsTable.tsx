import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useEffect, useMemo, useState } from 'react'
import type { MachineConfig } from '../../types'
import { useMachineControl } from '../../store/machineControlStore'
import {
  applyStoredGrblSettings,
  readConnectedGrblSettings,
  writeGrblSettingAndReadBack,
} from '../../lib/machine/machineSession'
import {
  cloneGrblSettings,
  formatGrblMask,
  GRBL_SETTINGS,
  recordGrblSettings,
  type GrblSettingsRecord,
} from '../../lib/machine/grbl/settings'

interface GrblSettingsTableProps {
  machine: MachineConfig
  onChange: (mut: (machine: MachineConfig) => MachineConfig) => void
}

export function GrblSettingsTable({ machine, onChange }: GrblSettingsTableProps) {
  useText('control-screens-not-probing')
  const connectionPhase = useMachineControl((state) => state.connectionPhase)
  const connectionKind = useMachineControl((state) => state.connectionKind)
  const reported = useMachineControl((state) => state.settings)
  const connected = connectionPhase === 'connected' && connectionKind === 'serial'
  const stored = cloneGrblSettings(machine)
  const [typed, setTyped] = useState<GrblSettingsRecord>({})
  const [sending, setSending] = useState<number | 'all' | 'read' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [offlineEdited, setOfflineEdited] = useState<Set<number>>(() => new Set())

  useEffect(() => {
    setTyped((current) => {
      const next = { ...current }
      for (const [key, value] of Object.entries(connected ? reported : stored)) {
        if (sending !== Number(key)) next[Number(key)] = value
      }
      return next
    })
  }, [connected, reported, machine.grblSettings, sending])

  const rows = useMemo(() => {
    const ids = new Set<number>([
      ...Object.keys(stored).map(Number),
      ...(connected ? Object.keys(reported).map(Number) : []),
    ])
    return [...ids].filter(Number.isSafeInteger).sort((left, right) => left - right)
  }, [connected, reported, machine.grblSettings])

  const submit = async (id: number): Promise<void> => {
    if (sending !== null) return
    const current = connected ? reported[id] : stored[id]
    const value = (typed[id] ?? current ?? '').trim()
    if (value === current) return
    if (!connected) {
      setOfflineEdited((current) => new Set(current).add(id))
      onChange((current) => recordGrblSettings(current, {
        ...(current.grblSettings ?? {}),
        [id]: value,
      }))
      setMessage(controlText('GrblSettingsTable.text001', { value1: String(id) }))
      return
    }
    if (value === reported[id]) return
    setSending(id)
    setMessage(controlText('GrblSettingsTable.text002', { value1: String(id) }))
    const result = await writeGrblSettingAndReadBack(id, value)
    if (result.ok) {
      setTyped((current) => ({ ...current, [id]: result.value }))
      onChange((current) => recordGrblSettings(current, {
        ...(current.grblSettings ?? {}),
        [id]: result.value,
      }))
      setMessage(controlText('GrblSettingsTable.text003', { value1: String(id), value2: String(result.value) }))
    } else {
      setTyped((current) => ({ ...current, [id]: reported[id] ?? stored[id] ?? '' }))
      setMessage(controlText('GrblSettingsTable.text004', { value1: String(result.reason) }))
    }
    setSending(null)
  }

  const read = async (): Promise<void> => {
    if (sending !== null || !connected) return
    setSending('read')
    setMessage(controlText('GrblSettingsTable.text005'))
    try {
      const result = await readConnectedGrblSettings()
      const readback = Object.fromEntries(result) as GrblSettingsRecord
      onChange((current) => recordGrblSettings(current, readback))
      setOfflineEdited(new Set())
      setMessage(controlText('GrblSettingsTable.text006', { value1: String(result.size) }))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(null)
    }
  }

  const applyStored = async (): Promise<void> => {
    if (sending !== null || !connected) return
    setSending('all')
    const intent = stored
    const differing = Object.keys(intent).filter((key) => intent[Number(key)] !== reported[Number(key)])
    if (differing.length === 0) {
      setMessage(controlText('GrblSettingsTable.text007'))
      setSending(null)
      return
    }
    setMessage(controlText('GrblSettingsTable.text008', { value1: String(differing.length), value2: String(differing.length === 1 ? '' : 's') }))
    const results = await applyStoredGrblSettings(intent)
    const failed = results.filter((result) => !result.ok).length
    const readback = results.filter((result) => result.ok)
    if (readback.length > 0) {
      onChange((current) => recordGrblSettings(current, {
        ...(current.grblSettings ?? {}),
        ...Object.fromEntries(readback.map((result) => [result.key, result.value])),
      }))
    }
    setMessage(failed === 0
      ? controlText('GrblSettingsTable.text009', { value1: String(results.length), value2: String(results.length === 1 ? '' : 's') })
      : controlText('GrblSettingsTable.text010', { value1: String(failed), value2: String(failed === 1 ? '' : 's') }))
    setSending(null)
  }

  return (
    <section data-testid="machine-def-grbl-settings" style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <strong>{controlText('GrblSettingsTable.text011')}</strong>
        <button type="button" className="control-chip-btn" onClick={() => { void read() }} disabled={!connected || sending !== null}>{controlText('GrblSettingsTable.text012')}</button>
        <button
          type="button"
          className="control-chip-btn"
          data-testid="machine-def-grbl-apply-stored"
          onClick={() => { void applyStored() }}
          disabled={!connected || sending !== null || Object.keys(stored).length === 0}
        >{controlText('GrblSettingsTable.text013')}</button>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          {connected ? controlText('GrblSettingsTable.text014') : controlText('GrblSettingsTable.text015')}
        </span>
      </div>
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <table
          className="mform-axis-table"
          data-testid="machine-def-grbl-table"
          style={{ width: '100%', maxWidth: 850, minWidth: 720, tableLayout: 'fixed' }}
        >
          <thead>
            <tr>
              <th style={{ width: 64 }}>{controlText('GrblSettingsTable.text016')}</th>
              <th style={{ width: 260 }}>{controlText('GrblSettingsTable.text017')}</th>
              <th style={{ width: 130 }}>{controlText('GrblSettingsTable.text018')}</th>
              <th style={{ width: 130 }}>{controlText('GrblSettingsTable.text019')}</th>
              <th style={{ width: 155 }}>{controlText('GrblSettingsTable.text020')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((id) => {
              const definition = GRBL_SETTINGS[id]
              const current = connected ? reported[id] : stored[id]
              const intended = stored[id]
              const state = connected
                ? intended !== undefined && intended !== current ? controlText('GrblSettingsTable.text021') : controlText('GrblSettingsTable.text022')
                : offlineEdited.has(id) ? controlText('GrblSettingsTable.text023') : controlText('GrblSettingsTable.text024')
              const mask = definition?.kind === 'mask' && current !== undefined
                ? formatGrblMask(current, definition.maskBits ?? [])
                : definition?.unit ?? ''
              return (
                <tr key={id} data-testid={`machine-def-grbl-row-${id}`}>
                  <th scope="row">${id}</th>
                  <td>{definition?.name ?? controlText('GrblSettingsTable.text025')}</td>
                  <td>
                    <input
                      className="mform-input mform-input-mono"
                      aria-label={controlText('GrblSettingsTable.text026', { value1: String(id) })}
                      value={typed[id] ?? current ?? ''}
                      disabled={sending !== null}
                      onChange={(event) => setTyped((values) => ({ ...values, [id]: event.target.value }))}
                      onBlur={() => { void submit(id) }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        void submit(id)
                      }}
                      style={{ width: '100%', minWidth: 72 }}
                    />
                  </td>
                  <td title={definition?.unit}>{mask}</td>
                  <td data-testid={`machine-def-grbl-state-${id}`}>{sending === id ? 'sending' : state}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p className="mform-help">{controlText('GrblSettingsTable.text027')}</p>
      )}
      {message && <p className="mform-help" role="status" data-testid="machine-def-grbl-status">{message}</p>}
    </section>
  )
}
