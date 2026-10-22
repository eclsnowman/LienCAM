// WO-2329: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
// A sample of the Probing screens: the routine names and the run checks. A
// key left out here shows its English text. Axis letters, T/G words and
// numbers stay as they are.
import type { Translation } from '../../index'

const probingScreens: Translation<'probing-screens'> = {
  "probingPanel1": "Noch keine Nullpunktverschiebung aktiv - Z0 wird in die aktive geschrieben.",
  "probingPanel2": "{{value1}} Z0: seit dem Öffnen nicht von LienCAM gesetzt - das in der Steuerung gespeicherte {{value2}} Z wird verwendet.",
  "probingPanel6": "{{value1}} Z0 in Verwendung: gesetzt um {{value2}}{{value3}}.",
  "probingPanel7": "Rohteiloberkante",
  "probingPanel8": "Kante",
  "probingPanel9": "Einzelne X/Y-Fläche",
  "probingPanel10": "Außenecke",
  "probingPanel11": "Zwei Außenflächen",
  "probingPanel12": "Innenecke",
  "probingPanel13": "Zwei Innenflächen",
  "probingPanel14": "Winkel",
  "probingPanel15": "Ausrichtung über zwei Punkte",
  "probingPanel16": "Bohrung",
  "probingPanel17": "Kreismittelpunkt innen",
  "probingPanel18": "Zapfen",
  "probingPanel19": "Kreismittelpunkt außen",
  "probingPanel20": "Rechtecktasche",
  "probingPanel21": "Vier Innenflächen",
  "probingPanel22": "Rechteckzapfen",
  "probingPanel23": "Vier Außenflächen",
  "probingPanel24": "Z-Oberfläche",
  "probingPanel25": "Schnittfläche vermessen",
  "probingPanel26": "Werkzeug Z",
  "probingPanel27": "Aktives Werkzeug messen",
  "probingPanel28": "Kalibrieren",
  "probingPanel29": "Tastsystem-Radius X / Y",
  "probingPanel39": "Schreibt {{value1}} {{value2}}",
  "probingPanel40": "Stopp - bricht die laufende Antastroutine ab. Kein NOT-HALT: nichts rastet ein.",
  "probingPanel41": "Die Verfahrgrenzen der Maschine sind noch nicht bekannt - die Steuerungseinstellungen wurden nicht gelesen.",
  "probingPanel44": "Die Maschine vor dem Planen eines automatischen Antastzyklus referenzieren.",
  "probingPanel45": "Die Maschine vor dem Planen der Netzvermessung referenzieren.",
  "probingPanel55": "{{value1}}-Nullpunkt bestätigen",
  "probingPanel60": "nicht gesetzt",
  "probingPanel78": "Zuerst mit der Maschine verbinden.",
  "probingPanel79": "Ein Antastzyklus läuft - warten, bis er fertig ist.",
  "probingPanel80": "Ein Halt (ein Werkzeugwechsel, der auf Sie wartet) belegt die Maschine - NC-Start drücken, um ihn abzuschließen, oder NC-Stopp, dann antasten.",
  "probingPanel81": "Ein Programm läuft - Vorschub-Stopp, dann NC-Stopp, bevor Sie antasten.",
  "probingPanel82": "Die Maschine ist {{value1}} - warten, bis sie bereit ist.",
  "probingPanel83": "Zuerst die Maschinenposition lesen.",
  "probingPanel84": "Diese Routine hat noch keinen Plan.",
  "probingPanel90": "Winkelergebnis",
  "probingPanel93": "{{value1}} Netzpunkte werden angetastet - den NOT-HALT in Reichweite halten.",
  "probingPanel96": "Werkstück Z0 gesetzt: {{value1}} Z0 = {{value2}} {{value3}}."
}

export default probingScreens
