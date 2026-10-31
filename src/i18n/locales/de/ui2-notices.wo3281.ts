// WO-3281: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const ui2Notices: Translation<'ui2-notices.wo3281'> = {
  levels: {
    info: 'Information',
    warning: 'Warnung',
    cannotDoThis: 'Jetzt nicht verfügbar',
    error: 'Fehler',
  },
  units: {
    wrongUnit: 'Dieses Feld akzeptiert diese Einheit nicht.',
    wrongMark: 'Verwenden Sie das in den Einstellungen gewählte Dezimalzeichen.',
  },
}

export default ui2Notices
