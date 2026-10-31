// WO-3281: French, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const ui2Notices: Translation<'ui2-notices.wo3281'> = {
  levels: {
    info: 'Information',
    warning: 'Avertissement',
    cannotDoThis: 'Indisponible pour le moment',
    error: 'Erreur',
  },
  units: {
    wrongUnit: 'Ce champ n’accepte pas cette unité.',
    wrongMark: 'Utilisez le séparateur décimal défini dans les Réglages.',
  },
}

export default ui2Notices
