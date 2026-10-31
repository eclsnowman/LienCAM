// WO-3234: words for Thin in the Extrude dialog - wall thickness and side,
// the one-line summary of where the wall sits, and the builder's refusals.
const thinExtrude = {
  wall: 'Wall',
  thin: 'Thin',
  thickness: 'Thickness',
  side: 'Side',
  sideInside: 'Inside',
  sideOutside: 'Outside',
  sideCenter: 'Center',
  summaryInside: 'Thin wall {{thickness}} mm inside the sketch outline, toward the material.',
  summaryOutside: 'Thin wall {{thickness}} mm outside the sketch outline, away from the material.',
  summaryCenter: 'Thin wall {{thickness}} mm centred on the sketch outline, {{half}} mm each way.',
  endNotAvailable: '{{end}} is not available for Thin yet - choose Blind or Symmetric.',
  thicknessMustBePositive: 'Thin wall thickness must be a positive number of mm (got {{thickness}}).',
  unknownWallMode: 'Unknown extrude wall mode "{{mode}}".',
  unknownWallSide: 'Unknown thin wall side "{{side}}" - use inside, outside or center.',
} as const

export default thinExtrude

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'thin-extrude.wo3234': typeof thinExtrude
  }
}
