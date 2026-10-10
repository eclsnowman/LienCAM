// WO UI-12 (BK-70/72/73): native right-click/keyboard context menu for a
// feature-tree row, plus the delete confirmation dialog it (and the Delete
// key) opens. Split out of FeatureTree.tsx as its own module per the WO's
// "new context-menu module" instruction -- FeatureTree only owns WHEN this
// opens (row onContextMenu / keyboard) and WHAT data it's handed; the menu
// itself never reaches into `dag`/`folders` directly, same "caller passes
// plain data + callbacks, component never touches the store" discipline
// every other FeatureTree*Controls interface in this file already follows.

import { useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Ban, ChevronRight, Download, Eye, EyeOff, ExternalLink, Folder, FolderPlus, FolderX, Pencil, Trash2 } from 'lucide-react'
import type { FeatureTreeEditEntry } from './FeatureTree'

export interface TreeContextMenuFolderOption {
  id: string
  name: string
}

export interface TreeContextMenuProps {
  x: number
  y: number
  /** Omitted entirely when the `suppress` control isn't wired on the tree -- mirrors the row's own suppress-button gating. */
  suppressed?: boolean
  /** Omitted unless this is a sketch row and the persisted hide control is wired. */
  hidden?: boolean
  /** Omitted entirely when the `folders` control isn't wired on the tree. */
  folderMenu?: {
    currentFolderId: string | null
    options: TreeContextMenuFolderOption[]
    onMoveToFolder(folderId: string): void
    onCreateFolder(name: string): void
    onRemoveFromFolder(): void
  }
  /** Omitted entirely when the `del` control isn't wired on the tree. */
  onDeleteRequest?(): void
  onToggleHidden?(): void
  onToggleSuppress?(): void
  /** WO UI-18 (D3): omitted entirely when the `edit` control isn't wired on the
   *  tree OR the caller's per-node lookup returns `undefined` for this row
   *  (genesis rows). Otherwise ALWAYS renders: `{ onEdit }` clickable, routed
   *  to the SAME handler the canonical Edit... entry point uses; `{ reason }`
   *  disabled with that reason as its title -- no silent no-op path. */
  editEntry?: FeatureTreeEditEntry
  /** NAV-BODY-ROW: omitted entirely for every row kind with no cross-workspace
   *  destination of its own (only a live `body` row has one -- the recon's own
   *  verdict, NAV-FEATURE-TREE-RECON.report.md). When present, renders "Show
   *  in CAM" -- the reverse leg of UI-EDIT-MODEL-FROM-BODY's own "Edit model"
   *  item, routed through the SAME select+switch-workspace mechanism
   *  DesignTree's row click already uses (setSelectedGeometry + setWorkspace),
   *  never a new one. */
  onShowInCam?(): void
  /** WO-2448: omitted unless the row is a body. Opens the Export window on that body's model. */
  onExport?(): void
  onClose(): void
}

/**
 * The v1 item set (mission #1) is EXACTLY: "Move to folder" (submenu),
 * "Delete...", "Suppress/Unsuppress" -- each present only if its backing
 * control was passed, same optional-per-affordance contract the row buttons
 * already use. Click-to-expand submenu (not hover) so this is trivially
 * testable via fireEvent.click, no pointer-hover simulation needed.
 */
