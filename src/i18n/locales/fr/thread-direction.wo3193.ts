// WO-3193: French, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const threadDirection: Translation<'thread-direction.wo3193'> = {
  direction: 'Sens',
  bottomUp: 'De bas en haut',
  topDown: 'De haut en bas',
  summaryBottomUp: 'de bas en haut',
  summaryTopDown: 'de haut en bas',
  resultClimb: 'Coupe en avalant avec cet outil et ce sens de filet',
  resultConventional: 'Coupe en opposition avec cet outil et ce sens de filet',
  summary: '{{hand}} / {{direction}} ({{cut}}) / {{lead}}',
}

export default threadDirection
