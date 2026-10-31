// WO-3280: German words of the New UI kit actions (Prompt bar, View cube, unavailable lock).
import type { Translation } from '../../index'

const ui2Actions: Translation<'ui2-actions.wo3280'> = {
  cancel: 'Abbrechen',
  escKey: 'Esc',
  locked: 'Gesperrt',
  viewStyle: 'Ansichtsstil',
  styleShaded: 'Schattiert',
  styleShadedEdges: 'Schattiert mit Kanten',
  styleWireframe: 'Drahtmodell',
  styleHiddenEdges: 'Verdeckte Kanten',
} as const

export default ui2Actions


