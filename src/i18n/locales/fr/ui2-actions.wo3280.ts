// WO-3280: French words of the New UI kit actions (Prompt bar, View cube, unavailable lock).
import type { Translation } from '../../index'

const ui2Actions: Translation<'ui2-actions.wo3280'> = {
  cancel: 'Annuler',
  escKey: 'Échap',
  locked: 'Verrouillé',
  viewStyle: 'Style de vue',
  styleShaded: 'Ombré',
  styleShadedEdges: 'Ombré avec arêtes',
  styleWireframe: 'Fil de fer',
  styleHiddenEdges: 'Arêtes cachées',
} as const

export default ui2Actions


