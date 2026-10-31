// WO-3227: the Programmed cut group in Tool Library > Cutting Data.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'tool-cut-calculator.wo3227'> = {
  title: 'Coupe programmée',
  depthOfCut: 'Profondeur de passe (ap)',
  stepover: 'Engagement radial (ae)',
  engagementAngle: "Angle d'engagement",
  maxChip: 'Épaisseur de copeau max',
  meanChip: 'Épaisseur de copeau moyenne',
  removalRate: "Débit d'enlèvement",
  degrees: '°',
  removalUnitMm: 'cm³/min',
  removalUnitInch: 'in³/min',
  rubbing: "Le copeau max est plus fin que {{value}} : l'arête peut frotter au lieu de couper.",
  trust: "Ceci estime la coupe programmée ; l'engagement réel, la rigidité de l'outil et la tenue du bridage n'ont pas été vérifiés.",
  notApplicableShape: "Ce calculateur modélise une fraise plate qui coupe de côté ; le modèle ne s'applique pas à cet outil.",
  notApplicableDepth: "La profondeur de passe dépasse la longueur des dents ; le modèle ne s'applique pas.",
  needsNumbers: 'il faut un diamètre, une vitesse, une avance, une profondeur et un engagement valides',
  needsSpindle: 'il faut une vitesse de broche et des dents',
  noContact: 'pas d’engagement, pas de contact',
  stepoverOverDiameter: "l'engagement dépasse le diamètre",
}

export default words
