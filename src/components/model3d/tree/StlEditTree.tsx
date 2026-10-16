import { Pencil, Settings2 } from 'lucide-react'
import { describeMeshEdit, type MeshEditRecord } from '../../../mesh/edit'
import { useText } from '../../../i18n'
import type { FeatureTreeEditEntry } from './FeatureTree'

export const stlEditRowId = (recordId: string): string => `stl-edit:${recordId}`

/** STL history belongs to the imported row's persisted journal, never the
 * kernel DAG. Both tree Edit and toolbar Edit use the same resolver. */
export function StlEditTree({ records, selectedId, onSelect, editEntryFor }: {
  records: readonly MeshEditRecord[]
  selectedId: string | null
  onSelect(id: string): void
  editEntryFor(id: string): FeatureTreeEditEntry | undefined
}) {
  const text = useText('sketch-and-model-workbench')
  return <>{records.map((record) => {
    const id = stlEditRowId(record.id)
    const entry = editEntryFor(id)
    const editable = entry !== undefined && 'onEdit' in entry
    const selected = selectedId === id
    return <div key={id} className="wb-tree-row" data-testid={`feature-row-${id}`}
      role="treeitem" tabIndex={0} aria-selected={selected} onClick={() => onSelect(id)}
      onDoubleClick={() => { if (editable) entry.onEdit() }}
      onKeyDown={(event) => { if (event.key === 'Enter' && editable) { onSelect(id); entry.onEdit() } }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 'var(--row-default)', padding: '0 8px',
        cursor: 'pointer', background: selected ? 'var(--select-ui-bg)' : 'transparent',
        borderLeft: selected ? '2px solid var(--accent-blue)' : '2px solid transparent', borderBottom: '1px solid var(--border-subtle)' }}>
      <Settings2 size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={describeMeshEdit(record)}>
        {describeMeshEdit(record)}
      </span>
      {editable && <button type="button" className="wb-row-action" data-testid={`stl-edit-reopen-${record.id}`}
        aria-label={text('SolidsWorkbenchPage.edit')} data-tooltip={text('SolidsWorkbenchPage.edit')}
        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 2 }}
        onClick={(event) => { event.stopPropagation(); onSelect(id); entry.onEdit() }}>
        <Pencil size={13} aria-hidden="true" />
      </button>}
    </div>
  })}</>
}
