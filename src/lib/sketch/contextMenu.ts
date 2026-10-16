// Sketch right-click context menu model (interaction framework).
//
// PURE decision layer: given the machine state + selection it answers
// "which items does the right-click menu offer?" in three modes:
//
//   ARMED TOOL    tool-aware items: Confirm step (when the current step
//                 is confirmable), Cancel tool, construction-mode toggle
//   SELECTION     valid constraint shortcuts for the selected operand
//                 set (the SAME validity map as the Stage 4 toolbox
//                 buttons), Delete, Toggle construction, and
//                 launch-with-pre-selection for Mirror / Patterns /
//                 Fillet (arming consumes the selection where the tool
//                 supports it)
//   EMPTY         tool launchers (CREATE + MODIFY + Project), with
//                 their single-key shortcut hints
//
// The component renders the items verbatim and dispatches each item's
// action through the store; nothing in here touches the DOM.

import type { Sketch, SketchConstraintKind } from './types'
import {
  PRESELECTION_TOOLS, type SketchToolId, type ToolState,
} from './tools/toolMachine'
import { toolStepStatus } from './tools/toolSteps'
import {
  planConstraintForSelection, constraintKindLabel,
} from './constraintActions'
import { SKETCH_TOOL_LABELS } from './promptBar'
import { SHORTCUT_KEY_BY_TOOL } from './tools/shortcuts'
import { decodeCenterSelectionRef } from './centerReferences'
import { patternForSelection } from './patterns'

export type ContextMenuAction =
  | { kind: 'edit-pattern' }
  | { kind: 'break-pattern' }
  | { kind: 'confirm-step' }                                   // sketchToolEnd
  | { kind: 'cancel-tool' }                                    // disarm to select
  | { kind: 'toggle-construction' }                            // mode / selection flip
  | { kind: 'apply-constraint'; constraint: SketchConstraintKind }
  | { kind: 'copy-selection' }
  | { kind: 'paste-selection' }
  | { kind: 'delete-selection' }
  | { kind: 'group-block' }                                    // SKC-BLOCKS: group into block
  | { kind: 'explode-block' }                                  // SKC-BLOCKS: explode block
  | { kind: 'edit-block' }                                     // SKC-BLOCKS Stage 4: enter edit-in-place
  | { kind: 'insert-instance' }                                // SKC-BLOCKS Stage 5: place another instance
  | { kind: 'finish-block-edit' }                               // SKC-BLOCKS Stage 4: exit, re-freeze
  | { kind: 'cancel-block-edit' }                               // SKC-BLOCKS Stage 4: exit, revert
  | { kind: 'arm-tool'; tool: SketchToolId }                   // setSketchTool

export interface ContextMenuItem {
  id: string
  label: string
  action: ContextMenuAction
  /** Render a separator line above this item. */
  separatorBefore?: boolean
  disabled?: boolean
}

export interface ContextMenuArgs {
  /** Machine state (store: sketchTool / sketchToolChain). */
  state: ToolState
  sketch: Sketch | null
  selectedIds: readonly string[]
  /** Draw-as-construction mode (armed-tool toggle item). */
  constructionMode: boolean
  /** SKC-BLOCKS Stage 4: a block edit-in-place session is currently open. When
   *  true, Finish/Cancel items lead the menu (whatever mode it would otherwise
   *  build) and the group/explode/edit-block items are suppressed -- there is
   *  nothing to group/explode/re-enter while already inside a session. */
  blockEditActive?: boolean
}

/** Constraint kinds offered as selection shortcuts, toolbox order. */
const CONSTRAINT_MENU_KINDS: readonly SketchConstraintKind[] = [
  'coincident', 'concentric', 'parallel', 'perpendicular', 'collinear',
  'horizontal', 'vertical', 'tangent', 'equal', 'midpoint',
  'symmetric', 'fix', 'point_on_object',
]

/** Tool launchers offered on empty right-click (curated, CREATE then
 *  MODIFY then Project — the full toolbox stays the complete list). */
