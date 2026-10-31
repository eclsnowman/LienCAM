// WO-3301 (UI M2 W2-8): what each mode's ribbon offers, as data. Rail tools of Form and Relief keep their
// test ids (the session builds the buttons; this table gives each a command id, a place and a catalogue label
// key from the catalogues the shipped rail already uses). Drawing's tools are the editor toolbar's.
import type { ActionKind } from '../../components/kit/types'
import type { MessageKey } from '../../notices/types'

export type ModeId = 'form' | 'relief' | 'drawing'
export const MODE_IDS: readonly ModeId[] = ['form', 'relief', 'drawing']

export interface ToolRow {
  /** the command id suffix: `model.<mode>.<id>` */
  readonly id: string
  /** the session's rail test id (Form and Relief); absent for Drawing */
  readonly testId?: string
  readonly labelKey: MessageKey
  readonly kind: ActionKind
  /** false = the shipped rail never shows it today (a switched-off option): the table keeps it, the ribbon does not place it */
  readonly offered?: false
}

export interface GroupRow {
  readonly id: string
  readonly captionKey: MessageKey
  readonly tools: readonly ToolRow[]
}

const wb = (key: string): MessageKey => `sketch-and-model-workbench:${key}` as MessageKey
const td = (key: string): MessageKey => `technical-drawings:${key}` as MessageKey
export const modeKey = (key: string): MessageKey => `ui2-model-modes.wo3301:${key}` as MessageKey

function rail(prefix: 'form' | 'relief', words: string, rows: ReadonlyArray<readonly [string, string, ActionKind?]>): readonly ToolRow[] {
  return rows.map(([id, key, kind]) => ({
    id, testId: `${prefix}-${id}`, labelKey: wb(`${words}.${key}`), kind: kind ?? 'momentary',
    ...(id === 'pull-body' ? { offered: false as const } : {}),
  }))
}
const form = (rows: ReadonlyArray<readonly [string, string, ActionKind?]>) => rail('form', 'useFormSession', rows)
const relief = (rows: ReadonlyArray<readonly [string, string, ActionKind?]>) => rail('relief', 'useReliefSession', rows)

export const FORM_GROUPS: readonly GroupRow[] = [
  {
    id: 'create', captionKey: wb('useFormSession.formStartFrom'),
    tools: form([
      ['starter-box', 'box', 'choice'], ['starter-cylinder', 'cylinder', 'choice'], ['starter-sphere', 'sphere', 'choice'],
      ['starter-torus', 'torus', 'choice'], ['starter-plane', 'plane', 'choice'], ['starter-pipe', 'pipe', 'choice'],
      ['starter-extrude', 'extrude', 'choice'], ['starter-revolve', 'revolve', 'choice'], ['starter-loft', 'loft', 'choice'],
      ['starter-face', 'face', 'choice'], ['starter-body', 'fromBody', 'choice'],
    ]),
  },
  {
    id: 'edit', captionKey: wb('useFormSession.editForm'),
    tools: form([
      ['transform-translate', 'move', 'choice'], ['transform-rotate', 'rotate', 'choice'], ['transform-scale', 'scale', 'choice'],
      ['flatten', 'flatten'], ['straighten', 'straighten'], ['make-uniform', 'uniform'], ['pull-body', 'pullToBody'], ['pull', 'pull'],
    ]),
  },
  {
    id: 'topology', captionKey: wb('useFormSession.topology'),
    tools: form([
      ['insert-loop', 'insertLoop'], ['crease', 'crease'], ['uncrease', 'uncrease'], ['insert-point', 'insertPoint'],
      ['add-face', 'addFace', 'latched'], ['face-chain', 'chain', 'latched'], ['subdivide', 'subdivide'], ['weld', 'weld'],
      ['weld-close', 'weldClose'], ['unweld', 'unweld'],
    ]),
  },
  {
    id: 'select', captionKey: wb('useFormSession.select'),
    tools: form([['select-loop', 'loop'], ['select-ring', 'ring'], ['select-grow', 'grow'], ['select-shrink', 'shrink'], ['select-all', 'all']]),
  },
  {
    id: 'openings', captionKey: wb('useFormSession.openings'),
    tools: form([['delete-faces', 'delete'], ['fill-hole', 'fillHole'], ['bridge', 'bridge'], ['thicken', 'thicken']]),
  },
  {
    id: 'symmetry', captionKey: wb('useFormSession.symmetry'),
    tools: form([
      ['mirror-x', 'mirrorX', 'latched'], ['mirror-y', 'mirrorY', 'latched'], ['mirror-z', 'mirrorZ', 'latched'],
      ['circular', 'circular', 'latched'], ['mirror-selection', 'between', 'latched'], ['mirror-duplicate', 'duplicate'],
    ]),
  },
  {
    id: 'display', captionKey: wb('useFormSession.display'),
    tools: form([['display-cage', 'cage', 'choice'], ['display-both', 'both', 'choice'], ['display-smooth', 'smooth', 'choice']]),
  },
  { id: 'history', captionKey: modeKey('groupHistory'), tools: form([['undo', 'undo'], ['redo', 'redo']]) },
]

