// cam3d integration (L6 bridge): app Tool -> kernel CutterSpec.
//
// This is the sanctioned crossing from the app's tool vocabulary
// (src/types Tool/ToolType) into the cam3d kernel's radial-profile CutterSpec
// (kernel/types.ts). Strategy/kernel code never imports src/types; the
// integration layer owns this one translation.
//
// ADR-0003 (no silent fallback): a tool the parallel-finish strategy cannot
// faithfully represent must FAIL LOUD with a named error, never be quietly
// coerced into the nearest cutter (which would cut the wrong surface).

import type { CutterSpec } from '../kernel/types';
import type { Tool } from '../../types';

/**
 * Thrown when a Tool's type has no faithful CutterSpec for a parallel_3d
 * finish. Named so callers (and tests) can switch on it and the store can
 * surface a clear, actionable message.
 */
export class UnsupportedCutterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCutterError';
  }
}

/**
 * Map an app Tool to a cam3d CutterSpec for the parallel finishing strategy.
 *
 * Supported: flat_end_mill -> flat, ball_end_mill -> ball,
 * bull_nose -> bull/toroid (needs a corner radius), v_bit -> vbit/cone
 * (WO-1971; angle from the axis plus optional tip flat). Every other tool
 * type (drill, chamfer_mill, ...) fails loud: the 3D kernel does not yet
 * model their profiles, and a silent substitution would gouge.
 */
export function toolToCutterSpec(tool: Tool): CutterSpec {
  const diameter = tool.diameter;
  if (!(diameter > 0) || !Number.isFinite(diameter)) {
    throw new UnsupportedCutterError(
      `parallel_3d cannot use tool "${tool.name}": diameter must be a positive finite number (got ${diameter}).`,
    );
  }

  switch (tool.type) {
    case 'flat_end_mill':
      return { kind: 'flat', diameter };
    case 'ball_end_mill':
      return { kind: 'ball', diameter };
    case 'bull_nose': {
      const cornerRadius = tool.cornerRadius;
      if (cornerRadius === undefined || !(cornerRadius > 0) || !Number.isFinite(cornerRadius)) {
        throw new UnsupportedCutterError(
          `parallel_3d cannot use bull-nose tool "${tool.name}": it needs a positive cornerRadius ` +
            `(got ${cornerRadius}).`,
        );
      }
      if (cornerRadius > diameter / 2 + 1e-9) {
        throw new UnsupportedCutterError(
          `parallel_3d cannot use bull-nose tool "${tool.name}": cornerRadius ${cornerRadius} exceeds ` +
            `the tool radius ${diameter / 2}.`,
        );
      }
      return { kind: 'bull', diameter, cornerRadius };
    }
    case 'v_bit': {
      // Absent angle: the same 59 deg default the tool drawing uses
      // (toolHalfAngleRad), so the cut matches the tool the operator sees.
      const angleFromAxisDeg = tool.angleFromAxisDeg ?? 59;
      if (!Number.isFinite(angleFromAxisDeg) || angleFromAxisDeg <= 0 || angleFromAxisDeg >= 90) {
        throw new UnsupportedCutterError(
          `3D operations cannot use V-bit "${tool.name}": its angle from the tool axis must be between 0 and ` +
            `90 degrees (got ${angleFromAxisDeg}).`,
        );
      }
      const tipDiameter = tool.tipDiameter ?? 0;
      if (!Number.isFinite(tipDiameter) || tipDiameter < 0 || tipDiameter >= diameter) {
        throw new UnsupportedCutterError(
          `3D operations cannot use V-bit "${tool.name}": its tip flat (${tipDiameter} mm) must be smaller ` +
            `than its diameter (${diameter} mm).`,
        );
      }
      return tipDiameter > 0
        ? { kind: 'vbit', diameter, angleFromAxisDeg, tipDiameter }
        : { kind: 'vbit', diameter, angleFromAxisDeg };
    }
    default:
      throw new UnsupportedCutterError(
        `parallel_3d does not yet support ${tool.type} cutters (tool "${tool.name}"). ` +
          `Use a flat, ball or bull-nose end mill, or a V-bit.`,
      );
  }
}
