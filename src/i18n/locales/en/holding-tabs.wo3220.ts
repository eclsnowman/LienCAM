// WO-3220: words for Suggest tab locations in Properties > Holding tabs - the
// command, its preview of the suggested locations and the one-line reasons
// it gives when a contour is not one it can suggest for.
const holdingTabs = {
  suggest: 'Suggest tab locations',
  suggestTooltip: 'Propose tab centers away from corners, short spans, nearby holes and workholding. Nothing changes until you Apply. Outlines with hand-placed tabs are left as they are.',
  foundOf: 'Found {{found}} of {{requested}} suggestions',
  loopLine: 'Outline {{index}}: {{found}} of {{requested}} at {{positions}} mm along the cut',
  loopNone: 'Outline {{index}}: no location fits, so Apply leaves it without tabs',
  loopHandPlaced: 'Outline {{index}}: hand-placed tabs kept as they are',
  avoided: 'Avoided: {{reasons}}',
  notChecked: 'Not checked: {{items}}',
  apply: 'Apply',
  applyPartial: 'Apply {{count}}',
  cancel: 'Cancel',
  applied: 'Applied {{count}} tab locations. Generate to cut them.',
  appliedWithNone: 'Applied {{count}} tab locations; outlines left without tabs: {{none}}. Generate to cut them.',
  outlinesWithoutTabs: 'Outlines without tabs: {{count}}',
  reasonCorner: 'corners and short spans',
  reasonEntry: 'the entry and exit',
  reasonOppositeWall: 'the opposite wall',
  reasonOtherOutline: 'other outlines and holes',
  reasonFixture: 'workholding',
  reasonMaterial: 'places with no material around them',
  reasonOther: 'other limits',
  omittedHolder: 'tool holder clearance',
  omittedFixtures: 'workholding without a readable shape',
  diagnosticThinWeb: 'The tab is no wider than the cutter, so it leaves almost no web.',
  diagnosticOther: 'Could not suggest for one outline ({{code}}).',
  refuseMissing: 'This operation no longer exists.',
  refuseNotContour: 'Suggest tab locations works on Contour operations only.',
  refuseOpen: 'Suggest tab locations works on closed contours; this one is open.',
  refuseRoughing: 'Suggest tab locations works on finish-only contours; this one roughs first, so it is not offered.',
  refuseTabsOff: 'Turn holding tabs on first.',
  refuseGenerateFirst: 'Generate this operation first: suggestions are placed on its finish path.',
  refuseStale: 'The operation changed since it was generated. Generate again to suggest.',
  refuseAllHandPlaced: 'Every outline already has hand-placed tabs. Reset to even spacing first to get suggestions.',
  refuseChanged: 'Something changed, so the suggestions were worked out again. Review them and apply again.',
  refuseNothingFound: 'No location fits, so there is nothing to apply.',
} as const

export default holdingTabs

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'holding-tabs.wo3220': typeof holdingTabs
  }
}
