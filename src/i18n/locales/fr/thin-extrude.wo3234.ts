// WO-3234: French, machine-translated and checked against docs/i18n/GLOSSARY-fr.md.
import type { Translation } from '../../index'

const thinExtrude: Translation<'thin-extrude.wo3234'> = {
  wall: 'Paroi',
  thin: 'Mince',
  thickness: 'Épaisseur',
  side: 'Côté',
  sideInside: 'Intérieur',
  sideOutside: 'Extérieur',
  sideCenter: 'Centré',
  summaryInside: 'Paroi mince de {{thickness}} mm à l\'intérieur du contour de l\'esquisse, vers la matière.',
  summaryOutside: 'Paroi mince de {{thickness}} mm à l\'extérieur du contour de l\'esquisse, à l\'écart de la matière.',
  summaryCenter: 'Paroi mince de {{thickness}} mm centrée sur le contour de l\'esquisse, {{half}} mm de chaque côté.',
  endNotAvailable: '{{end}} n\'est pas encore disponible pour une paroi mince - choisissez Borgne ou Symétrique.',
  thicknessMustBePositive: 'L\'épaisseur de paroi doit être un nombre positif en mm (reçu : {{thickness}}).',
  unknownWallMode: 'Mode de paroi d\'extrusion inconnu « {{mode}} ».',
  unknownWallSide: 'Côté de paroi inconnu « {{side}} » - utilisez inside, outside ou center.',
}

export default thinExtrude
