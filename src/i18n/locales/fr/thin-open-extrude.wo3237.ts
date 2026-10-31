// WO-3237: French, machine-translated and checked against docs/i18n/GLOSSARY-fr.md.
import type { Translation } from '../../index'

const thinOpenExtrude: Translation<'thin-open-extrude.wo3237'> = {
  source: 'Paroi le long de',
  sourceRegions: 'Régions fermées de l\'esquisse',
  chainOption: 'Chaîne ouverte dans {{sketch}} : {{curves}}',
  reverse: 'Inverser',
  travels: 'La chaîne commence à {{curve}} et va jusqu\'à {{last}} ; la flèche dans la vue montre le sens.',
  sideLeft: 'Gauche',
  sideRight: 'Droite',
  summaryLeft: 'Paroi mince de {{thickness}} mm à gauche de la chaîne, dans son sens de parcours.',
  summaryRight: 'Paroi mince de {{thickness}} mm à droite de la chaîne, dans son sens de parcours.',
  summaryCenter: 'Paroi mince de {{thickness}} mm centrée sur la chaîne, {{half}} mm de chaque côté.',
  needsThin: 'Une chaîne ouverte d\'esquisse ne s\'extrude qu\'en paroi mince : activez Mince ou choisissez des régions fermées.',
  chainUnresolved: 'La chaîne enregistrée ne peut pas être suivie : {{message}}',
  unknownOpenSide: 'Côté de paroi inconnu « {{side}} » pour une chaîne ouverte : utilisez gauche, droite ou centre.',
  wrongSketch: 'La chaîne appartient à l\'esquisse {{chainSketch}}, pas à l\'esquisse {{sketch}} de cette extrusion.',
}

export default thinOpenExtrude
