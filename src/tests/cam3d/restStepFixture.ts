import type { PartMesh } from '../../cam3d/kernel/types';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';

export const REST_FIXTURE = {
  sizeX: 70,
  sizeY: 50,
  topZ: 12,
  floorZ: 4,
  regions: [
    { name: 'five-mm-slot', x0: 10, x1: 30, y0: 10, y1: 15 },
    { name: 'four-mm-slot', x0: 40, x1: 60, y0: 30, y1: 34 },
  ],
  referenceReachableRegion: { name: 'twelve-mm-pocket', x0: 10, x1: 35, y0: 30, y1: 42 },
} as const;

export function restStepFixture(): PartMesh {
  const { sizeX, sizeY, topZ, floorZ, regions, referenceReachableRegion } = REST_FIXTURE;
  const allRegions = [...regions, referenceReachableRegion];
  const xs = [...new Set([0, ...allRegions.flatMap(region => [region.x0, region.x1]), sizeX])].sort((a, b) => a - b);
  const ys = [...new Set([0, ...allRegions.flatMap(region => [region.y0, region.y1]), sizeY])].sort((a, b) => a - b);
  const inSlot = (x: number, y: number): boolean => allRegions.some(region =>
    x > region.x0 && x < region.x1 && y > region.y0 && y < region.y1);
  const builder = new MeshBuilder();
  const pocket: boolean[][] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    pocket[i] = [];
    for (let j = 0; j < ys.length - 1; j++) {
      pocket[i][j] = inSlot((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2);
      const z = pocket[i][j] ? floorZ : topZ;
      builder.quad(
        builder.vertex(xs[i], ys[j], z), builder.vertex(xs[i + 1], ys[j], z),
        builder.vertex(xs[i + 1], ys[j + 1], z), builder.vertex(xs[i], ys[j + 1], z),
      );
    }
  }
  const wall = (ax: number, ay: number, bx: number, by: number, px: number, py: number): void => {
    const dot = (by - ay) * (px - (ax + bx) / 2) - (bx - ax) * (py - (ay + by) / 2);
    const loA = builder.vertex(ax, ay, floorZ), loB = builder.vertex(bx, by, floorZ);
    const hiA = builder.vertex(ax, ay, topZ), hiB = builder.vertex(bx, by, topZ);
    if (dot >= 0) builder.quad(loA, loB, hiB, hiA);
    else builder.quad(hiA, hiB, loB, loA);
  };
  for (let i = 0; i < xs.length - 2; i++) for (let j = 0; j < ys.length - 1; j++) {
    if (pocket[i][j] === pocket[i + 1][j]) continue;
    const x = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
    wall(x, y0, x, y1, pocket[i][j] ? (xs[i] + x) / 2 : (x + xs[i + 2]) / 2, (y0 + y1) / 2);
  }
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 2; j++) {
    if (pocket[i][j] === pocket[i][j + 1]) continue;
    const y = ys[j + 1], x0 = xs[i], x1 = xs[i + 1];
    wall(x0, y, x1, y, (x0 + x1) / 2, pocket[i][j] ? (ys[j] + y) / 2 : (y + ys[j + 2]) / 2);
  }
  const bottom = [
    builder.vertex(0, 0, 0), builder.vertex(sizeX, 0, 0),
    builder.vertex(sizeX, sizeY, 0), builder.vertex(0, sizeY, 0),
  ];
  const top = [
    builder.vertex(0, 0, topZ), builder.vertex(sizeX, 0, topZ),
    builder.vertex(sizeX, sizeY, topZ), builder.vertex(0, sizeY, topZ),
  ];
  builder.quad(bottom[0], bottom[3], bottom[2], bottom[1]);
  for (let i = 0; i < 4; i++) builder.quad(bottom[i], bottom[(i + 1) % 4], top[(i + 1) % 4], top[i]);
  return builder.build();
}
