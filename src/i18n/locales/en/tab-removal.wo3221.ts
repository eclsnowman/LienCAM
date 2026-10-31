// WO-3221: words for Create tab removal contour in Properties > Holding tabs -
// the action, its review of the tabs and the setup's holding method, and the
// one-line reasons when it cannot make or generate the linked cleanup.
const tabRemoval = {
  action: 'Create tab removal contour',
  actionTooltip: 'Make a separate Contour that cuts these outlines to the same bottom with tabs off, removing every tab on them. This operation and its tabs are not changed.',
  reviewAll: 'All {{count}} tabs will be removed (outlines: {{outlines}}).',
  reviewTab: '{{label}} at X{{x}} Y{{y}}: {{width}} mm wide x {{height}} mm high, {{shape}}',
  shapeBox: 'box',
  shapeTriangular: 'triangular',
  reviewHolding: 'Holding method in this setup: {{method}}',
  reviewHoldingNone: 'No holding method is chosen for this setup.',
  reviewNotes: 'Setup note: {{note}}',
  reviewRetention: 'After the last tab is cut the tabs no longer hold the part. Simulation shows the cut, not that the part stays held.',
  reviewSameSetup: 'The cleanup runs in this same setup. Removing tabs from a flipped second side is not offered.',
  materialReading: 'Reading the remaining stock...',
  materialRetained: 'Remaining stock: material above the cut bottom at {{retained}} of {{count}} tabs.',
  materialUnavailable: 'Remaining stock could not be read ({{reason}}). The cleanup traces the full outline anyway.',
  create: 'Create',
  cancel: 'Cancel',
  created: 'Created {{name}}. Generate it to cut the tabs away.',
  defaultName: '{{name}} - tab removal',
  linked: 'Tab removal for {{name}}: removes all {{count}} of its tabs (outlines: {{outlines}}), cutting with tabs off.',
  refuseMissing: 'This operation no longer exists.',
  refuseNotContour: 'Create tab removal contour works on Contour operations only.',
  refuseIsCleanup: 'This is already a tab removal contour.',
  refuseOpen: 'Create tab removal contour works on closed contours; this one is open.',
  refuseTabsOff: 'This contour has no holding tabs to remove.',
  refuseGenerateFirst: 'Generate this operation first: the tabs to remove are read from its finish path.',
  refuseStale: 'The operation changed since it was generated. Generate again first.',
  refuseNoTabs: 'No outline of this contour carries tabs.',
  refuseSelective: 'Removing only some tabs is not implemented. Keep every tab selected: the cleanup removes all tabs on these outlines.',
  refuseFlipped: 'Removing tabs from a flipped second side is not offered; the cleanup runs in the source setup.',
  refuseRejected: 'The tab removal contour could not be added, so nothing was changed.',
  computeBindingMalformed: 'This tab removal contour\'s link to its source cannot be read, so it is not generated. Create it again from the tabbed contour.',
  computeSourceMissing: 'The tabbed contour this tab removal contour was made from no longer exists, so it is not generated.',
  computeSourceOtherSetup: 'This tab removal contour is not in the setup of the tabbed contour it was made from, so it is not generated.',
  computeSourceAfter: 'This tab removal contour is above the tabbed contour it was made from. Move it below that contour to generate it.',
  computeSourceDisabled: 'The tabbed contour this tab removal contour was made from is suppressed, so it is not generated.',
  computeSourceChanged: 'The tabbed contour this tab removal contour was made from has changed its outline, tabs, heights or tool. Create the tab removal contour again from it.',
  computeCleanupChanged: 'This tab removal contour no longer cuts its source\'s outlines with its tool and side, tabs off, so it is not generated. Create it again from the tabbed contour.',
} as const

export default tabRemoval

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'tab-removal.wo3221': typeof tabRemoval
  }
}
