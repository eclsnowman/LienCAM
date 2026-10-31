// WO-2329: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
// A sample of LienCAM's own operator messages: why a toolpath is outdated.
// Controller messages are never in this catalog - they show as the controller
// sent them. A key left out here shows its English text.
import type { Translation } from '../../index'

const messages: Translation<'console-and-operator-messages'> = {
  "postToolNumberAssigned": "T{{number}} wurde „{{name}}“ für dieses Programm zugewiesen.",
  "g53BottomOfTravel": "„{{name}}“, Zeile {{line}}: {{code}} fährt auf Maschinen-Z {{z}}, das untere Ende des Z-Verfahrwegs dieser Maschine. Es läuft wie geschrieben.",
  "g53BottomOfTravelMore": "„{{name}}“: {{count}} weitere Zeilen fahren ebenfalls an das untere Ende des Z-Verfahrwegs, die nächste in Zeile {{line}}.",
  "interpreterHandover": "„{{name}}“: Zeile {{line}} ({{word}}) liest der Datei-Interpreter der Maschinenbrücke, deshalb wird die ganze Datei dort gelesen.",
  "interpreterHandoverNoLine": "„{{name}}“: Diese Datei liest der Datei-Interpreter der Maschinenbrücke, deshalb wird die ganze Datei dort gelesen.",
  "index40": "{{value1}}: {{value3}} Verbindungen geprüft; {{value2}} Eilgangbewegungen bleiben unter der Sicherheitshöhe über bereits entferntem Material.",
  "outdatedReasonEarlierChanged": "{{name}} wurde nach dieser Berechnung geändert",
  "outdatedReasonEarlierRemoved": "{{name}} wurde nach dieser Berechnung gelöscht",
  "outdatedReasonEarlierEnabled": "{{name}} wurde nach dieser Berechnung eingeschaltet",
  "outdatedReasonEarlierDisabled": "{{name}} wurde nach dieser Berechnung ausgeschaltet",
  "outdatedReasonOrder": "die Reihenfolge der Arbeitsschritte wurde nach dieser Berechnung geändert",
  "outdatedReasonTool": "sein Werkzeug wurde geändert",
  "outdatedReasonGeometry": "seine Geometrie wurde geändert",
  "outdatedReasonSettings": "seine Einstellungen wurden geändert",
  "outdatedReasonStock": "das Rohteil wurde geändert",
  "outdatedReasonOrigin": "der Nullpunkt der Aufspannung wurde geändert",
  "outdatedReasonParts": "die Teile, gegen die er berechnet wird, wurden geändert",
  "outdatedReasonWorkholding": "die Spannmittel wurden geändert",
  "outdatedReasonMachine": "die Maschine wurde geändert",
  "outdatedReasonNest": "seine Verschachtelung muss neu berechnet werden",
  "outdatedReasonChangedWhileComputing": "seine Eingaben wurden während der Berechnung geändert",
  "outdatedReasonHistory": "Rückgängig hat ihn ohne seinen Werkzeugweg zurückgebracht",
  "outdatedReasonInterrupted": "er wurde noch berechnet, als das Programm geschlossen wurde",
  "outdatedReasonNoToolpath": "er hat keinen gespeicherten Werkzeugweg",
  "outdatedReasonOpened": "sein gespeicherter Werkzeugweg passt nicht zu seinen aktuellen Eingaben",
  "outdatedReasonInputs": "seine Eingaben wurden nach dieser Berechnung geändert"
}

export default messages