export const RELIEF_GROUPS: readonly GroupRow[] = [
  { id: 'image', captionKey: wb('useReliefSession.reliefImage'), tools: relief([['open-image', 'openImage']]) },
  { id: 'place', captionKey: wb('useReliefSession.place'), tools: relief([['pick-face', 'pickFace'], ['fit', 'fitToFace']]) },
  {
    id: 'height', captionKey: wb('useReliefSession.height'),
    tools: relief([['raise', 'raise', 'choice'], ['emboss', 'emboss', 'choice'], ['engrave', 'engrave', 'choice'], ['invert', 'invert', 'latched']]),
  },
  { id: 'adjust', captionKey: wb('useReliefSession.adjust'), tools: relief([['auto', 'auto', 'latched']]) },
  {
    id: 'preview', captionKey: wb('useReliefSession.preview'),
    tools: relief([['map-height', 'heightMap', 'choice'], ['map-shaded', 'shaded', 'choice']]),
  },
]

const drawingTool = (id: string, key: string, kind: ActionKind = 'choice'): ToolRow => ({ id, labelKey: td(key), kind })
export const DRAWING_GROUPS: readonly GroupRow[] = [
  {
    id: 'dimension', captionKey: modeKey('groupDimension'),
    tools: [drawingTool('linear', 'annotate.toolLinear'), drawingTool('angle', 'annotate.toolAngle'), drawingTool('radius', 'annotate.toolRadius'), drawingTool('diameter', 'annotate.toolDiameter')],
  },
  { id: 'annotate', captionKey: modeKey('groupAnnotate'), tools: [drawingTool('balloon', 'annotate.toolBalloon')] },
  {
    id: 'sheet', captionKey: modeKey('groupSheet'),
    tools: [drawingTool('detail', 'annotate.toolDetail'), drawingTool('size-letter', 'editor.letter'), drawingTool('size-a4', 'editor.a4')],
  },
  {
    id: 'export', captionKey: modeKey('groupExport'),
    tools: [drawingTool('export-pdf', 'export.pdf', 'momentary'), drawingTool('export-dxf', 'export.dxf', 'momentary')],
  },
  { id: 'history', captionKey: modeKey('groupHistory'), tools: [drawingTool('undo', 'annotate.undo', 'momentary'), drawingTool('redo', 'annotate.redo', 'momentary')] },
]

/** DXF + logo is shown only while the sheet has a logo (as the shipped editor does), so it is not in the Export group;
 *  ModeSync adds it as a group of its own while that holds. */
export const DXF_LOGO_TOOL: ToolRow = drawingTool('export-dxf-logo', 'export.dxfLogo', 'momentary')

/** The command id of a tool: the registry takes letters and digits between dots, so `export-pdf` is `exportPdf`. */
export const commandIdOf = (mode: ModeId, toolId: string): `${string}.${string}` =>
  `model.${mode}.${toolId.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`

export const GROUPS_BY_MODE: Readonly<Record<ModeId, readonly GroupRow[]>> = { form: FORM_GROUPS, relief: RELIEF_GROUPS, drawing: DRAWING_GROUPS }
