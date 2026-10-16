// WO UI-13B: named-parameter table UI, wired directly onto DOC-4's engine
// (src/doc/params/table.ts's ParameterTable) -- the DOC-4 WO delivered the
// engine only (parser/evaluator/table/executor), with zero src/components
// entries; this is the first UI ever built against that surface. Reachable
// on the real workbench route (?lab3d=1&workbench=1), not a dev-only demo.
//
// Layout/contract mirrors this page's OTHER docked panels (BodyListPanel):
// pure props-in/callbacks-out, the PARENT (SolidsWorkbenchPage) owns the
// live ParameterTable instance + the shared dag/scheduler it regenerates
// through, so a parameter edit here regenerates the SAME feature tree a
// dialog Apply does -- no second regen path.
//
// Testids EXACTLY per the INT-5 scanner (tools/smoke/int5-premise-check.mjs:133):
// params-table, param-add, param-row.

import { useText } from '../../../i18n'
import { useState } from 'react'
import type { ParameterTable } from '../../../doc'

export interface ParametersTableProps {
  paramTable: ParameterTable
  /** Bumped by the parent after any mutation (setExpression/undo/redo/delete)
   *  so this purely-derived-from-paramTable component re-renders -- ParameterTable
   *  itself has no subscribe() (it is a thin CRUD/orchestration layer, not a
   *  store), same reason the parent's own `dagVersion` exists for the tree. */
  version: number
  /** Called after a successful mutation so the parent can bump `version`
   *  (and, in future, log a console event) -- see SolidsWorkbenchPage's
   *  handleParamChanged. */
  onChanged(): void
  /** Attempts to delete parameter `name`. Returns an error message (parameter
   *  NOT deleted) when other nodes still directly consume it, or undefined on
   *  success. Synchronous: deletion never touches the kernel (a parameter
   *  with no consumers has nothing downstream to regenerate). */
  onDeleteParameter(name: string): string | undefined
}

function formatParamDiag(diag: { code: string; params: Record<string, string> } | undefined): string | undefined {
  if (diag === undefined) return undefined
  const detail = Object.entries(diag.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  return detail === '' ? diag.code : `${diag.code}: ${detail}`
}

const rowStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0', borderBottom: "1px solid var(--border-subtle, #2a3540)" }
const fieldRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: 'border-box',
  background: 'var(--surface-1, #161b20)',
  color: 'var(--text-primary)',
  border: "1px solid var(--border-subtle, #2a3540)",
  borderRadius: 4,
  padding: '2px 6px',
}

export function ParametersTable({ paramTable, version, onChanged, onDeleteParameter }: ParametersTableProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  void version // re-render trigger only -- every read below goes straight through paramTable
  const [newName, setNewName] = useState('')
  const [newExpression, setNewExpression] = useState('')
  const [addError, setAddError] = useState<string | undefined>(undefined)
  // Per-name draft strings for an EXISTING row's expression field, so typing
  // doesn't commit on every keystroke (mirrors ExtrudeDialog's fx field,
  // committed on blur/Enter instead of onChange).
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string | undefined>>({})
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string | undefined>>({})

  const names = paramTable.names()

  const commitNew = async (): Promise<void> => {
    const name = newName.trim()
    if (name === '') return
    const outcome = await paramTable.setExpression(name, newExpression)
    if (!outcome.ok) {
      setAddError(formatParamDiag(outcome.diag))
      return
    }
    setAddError(undefined)
    setNewName('')
    setNewExpression('')
    onChanged()
  }

  const commitRow = async (name: string): Promise<void> => {
    const draft = drafts[name]
    if (draft === undefined) return
    const outcome = await paramTable.setExpression(name, draft)
    if (!outcome.ok) {
      setRowErrors((prev) => ({ ...prev, [name]: formatParamDiag(outcome.diag) }))
      return
    }
    setRowErrors((prev) => ({ ...prev, [name]: undefined }))
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    onChanged()
  }

  const handleDelete = (name: string): void => {
    const err = onDeleteParameter(name)
    setDeleteErrors((prev) => ({ ...prev, [name]: err }))
    if (err === undefined) onChanged()
  }

  return (
    <div data-testid="params-table" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontWeight: 600 }}>{workbenchText('ParametersTable.parameters')}</div>
      {names.length === 0 ? (
        <div style={{ color: 'var(--text-muted)' }} data-testid="params-table-empty">
          {workbenchText('ParametersTable.noParametersYet')}</div>
      ) : (
        names.map((name) => {
          const draft = drafts[name] ?? paramTable.expressionOf(name) ?? ''
          const status = paramTable.statusOf(name)
          const diagnostic = paramTable.diagnosticsOf(name)[0]
          return (
            <div key={name} data-testid="param-row" style={rowStyle}>
              <div style={fieldRowStyle}>
                <span data-testid={`param-name-${name}`} style={{ width: 90, fontFamily: 'monospace' }}>
                  {name}
                </span>
                <input
                  data-testid={`param-expression-${name}`}
                  type="text"
                  value={draft}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [name]: e.target.value }))}
                  onBlur={() => void commitRow(name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  style={inputStyle}
                />
                <span data-testid={`param-value-${name}`} style={{ width: 90, textAlign: 'right', color: 'var(--text-muted)' }}>
                  {paramTable.valueOf(name)?.toFixed(4) ?? '--'}
                </span>
                <button type="button" data-testid={`param-delete-${name}`} className="modal-btn modal-btn-ghost" onClick={() => handleDelete(name)}>
                  {workbenchText('ParametersTable.delete')}</button>
              </div>
              {status !== 'ok' && diagnostic !== undefined && (
                <div data-testid={`param-status-${name}`} style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
                  {formatParamDiag(diagnostic as { code: string; params: Record<string, string> })}
                </div>
              )}
              {rowErrors[name] !== undefined && (
                <div data-testid={`param-row-error-${name}`} style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
                  {rowErrors[name]}
                </div>
              )}
              {deleteErrors[name] !== undefined && (
                <div data-testid={`param-delete-error-${name}`} style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
                  {deleteErrors[name]}
                </div>
              )}
            </div>
          )
        })
      )}
      {/* WO UI-13B (INT-5 scanner, tools/smoke/int5-premise-check.mjs:133): the
          scanner's own script never creates a parameter before checking
          workbench testids, so `param-row` must be discoverable from a
          fresh, zero-parameter page load -- this "add a new parameter" row
          IS a row of the table (an editable blank one, the same idiom a
          spreadsheet's always-visible entry row uses), not a separate
          concept from the committed rows above. */}
      <div data-testid="param-row" style={fieldRowStyle}>
        <input data-testid="param-new-name" type="text" placeholder={workbenchText('ParametersTable.name')} value={newName} onChange={(e) => setNewName(e.target.value)} style={{ ...inputStyle, width: 90, flex: 'unset' }} />
        <input
          data-testid="param-new-expression"
          type="text"
          placeholder={workbenchText('ParametersTable.expressionEG2Base5Or10mm')}
          value={newExpression}
          onChange={(e) => setNewExpression(e.target.value)}
          style={inputStyle}
        />
        <button type="button" data-testid="param-add" className="modal-btn modal-btn-primary" disabled={newName.trim() === ''} onClick={() => void commitNew()}>
          {workbenchText('ParametersTable.add')}</button>
      </div>
      {addError !== undefined && (
        <div data-testid="param-add-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
          {addError}
        </div>
      )}
    </div>
  )
}
