import { describe, expect, it } from 'vitest';
import type {
  CutterHandle, CutterSpec, GeometryKernel, GridSpec, MeshHandle, PartMesh,
} from '../../cam3d/kernel/types';
import { pencilFinish } from '../../cam3d/strategies/pencil';

const BULL: CutterSpec = { kind: 'bull', diameter: 12, cornerRadius: 1 };
const TOLERANCE = 0.5;
const MESH = 1 as MeshHandle;
const HEIGHTS = { clearanceZ: 20, retractZ: 18, feedZ: 15 };
const BOUNDS = { minX: 0, minY: 0, maxX: 6, maxY: 4 };

type SyntheticMode = 'analytic-slope' | 'depth-gap';

/**
 * The ridge grid drives pencil's topology stage while dropPoints supplies the
 * independently known exact surface used to verify the final cutter drop.
 * Recording cutter specs makes a ball-for-bull substitution observable even
 * when its numeric result happens to remain collision-free on a fixture.
 */
class SyntheticPencilKernel implements GeometryKernel {
  readonly name = 'wo1195-synthetic';
  readonly madeCutters: CutterSpec[] = [];
  private readonly cutters = new Map<number, CutterSpec>();
  private readonly mode: SyntheticMode;
  private readonly slope: number;
  private readonly rejectBull: boolean;
  private nextCutter = 1;

  constructor(mode: SyntheticMode, slope = 0, rejectBull = false) {
    this.mode = mode;
    this.slope = slope;
    this.rejectBull = rejectBull;
  }

  uploadMesh(_mesh: PartMesh): MeshHandle { return MESH; }
  releaseMesh(_mesh: MeshHandle): void {}

  makeCutter(spec: CutterSpec): CutterHandle {
    if (this.rejectBull && spec.kind === 'bull') throw new Error('synthetic kernel has no bull profile');
    const handle = this.nextCutter++;
    this.madeCutters.push(spec);
    this.cutters.set(handle, spec);
    return handle as CutterHandle;
  }

  releaseCutter(handle: CutterHandle): void { this.cutters.delete(handle); }

  async dropGrid(
    _mesh: MeshHandle,
    cutter: CutterHandle,
    grid: GridSpec,
    opts?: { signal?: AbortSignal; onProgress?: (fraction: number) => void; surfaceZ?: Float64Array },
  ): Promise<Float64Array> {
    const spec = this.cutter(cutter);
    const lift = this.profileLift(spec);
    const z = new Float64Array(grid.nx * grid.ny);
    const ridgeY = Math.floor(grid.ny / 2);
    for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
      const index = iy * grid.nx + ix;
      const surface = this.slope * (grid.x0 + ix * grid.dx);
      opts?.surfaceZ?.set([surface], index);
      const onRidge = iy === ridgeY && ix > 0 && ix < grid.nx - 1;
      z[index] = surface + lift + (onRidge ? 1 : 0);
    }
    opts?.onProgress?.(1);
    return z;
  }

  dropPath(
    mesh: MeshHandle,
    cutter: CutterHandle,
    xy: Float64Array,
    zSeed: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Float64Array> {
    return this.dropPoints(mesh, cutter, xy, zSeed, opts);
  }

  async dropPoints(
    _mesh: MeshHandle,
    cutter: CutterHandle,
    xy: Float64Array,
    _zSeed: number,
    _opts?: { signal?: AbortSignal },
  ): Promise<Float64Array> {
    const spec = this.cutter(cutter);
    const z = new Float64Array(xy.length / 2);
    for (let i = 0; i < z.length; i++) {
      const x = xy[2 * i];
      z[i] = this.mode === 'depth-gap'
        ? (x > 2.25 && x < 3.75 ? 0 : 2)
        : this.slope * x + this.profileLift(spec);
    }
    return z;
  }

  private cutter(handle: CutterHandle): CutterSpec {
    const spec = this.cutters.get(handle as number);
    if (!spec) throw new Error(`unknown synthetic cutter ${handle}`);
    return spec;
  }

  private profileLift(spec: CutterSpec): number {
    const normalLift = Math.hypot(1, this.slope) - 1;
    if (spec.kind === 'ball') return spec.diameter / 2 * normalLift;
    if (spec.kind === 'bull') {
      const flatRadius = spec.diameter / 2 - spec.cornerRadius;
      return spec.cornerRadius * normalLift + flatRadius * Math.abs(this.slope);
    }
    return 0;
  }
}