const EMPTY_LAUNCHERS: readonly SketchToolId[] = [
  'line', 'rect-corner', 'circle-center', 'arc-3pt', 'polygon', 'gear', 'slot',
  'point', 'smart-dimension',
  'trim', 'split', 'extend', 'fillet', 'chamfer', 'offset', 'mirror',
  'pattern-linear', 'pattern-circular', 'pattern-path', 'move', 'rotate', 'scale',
  'project',
]

/** First MODIFY launcher in EMPTY_LAUNCHERS (separator placement). */
const FIRST_MODIFY: SketchToolId = 'trim'

/** Launchers offered on a selection right-click: EVERY tool that
 *  consumes a pre-selection when armed. Derived from PRESELECTION_TOOLS
 *  (single source of truth — a tool gaining pre-selection seeding can
 *  never be missing here); arming consumes the selection as operands
 *  via armToolWithSelection (fillet seeds every shared corner among the
 *  selected lines, offset seeds the first selected curve's chain). */
const SELECTION_LAUNCHERS: ReadonlyArray<{ tool: SketchToolId; seeds: boolean }> =
  [...PRESELECTION_TOOLS].map((tool) => ({ tool, seeds: true }))

function launcherLabel(tool: SketchToolId): string {
  const key = SHORTCUT_KEY_BY_TOOL[tool]
  return key ? `${SKETCH_TOOL_LABELS[tool]} (${key})` : SKETCH_TOOL_LABELS[tool]
}

/** Build the menu items for the current state (header cases). */
export function buildSketchContextMenu(args: ContextMenuArgs): ContextMenuItem[] {
  const items = buildBaseSketchContextMenu(args)
  if (!args.blockEditActive) return items
  // SKC-BLOCKS Stage 4: Finish/Cancel LEAD the menu regardless of which base
  // case built the rest (armed-tool / selection / empty) -- a block-edit
  // session is orthogonal to the tool machine's own state, so whatever the
  // user would otherwise see stays available underneath.
  const blockEditItems: ContextMenuItem[] = [
    { id: 'finish-block-edit', label: 'Finish editing block', action: { kind: 'finish-block-edit' } },
    { id: 'cancel-block-edit', label: 'Cancel block edit', action: { kind: 'cancel-block-edit' } },
  ]
  const rest = items.length > 0
    ? [{ ...items[0], separatorBefore: true }, ...items.slice(1)]
    : items
  return [...blockEditItems, ...rest]
}

