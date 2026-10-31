// WO-3237: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const thinOpenExtrude: Translation<'thin-open-extrude.wo3237'> = {
  source: 'Wand entlang',
  sourceRegions: 'Geschlossene Skizzenbereiche',
  chainOption: 'Offene Kette in {{sketch}}: {{curves}}',
  reverse: 'Umkehren',
  travels: 'Die Kette beginnt bei {{curve}} und läuft bis {{last}}; der Pfeil in der Ansicht zeigt die Richtung.',
  sideLeft: 'Links',
  sideRight: 'Rechts',
  summaryLeft: 'Dünne Wand {{thickness}} mm links der Kette, in ihrer Richtung gesehen.',
  summaryRight: 'Dünne Wand {{thickness}} mm rechts der Kette, in ihrer Richtung gesehen.',
  summaryCenter: 'Dünne Wand {{thickness}} mm mittig auf der Kette, {{half}} mm je Seite.',
  needsThin: 'Eine offene Skizzenkette wird nur als dünne Wand extrudiert - Dünnwandig einschalten oder geschlossene Bereiche wählen.',
  chainUnresolved: 'Der gespeicherten Kette kann nicht gefolgt werden: {{message}}',
  unknownOpenSide: 'Unbekannte Wandseite "{{side}}" für eine offene Kette - links, rechts oder Mitte verwenden.',
  wrongSketch: 'Die Kette gehört zur Skizze {{chainSketch}}, nicht zur Skizze {{sketch}} dieser Extrusion.',
}

export default thinOpenExtrude
