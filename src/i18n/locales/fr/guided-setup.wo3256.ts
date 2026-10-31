// WO-3256: Configuration guidée (unités, machine, outils).
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'guided-setup.wo3256'> = {
  title: 'Configuration guidée',
  intro: "Trois points que la plupart des gens vérifient avant leur premier travail. Chacun ouvre l'éditeur existant, et vous revenez ici quand vous le fermez.",
  openerButton: 'Configuration guidée',
  openerTooltip: "Passer en revue les unités, la machine et les outils. Rien n'est créé ni modifié tant que vous n'enregistrez pas dans l'un de ces éditeurs.",
  settingsHeading: 'Première configuration',
  settingsHint: 'Unités, machine et outils dans une courte liste. Facultatif ; ouvrez-la quand vous voulez.',
  unitsTitle: 'Unités',
  unitsSummary: "Unités d'affichage : {{display}}. Unités d'export du G-code : {{export}}.",
  unitsNote: "Les unités d'affichage et les unités d'export du G-code sont des réglages distincts.",
  unitMm: 'millimètres (mm)',
  unitIn: 'pouces (in)',
  unitsOpen: 'Ouvrir les Réglages',
  machineTitle: 'Machine CNC',
  machineSummary: 'Machine du projet : {{name}}',
  machineNone: "Machine du projet : aucune choisie pour l'instant",
  machineOpen: 'Ouvrir la bibliothèque de machines',
  toolsTitle: 'Outils (facultatif)',
  toolsSummary: 'Outils dans votre bibliothèque : {{count}}',
  toolsOpen: "Ouvrir la bibliothèque d'outils",
  savedNote: 'Les modifications enregistrées sont conservées quand vous quittez la configuration.',
  skip: 'Ignorer la configuration',
  continue: 'Continuer vers le projet',
  close: 'Fermer la configuration guidée',
}

export default words
