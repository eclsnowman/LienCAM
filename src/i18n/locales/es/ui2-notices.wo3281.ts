// WO-3281: Spanish, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const ui2Notices: Translation<'ui2-notices.wo3281'> = {
  levels: {
    info: 'Información',
    warning: 'Advertencia',
    cannotDoThis: 'No disponible ahora',
    error: 'Error',
  },
  units: {
    wrongUnit: 'Este campo no admite esa unidad.',
    wrongMark: 'Use el separador decimal definido en Ajustes.',
  },
}

export default ui2Notices
