import { textFor, useText } from '../../i18n'
import { useState } from 'react'

const shellText = textFor('app-shell-settings-menus')

// P2 (clutter audit, 2026-07): the ONE inline-rename mechanism for every named
// design-tree row (project, geometry, layer, folder, nest, seed child, stock,
// setup, operation). At rest it renders the row's name label; while `editing`
// it renders an input IN PLACE of the label, pre-filled with the current name
// and fully selected so typing replaces it.
//
// Contract (identical for every row type):
// - Double-click on the NAME TEXT starts the edit (stopPropagation so the row
//   body's click/dblclick stays free — P13 will claim row-body double-click
//   for sketch edit). F2 / context-menu Rename start it via `editing` from
//   the parent (DesignTree owns the single rename target).
// - Enter or blur commits through onCommit — the parent routes that to the
//   row type's EXISTING store rename action (no new write paths).
// - Escape cancels; an empty / whitespace-only name cancels (no rename).
//
// Styling reuses the existing rename-input classes (.tree-inline-rename by
// default) per UI-STANDARD sec 11 — no new colors or sizes.

interface TreeRenameLabelProps {
  name: string
  /** True when THIS row is the tree's current rename target. */
  editing: boolean
  /** Label class at rest (row-type specific, e.g. tree-item-label). */
  className: string
  /** Input class while editing; defaults to the shared .tree-inline-rename. */
  inputClassName?: string
  /** Label tooltip (shared ThemedTooltip); defaults to "<name> (double-click to rename)". */
  tooltip?: string
  /** data-testid for the at-rest label. */
  testId?: string
  onStart: () => void
  onCommit: (name: string) => void
  onCancel: () => void
}

export function TreeRenameLabel({
  name, editing, className, inputClassName, tooltip, testId, onStart, onCommit, onCancel,
}: TreeRenameLabelProps) {
  useText('app-shell-settings-menus')
  if (!editing) {
    return (
      <span
        className={className}
        data-testid={testId}
        onDoubleClick={(e) => { e.stopPropagation(); onStart() }}
        data-tooltip={tooltip ?? shellText('TreeRenameLabel.doubleClickToRename', { name: name })}
      >{name}</span>
    )
  }
  return (
    <TreeRenameInput
      key={name}
      initial={name}
      inputClassName={inputClassName}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  )
}

// Separate component so the draft state mounts fresh per edit (hooks stay
// unconditional in TreeRenameLabel).
function TreeRenameInput({ initial, inputClassName, onCommit, onCancel }: {
  initial: string
  inputClassName?: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  useText('app-shell-settings-menus')
  const [value, setValue] = useState(initial)
  const commit = () => {
    const n = value.trim()
    if (n) onCommit(n)
    else onCancel()   // empty / whitespace-only -> cancel, no rename
  }
  return (
    <input
      className={inputClassName ?? 'tree-inline-rename'}
      data-testid="tree-rename-input"
      value={value}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}
