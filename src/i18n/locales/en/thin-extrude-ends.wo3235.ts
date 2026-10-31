// WO-3235: words for Thin walls that end at a target - the one line that
// says how Up to next / part decide where each wall stops.
const thinExtrudeEnds = {
  wallsStopOnTheirOwnSection: 'Each wall stops at the first face that covers its whole wall section; the hollow centre does not count.',
} as const

export default thinExtrudeEnds

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'thin-extrude-ends.wo3235': typeof thinExtrudeEnds
  }
}