function buildBaseSketchContextMenu(args: ContextMenuArgs): ContextMenuItem[] {
  const { state, sketch, selectedIds, constructionMode, blockEditActive } = args

  // ---- ARMED: tool-aware items ------------------------------------------------
  if (state.tool !== 'select') {
    const status = toolStepStatus(state, {
      entities: sketch?.entities ?? [],
      selectedIds,
    })
    const items: ContextMenuItem[] = [
      {
        id: 'confirm-step',
        label: 'Confirm step (Enter)',
        action: { kind: 'confirm-step' },
        disabled: !(status?.confirmable ?? false),
      },
      {
        id: 'cancel-tool',
        label: `Cancel ${SKETCH_TOOL_LABELS[state.tool]} (Esc)`,
        action: { kind: 'cancel-tool' },
      },
      {
        id: 'toggle-construction',
        label: `Construction mode: ${constructionMode ? 'on' : 'off'} (Q)`,
        action: { kind: 'toggle-construction' },
        separatorBefore: true,
      },
    ]
    return items
  }

  // ---- SELECT + selection: constraints, edits, launchers ---------------------
  const hasRawEntities =
    sketch !== null &&
    selectedIds.some((id) => sketch.entities.some((e) => e.id === id))
  const hasCenterRefs =
    sketch !== null &&
    selectedIds.some((id) => {
      const ref = decodeCenterSelectionRef(id)
      return ref !== null && sketch.entities.some((e) => e.id === ref.entityId)
    })
  if (sketch && selectedIds.length > 0 && (hasRawEntities || hasCenterRefs)) {
    const items: ContextMenuItem[] = []
    // Valid constraint shortcuts only — the same plan the toolbox
    // buttons enable on (invalid kinds are dropped, not greyed: the
    // menu stays short and every item works).
    for (const kind of CONSTRAINT_MENU_KINDS) {
      const plan = planConstraintForSelection(sketch, [...selectedIds], kind)
      if (plan.ok) {
        items.push({
          id: `constraint-${kind}`,
          label: constraintKindLabel(kind),
          action: { kind: 'apply-constraint', constraint: kind },
        })
      }
    }
    if (hasRawEntities) {
      if (patternForSelection(sketch, selectedIds)) {
        items.push({ id: 'edit-pattern', label: 'Edit pattern', action: { kind: 'edit-pattern' } },
          { id: 'break-pattern', label: 'Break pattern', action: { kind: 'break-pattern' } })
      }
      items.push({
        id: 'copy-selection',
        label: 'Copy (Ctrl+C)',
        action: { kind: 'copy-selection' },
        separatorBefore: items.length > 0,
      })
    }
    items.push({
      id: 'paste-selection',
      label: 'Paste (Ctrl+V)',
      action: { kind: 'paste-selection' },
      separatorBefore: !hasRawEntities && items.length > 0,
    })
    items.push({
      id: 'delete-selection',
      label: hasCenterRefs && !hasRawEntities ? 'Delete owner (Del)' : 'Delete (Del)',
      action: { kind: 'delete-selection' },
    })
    // Construction and modify tools consume whole entities. Do not silently
    // reinterpret a point-site selection as its parent curve.
    if (hasRawEntities) {
      items.push({
        id: 'toggle-construction',
        label: 'Toggle construction (Q)',
        action: { kind: 'toggle-construction' },
      })
      // SKC-BLOCKS: group a selection of ordinary entities into a rigid block,
      // explode a single selected block, or open it for edit-in-place. Group/
      // explode/edit-block are mutually exclusive by selection shape; nested
      // blocks are refused downstream by name. Suppressed entirely while a
      // block-edit session is already open (nothing to group/explode/re-enter).
      if (!blockEditActive) {
        const selectedEntities = selectedIds
          .map((id) => sketch.entities.find((e) => e.id === id))
          .filter((e): e is NonNullable<typeof e> => e !== undefined)
        const selectedBlocks = selectedEntities.filter((e) => e.kind === 'block')
        if (selectedEntities.length === 1 && selectedBlocks.length === 1) {
          items.push({
            id: 'explode-block',
            label: 'Explode block',
            action: { kind: 'explode-block' },
            separatorBefore: true,
          })
          items.push({
            id: 'edit-block',
            label: 'Edit block',
            action: { kind: 'edit-block' },
          })
          items.push({
            id: 'insert-instance',
            label: 'Place another instance',
            action: { kind: 'insert-instance' },
          })
        } else if (selectedEntities.length >= 1 && selectedBlocks.length === 0) {
          items.push({
            id: 'group-block',
            label: 'Group into block',
            action: { kind: 'group-block' },
            separatorBefore: true,
          })
        }
      }
      SELECTION_LAUNCHERS.forEach(({ tool, seeds }, i) => {
        items.push({
          id: `launch-${tool}`,
          label: seeds ? `${launcherLabel(tool)} with selection` : launcherLabel(tool),
          action: { kind: 'arm-tool', tool },
          separatorBefore: i === 0,
        })
      })
    }
    return items
  }

  // ---- SELECT + empty: tool launchers ----------------------------------------
  const launchers = EMPTY_LAUNCHERS.map((tool): ContextMenuItem => ({
    id: `launch-${tool}`,
    label: launcherLabel(tool),
    action: { kind: 'arm-tool', tool },
    separatorBefore: tool === FIRST_MODIFY || tool === 'project',
  }))
  if (sketch === null) return launchers
  return [
    {
      id: 'paste-selection',
      label: 'Paste (Ctrl+V)',
      action: { kind: 'paste-selection' },
    },
    { ...launchers[0], separatorBefore: true },
    ...launchers.slice(1),
  ]
}
