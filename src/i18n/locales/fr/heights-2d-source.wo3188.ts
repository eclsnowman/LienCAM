// WO-3188: French, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const heights2dSource: Translation<'heights-2d-source.wo3188'> = {
  chamferAssumed: 'Ce contour n\'a pas de hauteur propre : le chanfrein commence au sommet de la matière à cet endroit. Choisissez ici Dessus du brut, Dessous du brut ou un décalage pour le placer.',
  geometryAssumed: 'Ce contour n\'a pas de hauteur propre : Géométrie est le plan sur lequel il repose, Z {{z}} {{unit}}. Choisissez ici Dessus du brut, Dessous du brut ou un décalage pour placer la coupe.',
}

export default heights2dSource
