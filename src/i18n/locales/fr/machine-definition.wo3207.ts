// WO-3207: controller network and second-side confirmation text.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'machine-definition.wo3207'> = {
  networkTitle: 'Réseau du contrôleur',
  networkHelp: 'L’AXBB-E utilise 10.10.10.11 et n’a pas de serveur DHCP. Choisissez son port réseau filaire ; ceci configure uniquement l’adressage.',
  wiredPort: 'Port réseau filaire',
  wiredPortLabel: 'Port réseau filaire du contrôleur',
  chooseWiredPort: 'Choisir le port réseau filaire',
  portPlaceholder: 'p. ex. enp1s0',
  hostAddress: 'Adresse de cet ordinateur',
  hostAddressLabel: 'Adresse de l’ordinateur du contrôleur',
  settingUp: 'Configuration en cours...',
  setupNetwork: 'Configurer le réseau du contrôleur',
  listPortsError: 'Impossible de répertorier les ports réseau filaires : {{error}} ; saisissez le nom du port ci-dessous.',
  setupError: 'La configuration du réseau du contrôleur n’a pas pu aboutir : {{error}}',
  reuseTitle: 'Réutiliser G{{fixtureOffset}} ?',
  reuseBody: 'Les six décalages d’origine (G54-G59) sont utilisés. Réutiliser G{{fixtureOffset}} de "{{parentSetupName}}" pour cette seconde face ?',
  reuseConfirm: 'Réutiliser G{{fixtureOffset}}',
  cancel: 'Annuler',
}

export default words
