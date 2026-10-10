import type { Vec3 } from '../../types'

/**
 * Compute the group position that seats an imported part FLAT ON THE FLOOR the
 * same way STL import does: centre the part over the origin in XY and drop its
 * bottom onto the machine table (world z = 0).
 *
 * STL bakes this transform into the mesh vertices at load
 * (`CNCViewport.addSTL` translates by `-center.x, -center.y, -bbox.min.z`). A
 * STEP/B-rep part must keep its NATIVE mesh coordinates (the OCCT worker derives
 * faces/edges in shape space), so the identical seat is expressed as the part
 * GROUP's `position` instead — exactly the representation the "Drop to floor"
 * placement tool already produces for a moved part. The stored boundingBox stays
 * native; world extent = boundingBox transformed by this position.
 *
 * @param min native bounding-box minimum corner (mm)
 * @param max native bounding-box maximum corner (mm)
 * @returns the part position that lands its XY centre on the origin and its
 *   bottom face on z = 0
 */
export function seatedPositionFromBounds(min: Vec3, max: Vec3): Vec3 {
  // Normalise -0 -> 0: a part already centred on an axis yields -0 here, which
  // is numerically zero but trips strict (Object.is) equality and reads oddly in
  // a serialized position. Keep stored coords clean.
  const norm = (n: number) => (n === 0 ? 0 : n)
  return {
    x: norm(-(min.x + max.x) / 2),
    y: norm(-(min.y + max.y) / 2),
    z: norm(-min.z),
  }
}
