// Shared catalog used by both the standalone Node planner and phone client.
// WO-2809: each feature routine runs the machine Probing screen's routine
// (corner = its Inside corner, front-left), from the top, as the operator approved.
export const PROBE_ROUTINES = [
  { id: 'bore', name: 'Bore Center (Inside)', desc: 'Find center & diameter of round hole/pocket', touches: 4 },
  { id: 'boss', name: 'Boss Center (Outside)', desc: 'Find center & diameter of circular protrusion', touches: 4 },
  { id: 'edge', name: 'Single Edge (X/Y)', desc: 'Find X or Y workpiece edge with tip offset', touches: 1 },
  { id: 'corner', name: 'Inside Corner (2-Touch)', desc: 'Find the front-left inside corner of a pocket', touches: 2 },
  { id: 'zSurface', name: 'Z Surface Touch', desc: 'Find top surface Z or measure tool offset', touches: 1 },
  { id: 'rectPocket', name: 'Rect Pocket Center', desc: 'Find center & size of internal rectangle', touches: 4 },
  { id: 'rectBoss', name: 'Rect Boss Center', desc: 'Find center & size of external rectangle', touches: 4 },
  { id: 'angle', name: 'Angle / Yaw Alignment', desc: 'Measure part rotation angle along an edge', touches: 2 },
];

/** The Probing screen's own setup defaults the phone runs with (WO-2063). */
export const SCREEN_START_WITHIN_MM = 10;
export const SCREEN_TOP_SEARCH_MM = 25;

const mm = (v) => `${Number(v.toFixed(1))} mm`;

// The screen's face and corner names (probeScene.ts faceName / cornerName).
function faceName(axis, direction, inside) {
  const plus = axis === 'X' ? (inside ? 'right' : 'left') : (inside ? 'back' : 'front');
  const minus = axis === 'X' ? (inside ? 'left' : 'right') : (inside ? 'front' : 'back');
  return `${direction === '+' ? plus : minus} ${inside ? 'wall' : 'face'}`;
}

/**
 * WO-2809: the phone's first step - where to put the probe - in the Probing
 * screen's own words (probeScene.ts whereSentence) for the same setup. Z
 * surface is the phone's own touch and keeps its own sentence.
 */
export function firstStepSentence(routineId, {
  edgeAxis = 'X',
  edgeDirection = '+',
  wcs = 'G54',
  clearanceMm = 5,
  startWithinMm = SCREEN_START_WITHIN_MM,
  topSearchMm = SCREEN_TOP_SEARCH_MM,
  topFromWorkZero = false,
  cornerXDirection = '-',
  cornerYDirection = '-',
} = {}) {
  const above = `less than ${mm(topSearchMm)} above the top`;
  const setZ0 = `Set part Z0 (${wcs}), then jog`;
  switch (routineId) {
    case 'edge':
      return `Jog the probe over the stock, within ${mm(startWithinMm)} of the ${faceName(edgeAxis, edgeDirection, false)}, ${above}.`;
    case 'angle':
      return `Jog over the stock within ${mm(startWithinMm)} of the ${faceName(edgeAxis === 'X' ? 'Y' : 'X', edgeDirection, false)}, at point 1, ${above}.`;
    case 'corner':
      return `${setZ0} over the ${cornerYDirection === '-' ? 'front' : 'back'}-${cornerXDirection === '-' ? 'left' : 'right'} corner of the pocket, within ${mm(clearanceMm)} of both walls, above the top.`;
    case 'bore':
      return `${setZ0} over the middle of the bore, above the top.`;
    case 'rectPocket':
      return `${setZ0} over the middle of the pocket, above the top.`;
    case 'boss':
    case 'rectBoss':
      return `${topFromWorkZero ? setZ0 : 'Jog'} over the middle of the boss, ${topFromWorkZero ? 'above the top' : above}.`;
    default:
      return 'Jog the probe over the surface. It probes straight down.';
  }
}
