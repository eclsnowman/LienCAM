// WO GEO-UNIFY-S1b (Operator finding, private header-finding capture):
// "looks out of place. does not match
// visuals or even align. Also how do I rename a model here? Can I create a
// new one here." Replaces the OLD floating "Editing: <name> [Finish]" banner
// (formerly App.tsx's position:absolute .model-item-editing-banner, sitting
// top-left over the MODEL panel with no relation to anything on screen) with
// a REAL row inside the workbench's own docked left panel
// (SolidsWorkbenchPage.tsx's .panel-left), reusing the EXACT .panel-header/
// .panel-title/.panel-name frame + tokens the CAM Design Tree's own
// project-name row uses one level up the tree (WO UI-17's "match the CAM
// left panel" precedent, DesignTree.tsx's own panel-header). No new colors.
//
// Pure props-in/callbacks-out -- same discipline BodyListPanel.tsx documents
// for this panel's other embedded pieces. SolidsWorkbenchPage owns every
// store read/action; this component only renders them. Closes three parts of
// Operator's "dead-end workspace" finding:
//
//   1. Inline click-to-rename: TreeRenameLabel, the ONE rename mechanism
//      (see that component's own header comment) -- double-click the name,
//      Enter/blur commits, Escape cancels -- routed through the SAME
//      renameModelItem() action DesignTree's own unified-tree model rows
//      commit through (GEO-UNIFY Stage 1). One canonical action, two entry
//      points.
//   2. A model SWITCHER dropdown listing every project.modelItems entry
//      (current one checked). Picking a different one calls openModelItem(id)
//      -- see SolidsWorkbenchPage's own outer wrapper export (this file's
//      sibling, keyed on `${modelItemId}:${documentGeneration}`) for why that
//      is safe: the key change fully remounts to the picked item's own
//      document, and documentHolder.ts's registerLiveDocument unmount
//      cleanup stashes the OUTGOING item's edits first. Switching is "finish
//      this one, open that one", never a silent discard.
//   3. "+ New model": literally addModelItem(), the SAME action the Geometry
//      section header's own "New model" button calls (DesignTree.tsx) -- a
//      model minted from inside this workspace and one minted from the tree
//      are indistinguishable afterward.
//
// Finish (4) is unchanged in behavior and reuses its existing
// .model-item-finish-btn look; it just no longer floats.

import { useState } from 'react'
import { Box, Check, ChevronDown, Plus } from 'lucide-react'
import { TreeRenameLabel } from '../panels/TreeRenameLabel'

export interface ModelWorkspaceHeaderItem {
  id: string
  name: string
}

export interface ModelWorkspaceHeaderProps {
  /** Null when no Model Item context is active (the standalone `?lab3d=1&
   *  workbench=1` route, or a document that has never gone through
   *  enterModelWorkspace) -- renders the panel's pre-existing plain "Design
   *  Tree" title, byte-identical to before this WO. */
  activeItem: ModelWorkspaceHeaderItem | null
  /** Every Model Item in the project (project.modelItems' own order) -- the
   *  switcher's list. May include `activeItem` itself. */
  items: ModelWorkspaceHeaderItem[]
  onRename(id: string, name: string): void
  onSwitch(id: string): void
  onNewModel(): void
  onFinish(): void
}

export function ModelWorkspaceHeader({
  activeItem, items, onRename, onSwitch, onNewModel, onFinish,
}: ModelWorkspaceHeaderProps) {
  const [renaming, setRenaming] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)

  if (activeItem === null) {
    return (
      <div className="panel-header">
        <span className="panel-title">Design Tree</span>
      </div>
    )
  }

  return (
    <div className="panel-header model-workspace-header" data-testid="model-workspace-header">
      <div className="panel-title">
        <Box size={13} style={{ flexShrink: 0 }} />
        <TreeRenameLabel
          name={activeItem.name}
          editing={renaming}
          className="panel-name"
          inputClassName="panel-project-rename"
          testId="model-workspace-header-name"
          tooltip="Double-click to rename this model"
          onStart={() => setRenaming(true)}
          onCommit={(n) => { onRename(activeItem.id, n); setRenaming(false) }}
          onCancel={() => setRenaming(false)}
        />
        <button
          type="button"
          className="icon-btn icon-btn-sm model-workspace-switcher-trigger"
          data-testid="model-workspace-switcher-trigger"
          data-tooltip="Switch model"
          aria-label="Switch model"
          aria-expanded={switcherOpen}
          onClick={() => setSwitcherOpen((v) => !v)}
        >
          <ChevronDown size={12} />
        </button>
        {/* Click/right-click-outside close, same idiom TreeContextMenu.tsx's
            own backdrop uses. Two independent conditionals rather than one
            fragment-wrapped pair -- keeps each div's own JSX authoring site
            unambiguous for the overlay census's static walk (WO UI-70). */}
        {switcherOpen && (
          <div
            data-testid="model-workspace-switcher-backdrop"
            onClick={() => setSwitcherOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 100 }}
          />
        )}
        {switcherOpen && (
          <div className="model-workspace-switcher-menu" role="menu" data-testid="model-workspace-switcher-menu">
            {items.map((item) => {
              const current = item.id === activeItem.id
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className={`model-workspace-switcher-item${current ? ' current' : ''}`}
                  data-testid={`model-workspace-switcher-item-${item.id}`}
                  onClick={() => {
                    setSwitcherOpen(false)
                    if (!current) onSwitch(item.id)
                  }}
                >
                  <span className="model-workspace-switcher-check">{current && <Check size={12} />}</span>
                  <span className="model-workspace-switcher-name">{item.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className="model-workspace-header-actions">
        <button
          type="button"
          className="tree-section-add-btn"
          data-testid="model-workspace-new-model-btn"
          data-tooltip="New model"
          aria-label="New model"
          onClick={onNewModel}
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          className="model-item-finish-btn"
          data-testid="model-item-finish-btn"
          onClick={onFinish}
        >
          Finish
        </button>
      </div>
    </div>
  )
}
