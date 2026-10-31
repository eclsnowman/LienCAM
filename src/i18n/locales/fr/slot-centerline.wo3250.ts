// WO-3250: French, machine-translated and checked against docs/i18n/GLOSSARY-fr.md.
// Screen names that still show in English (Engrave, Trace, Plain, Trochoidal,
// Slot width, Tool) stay in English so the text matches what is on screen.
import type { Translation } from '../../index'

const slotCenterline: Translation<'slot-centerline.wo3250'> = {
  card: 'Rainure (ligne médiane)',
  cardTooltip: 'Usine une rainure centrée sur les lignes choisies. Crée une opération Engrave en mode Trace sur la ligne, enregistrée et modifiée comme Engrave.',
  defaultName: 'Rainure',
  plainWidth: 'Plain usine une rainure exactement de la largeur de l\'outil : {{width}} {{unit}}. Choisissez Trochoidal pour une rainure plus large.',
  plainWidthNoTool: 'Plain usine une rainure exactement de la largeur de l\'outil. Choisissez un outil dans l\'onglet Tool pour voir la largeur.',
  trochoidalRange: 'Trochoidal usine avec cet outil une rainure de {{min}} à {{max}} {{unit}} de large. Un Slot width saisi hors de cette plage est ramené à la borne la plus proche.',
}

export default slotCenterline
