import { useMemo, useState, type MouseEvent } from 'react'
import { useCamStore } from '../../../store'
import {
  buildBrowserModel,
  buildReferenceRows,
  rowsForIds,
  type BrowserRow,
} from '../../../lib/sketch/browserModel'
import { BADGE_TEXT } from '../../../lib/sketch/sketcher/sketchLayer'
import { sketcherTools } from '../../../lib/sketch/sketcher'
import type { Sketch, SketchDimensionKind } from '../../../lib/sketch/types'
import { ChevronRight, ChevronDown, Trash2, Unlink } from 'lucide-react'

// BROWSER section of the sketch toolbox (Stage 4, PLAN 3.5): every
// constraint and dimension of the active sketch, grouped by kind. Rows
// hover-highlight the bound entities in the viewport, click-select the
// constraint (same selection model as clicking its glyph badge), and
// delete via the row trash button or the Delete key (selection path).
//
// Performance (340-constraint BMG lift): rendering is CAPPED per group at
// GROUP_RENDER_CAP rows with an explicit "Show all N" expander — counts in
// the headers stay document-wide and honest. No virtualization dependency.

const GROUP_RENDER_CAP = 40

// Row glyph iconography: constraints reuse the EXACT viewport badge codes
// (BADGE_TEXT); dimensions get short codes in the same visual language.
const DIM_BADGE_TEXT: Record<SketchDimensionKind, string> = {
  distance: 'd',
  distanceX: 'dx',
  distanceY: 'dy',
  ordinate: 'ord',
  distancePL: 'd_|',
  angle: 'a',
  angle3: 'a3',
  radius: 'r',
  diameter: 'dia',
  arcLength: 'Lar',
  majorRadius: 'Ra',
  minorRadius: 'Rb',
  focusDistance: '2c',
  d1xd2: 'd1xd2',
}

function rowGlyph(row: BrowserRow): string {
  return row.isDimension
    ? DIM_BADGE_TEXT[row.kind as SketchDimensionKind]
    : BADGE_TEXT[row.kind as keyof typeof BADGE_TEXT]
}

// Viewport hover bridge — same global handle other panels use. The row
// hover takes the SAME highlight path as hovering the glyph badge in the
// viewport (constraint id -> badge tint + bound-entity tint).
interface VpHoverHandle {
  setSketchHover?: (id: string | null) => void
}
function viewportHandle(): VpHoverHandle | null {
  return ((window as unknown as Record<string, unknown>)
    .__cncViewport as VpHoverHandle) ?? null
}

// ---- Shared row -------------------------------------------------------------

