// WO-3008: the kernel world model (alpha.3 A3-08, P2 parity slice). No app path
// calls it yet; the engine selector stays `current` and the app keeps reading
// stock from the viewport (getStockBoundsFromViewport).
export * from './contracts'
export * from './placement'
export * from './stock'
export * from './loops'
export * from './machine'
