// WO-3188: the one line Heights shows when an operation's outline is plain 2D
// (DXF/SVG/sketch) and carries no height, so a height is assumed.
const heights2dSource = {
  chamferAssumed: 'This outline has no height of its own: the chamfer starts at the top of the material at this spot. Pick Stock top, Stock bottom or an offset here to place it.',
  geometryAssumed: 'This outline has no height of its own: Geometry is the plane it lies on, Z {{z}} {{unit}}. Pick Stock top, Stock bottom or an offset here to place the cut.',
} as const

export default heights2dSource

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'heights-2d-source.wo3188': typeof heights2dSource
  }
}
