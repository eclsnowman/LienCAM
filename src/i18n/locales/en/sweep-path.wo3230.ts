// WO-3230: words for sweeping along a sketch path - the Sweep dialog's
// Axis / Sketch path switch, the path list with its start and direction,
// and the one-line reasons a saved path cannot be followed.
const sweepPath = {
  pathSource: 'Path',
  modeAxis: 'Axis',
  modeSketch: 'Sketch path',
  followPath: 'Follow path',
  chain: 'Curves',
  choosePath: 'Choose an open line or arc chain',
  chainOption: '{{sketch}}: {{curves}}',
  curveLine: 'line {{id}}',
  curveArc: 'arc {{id}}',
  startsAt: 'Starts at ({{x}}, {{y}}, {{z}}) mm, heading ({{dx}}, {{dy}}, {{dz}})',
  reverse: 'Reverse',
  noChains: 'No sketch before this sweep has an open line or arc chain to follow.',
  notListed: '{{sketch}} is not listed: {{message}}',
  branched: '{{sketch}} is not listed: its curves {{curves}} branch, so they do not form one open chain.',
  savedPathUnresolved: 'The saved path cannot be followed: {{message}}',
  pathUnresolved: 'Sweep path ({{code}}): {{message}}',
  pathSketchMissing: "The path sketch {{sketchId}} does not exist at this point in the model (deleted, or rolled back past). Restore it or pick another path.",
  pathCycle: '{{sketch}} is built from {{feature}}, so it cannot be its path: that would make a loop.',
  savedAsPath: 'Sketch saved as an open path: it has no closed profile, and Sweep can follow it.',
} as const

export default sweepPath

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'sweep-path.wo3230': typeof sweepPath
  }
}