describe('WO-1195 pencil bull profile and finish-depth split', () => {
  for (const angleDeg of [15, 35]) {
    it(`drops a bull cutter on a ${angleDeg} degree plane at the analytic Minkowski height`, async () => {
      const slope = Math.tan(angleDeg * Math.PI / 180);
      const kernel = new SyntheticPencilKernel('analytic-slope', slope);
      const pencil = await pencilFinish(kernel, {
        mesh: MESH, cutter: BULL, tolerance: TOLERANCE, direction: 'climb',
        xyBounds: BOUNDS, heights: HEIGHTS, zSeed: -10,
      });
      const cornerRadius = BULL.kind === 'bull' ? BULL.cornerRadius : 0;
      const flatRadius = BULL.diameter / 2 - cornerRadius;
      const ballLift = cornerRadius * (Math.hypot(1, slope) - 1);
      const bullLift = ballLift + flatRadius * Math.abs(slope);
      const cutMoves = pencil.moves.filter(move => move.role === 'cut');
      const maxFixedError = Math.max(...cutMoves.map(move =>
        Math.abs(move.z - (slope * move.x + bullLift))));
      const ballSubstitutionError = bullLift - ballLift;

      console.log(`WO-1195 bull slope ${angleDeg}deg: fixed error=${maxFixedError.toFixed(6)} mm; `
        + `ball substitution below by=${ballSubstitutionError.toFixed(6)} mm; tolerance=${TOLERANCE}`);
      expect(kernel.madeCutters).toEqual([
        { kind: 'ball', diameter: cornerRadius * 2 },
        BULL,
      ]);
      expect(ballSubstitutionError).toBeGreaterThan(TOLERANCE);
      expect(maxFixedError).toBeLessThanOrEqual(TOLERANCE);
    });
  }

  it('refuses bull cutters plainly when the active kernel cannot model their drop', async () => {
    const kernel = new SyntheticPencilKernel('analytic-slope', 0.25, true);
    await expect(pencilFinish(kernel, {
      mesh: MESH, cutter: BULL, tolerance: TOLERANCE, direction: 'climb',
      xyBounds: BOUNDS, heights: HEIGHTS, zSeed: -10,
    })).rejects.toThrow('pencilFinish: bull-nose drop is unavailable in the active geometry kernel');
  });

  it('splits a track whose middle falls below the finish depth and delegates its connector', async () => {
    const kernel = new SyntheticPencilKernel('depth-gap');
    const pencil = await pencilFinish(kernel, {
      mesh: MESH, cutter: { kind: 'ball', diameter: 2 }, tolerance: TOLERANCE,
      minFinishZ: 1, direction: 'climb', xyBounds: BOUNDS, heights: HEIGHTS, zSeed: -10,
    });
    const cuttingSpansGap = pencil.moves.some((move, index) => {
      if (index === 0 || move.role !== 'cut' || pencil.moves[index - 1].role !== 'cut') return false;
      const previous = pencil.moves[index - 1];
      return Math.min(previous.x, move.x) <= 2.25 && Math.max(previous.x, move.x) >= 3.75;
    });
    const lastLeftCut = pencil.moves.findLastIndex(move => move.role === 'cut' && move.x <= 2.25);
    const firstRightCut = pencil.moves.findIndex((move, index) =>
      index > lastLeftCut && move.role === 'cut' && move.x >= 3.75);
    const connectorMoves = pencil.moves.slice(lastLeftCut + 1, firstRightCut);

    console.log(`WO-1195 finish-depth split: passes=${pencil.meta.params?.tracedPolylineCount}; `
      + `connector roles=${connectorMoves.map(move => move.role).join(',')}; cutting gap span=${cuttingSpansGap}`);
    expect(pencil.meta.params?.tracedPolylineCount).toBe(2);
    expect(cuttingSpansGap).toBe(false);
    expect(connectorMoves.length).toBeGreaterThan(0);
    expect(connectorMoves.every(move => move.role !== 'cut')).toBe(true);
  });
});
