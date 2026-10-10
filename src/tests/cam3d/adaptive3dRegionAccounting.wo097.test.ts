// WO-097: adaptive-region accounting must describe regions the cutter can
// actually machine, not every pre-offset stock/part polygon component.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { resolveSamplePartPath } from '../../cam3d/input/fixturePaths';
import {
  importStepToPartMesh,
  makeOcctCoreTessellator,
} from '../../cam3d/input';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterSpec, MeshHandle, PartMesh } from '../../cam3d/kernel/types';
import type { Box3 } from '../../cam3d/stock';
import {
  adaptiveRough,
  adaptiveRoughCompletionError,
  type AdaptiveRoughInput,
} from '../../cam3d/strategies/adaptiveRough';
import {
  loadOcctModel,
  _resetOcctModelForTest,
  type OcctModelModule,
} from '../../lib/cam/geometry/occt/model/loader';
import type { AdaptiveRoughDiagnostics } from '../../types';

const here = dirname(fileURLToPath(import.meta.url));
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm');
const cutter: CutterSpec = { kind: 'flat', diameter: 9.52 };
const cellSize = cutter.diameter / 12;

let oc: OcctModelModule;
let mesh: PartMesh;
let kernel: BvhKernel;

beforeAll(async () => {
  _resetOcctModelForTest();
  oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
  const source = readFileSync(resolveSamplePartPath('Step Test With Holes.step'));
  const bytes = new ArrayBuffer(source.byteLength);
  new Uint8Array(bytes).set(source);
  mesh = (await importStepToPartMesh(bytes, {
    camTolerance: 0.05,
    tessellator: makeOcctCoreTessellator(oc),
  })).mesh;
  kernel = new BvhKernel();
}, 120_000);

function centeredStockBounds(part: PartMesh): Box3 {
  const centerX = (part.bounds.min[0] + part.bounds.max[0]) / 2;
  const centerY = (part.bounds.min[1] + part.bounds.max[1]) / 2;
  return {
    minX: centerX - 50,
    minY: centerY - 50,
    minZ: part.bounds.min[2],
    maxX: centerX + 50,
    maxY: centerY + 50,
    maxZ: part.bounds.max[2] + 1,
  };
}

function inputFor(handle: MeshHandle, stockBounds: Box3, fullStock: boolean): AdaptiveRoughInput {
  return {
    mesh: handle,
    cutter,
    stockBounds,
    stockBoundsAreRealStock: true,
    cellSize,
    // WO-408: 3 -> 15 (part 5 levels / full stock 7 -> 2 / 3, the planner still
    // pins the part's flat floors). The accounting question is per region and
    // the sub-tool hole candidates exist at every level of this through-holed
    // part; the level count carried no part of it. Note: every run here is TWO
    // roughs - the retained-model probe collides at the small probe and the
    // strategy retries at the full probe (product behaviour, not the test's).
    maxStepdown: 15,
    stepover: 0.4,
    tolerance: 0.05,
    helixDiameter: 3,
    helixAngleDeg: 10,
    radialStockToLeave: 0,
    axialStockToLeave: 0,
    heights: { clearanceZ: stockBounds.maxZ + 5, retractZ: stockBounds.maxZ + 2, feedZ: stockBounds.maxZ + 2 },
    materialTopZ: stockBounds.maxZ,
    ...(fullStock ? { reachStockEdgeBy: cutter.diameter / 2 } : {}),
  };
}

async function runCase(stockBounds: Box3, fullStock: boolean): Promise<AdaptiveRoughDiagnostics> {
  const handle = kernel.uploadMesh(mesh);
  let diagnostics: AdaptiveRoughDiagnostics | undefined;
  try {
    const ir = await adaptiveRough(kernel, inputFor(handle, stockBounds, fullStock), {
      onDiagnostics: (result) => { diagnostics = result.adaptiveRough; },
    });
    expect(ir.moves.length).toBeGreaterThan(0);
  } finally {
    kernel.releaseMesh(handle);
  }
  expect(diagnostics).toBeDefined();
  return diagnostics!;
}

