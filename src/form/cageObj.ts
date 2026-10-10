import type { Cage } from './cage'

/** Keep the control polygons (including n-gons), rather than the triangulated skin.
 * OBJ has no unit or up-axis field, so document the cage's mm, Z-up convention. */
export function cageObj(cage: Cage): string {
  return [
    '# LienCAM Form control cage - millimetres, Z up',
    ...cage.positions.map(([x, y, z]) => `v ${x} ${y} ${z}`),
    ...cage.faces.map((face) => `f ${face.map((index) => index + 1).join(' ')}`),
    '',
  ].join('\n')
}
