import type { Profile } from './contracts'

// Compatibility data, not a proposal to unify numbers or enable a new policy.
export const profiles = Object.freeze({
  face: Object.freeze({ id: 'face', precision: 6, fill: 'raycast', offsetFill: 'native', arcTolerance: 0.0025, decimation: 0.0025, miterLimit: 2, orientation: 'preserve-native', origin: 'src/lib/cam/face2d/clipperOffset.ts' } satisfies Profile),
  adaptive: Object.freeze({ id: 'adaptive', precision: 4, fill: 'EvenOdd', offsetFill: 'native', arcTolerance: 0.02, decimation: null, miterLimit: 2, orientation: 'preserve-native', origin: 'src/lib/cam/adaptiveClearing2d/engine/clipperEngine.ts' } satisfies Profile),
  vcarve: Object.freeze({ id: 'vcarve', precision: 4, fill: 'NonZero', differenceFill: 'Positive', offsetFill: 'Positive', arcTolerance: 0.01, decimation: null, miterLimit: 2, orientation: 'preserve-native', origin: 'src/lib/cam/vcarve2d/clipper.ts' } satisfies Profile),
  cam3d: Object.freeze({ id: 'cam3d', precision: 6, fill: 'NonZero', offsetFill: 'native', arcTolerance: 0.02, decimation: null, miterLimit: 2, orientation: 'preserve-native', origin: 'src/cam3d/geom2d/index.ts' } satisfies Profile),
  script: Object.freeze({ id: 'script', precision: null, fill: 'raycast', offsetFill: 'script', arcTolerance: null, decimation: null, miterLimit: 4, orientation: 'preserve-native', origin: 'src/lib/cam/geometry/index.ts' } satisfies Profile),
})
