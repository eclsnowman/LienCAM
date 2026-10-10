import { describe, expect, it } from 'vitest';

import { adaptiveRoughCompletionError } from '../../cam3d/strategies/adaptiveRough';
import type { AdaptiveRoughDiagnostics } from '../../types';

describe('WO-130 cutter-erased region accounting', () => {
  it('refuses a clean completion when the tool fits no candidate region', () => {
    const diagnostics = {
      effectiveCellSize: 0.5,
      toolDiameter: 20,
      helixDiameter: 3,
      levelCount: 1,
      plannedRegions: 0,
      machinedRegions: 0,
      skippedRegions: 0,
      partialRegions: 0,
      cutterErasedRegions: 4,
      reasonCounts: {},
      issues: [],
    } satisfies AdaptiveRoughDiagnostics;

    expect(adaptiveRoughCompletionError(diagnostics)).toBe(
      '4 adaptive regions could not fit the selected tool; refusing a clean completion',
    );
  });

  it('keeps cutter-erased remnants informational when another region was machined', () => {
    const diagnostics = {
      effectiveCellSize: 0.5,
      toolDiameter: 20,
      helixDiameter: 3,
      levelCount: 1,
      plannedRegions: 1,
      machinedRegions: 1,
      skippedRegions: 0,
      partialRegions: 0,
      cutterErasedRegions: 4,
      reasonCounts: {},
      issues: [],
    } satisfies AdaptiveRoughDiagnostics;

    expect(adaptiveRoughCompletionError(diagnostics)).toBeUndefined();
  });
});
