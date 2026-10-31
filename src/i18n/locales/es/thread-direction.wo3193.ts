// WO-3193: Spanish, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const threadDirection: Translation<'thread-direction.wo3193'> = {
  direction: 'Dirección',
  bottomUp: 'De abajo arriba',
  topDown: 'De arriba abajo',
  summaryBottomUp: 'de abajo arriba',
  summaryTopDown: 'de arriba abajo',
  resultClimb: 'Corta en concordancia con esta herramienta y este sentido de rosca',
  resultConventional: 'Corta en oposición con esta herramienta y este sentido de rosca',
  summary: '{{hand}} / {{direction}} ({{cut}}) / {{lead}}',
}

export default threadDirection