function expectHonestAccounting(diagnostics: AdaptiveRoughDiagnostics): void {
  expect(diagnostics.plannedRegions).toBe(
    diagnostics.machinedRegions + diagnostics.skippedRegions,
  );
  expect(diagnostics.issues).toHaveLength(
    diagnostics.skippedRegions + diagnostics.partialRegions,
  );
  expect(diagnostics.issues.every((issue) => issue.reason.trim().length > 0)).toBe(true);
  expect(Object.values(diagnostics.reasonCounts).reduce((sum, count) => sum + count, 0)).toBe(
    diagnostics.skippedRegions + diagnostics.partialRegions,
  );
  expect(diagnostics.reasonCounts['no-cut-region']).toBeUndefined();
  expect(diagnostics.skippedRegions).toBe(0);
  expect(adaptiveRoughCompletionError(diagnostics)).toBeUndefined();
}

describe('WO-097 adaptive-region accounting', () => {
  // WO-408: the part-only and full-stock cases are separate tests (they share
  // nothing but the mesh) so each is one rough, not two in one timeout.
  it('does not report sub-tool candidates as skipped regions on Operator\'s part (part-bounds stock)', { timeout: 120_000 }, async () => {
    const partBounds: Box3 = {
      minX: mesh.bounds.min[0],
      minY: mesh.bounds.min[1],
      minZ: mesh.bounds.min[2],
      maxX: mesh.bounds.max[0],
      maxY: mesh.bounds.max[1],
      maxZ: mesh.bounds.max[2],
    };
    const partOnly = await runCase(partBounds, false);
    // eslint-disable-next-line no-console
    console.log(
      `WO-097 accounting (part bounds, ${partOnly.levelCount} levels): ` +
        `${partOnly.machinedRegions}/${partOnly.plannedRegions}, skipped ${partOnly.skippedRegions}`,
    );
    expectHonestAccounting(partOnly);
  });

  // WO-410 (re-pinned 2026-08-21): 120_000 -> 450_000. The honest-belief contract (FOLD:
  // only real travel is folded into `cleared`; residualMaxInscribedR measured to 1.5x R so
  // the fail-loud abort is reachable) makes this full-stock rough MACHINE the tool-enterable
  // leftovers the phantom disk used to hide (11 extra entries on the WO-410 fix5 evidence),
  // plus WO-409 pecked keep-down links. Measured 164s isolated, 164-356s alongside the file's
  // other tests/concurrent load at HEAD (was <120s pre-landing) -- two independent runs both
  // finite and still progressing (never hung), so this is more real work under contention, not
  // a runaway; 450s gives real headroom over the worst measured run.
  //
  // NOT a full re-pin: with the timeout no longer the limiter, this test still fails --
  // now on a RetainedModelCollisionError ("retained-model collision refused on move 4606:
  // commanded tool tip requires Z >= -0.4950 for the conservative cutter envelope",
  // src/cam3d/strategies/adaptiveRough.ts:302 assertMovesClearRetainedModel/validateMoves).
  // roughGateA.test.ts's Gate A.5 hit the SAME error class from the SAME source function on a
  // different fixture (see that file's own WO-410 investigation) -- two independent fixtures,
  // one code path. This does not trace to a named WO-410 contract point as an intended
  // consequence; left red and reported as a possible real, systemic collision-refusal
  // regression rather than re-pinned or masked.
  it('does not report sub-tool candidates as skipped regions on the full-stock case (10 mm ring, reach = R)', { timeout: 450_000 }, async () => {
    const fullStock = await runCase(centeredStockBounds(mesh), true);
    // eslint-disable-next-line no-console
    console.log(
      `WO-097 accounting (full stock, ${fullStock.levelCount} levels): ` +
        `${fullStock.machinedRegions}/${fullStock.plannedRegions}, skipped ${fullStock.skippedRegions}`,
    );
    expectHonestAccounting(fullStock);
  });

  it('names a majority-skip refusal instead of allowing a clean completion', () => {
    const diagnostics: AdaptiveRoughDiagnostics = {
      effectiveCellSize: 0.5,
      toolDiameter: 10,
      helixDiameter: 3,
      levelCount: 1,
      plannedRegions: 5,
      machinedRegions: 2,
      skippedRegions: 3,
      partialRegions: 0,
      reasonCounts: { 'no-start-point': 3 },
      issues: [],
    };

    expect(adaptiveRoughCompletionError(diagnostics)).toBe(
      '3 of 5 machinable adaptive regions produced no toolpath ' +
        '(no-start-point: 3); refusing a clean completion',
    );
    expect(adaptiveRoughCompletionError({
      ...diagnostics,
      machinedRegions: 3,
      skippedRegions: 2,
      reasonCounts: { 'no-start-point': 2 },
    })).toBeUndefined();
  });
});
