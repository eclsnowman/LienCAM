/** Legacy values with their actual caller origins. No budget shares, unified
 * sampling policy, or achieved-error guarantee is enabled by this record. */
export function parityTolerance(input: { camTolerance: number; postArcFitTolerance?: number; inputResolutionMm?: number }) {
  const { camTolerance, postArcFitTolerance = 0.05, inputResolutionMm } = input
  if (!(camTolerance > 0) || !Number.isFinite(camTolerance) || !(postArcFitTolerance > 0) || !Number.isFinite(postArcFitTolerance)
    || (inputResolutionMm !== undefined && (!(inputResolutionMm > 0) || !Number.isFinite(inputResolutionMm)))) throw new Error('tolerance values must be positive finite mm')
  const value = (amount: number, unit: 'mm' | 'radians' | 'degrees' | 'steps/turn', origin: string) => ({ value: amount, unit, origin })
  return {
    policy: 'parity' as const,
    budget: null, // Future budget mode deliberately not implemented/selectable.
    // This is a maximum chord LENGTH, not a sagitta bound.
    importChord: value(0.5, 'mm', 'src/lib/import/dxfCurves.ts:CHORD_LEN_MM'),
    tessellationDeflection: value(camTolerance / 4, 'mm', 'src/cam3d/input/step.ts:requestedDeflection'),
    postArcFit: value(postArcFitTolerance, 'mm', input.postArcFitTolerance === undefined ? 'src/lib/post/emit.ts:DEFAULT_ARC_TOLERANCE' : 'caller post configuration'),
    displayChord: value(0.35, 'mm', 'src/lib/cam/toolpathArcSampling.ts:DEFAULT_MAX_CHORD_MM'),
    displayAngle: value(7.5, 'degrees', 'src/lib/cam/toolpathArcSampling.ts:DEFAULT_MAX_ANGLE_DEG'),
    helix2d: value(36, 'steps/turn', 'src/lib/cam/moves/index.ts:helixDescent default sampling'),
    helixAdaptive: value(Math.PI / 16, 'radians', 'src/lib/cam/adaptiveClearing2d/engine/emit.ts:HELIX_FI_STEP'),
    helixThread: value(Math.PI / 16, 'radians', 'src/lib/cam/threadHelix.ts:HELIX_FI_STEP'),
    helix3d: value(24, 'steps/turn', 'src/cam3d/rough/emit.ts:HELIX_SEGMENTS_PER_TURN'),
    adaptivePrefit: value(Math.max(0.002, 0.25 * camTolerance), 'mm', 'src/cam3d/rough/smoothPath.ts:fitTolerance'),
    diagnostics: inputResolutionMm !== undefined && inputResolutionMm > camTolerance
      ? [`input resolution ${inputResolutionMm} mm is coarser than requested ${camTolerance} mm; achieved tolerance is not certified`] : [],
  }
}
