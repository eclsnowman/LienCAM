import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { liencamCommands } from '../agent/commands'
import type {
  Sketch,
  SketchEntity,
  SketchConstraint,
  SketchDimension,
  DistanceDimension,
} from './types'

// ============================================================
// Dev-only demo sketch seed (Stage 2 gate tooling)
// ============================================================
//
// Diagnostic-input visualization: rendering/selection land BEFORE drawing
// tools exist (Stage 3), so this seed fabricates a sketch that exercises
// every Stage 2 render feature:
//   - fully-defined rectangle (coincident corners, H/V, 2 driving dims,
//     fixed corner)
//   - under-defined circle + line tangent to it
//   - an arc, a construction line, a point entity
//   - one driven (reference) dimension
// Registered on window as __seedDemoSketch / __seedConflict in DEV builds
// only (see registerSketchDevSeed call in App.tsx).

// Deterministic ids so repeated seeds and screenshots are reproducible.
const id = (name: string) => `demo-${name}`

export function buildDemoSketch(): Sketch {
  const entities: SketchEntity[] = [
    // Rectangle: 4 independent lines joined by coincident constraints
    // (independent-endpoint model — corners are paired endpoints, not shared vertices).
    { id: id('rect-bottom'), kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 60, y: 0 } },
    { id: id('rect-right'), kind: 'line', construction: false,
      start: { x: 60, y: 0 }, end: { x: 60, y: 40 } },
    { id: id('rect-top'), kind: 'line', construction: false,
      start: { x: 60, y: 40 }, end: { x: 0, y: 40 } },
    { id: id('rect-left'), kind: 'line', construction: false,
      start: { x: 0, y: 40 }, end: { x: 0, y: 0 } },
    // Under-defined circle + a line tangent to it.
    { id: id('circle'), kind: 'circle', construction: false,
      center: { x: 95, y: 20 }, radius: 10 },
    { id: id('tangent-line'), kind: 'line', construction: false,
      start: { x: 78, y: 31 }, end: { x: 112, y: 32 } },
    // A free arc.
    { id: id('arc'), kind: 'arc', construction: false,
      center: { x: 30, y: 68 }, radius: 12,
      startAngle: 0.35, endAngle: 2.3 },
    // Construction line (dashed + dimmed).
    { id: id('construction'), kind: 'line', construction: true,
      start: { x: 60, y: 55 }, end: { x: 105, y: 75 } },
    // Bare point entity.
    { id: id('point'), kind: 'point', construction: false,
      at: { x: 118, y: 58 } },
  ]

  const constraints: SketchConstraint[] = [
    // Coincident corners.
    { id: id('c-bl'), kind: 'coincident',
      a: { entityId: id('rect-bottom'), site: 'start' },
      b: { entityId: id('rect-left'), site: 'end' } },
    { id: id('c-br'), kind: 'coincident',
      a: { entityId: id('rect-bottom'), site: 'end' },
      b: { entityId: id('rect-right'), site: 'start' } },
    { id: id('c-tr'), kind: 'coincident',
      a: { entityId: id('rect-right'), site: 'end' },
      b: { entityId: id('rect-top'), site: 'start' } },
    { id: id('c-tl'), kind: 'coincident',
      a: { entityId: id('rect-top'), site: 'end' },
      b: { entityId: id('rect-left'), site: 'start' } },
    // H / V sides.
    { id: id('h-bottom'), kind: 'horizontal', line: id('rect-bottom') },
    { id: id('h-top'), kind: 'horizontal', line: id('rect-top') },
    { id: id('v-right'), kind: 'vertical', line: id('rect-right') },
    { id: id('v-left'), kind: 'vertical', line: id('rect-left') },
    // Ground the bottom-left corner — with the dims below this makes the
    // rectangle rigid AND positioned (0 DoF for the rect subsystem).
    { id: id('fix-bl'), kind: 'fix',
      point: { entityId: id('rect-bottom'), site: 'start' } },
    // Tangency between the free line and the circle.
    { id: id('tangent'), kind: 'tangent',
      a: id('tangent-line'), b: id('circle') },
  ]

  const dimensions: SketchDimension[] = [
    // Driving rectangle dims.
    { id: id('dim-width'), kind: 'distance', driving: true, value: 60,
      a: { entityId: id('rect-bottom'), site: 'start' },
      b: { entityId: id('rect-bottom'), site: 'end' },
      labelAnchor: { x: 30, y: -9 } },
    { id: id('dim-height'), kind: 'distance', driving: true, value: 40,
      a: { entityId: id('rect-right'), site: 'start' },
      b: { entityId: id('rect-right'), site: 'end' },
      labelAnchor: { x: 71, y: 20 } },
    // Driven (reference) radius on the arc — reported, never solved.
    { id: id('dim-arc-r'), kind: 'radius', driving: false, value: 12,
      entityId: id('arc') },
  ]

  return {
    id: id('sketch'),
    layerId: id('layer'),
    entities,
    constraints,
    dimensions,
    solveStatus: { dof: -1, conflicting: [], redundant: [] },
  }
}

/** Seed the demo sketch, switch to sketch mode, and solve. The document is
 *  re-homed onto a REAL "Sketch N" layer so finishing the seeded sketch
 *  bakes like any user-drawn one (no placeholder layer ids at runtime). */
export function seedDemoSketch() {
  const s = useCamStore.getState()
  const layer = s.createSketchLayer()
  // WO-2189: the layer lands on its own new sketch part - record it as the owner.
  const owner = useCamStore.getState().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layer.id))
  s.setActiveSketch({ ...buildDemoSketch(), layerId: layer.id, ownerGeometryId: owner?.id })
  s.setViewerMode('sketch')
  s.solveSketch()
}

/** Add a dimension that CONFLICTS with the seeded rectangle width
 *  (60 vs 70 on the same two points) -> over-defined banner + red
 *  entities. Requires the demo sketch to be active. */
export function seedConflict() {
  const s = useCamStore.getState()
  if (!s.activeSketch) {
    console.warn('seedConflict: seed the demo sketch first')
    return
  }
  const dim: DistanceDimension = {
    id: id('dim-conflict'), kind: 'distance', driving: true, value: 70,
    a: { entityId: id('rect-bottom'), site: 'start' },
    b: { entityId: id('rect-bottom'), site: 'end' },
    labelAnchor: { x: 30, y: 14 },
  }
  s.addDimension(dim)
  s.solveSketch()
}

/** DEV-only: expose the seeds on window for console / playwright use. */
export function registerSketchDevSeed() {
  const w = window as unknown as Record<string, unknown>
  w.__seedDemoSketch = seedDemoSketch
  w.__seedConflict = seedConflict
  // The APP's store instance, for read-only gate probes. Playwright used
  // to import('/src/store/index.ts'), but after an HMR invalidation vite
  // serves that bare URL as a SECOND module instance (the app's imports
  // carry ?t= timestamps) — the probe then reads a different store and
  // every assertion lies. Registering the live instance removes the
  // ambiguity.
  w.__camStore = useCamStore
  // ADR-0055's typed, read-only agent boundary. This is installed beside the
  // existing development hooks; none of those broader internal tools changes.
  w.__liencam = liencamCommands
  // GEO-25: uiPrefs (viewportTheme, panel widths, etc.) is a SEPARATE
  // persisted store from the project (see uiPrefs.ts header) -- capture/
  // gate scripts that need to drive the viewport theme need their own
  // reliable handle, same "live instance, no HMR ambiguity" reasoning as
  // __camStore above.
  w.__camUiPrefs = useUiPrefs
}
