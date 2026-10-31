// WO-3308: one Control column. Outside Arrange it is a plain stack of the shown modules, so no
// window size and no gesture can move anything. In Arrange each module gets a dashed outline and a
// grip; dragging shows a drop line, and dropping moves the module (the only way modules move).
import { useState, type DragEvent, type ReactNode } from 'react'
import { useText } from '../../i18n'
import { isLocked, type ControlColumn, type ControlModuleId, type ModulePlacement } from './layout'
import { MODULE_LABEL_KEY } from './modules'
import type { ControlLayoutApi } from './useControlLayout'
import './arrange.css'

export interface ArrangeColumnProps {
  readonly column: ControlColumn
  readonly api: ControlLayoutApi
  /** The module's content; the workspace draws it (WO-3298). */
  render(placement: ModulePlacement): ReactNode
}

/** The module being dragged. One value for all three columns, so a drag can cross from one to another. */
let dragged: ControlModuleId | null = null
const startDrag = (id: ControlModuleId) => { dragged = id }
const endDrag = () => { dragged = null }

export function ArrangeColumn({ column, api, render }: ArrangeColumnProps) {
  const t = useText('ui2-control-arrange.wo3308')
  const [drop, setDrop] = useState<number | null>(null)
  const modules = api.columns(column)

  const indexAt = (e: DragEvent<HTMLElement>): number => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(':scope > [data-module]')]
    const at = items.findIndex(el => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 })
    return at < 0 ? items.length : at
  }
  const onDrop = (e: DragEvent<HTMLElement>) => {
    const id = dragged
    const index = indexAt(e)
    endDrag()
    setDrop(null)
    if (!id) return
    // the index counts the shown modules; map it to a place among all of the column's modules
    const all = api.layout.placements.filter(p => p.column === column && p.id !== id)
    const before = modules.filter(m => m.id !== id)[index > modules.findIndex(m => m.id === id) && modules.some(m => m.id === id) ? index - 1 : index]
    api.move(id, column, before ? all.findIndex(p => p.id === before.id) : all.length)
    e.preventDefault()
  }

  if (!api.arranging) {
    return (
      <div className="arrange-column" data-column={column} data-testid={`control-column-${column}`}>
        {modules.map(p => <div key={p.id} data-module={p.id} data-folded={p.folded || undefined}>{render(p)}</div>)}
      </div>
    )
  }
  return (
    <div className="arrange-column" data-column={column} data-arranging="" data-testid={`control-column-${column}`}
      onDragOver={e => { if (dragged) { e.preventDefault(); setDrop(indexAt(e)) } }}
      onDragLeave={() => setDrop(null)} onDrop={onDrop}>
      {modules.map((p, i) => (
        <div key={p.id} className="arrange-frame" data-module={p.id} data-locked={isLocked(p.id) || undefined}>
          {drop === i && <div className="arrange-drop" data-testid="arrange-drop-line" />}
          {!isLocked(p.id) && (
            <span className="arrange-grip" draggable data-testid={`arrange-grip-${p.id}`}
              aria-label={t('grip', { name: t(MODULE_LABEL_KEY[p.id]) })}
              onDragStart={() => startDrag(p.id)} onDragEnd={() => { endDrag(); setDrop(null) }} />
          )}
          {render(p)}
        </div>
      ))}
      {drop === modules.length && <div className="arrange-drop" data-testid="arrange-drop-line" />}
    </div>
  )
}