export function TreeContextMenu({ x, y, suppressed, hidden, folderMenu, onDeleteRequest, onToggleHidden, onToggleSuppress, editEntry, onShowInCam, onExport, onClose }: TreeContextMenuProps) {
  const [folderSubmenuOpen, setFolderSubmenuOpen] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const itemStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '5px 10px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontSize: 12,
    textAlign: 'left',
  }

  return (
    <>
      <div
        data-testid="tree-context-menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
        style={{ position: 'fixed', inset: 0, zIndex: 100 }}
      />
      <div
        data-testid="tree-context-menu"
        role="menu"
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
        style={{
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 101,
          minWidth: 180,
          background: 'var(--surface-2, #10151b)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          padding: 4,
          fontFamily: 'var(--font-ui)',
        }}
      >
        {folderMenu !== undefined && (
          <div>
            <button
              type="button"
              role="menuitem"
              data-testid="tree-context-menu-move-to-folder"
              onClick={() => setFolderSubmenuOpen((v) => !v)}
              style={itemStyle}
            >
              <Folder size={13} />
              <span style={{ flex: 1 }}>Move to folder</span>
              <ChevronRight size={12} />
            </button>
            {folderSubmenuOpen && (
              <div data-testid="tree-context-menu-folder-submenu" style={{ paddingLeft: 14, borderLeft: '1px solid var(--border-subtle)', marginLeft: 10 }}>
                {folderMenu.options.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="menuitem"
                    data-testid={`tree-context-menu-folder-${f.id}`}
                    onClick={() => {
                      folderMenu.onMoveToFolder(f.id)
                      onClose()
                    }}
                    style={itemStyle}
                  >
                    <Folder size={12} />
                    <span>{f.name}</span>
                  </button>
                ))}
                {creatingFolder ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px' }}>
                    <input
                      type="text"
                      data-testid="tree-context-menu-new-folder-input"
                      value={newFolderName}
                      autoFocus
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const trimmed = newFolderName.trim()
                          if (trimmed.length > 0) folderMenu.onCreateFolder(trimmed)
                          onClose()
                        } else if (e.key === 'Escape') {
                          e.stopPropagation()
                          setCreatingFolder(false)
                          setNewFolderName('')
                        }
                      }}
                      style={{ flex: 1, background: 'var(--surface-1)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="tree-context-menu-new-folder"
                    onClick={() => setCreatingFolder(true)}
                    style={itemStyle}
                  >
                    <FolderPlus size={12} />
                    <span>New folder...</span>
                  </button>
                )}
                {folderMenu.currentFolderId !== null && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="tree-context-menu-remove-from-folder"
                    onClick={() => {
                      folderMenu.onRemoveFromFolder()
                      onClose()
                    }}
                    style={itemStyle}
                  >
                    <FolderX size={12} />
                    <span>Remove from folder</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {onShowInCam !== undefined && (
          <button
            type="button"
            role="menuitem"
            data-testid="tree-context-menu-show-in-cam"
            onClick={() => {
              onShowInCam()
              onClose()
            }}
            style={itemStyle}
          >
            <ExternalLink size={13} />
            <span>Show in CAM</span>
          </button>
        )}
        {onExport !== undefined && (
          <button
            type="button"
            role="menuitem"
            data-testid="tree-context-menu-export"
            onClick={() => {
              onExport()
              onClose()
            }}
            style={itemStyle}
          >
            <Download size={13} />
            <span>Export...</span>
          </button>
        )}
        {editEntry?.referenceImage?.onCalibrate && <button type="button" role="menuitem" data-testid="tree-context-menu-calibrate" style={itemStyle}
          onClick={() => { editEntry.referenceImage?.onCalibrate?.(); onClose() }}>Calibrate</button>}
        {editEntry?.referenceImage && <button type="button" role="menuitemcheckbox" aria-checked={editEntry.referenceImage.scaleLocked}
          data-testid="tree-context-menu-lock-scale" style={itemStyle}
          onClick={() => { editEntry.referenceImage?.onToggleLock(); onClose() }}>{editEntry.referenceImage.scaleLocked ? 'Unlock scale' : 'Lock scale'}</button>}
        {editEntry !== undefined && (
          <button
            type="button"
            role="menuitem"
            data-testid="tree-context-menu-edit"
            disabled={!('onEdit' in editEntry)}
            data-tooltip={'reason' in editEntry ? editEntry.reason : undefined}
            onClick={() => {
              if ('onEdit' in editEntry) {
                editEntry.onEdit()
                onClose()
              }
            }}
            style={{ ...itemStyle, ...('reason' in editEntry ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
          >
            <Pencil size={13} />
            <span>Edit...</span>
          </button>
        )}
        {onDeleteRequest !== undefined && (
          <button
            type="button"
            role="menuitem"
            data-testid="tree-context-menu-delete"
            onClick={() => {
              onDeleteRequest()
              onClose()
            }}
            style={itemStyle}
          >
            <Trash2 size={13} />
            <span>Delete...</span>
          </button>
        )}
        {onToggleHidden !== undefined && (
          <button
            type="button"
            role="menuitem"
            data-testid="tree-context-menu-hide"
            onClick={() => {
              onToggleHidden()
              onClose()
            }}
            style={itemStyle}
          >
            {hidden === true ? <Eye size={13} /> : <EyeOff size={13} />}
            <span>{hidden === true ? 'Show' : 'Hide'}</span>
          </button>
        )}
        {onToggleSuppress !== undefined && (
          <button
            type="button"
            role="menuitem"
            data-testid="tree-context-menu-suppress"
            onClick={() => {
              onToggleSuppress()
              onClose()
            }}
            style={itemStyle}
          >
            <Ban size={13} />
            <span>{suppressed === true ? 'Unsuppress' : 'Suppress'}</span>
          </button>
        )}
      </div>
    </>
  )
}

export interface DeleteConfirmDialogProps {
  targetName: string
  /** Display names of every transitive consumer that would also be removed -- EXCLUDING the target itself. */
  consumerNames: string[]
  onCancel(): void
  onConfirm(): void
}

/**
 * WO UI-12 (BK-73), acceptance #3: zero consumers -> plain confirm naming the
 * target; N consumers -> names EVERY one (never just direct consumers -- the
 * caller is expected to have already walked the full transitive closure via
 * FeatureDag.transitiveConsumersOf, this dialog just renders whatever list it
 * is handed) with a single "delete with dependents" action. Either branch is
 * one Cancel/Confirm pair -- the caller decides (via the consumerNames it
 * passes in) which copy renders, this component holds no dag knowledge.
 */
export function DeleteConfirmDialog({ targetName, consumerNames, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  const hasConsumers = consumerNames.length > 0
  return (
    <>
      <div data-testid="tree-delete-confirm-backdrop" style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'var(--overlay-scrim-1)' }} />
      <div
        data-testid="tree-delete-confirm"
        role="alertdialog"
        aria-modal="true"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 201,
          minWidth: 320,
          maxWidth: 420,
          background: 'var(--surface-2, #10151b)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          padding: 16,
          fontFamily: 'var(--font-ui)',
          color: 'var(--text-primary)',
        }}
      >
        <div data-testid="tree-delete-confirm-title" style={{ fontWeight: 600, marginBottom: 8 }}>
          {hasConsumers ? `Delete '${targetName}' and ${consumerNames.length} dependent feature(s)?` : `Delete '${targetName}'?`}
        </div>
        {hasConsumers && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 4 }}>
              These features consume it and will be removed too:
            </div>
            <ul data-testid="tree-delete-confirm-consumers" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
              {consumerNames.map((name, i) => (
                <li key={i} data-testid={`tree-delete-confirm-consumer-${i}`}>
                  {name}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" data-testid="tree-delete-confirm-cancel" className="modal-btn modal-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" data-testid="tree-delete-confirm-confirm" className="modal-btn modal-btn-primary" onClick={onConfirm}>
            {hasConsumers ? 'Delete with dependents' : 'Delete'}
          </button>
        </div>
      </div>
    </>
  )
}
