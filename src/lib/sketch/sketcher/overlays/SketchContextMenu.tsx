import { useText } from '../../../../i18n'
import { useEffect, useRef, useState } from 'react'
import { patternForSelection } from '../../patterns'
import { SketchPatternEditor } from './SketchPatternEditor'
import { useSketcherTool } from '../useSketcherTool'
import { sketcherTools } from '../toolController'
import {
  buildSketchContextMenu,
  type ContextMenuAction,
} from '../../contextMenu'
import type { SketcherOverlaysPort } from './port'

interface Props {
  port: SketcherOverlaysPort
  /** Menu anchor in CLIENT coordinates (the right-click position). Owned by the package's own
   *  ./menuStore.ts and passed down by <SketcherOverlays/>, so this stays a pure render. */
  at: { x: number; y: number }
  onClose: () => void
}

/**
 * Sketch-mode right-click context menu (interaction framework). Renders
 * the pure buildSketchContextMenu model verbatim — tool-aware items
 * while a tool is armed, valid constraint shortcuts + launchers for a
 * selection, tool launchers on empty space — and dispatches each item
 * through the SAME actions the toolbox and keyboard take. Closes
 * on item click, outside click, or Esc (Esc is swallowed so it cannot
 * also cancel the armed tool).
 *
 * WO SKC-14C: tool items dispatch to the package; the two DOCUMENT items
 * (apply-constraint, delete-selection) go out through the host port, which is
 * right — both are document edits that own their own undo step, and a panel
 * button shares them.
 */
export function SketchContextMenu({ port, at, onClose }: Props) {
  const workbenchText = useText('sketch-and-model-workbench')
  const tool = useSketcherTool((s) => s.tool)
  const chain = useSketcherTool((s) => s.chain)
  const sketch = port.useSketch()
  const selectedIds = port.useSelectedIds()
  const constructionMode = useSketcherTool((s) => s.constructionMode)
  const menuRef = useRef<HTMLDivElement>(null)
  const [editingPattern, setEditingPattern] = useState(false)

  // Esc closes the MENU only: capture-phase window listener runs before
  // the viewport's bubble-phase sketch key handler, and stopPropagation
  // keeps the Esc from also cancelling the armed tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Keep the menu inside the window (flip up/left when it would clip).
  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth) el.style.left = `${at.x - r.width}px`
    if (r.bottom > window.innerHeight) el.style.top = `${at.y - r.height}px`
  }, [at])

  // SKC-BLOCKS Stage 4: `?.() ?? null` because useBlockEditId is OPTIONAL on
  // SketcherOverlaysPort (a host that does not offer block edit-in-place --
  // e.g. the workbench mount today -- simply never has this field; the call
  // is unconditional per render for any GIVEN port, so hook order is stable).
  const blockEditId = port.useBlockEditId?.() ?? null

  const items = buildSketchContextMenu({
    state: { tool, chain },
    sketch,
    selectedIds,
    constructionMode,
    blockEditActive: blockEditId != null,
  })

  const dispatch = (action: ContextMenuAction) => {
    switch (action.kind) {
      case 'edit-pattern':
        setEditingPattern(true)
        return
      case 'break-pattern':
        sketcherTools.breakSelectedPattern()
        break
      case 'confirm-step':
        sketcherTools.end()
        break
      case 'cancel-tool':
        sketcherTools.armTool('select')
        break
      case 'toggle-construction':
        sketcherTools.toggleConstruction()
        break
      case 'apply-constraint':
        port.applyConstraint(action.constraint)
        break
      case 'copy-selection':
        sketcherTools.copySelection()
        break
      case 'paste-selection':
        sketcherTools.pasteSelection()
        break
      case 'delete-selection':
        port.deleteSelection()
        break
      case 'group-block':
        port.groupSelectionIntoBlock()
        break
      case 'explode-block':
        port.explodeSelectedBlock()
        break
      case 'insert-instance':
        port.insertInstance()
        break
      case 'edit-block': {
        const blockId = selectedIds.find((id) => sketch?.entities.find((e) => e.id === id)?.kind === 'block')
        if (blockId) port.beginBlockEdit?.(blockId)
        break
      }
      case 'finish-block-edit':
        port.finishBlockEdit?.()
        break
      case 'cancel-block-edit':
        port.cancelBlockEdit?.()
        break
      case 'arm-tool':
        sketcherTools.armTool(action.tool)
        break
    }
    onClose()
  }

  const pattern = sketch && patternForSelection(sketch, selectedIds)
  if (editingPattern && pattern && sketch) return <SketchPatternEditor pattern={pattern} entities={sketch.entities} onClose={onClose} />

  return (
    <>
      {/*
        Click-away overlay (also swallows the click).

        WO SKC-14-R1: this backdrop no longer handles `contextmenu`. The sketcher component owns
        that gesture now, on a NATIVE listener at the viewport root -- which fires BEFORE React's
        delegated handlers, not after them. Keeping a backdrop handler here would have inverted the
        old net behaviour: a right-click while the menu is open must MOVE the menu to the new point
        (previously: backdrop closed, then the root's handler reopened at the new spot). The
        component already calls preventDefault across the whole sketch surface, so the browser menu
        stays suppressed.
      */}
      <div className="sketch-context-overlay" onPointerDown={onClose} />
      <div
        ref={menuRef}
        className="sketch-context-menu"
        style={{ left: at.x, top: at.y }}
        role="menu"
        aria-label={workbenchText('SketchContextMenu.sketchContextMenu')}
      >
        {items.map((item) => (
          <div key={item.id}>
            {item.separatorBefore && <div className="sketch-context-sep" />}
            <button
              className="sketch-context-item"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => dispatch(item.action)}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
