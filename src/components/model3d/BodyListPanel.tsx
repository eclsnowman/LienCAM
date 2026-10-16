// 3D Lab: presentational body-list panel (WO UI-2). Pure props-in,
// callbacks-out -- Lab3DView owns all state (body array, THREE.Object3D
// visibility, session.disposeBody wiring); this component only renders it.
//
// WO UI-17 (criterion 1): grew a `variant` -- 'panel' (default) keeps the
// Lab3DView standalone right-sidebar look byte-identical; 'embedded' drops the
// fixed width/border/background so the list sits inside the workbench's CAM
// .panel-left/.tree-section frame (which provides that chrome), with CAM
// tree-row styling (eye toggle, token colors) instead of the lab's raw
// checkbox rows.

import { useText } from '../../i18n'
import { useState } from 'react'
import { ExternalLink, Trash2 } from 'lucide-react'
import type { RGB } from './appearance'
import { TreeContextMenu } from './tree/TreeContextMenu'
import { MODEL_ROW_ID, modelBodyExportable, openExportWindow } from '../../lib/exportCenter'

// WO UI-25 (A3 entry-point fix): same hex<->RGB idiom as AppearancePanel.tsx's
// module-local toHex/fromHex (and DesignTree.tsx's part-color picker) --
// duplicated rather than imported since it's a 3-line pure pair, not a shared
// contract.
function toHex(color: RGB | undefined): string {
  if (color === undefined) return '#cccccc'
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${c(color[0])}${c(color[1])}${c(color[2])}`
}

function fromHex(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

export interface BodyListEntry {
  bodyId: string
  /** Stable, original body identity. bodyId remains the current live leaf. */
  lineageId?: string
  name: string
  visible: boolean
  /** Exact volume from the kernel measure API (WO INT-1 acceptance #3: "body
   *  panel shows exact volume"). Undefined until the async measure() call
   *  resolves -- never a tessellation-derived estimate. */
  volume?: number
  /** WO UI-25 (A3): current appearanceStore body color, read fresh by the
   *  caller on every render. Undefined = no color assigned yet. */
  color?: RGB
  /** NAV-BODY-ROW: true iff this LIVE body already has a CAM Geometry-list
   *  row (findModelBodyGeometryRow, src/lib/cam/modelBodyAdapter.ts). Gates
   *  both the inline "Show in CAM" icon and the context-menu item -- an
   *  unsynced/never-regenerated body OMITS the affordance rather than
   *  dead-ending on a stale/missing row (the WO's own rule). Undefined
   *  (Lab3DView's standalone 'panel' variant, which has no CAM concept at
   *  all) behaves exactly like `false`. */
  hasCamRow?: boolean
}

export interface BodyListPanelProps {
  bodies: BodyListEntry[]
  onToggleVisibility(bodyId: string): void
  onDispose(bodyId: string): void
  selectedBodyId?: string | null
  onSelect?(bodyId: string): void
  /** WO UI-25 (A3 entry-point fix): per-body color affordance next to the
   *  visibility checkbox, mirroring the CAM DesignTree swatch
   *  (DesignTree.tsx:1346, :943-964) wired to appearanceStoreRef.setBodyColor.
   *  Optional and additive -- omitting it (Lab3DView's 'panel' variant, out
   *  of this WO's scope) renders exactly as before, byte-for-byte. */
  onSetColor?(bodyId: string, color: RGB): void
  /** NAV-BODY-ROW: jump this body to its CAM Geometry-list row (select +
   *  switch workspace). Omitted entirely -- like `onSetColor` above -- for
   *  Lab3DView's standalone 'panel' variant, which has no CAM workspace to
   *  jump to. Wired for 'embedded' rows whose `hasCamRow` is true; gates BOTH
   *  the inline icon and the right-click "Show in CAM" item off the SAME prop
   *  so the two paths can never disagree about which rows are navigable. */
  onShowInCam?(bodyId: string): void
  /** 'panel' = standalone right sidebar (Lab3DView, unchanged); 'embedded' =
   *  chrome-free rows for a host panel that provides its own frame. */
  variant?: 'panel' | 'embedded'
}

export function BodyListPanel({ bodies, onToggleVisibility, onDispose, selectedBodyId, onSelect, onSetColor, onShowInCam, variant = 'panel' }: BodyListPanelProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  // NAV-BODY-ROW: local, render-only context-menu position state -- mirrors
  // FeatureTree.tsx's own `contextMenu` local state exactly (this component's
  // "presentational, props-in callbacks-out" contract covers the NAVIGATION
  // decision (`onShowInCam`), not the menu's own open/closed bookkeeping).
  const [contextMenuBodyId, setContextMenuBodyId] = useState<string | null>(null)
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null)

  if (variant === 'embedded') {
    return (
      <div data-testid="lab3d-body-list">
        {bodies.length === 0 ? (
          <div className="tree-empty">{workbenchText('BodyListPanel.noneYet')}</div>
        ) : (
          bodies.map((body) => (
            <div
              key={body.lineageId ?? body.bodyId}
              data-testid={`body-row-${body.bodyId}`}
              data-lineage-id={body.lineageId ?? body.bodyId}
              className="wb-tree-row"
              role="treeitem"
              aria-selected={body.bodyId === selectedBodyId}
              tabIndex={onSelect === undefined ? undefined : 0}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('button,input,label') !== null) return
                onSelect?.(body.bodyId)
              }}
              onContextMenu={(event) => {
                // NAV-BODY-ROW path 1: same idiom as FeatureTree.tsx's own
                // row onContextMenu -- select the row, then open the menu at
                // the real cursor position. Omitted (browser default menu
                // still suppressed via preventDefault, matching every other
                // row's right-click behavior) when this body has no CAM row
                // yet, so the menu never offers a dead-end item.
                // WO-2448: a live Model body also offers Export... on the same menu.
                const showInCam = onShowInCam !== undefined && body.hasCamRow === true
                if (!showInCam && !modelBodyExportable(undefined, body.bodyId)) return
                event.preventDefault()
                event.stopPropagation()
                onSelect?.(body.bodyId)
                setContextMenuBodyId(body.bodyId)
                setContextMenuPos({ x: event.clientX, y: event.clientY })
              }}
              onKeyDown={(event) => {
                if (onSelect === undefined || (event.key !== 'Enter' && event.key !== ' ')) return
                event.preventDefault()
                onSelect(body.bodyId)
              }}
              onMouseEnter={(event) => {
                if (body.bodyId !== selectedBodyId) event.currentTarget.style.background = 'var(--surface-hover)'
              }}
              onMouseLeave={(event) => {
                if (body.bodyId !== selectedBodyId) event.currentTarget.style.background = 'transparent'
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minHeight: 'var(--row-default)',
                padding: '2px 8px 2px 14px',
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
                fontSize: 'var(--font-size-md)',
                cursor: onSelect === undefined ? 'default' : 'pointer',
                background: body.bodyId === selectedBodyId ? 'var(--select-ui-bg)' : 'transparent',
              }}
            >
              {/* The visibility control stays a REAL checkbox (not an icon button):
                  ~20 pre-existing workbench tests read `.checked` off this exact
                  testid, and rewriting them to a new control shape would weaken
                  prior rounds' coverage (charter pre-flight rule). Styled to sit
                  quietly in the token'd row. */}
              <input
                type="checkbox"
                data-testid={`body-visible-${body.bodyId}`}
                checked={body.visible}
                onChange={() => onToggleVisibility(body.bodyId)}
                onClick={(event) => event.stopPropagation()}
                aria-label={workbenchText('BodyListPanel.toggleVisibilityOf', { name: String(body.name) })}
                style={{ accentColor: 'var(--accent)', margin: 0 }}
              />
              {/* WO UI-25 (A3 entry-point fix): a per-body color swatch mirroring
                  DesignTree.tsx's part-color picker (native hidden <input type="color">
                  under a colored label) -- the CAM design template this WO cites.
                  WO UI-25-R1 (Finding 2): the 14x14 VISUAL chip stays row-density-
                  appropriate, but the label's own box is padded out to the full
                  24x24 --hit-target-min -- background-clip: content-box keeps the
                  paint confined to the inner 14x14 so the enlarged box reads as a
                  hit-target ring, not a bigger chip. className="wb-row-action" is
                  the design review's own suggested one-liner: it reuses the row's
                  existing 0.55->1 hover ramp (autohide doctrine, app.css:6694-6700)
                  rather than inventing a state-indicator exemption, since this
                  swatch is exactly the same kind of state-carrying row control as
                  the genesis-row eye toggle (FeatureTree.tsx:1146) that already
                  gets the same treatment. */}
              {onSetColor !== undefined && (
                <label
                  data-testid={`body-color-${body.bodyId}`}
                  data-tooltip={workbenchText('BodyListPanel.changeColorOf', { name: String(body.name) })}
                  className="wb-row-action wb-color-swatch"
                  onClick={(event) => event.stopPropagation()}
                  style={{
                    position: 'relative',
                    display: 'inline-flex',
                    // App-wide `*{box-sizing:border-box}` (app.css:43) makes width/height
                    // the OUTER box -- 24 total minus 2*padding(4) minus 2*border(1)
                    // leaves exactly the 14x14 visual chip painted below via
                    // background-clip: content-box. The 24x24 outer box is the
                    // --hit-target-min effective click/focus target.
                    boxSizing: 'border-box',
                    width: 24,
                    height: 24,
                    padding: 4,
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-subtle)',
                    backgroundClip: 'content-box',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    flexShrink: 0,
                    // backgroundColor (NOT the background shorthand): the shorthand
                    // resets background-clip to border-box, defeating the 14x14 chip
                    // (UI-25-R1 audit major).
                    backgroundColor: toHex(body.color),
                  }}
                >
                  <input
                    type="color"
                    data-testid={`body-color-input-${body.bodyId}`}
                    value={toHex(body.color)}
                    onChange={(e) => onSetColor(body.bodyId, fromHex(e.target.value))}
                    aria-label={workbenchText('BodyListPanel.changeColorOf', { name: String(body.name) })}
                    style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', border: 'none', padding: 0, margin: 0, cursor: 'pointer' }}
                  />
                </label>
              )}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {body.name}
                {body.volume !== undefined && (
                  <span
                    data-testid={`body-volume-${body.bodyId}`}
                    style={{ display: 'block', color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)' }}
                  >
                    {workbenchText('BodyListPanel.mm3', { value1: String((body.volume.toFixed(2)) ?? '') })}</span>
                )}
              </span>
              {/* NAV-BODY-ROW path 2: inline icon, same idiom as the color
                  swatch/dispose buttons either side of it -- OMITTED (not
                  disabled) when this body has no CAM row yet, per the WO's
                  own "omitted, not disabled" rule for an unsynced body. */}
              {onShowInCam !== undefined && body.hasCamRow === true && (
                <button
                  type="button"
                  className="wb-row-action"
                  data-testid={`body-show-in-cam-${body.bodyId}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onShowInCam(body.bodyId)
                  }}
                  data-tooltip={workbenchText('BodyListPanel.showInCAM', { name: String(body.name) })}
                  aria-label={workbenchText('BodyListPanel.showInCAM', { name: String(body.name) })}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: 2 }}
                >
                  <ExternalLink size={13} />
                </button>
              )}
              <button
                type="button"
                className="wb-row-action"
                data-testid={`body-dispose-${body.bodyId}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onDispose(body.bodyId)
                }}
                data-tooltip={workbenchText('BodyListPanel.dispose', { name: String(body.name) })}
                aria-label={workbenchText('BodyListPanel.dispose', { name: String(body.name) })}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: 2 }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
        {/* NAV-BODY-ROW path 1: reuses FeatureTree's own TreeContextMenu
            component with ONLY `onShowInCam` wired -- every other item
            (suppress/hide/delete/folder/edit) stays omitted, so this renders
            as the one-item "Show in CAM" menu the WO scopes body rows to.
            WO-2448 adds Export... for a live Model body. */}
        {contextMenuBodyId !== null && contextMenuPos !== null && (
          <TreeContextMenu
            x={contextMenuPos.x}
            y={contextMenuPos.y}
            onShowInCam={onShowInCam !== undefined && bodies.find((b) => b.bodyId === contextMenuBodyId)?.hasCamRow === true
              ? () => onShowInCam(contextMenuBodyId) : undefined}
            onExport={modelBodyExportable(undefined, contextMenuBodyId) ? () => openExportWindow(MODEL_ROW_ID) : undefined}
            onClose={() => {
              setContextMenuBodyId(null)
              setContextMenuPos(null)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div
      data-testid="lab3d-body-list"
      style={{
        width: 220,
        flexShrink: 0,
        borderLeft: '1px solid #2a3540',
        padding: 10,
        overflowY: 'auto',
        background: '#161b20',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{workbenchText('BodyListPanel.bodies')}</div>
      {bodies.length === 0 ? (
        <div style={{ opacity: 0.6 }}>{workbenchText('BodyListPanel.noneYet')}</div>
      ) : (
        bodies.map((body) => (
          <div
            key={body.bodyId}
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}
          >
            <input
              type="checkbox"
              data-testid={`body-visible-${body.bodyId}`}
              checked={body.visible}
              onChange={() => onToggleVisibility(body.bodyId)}
              aria-label={workbenchText('BodyListPanel.toggleVisibilityOf', { name: String(body.name) })}
            />
            <span style={{ flex: 1 }}>
              {body.name}
              {body.volume !== undefined && (
                <span data-testid={`body-volume-${body.bodyId}`} style={{ display: 'block', opacity: 0.65, fontSize: 11 }}>
                  {workbenchText('BodyListPanel.mm3', { value1: String((body.volume.toFixed(2)) ?? '') })}</span>
              )}
            </span>
            <button
              type="button"
              data-testid={`body-dispose-${body.bodyId}`}
              onClick={() => onDispose(body.bodyId)}
              data-tooltip={workbenchText('BodyListPanel.dispose', { name: String(body.name) })}
            >
              {workbenchText('BodyListPanel.dispose2')}</button>
          </div>
        ))
      )}
    </div>
  )
}
