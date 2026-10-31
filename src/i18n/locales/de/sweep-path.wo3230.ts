// WO-3230: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const sweepPath: Translation<'sweep-path.wo3230'> = {
  pathSource: 'Pfad',
  modeAxis: 'Achse',
  modeSketch: 'Skizzenpfad',
  followPath: 'Pfad folgen',
  chain: 'Kurven',
  choosePath: 'Offene Linien- oder Bogenkette wählen',
  chainOption: '{{sketch}}: {{curves}}',
  curveLine: 'Linie {{id}}',
  curveArc: 'Bogen {{id}}',
  startsAt: 'Beginnt bei ({{x}}, {{y}}, {{z}}) mm, Richtung ({{dx}}, {{dy}}, {{dz}})',
  reverse: 'Umkehren',
  noChains: 'Keine Skizze vor diesem Sweep hat eine offene Linien- oder Bogenkette, der er folgen kann.',
  notListed: '{{sketch}} ist nicht aufgeführt: {{message}}',
  branched: '{{sketch}} ist nicht aufgeführt: ihre Kurven {{curves}} verzweigen sich und bilden daher keine einzelne offene Kette.',
  savedPathUnresolved: 'Dem gespeicherten Pfad kann nicht gefolgt werden: {{message}}',
  pathUnresolved: 'Sweep-Pfad ({{code}}): {{message}}',
  pathSketchMissing: 'Die Pfadskizze {{sketchId}} existiert an dieser Stelle im Modell nicht (gelöscht oder hinter die Rückrollmarke verschoben). Stelle sie wieder her oder wähle einen anderen Pfad.',
  pathCycle: '{{sketch}} wird aus {{feature}} erstellt und kann daher nicht dessen Pfad sein: Das ergäbe eine Schleife.',
  savedAsPath: 'Skizze als offener Pfad gespeichert: Sie hat kein geschlossenes Profil, und Sweep kann ihr folgen.',
}

export default sweepPath
