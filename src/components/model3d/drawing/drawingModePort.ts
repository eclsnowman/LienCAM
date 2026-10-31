// WO-3301 (UI M2 W2-8): Drawing mode as the New UI ribbon and Browser read it. Two ports, as the Form and
// Relief sessions have (../form/modePort): the Drawings section's model (list, create, open, delete) and the
// open sheet editor's session (tools, size, export, undo). Both are published by the components that own
// the state today; nothing here changes what a drawing computes or exports.
import { createModePort } from '../form/modePort'

export type DrawingToolId = 'linear' | 'angle' | 'radius' | 'diameter' | 'detail' | 'balloon'
export type DrawingExportKind = 'pdf' | 'dxf' | 'dxf-logo'
export type DrawingSheetChoice = 'letter' | 'a4'

export interface DrawingsModel {
  readonly modelItemId: string
  readonly drawings: ReadonlyArray<{ id: string; name: string; sourceGone: boolean }>
  /** the drawing open in the editor, if any */
  readonly openId: string | null
  /** a body to draw exists (the selected one, or the only one) and nothing is being made */
  readonly canCreate: boolean
  readonly creating: boolean
  /** how many bodies the item lists (the reason a create is not ready) */
  readonly bodyCount: number
  readonly removedName: string | null
  readonly notice: string | null
  create(): void
  open(drawingId: string): void
  close(): void
  remove(drawingId: string): void
  undoRemove(): void
}

export interface DrawingEditorSession {
  readonly modelItemId: string
  readonly drawingId: string
  readonly tool: DrawingToolId | null
  readonly sheetChoice: DrawingSheetChoice | null
  readonly hasSheet: boolean
  readonly hasLogo: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  chooseTool(tool: DrawingToolId): void
  changeSize(size: DrawingSheetChoice): void
  exportSheet(kind: DrawingExportKind): Promise<void>
  undo(): void
  redo(): void
}

export const drawingsModelPort = createModePort<DrawingsModel>()
export const drawingEditorPort = createModePort<DrawingEditorSession>()

export function drawingsSignature(m: DrawingsModel): string {
  return [m.modelItemId, m.openId ?? '', m.canCreate ? 1 : 0, m.creating ? 1 : 0, m.bodyCount, m.removedName ?? '', m.notice ?? '',
    ...m.drawings.map((d) => `${d.id}:${d.name}:${d.sourceGone ? 1 : 0}`)].join('|')
}

export function drawingEditorSignature(s: DrawingEditorSession): string {
  return [s.modelItemId, s.drawingId, s.tool ?? '', s.sheetChoice ?? '', s.hasSheet ? 1 : 0, s.hasLogo ? 1 : 0, s.canUndo ? 1 : 0, s.canRedo ? 1 : 0].join('|')
}
