// WO-3234: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const thinExtrude: Translation<'thin-extrude.wo3234'> = {
  wall: 'Wand',
  thin: 'Dünnwandig',
  thickness: 'Wandstärke',
  side: 'Seite',
  sideInside: 'Innen',
  sideOutside: 'Außen',
  sideCenter: 'Mittig',
  summaryInside: 'Dünne Wand {{thickness}} mm innerhalb der Skizzenkontur, zum Material hin.',
  summaryOutside: 'Dünne Wand {{thickness}} mm außerhalb der Skizzenkontur, vom Material weg.',
  summaryCenter: 'Dünne Wand {{thickness}} mm mittig auf der Skizzenkontur, {{half}} mm je Seite.',
  endNotAvailable: '{{end}} ist für Dünnwandig noch nicht verfügbar - Blind oder Symmetrisch wählen.',
  thicknessMustBePositive: 'Die Wandstärke muss eine positive Zahl in mm sein (erhalten: {{thickness}}).',
  unknownWallMode: 'Unbekannter Wandmodus "{{mode}}" für Extrusion.',
  unknownWallSide: 'Unbekannte Wandseite "{{side}}" - inside, outside oder center verwenden.',
}

export default thinExtrude
