// WO-3207: controller network and second-side confirmation text.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'machine-definition.wo3207'> = {
  networkTitle: 'Steuerungsnetzwerk',
  networkHelp: 'Die AXBB-E verwendet 10.10.10.11 und hat keinen DHCP-Server. Wählen Sie ihren kabelgebundenen Anschluss; hier wird nur die Adressierung eingerichtet.',
  wiredPort: 'Kabelgebundener Anschluss',
  wiredPortLabel: 'Kabelgebundener Anschluss der Steuerung',
  chooseWiredPort: 'Kabelgebundenen Anschluss wählen',
  portPlaceholder: 'z. B. enp1s0',
  hostAddress: 'Adresse dieses Computers',
  hostAddressLabel: 'Hostadresse der Steuerung',
  settingUp: 'Wird eingerichtet...',
  setupNetwork: 'Steuerungsnetzwerk einrichten',
  listPortsError: 'Kabelgebundene Anschlüsse konnten nicht aufgelistet werden: {{error}}; geben Sie unten den Anschlussnamen ein.',
  setupError: 'Die Einrichtung des Steuerungsnetzwerks konnte nicht abgeschlossen werden: {{error}}',
  reuseTitle: 'G{{fixtureOffset}} wiederverwenden?',
  reuseBody: 'Alle sechs Nullpunktverschiebungen (G54-G59) sind belegt. G{{fixtureOffset}} von "{{parentSetupName}}" für diese zweite Seite wiederverwenden?',
  reuseConfirm: 'G{{fixtureOffset}} wiederverwenden',
  cancel: 'Abbrechen',
}

export default words
