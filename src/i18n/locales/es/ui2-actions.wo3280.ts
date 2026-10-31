// WO-3280: Spanish words of the New UI kit actions (Prompt bar, View cube, unavailable lock).
import type { Translation } from '../../index'

const ui2Actions: Translation<'ui2-actions.wo3280'> = {
  cancel: 'Cancelar',
  escKey: 'Esc',
  locked: 'Bloqueado',
  viewStyle: 'Estilo de vista',
  styleShaded: 'Sombreado',
  styleShadedEdges: 'Sombreado con aristas',
  styleWireframe: 'Alambre',
  styleHiddenEdges: 'Aristas ocultas',
} as const

export default ui2Actions


