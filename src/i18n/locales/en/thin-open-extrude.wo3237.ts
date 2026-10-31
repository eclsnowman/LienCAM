// WO-3237: words for Thin walls along an open sketch chain in the Extrude
// dialog - choosing the chain, which way it travels, which side the wall sits
// on, and the builder's refusals.
const thinOpenExtrude = {
  source: 'Wall along',
  sourceRegions: 'Closed sketch regions',
  chainOption: 'Open chain in {{sketch}}: {{curves}}',
  reverse: 'Reverse',
  travels: 'Chain starts at {{curve}} and runs to {{last}}; the arrow in the view shows which way.',
  sideLeft: 'Left',
  sideRight: 'Right',
  summaryLeft: 'Thin wall {{thickness}} mm on the left of the chain, walking its direction.',
  summaryRight: 'Thin wall {{thickness}} mm on the right of the chain, walking its direction.',
  summaryCenter: 'Thin wall {{thickness}} mm centred on the chain, {{half}} mm each way.',
  needsThin: 'An open sketch chain extrudes only as a Thin wall - turn Thin on, or choose closed regions.',
  chainUnresolved: 'The saved chain cannot be followed: {{message}}',
  unknownOpenSide: 'Unknown open-chain wall side "{{side}}" - use left, right or center.',
  wrongSketch: 'The chain belongs to sketch {{chainSketch}}, not to this extrude\'s sketch {{sketch}}.',
} as const

export default thinOpenExtrude

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'thin-open-extrude.wo3237': typeof thinOpenExtrude
  }
}