// One browser row. Also the row component of the over-defined resolution
// flow (same icon/operands/hover-highlight, different action button).
export function BrowserRowView({
  row,
  selected,
  onSelect,
  actionTitle,
  onAction,
}: {
  row: BrowserRow
  selected: boolean
  /** Click-select (shift toggles, mirroring viewport click semantics). */
  onSelect: (row: BrowserRow, additive: boolean) => void
  /** Row action button (trash / remove). */
  actionTitle: string
  onAction: (row: BrowserRow) => void
}) {
  const statusClass =
    row.status === 'conflicting' || row.unresolved !== undefined ? ' sketch-browser-row-conflict'
    : row.status === 'redundant' ? ' sketch-browser-row-redundant'
    : ''
  return (
    <div
      className={
        `sketch-browser-row${statusClass}${selected ? ' sketch-browser-row-selected' : ''}`
      }
      onClick={(e: MouseEvent) => onSelect(row, e.shiftKey)}
      onMouseEnter={() => viewportHandle()?.setSketchHover?.(row.id)}
      onMouseLeave={() => viewportHandle()?.setSketchHover?.(null)}
      data-tooltip={row.unresolved ?? `${row.label}: ${row.operands}`}
      data-row-id={row.id}
      data-unresolved={row.unresolved !== undefined ? 'true' : undefined}
    >
      <code className="sketch-browser-glyph">{rowGlyph(row)}</code>
      <span className="sketch-browser-operands">
        {row.operands}
        {row.reference && <em> ref</em>}
      </span>
      {row.status !== 'ok' && (
        <span className="sketch-browser-flag">
          {row.status === 'conflicting' ? 'conflict' : 'redundant'}
        </span>
      )}
      {row.status === 'ok' && row.unresolved !== undefined && (
        <span className="sketch-browser-flag">unresolved</span>
      )}
      <button
        className="sketch-browser-trash"
        data-tooltip={actionTitle}
        aria-label={actionTitle}
        onClick={(e) => {
          e.stopPropagation()
          // A deleted row cannot stay hovered in the viewport.
          viewportHandle()?.setSketchHover?.(null)
          onAction(row)
        }}
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}

// ---- Associative offsets (WO-1859) --------------------------------------------
//
// An offset that still follows its source is a RELATION, so it belongs in the
// same place the operator already looks for relations. Each row names the
// offset (distance + piece count), selects its pieces, and its action button
// BREAKS the link rather than deleting anything: the geometry stays at the
// exact coordinates it has and simply stops following its source. The break
// itself runs through the shared engine (toolController.breakOffsetLink), the
// same one the workbench rail calls, so the two hosts cannot diverge.

function OffsetLinkSection() {
  const activeSketch = useCamStore((s) => s.activeSketch)
  const selectedIds = useCamStore((s) => s.sketchSelectedIds)
  const setSketchSelection = useCamStore((s) => s.setSketchSelection)

  const links = useMemo(() => {
    const byLink = new Map<string, { distance: number; ids: string[]; sources: number }>()
    for (const e of activeSketch?.entities ?? []) {
      if (!e.offsetLink) continue
      const found = byLink.get(e.offsetLink.id)
      if (found) found.ids.push(e.id)
      else {
        byLink.set(e.offsetLink.id, {
          distance: e.offsetLink.distance, ids: [e.id], sources: e.offsetLink.source.length,
        })
      }
    }
    return [...byLink.entries()]
  }, [activeSketch])

  if (links.length === 0) return null

  return (
    <div className="sketch-browser-group" data-testid="sketch-browser-offset-links">
      <div className="sketch-browser-group-title">Offsets ({links.length})</div>
      {links.map(([linkId, link]) => {
        const selected = link.ids.every((id) => selectedIds.includes(id))
        const label =
          `${link.distance} mm from ${link.sources} source ` +
          `entit${link.sources === 1 ? 'y' : 'ies'}`
        return (
          <div
            key={linkId}
            className={`sketch-browser-row${selected ? ' sketch-browser-row-selected' : ''}`}
            onClick={() => setSketchSelection(link.ids)}
            data-tooltip={`Offset: ${label}. Edit the source and this follows it.`}
          >
            <code className="sketch-browser-glyph">off</code>
            <span className="sketch-browser-operands">
              {label} - {link.ids.length} piece{link.ids.length === 1 ? '' : 's'}
            </span>
            <button
              className="sketch-browser-trash"
              data-tooltip="Break this link - the offset stays exactly where it is"
              aria-label="Break this offset link"
              onClick={(e) => {
                e.stopPropagation()
                setSketchSelection(link.ids)
                sketcherTools.breakOffsetLink()
              }}
            >
              <Unlink size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ---- Projected references (WO-1864) --------------------------------------------
//
// Every projected piece, named by where its geometry comes from now: following a model
// face/edge/vertex, UNRESOLVED (the source could not be found on the last model change -- the
// piece keeps its last position, the sketch still solves and bakes, and the row names the
// source), or a static copy that follows nothing (CAM-layer projection, pasted copy, broken link,
// edited piece). The action on a linked row BREAKS the link through the shared engine
// (toolController.breakProjectionLink) -- the piece stays exactly where it is.

export function ProjectionReferenceSection({
  sketch,
  selectedIds,
  onSelect,
}: {
  sketch: Sketch | null
  selectedIds: readonly string[]
  onSelect: (ids: string[]) => void
}) {
  const rows = useMemo(() => buildReferenceRows(sketch?.entities ?? []), [sketch])
  if (rows.length === 0) return null
  const unresolved = rows.filter((row) => row.status === 'unresolved').length
  return (
    <div className="sketch-browser-group" data-testid="sketch-browser-references">
      <div className="sketch-browser-group-title">
        References ({rows.length}){unresolved > 0 && ` - ${unresolved} unresolved`}
      </div>
      {rows.map((row) => (
        <div
          key={row.entityId}
          data-testid={`sketch-browser-reference-${row.entityId}`}
          data-reference-status={row.status}
          className={
            `sketch-browser-row${row.status === 'unresolved' ? ' sketch-browser-row-conflict' : ''}` +
            `${selectedIds.includes(row.entityId) ? ' sketch-browser-row-selected' : ''}`
          }
          onClick={() => onSelect([row.entityId])}
          data-tooltip={row.detail}
        >
          <code className="sketch-browser-glyph">ref</code>
          <span className="sketch-browser-operands">
            {row.entityLabel} - {row.sourceLabel ?? 'not linked'}
          </span>
          {row.status === 'unresolved' && <span className="sketch-browser-flag">unresolved</span>}
          {row.status !== 'not-linked' && (
            <button
              className="sketch-browser-trash"
              data-tooltip="Break this link - the geometry stays exactly where it is"
              aria-label="Break this model link"
              onClick={(e) => {
                e.stopPropagation()
                onSelect([row.entityId])
                sketcherTools.breakProjectionLink()
              }}
            >
              <Unlink size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// ---- Pierces (WO-1865) --------------------------------------------------------------
//
// Host-agnostic list of a sketch's Pierce constraints: each names its point and model edge, flags
// an edge with no crossing right now as unresolved (with the plain sentence as its tooltip), and
// deletes like every other constraint row. The workbench rail mounts it (the model edges a pierce
// follows only exist there); the CAM browser shows the same rows in its Pierce group.

export function PierceSection({
  sketch,
  selectedIds,
  onSelect,
  onDelete,
}: {
  sketch: Sketch | null
  selectedIds: readonly string[]
  onSelect: (ids: string[]) => void
  onDelete: (id: string) => void
}) {
  const rows = useMemo(() => {
    if (sketch === null) return []
    const ids = sketch.constraints.filter((c) => c.kind === 'pierce').map((c) => c.id)
    return ids.length === 0 ? [] : rowsForIds(sketch, ids)
  }, [sketch])
  if (rows.length === 0) return null
  const unresolved = rows.filter((row) => row.unresolved !== undefined).length
  return (
    <div className="sketch-browser-group" data-testid="sketch-browser-pierces">
      <div className="sketch-browser-group-title">
        Pierce ({rows.length}){unresolved > 0 && ` - ${unresolved} unresolved`}
      </div>
      {rows.map((row) => (
        <BrowserRowView
          key={row.id}
          row={row}
          selected={selectedIds.includes(row.id)}
          onSelect={(r) => onSelect([r.id])}
          actionTitle="Delete this pierce - the point is released where it stands"
          onAction={(r) => onDelete(r.id)}
        />
      ))}
    </div>
  )
}

function CamProjectionReferenceSection() {
  const activeSketch = useCamStore((s) => s.activeSketch)
  const selectedIds = useCamStore((s) => s.sketchSelectedIds)
  const setSketchSelection = useCamStore((s) => s.setSketchSelection)
  return (
    <ProjectionReferenceSection
      sketch={activeSketch}
      selectedIds={selectedIds}
      onSelect={setSketchSelection}
    />
  )
}

// ---- Browser section ---------------------------------------------------------

export function ConstraintBrowser() {
  const [collapsed, setCollapsed] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const activeSketch = useCamStore((s) => s.activeSketch)
  const liveStatus = useCamStore((s) => s.sketchSolveStatus)
  const selectedIds = useCamStore((s) => s.sketchSelectedIds)
  const setSketchSelection = useCamStore((s) => s.setSketchSelection)
  const deleteSketchItems = useCamStore((s) => s.deleteSketchItems)

  // Same status precedence as the solve banner: live solve status if one
  // has landed this session, else the status persisted on the document.
  const model = useMemo(
    () =>
      activeSketch
        ? buildBrowserModel(activeSketch, liveStatus ?? activeSketch.solveStatus)
        : null,
    [activeSketch, liveStatus],
  )

  if (!model) return null

  const total = model.constraintCount + model.dimensionCount

  const onSelect = (row: BrowserRow, additive: boolean) => {
    if (additive) {
      setSketchSelection(
        selectedIds.includes(row.id)
          ? selectedIds.filter((id) => id !== row.id)
          : [...selectedIds, row.id],
      )
    } else {
      setSketchSelection([row.id])
    }
  }

  const toggleGroupExpand = (kind: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  return (
    <div className="tree-section">
      <div
        className="tree-section-header tree-section-header-btn"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span>
          Browser
          <span className="sketch-browser-count">
            {` ${model.constraintCount} / ${model.dimensionCount} dim`}
            {model.conflictingCount > 0 &&
              ` - ${model.conflictingCount} conflicting`}
            {model.redundantCount > 0 &&
              ` - ${model.redundantCount} redundant`}
          </span>
        </span>
        <span className="tree-section-header-chevron">
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </span>
      </div>

      {!collapsed && (
        <div className="sketch-browser">
          {total === 0 && (
            <div className="sketch-browser-empty">No constraints yet</div>
          )}
          {/* WO-1859: offsets that still follow their source. */}
          <OffsetLinkSection />
          {/* WO-1864: projected pieces and the model source each follows. */}
          <CamProjectionReferenceSection />

          {model.groups.map((group) => {
            const expanded = expandedGroups.has(group.kind)
            const rows = expanded
              ? group.rows
              : group.rows.slice(0, GROUP_RENDER_CAP)
            const hidden = group.rows.length - rows.length
            return (
              <div key={group.kind} className="sketch-browser-group">
                <div className="sketch-browser-group-title">
                  {group.title} ({group.rows.length})
                </div>
                {rows.map((row) => (
                  <BrowserRowView
                    key={row.id}
                    row={row}
                    selected={selectedIds.includes(row.id)}
                    onSelect={onSelect}
                    actionTitle={`Delete this ${row.isDimension ? 'dimension' : 'constraint'}`}
                    onAction={(r) => deleteSketchItems([r.id])}
                  />
                ))}
                {hidden > 0 && (
                  <button
                    className="sketch-browser-more"
                    onClick={() => toggleGroupExpand(group.kind)}
                  >
                    Show all {group.rows.length}
                  </button>
                )}
                {expanded && group.rows.length > GROUP_RENDER_CAP && (
                  <button
                    className="sketch-browser-more"
                    onClick={() => toggleGroupExpand(group.kind)}
                  >
                    Show fewer
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
