// Shared catalog used by both the standalone Node planner and phone client.
export const PROBE_ROUTINES = [
  { id: 'bore', name: 'Bore Center (Inside)', desc: 'Find center & diameter of round hole/pocket', touches: 4 },
  { id: 'boss', name: 'Boss Center (Outside)', desc: 'Find center & diameter of circular protrusion', touches: 4 },
  { id: 'edge', name: 'Single Edge (X/Y)', desc: 'Find X or Y workpiece edge with tip offset', touches: 1 },
  { id: 'corner', name: 'Corner (2-Touch)', desc: 'Find inside or outside corner (NW/NE/SW/SE)', touches: 2 },
  { id: 'zSurface', name: 'Z Surface Touch', desc: 'Find top surface Z or measure tool offset', touches: 1 },
  { id: 'rectPocket', name: 'Rect Pocket Center', desc: 'Find center & size of internal rectangle', touches: 4 },
  { id: 'rectBoss', name: 'Rect Boss Center', desc: 'Find center & size of external rectangle', touches: 4 },
  { id: 'angle', name: 'Angle / Yaw Alignment', desc: 'Measure part rotation angle along an edge', touches: 2 },
];
