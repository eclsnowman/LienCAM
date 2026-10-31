// WO-3282: French, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const ui2Commands: Translation<'ui2-commands.wo3282'> = {
  searchLabel: 'Rechercher une commande',
  placeholder: 'Tapez le nom d’une commande ou un raccourci',
  results: 'Commandes',
  noMatch: 'Aucune commande ne correspond à « {{query}} ».',
  notNow: 'Indisponible pour le moment',
  placeSetup: 'Montage',
  placeSketch: 'Esquisse',
  placeModel: 'Modèle',
  placeToolpath: 'Parcours',
  placeSimulate: 'Simulation',
  placeControl: 'Commande',
  placeGlobal: 'Partout',
}

export default ui2Commands
