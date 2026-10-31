// WO-3227: the Programmed cut group in Tool Library > Cutting Data - its two
// inputs, its results, the rubbing note, the one-line trust sentence and the
// one-line reasons a result has no value.
const words = {
  title: 'Programmed cut',
  depthOfCut: 'Depth of cut (ap)',
  stepover: 'Stepover (ae)',
  engagementAngle: 'Engagement angle',
  maxChip: 'Max chip thickness',
  meanChip: 'Mean chip thickness',
  removalRate: 'Removal rate',
  degrees: '°',
  removalUnitMm: 'cm³/min',
  removalUnitInch: 'in³/min',
  rubbing: 'The max chip is thinner than {{value}}: the edge may rub rather than cut.',
  trust: 'This estimates the programmed cut; actual engagement, tool stiffness and holding strength have not been verified.',
  notApplicableShape: 'This calculator models a flat end mill cutting on its side; the model does not apply to this cutter.',
  notApplicableDepth: 'The depth of cut is longer than the flute length; the model does not apply.',
  needsNumbers: 'needs a usable diameter, speed, feed, depth and stepover',
  needsSpindle: 'needs a spindle speed and flutes',
  noContact: 'no stepover, no contact',
  stepoverOverDiameter: 'stepover is wider than the diameter',
}

export default words

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'tool-cut-calculator.wo3227': typeof words
  }
}
