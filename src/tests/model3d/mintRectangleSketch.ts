// SKC-PARAM-RECT-REMOVAL (Q-24, ruled "remove-param-rect" 2026-07-12): the
// New-sketch chooser's "Or insert a parametric rectangle instead" escape
// hatch (SketchPlaneDialog's `onChooseRectangle`) is gone -- see
// SolidsWorkbenchPage.tsx / SketchPlaneDialog.tsx history.
//
// This is the "direct profile source" ~50 SolidsWorkbenchPage.*.test.tsx
// fixtures migrated onto. It builds the exact same rectangle-profile
// 'sketch' DAG node the now-deleted SketchRectangleDialog's create-mode
// Apply handler used to build (SAME createFeatureCommand + rectangleProfile
// call, SAME nextId('SK') allocator, so ids stay SK1/SK2/... exactly as the
// old UI-driven flow produced) -- just called directly against the live page
// hooks instead of driven through a dialog button. Fixtures that only needed
// "a sketch to extrude from" as scaffolding for an unrelated assertion
// (push/pull, defeature, hole, ...) don't need to re-derive an equivalent
// through the interactive Sketcher package session; this is the plainest
// direct construction they already supported (SolidsWorkbenchPage.tsx
// exposes `dag`/`history` on window.__solidsWorkbenchHooks for exactly this
// kind of test-level direct command execution -- see e.g.
// SolidsWorkbenchPage.camModelBodies.test.tsx's own `extrudeNewBody`).
//
// RECT-DIALOG-REMOVAL (Operator Q-69, 2026-07-25): SketchRectangleDialog is
// deleted entirely -- both its create mode (already unreachable since
// SKC-PARAM-RECT-REMOVAL) and its BK-175 edit-mode reuse. This helper is now
// the ONLY thing in the codebase that still mints this node shape, purely as
// test scaffolding for the 51 fixtures below; editEntryFor's 'sketch' case
// gives any such node a named "legacy, no editor" refusal instead of
// reopening a dialog.
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { nextId } from '../../components/model3d/dialogs/nextId'
import { rectangleProfile, type SketchPlaneKind } from '../../components/model3d/workbench/profileGeometry'

export interface MintRectangleSketchOptions {
  width?: number | string
  height?: number | string
  offset?: number | string
  plane?: SketchPlaneKind | string
  /** Override the default nextId('SK') allocation. */
  id?: string
}

/** Directly constructs a rectangle-profile 'sketch' DAG node -- see file
 *  header. Returns the new node's id (SK1, SK2, ... unless `id` is given).
 *  Requires SolidsWorkbenchPage to be mounted and ready
 *  (window.__solidsWorkbenchHooks installed).
 *
 *  Awaits `hooks.fullResync([id])` before returning -- the SAME regen pass
 *  handleDialogApplied (SolidsWorkbenchPage.tsx) runs after every dialog's
 *  Apply, and the reason it must run here too: `history.execute` alone
 *  mutates the DAG (a plain object, not React state) without triggering any
 *  re-render, so a caller that only awaited the execute would race the
 *  FeatureTree row actually appearing. fullResync is what performs (and
 *  publishes) the state update the row's render depends on. */
export async function mintRectangleSketch(opts: MintRectangleSketchOptions = {}): Promise<string> {
  const hooks = window.__solidsWorkbenchHooks
  if (hooks === undefined) {
    throw new Error('mintRectangleSketch: __solidsWorkbenchHooks not installed (SolidsWorkbenchPage not mounted/ready yet)')
  }
  const width = opts.width !== undefined ? Number(opts.width) : 40
  const height = opts.height !== undefined ? Number(opts.height) : 20
  const offset = opts.offset !== undefined ? Number(opts.offset) : 10
  const plane = (opts.plane ?? 'xy') as SketchPlaneKind
  const id = opts.id ?? nextId(hooks.dag, 'SK')
  const profile = rectangleProfile({ sketchId: id, plane, width, height, offset })
  hooks.history.execute(
    createFeatureCommand(hooks.dag, {
      id,
      kind: 'sketch',
      // Current sketch writers persist the complete validated region list while
      // retaining profile as the legacy default. Keep this shared fixture on
      // the current node shape; profile-only compatibility has its own focused
      // regression in ProfileRegionPicker.ui66.test.tsx.
      payload: { name: `Sketch ${id}`, plane, width, height, offset, profile, regions: [profile] },
    }),
  )
  await hooks.fullResync([id])
  return id
}
