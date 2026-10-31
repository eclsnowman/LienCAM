// WO-3193: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const threadDirection: Translation<'thread-direction.wo3193'> = {
  direction: 'Richtung',
  bottomUp: 'Von unten nach oben',
  topDown: 'Von oben nach unten',
  summaryBottomUp: 'von unten nach oben',
  summaryTopDown: 'von oben nach unten',
  resultClimb: 'Schneidet im Gleichlauf mit diesem Werkzeug und dieser Steigungsrichtung',
  resultConventional: 'Schneidet im Gegenlauf mit diesem Werkzeug und dieser Steigungsrichtung',
  summary: '{{hand}} / {{direction}} ({{cut}}) / {{lead}}',
}

export default threadDirection
