// WO-3193: words for the Thread Mill direction choice (Bottom-up / Top-down)
// and the climb/conventional result it gives - New Operation and Properties.
const threadDirection = {
  direction: 'Direction',
  bottomUp: 'Bottom-up',
  topDown: 'Top-down',
  summaryBottomUp: 'bottom-up',
  summaryTopDown: 'top-down',
  resultClimb: 'Cuts climb with this cutter and hand',
  resultConventional: 'Cuts conventional with this cutter and hand',
  summary: '{{hand}} / {{direction}} ({{cut}}) / {{lead}}',
} as const

export default threadDirection

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'thread-direction.wo3193': typeof threadDirection
  }
}
