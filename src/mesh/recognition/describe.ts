// WO-1846: how a proved feature reads in the properties panel and the console.
//
// Plain words, the numbers Operator would measure with a pair of calipers, and no
// jargon: "6.00 mm through hole, 12.00 deep". The fit error is a separate,
// stated number - it is not folded into the diameter and it is not hidden.

import type { RecognizedFeature } from './types';

const KIND_WORDS: Record<RecognizedFeature['kind'], string> = {
  'through-hole': 'through hole',
  'blind-hole': 'blind hole',
  boss: 'boss',
  counterbore: 'counterbore',
  countersink: 'countersink',
  'chamfered-hole': 'chamfered hole',
};

const mm = (value: number): string => value.toFixed(2);

/** The diameters of a feature, in axial order, as one phrase. */
export function featureDiameterText(feature: RecognizedFeature): string {
  if (feature.kind === 'counterbore') {
    const sorted = [...feature.diametersMm].sort((a, b) => b - a);
    return `${mm(sorted[0])} down to ${mm(sorted[sorted.length - 1])} mm`;
  }
  if (feature.kind === 'countersink' || feature.kind === 'chamfered-hole') {
    const biggest = Math.max(...feature.diametersMm);
    return `${mm(feature.diameterMm)} mm bore, ${mm(biggest)} mm at the face`;
  }
  return `${mm(feature.diameterMm)} mm`;
}

/** One line naming THIS feature. */
export function describeFeature(feature: RecognizedFeature): string {
  const angle = feature.bands.find((b) => b.surface === 'cone')?.includedAngleDeg;
  // The included angle IS 2*atan(slope): a 90 degree countersink opens 1 mm
  // of radius per 1 mm of depth.
  const cone = angle === undefined ? '' : `, ${angle.toFixed(0)} degree`;
  // A boss stands proud of the face, so it is TALL; everything else here is cut
  // into the face and is DEEP. Same measured number, the word the operator uses.
  const extent = feature.kind === 'boss' ? 'tall' : 'deep';
  return `${feature.profile === 'spherical-cap' ? 'dome' : KIND_WORDS[feature.kind]} ${featureDiameterText(feature)}${cone}, ${mm(feature.depthMm)} mm ${extent}`;
}
