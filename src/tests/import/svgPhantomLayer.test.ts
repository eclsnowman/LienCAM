// @vitest-environment jsdom
//
// B5 (docs/planning/POST-MERGE-WORKPLAN.md): importing the user's Inkscape-
// authored SVG (Sample Parts/Leadscrew_Stepper_Mount.svg) added a phantom
// "Layer 1" that is not real geometry. The file's <defs> carries SolidWorks
// title-block symbols, dimension markers and hatch patterns (stroke #000000)
// at raw document coordinates far from the part; none of it is rendered (the
// file contains ZERO <use> elements), but querySelectorAll descends into
// <defs> so it all imported as a black color-layer. centerLoops then centered
// the COMBINED bounds, leaving the real part far from the group origin - and
// the transform gizmo attaches to the THREE group and draws at its origin, so
// it anchored "up in space" away from the part. Deleting the phantom layer
// did not help: the remaining loops kept their offset coordinates (stale
// bounds).
//
// These tests run the REAL import pipeline headless: jsdom provides DOMParser
// and the live DOM host; the only browser primitive jsdom lacks
// (SVGPathElement.getTotalLength/getPointAtLength) is polyfilled with a path
// evaluator (see svgPathGeometryPolyfill.ts). Store and viewport halves use
// the REAL store actions and REAL CNCViewport prototype methods
// (typedZTransform.test.ts conventions).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, it, expect, beforeAll } from 'vitest'
import { importSVG, type Import2DResult } from '../../lib/import/svgImporter'
import { computeBBox2D } from '../../lib/geometry/path2d'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { useCamStore } from '../../store'
import { transformLoopPoints } from '../../store/dispatchGeo'
import type { ImportedGeometry } from '../../types'
import { installSvgPathGeometry, flattenPathD } from './svgPathGeometryPolyfill'

const here = dirname(fileURLToPath(import.meta.url))
const svgPath = join(here, '../../../Sample Parts/Leadscrew_Stepper_Mount.svg')
const svgText = readFileSync(svgPath, 'utf8')

// ── Independent ground truth from the file itself ──────────────────────────
// Bounds computed straight from the path `d` data (same no-transform
// convention as the importer), split into rendered (outside <defs>) and
// non-rendered (inside <defs>) sets.

interface RawBounds { minX: number; minY: number; maxX: number; maxY: number }

function boundsOfPaths(els: Element[]): RawBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of els) {
    for (const run of flattenPathD(el.getAttribute('d') ?? '')) {
      for (const p of run) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
    }
  }
  return { minX, minY, maxX, maxY }
}

function isInsideDefs(el: Element): boolean {
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    if (cur.tagName.toLowerCase() === 'defs') return true
  }
  return false
}

// mm per SVG user unit, replicating the importer's getSVGScale for this file:
// width="255.47652" (unitless -> px at 96 dpi) over viewBox width 255.47651.
const SCALE = (255.47652 * 0.264583) / 255.47651

// -- Minimal real-method viewport (typedZTransform.test.ts pattern) ----------
interface VpUnderTest {
  add2DGeometry: CNCViewport['add2DGeometry']
  geometry2dGroups: Map<string, THREE.Group>
}

function makeVp(): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    sketchEditLayerId: null,
    selectedPartId: null,
    workpieceGroup: new THREE.Group(),
    rebuildStock: () => {},
    updateSelectableObjects: () => {},
    fitCameraToObject: () => {},
  })
  return vp as VpUnderTest
}

// World-XY bounding box of the rendered lines of a 2D part group — what the
// user SEES. The gizmo draws at the group origin, so "gizmo on the part"
// means group.position == rendered bbox center.
function renderedWorldBBox(group: THREE.Group): THREE.Box3 {
  const box = new THREE.Box3()
  group.updateMatrixWorld(true)
  group.traverse(c => {
    if (c instanceof THREE.Line) {
      c.geometry.computeBoundingBox()
      const b = c.geometry.boundingBox!.clone().applyMatrix4(c.matrixWorld)
      box.union(b)
    }
  })
  return box
}

let result: Import2DResult

beforeAll(() => {
  installSvgPathGeometry(window as unknown as { SVGElement: { prototype: object } })
  // jsdom's localStorage does not satisfy zustand's persist storage contract
  // (node-env store tests skip persistence entirely because localStorage is
  // undefined there). Point persist at a no-op storage for this jsdom file.
  useCamStore.persist.setOptions({
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  result = importSVG(svgText)
})

describe('B5: Leadscrew_Stepper_Mount.svg import has no phantom layer', () => {
  it('evidence: the file <defs> content is non-rendered and far from the part', () => {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const all = Array.from(doc.querySelectorAll('path'))
    const defsPaths = all.filter(isInsideDefs)
    const renderedPaths = all.filter(p => !isInsideDefs(p))

    // The phantom source: dozens of defs-only paths, zero <use> instantiations
    expect(defsPaths.length).toBeGreaterThan(30)
    expect(doc.querySelectorAll('use').length).toBe(0)

    // defs content (markers near the origin + title-block symbols) inflates
    // the vertical extent massively vs the real part
    const realB = boundsOfPaths(renderedPaths)
    const allB = boundsOfPaths(all)
    const realH = realB.maxY - realB.minY
    const allH = allB.maxY - allB.minY
    expect(allH).toBeGreaterThan(realH * 1.5)

    // Real part raw extents (user units, from the path data): the part the
    // user drew. Matches the document viewBox up to the stroke width.
    expect(realB.maxX - realB.minX).toBeCloseTo(251.905, 1)
    expect(realH).toBeCloseTo(193.323, 1)
  })

  it('imports only the real-geometry layers (no #000000 phantom, no empty layers)', () => {
    const colors = result.layers.map(l => l.color).sort()
    expect(colors).toEqual(['#00ff00', '#00ffff', '#ff00ff'])
    expect(result.layers).toHaveLength(3)

    // Every layer owns at least one loop and every loop points at a real layer
    const layerIds = new Set(result.layers.map(l => l.id))
    const usedIds = new Set(result.loops.map(l => l.layerId))
    for (const id of layerIds) expect(usedIds.has(id)).toBe(true)
    for (const loop of result.loops) expect(layerIds.has(loop.layerId)).toBe(true)

    // 7 cyan bolt/bearing circles + 1 green center bore + 1 magenta outline
    expect(result.loops).toHaveLength(9)
  })

  it('bounds match the real part, centered at the origin (gizmo anchor intent)', () => {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const renderedPaths = Array.from(doc.querySelectorAll('path')).filter(p => !isInsideDefs(p))
    const realB = boundsOfPaths(renderedPaths)

    expect(result.boundingBox.size.x).toBeCloseTo((realB.maxX - realB.minX) * SCALE, 1)
    expect(result.boundingBox.size.y).toBeCloseTo((realB.maxY - realB.minY) * SCALE, 1)
    // centerLoops invariant: loop bbox center == (0,0) == group origin == gizmo
    expect(result.boundingBox.center.x).toBeCloseTo(0, 6)
    expect(result.boundingBox.center.y).toBeCloseTo(0, 6)
    const bb = computeBBox2D(result.loops)
    expect(bb.center.x).toBeCloseTo(0, 6)
    expect(bb.center.y).toBeCloseTo(0, 6)
  })

  it('viewport: gizmo anchor (group origin) sits at the rendered part center', () => {
    const vp = makeVp()
    vp.add2DGeometry(
      'geo-svg', result.loops, result.layers,
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
    )
    const group = vp.geometry2dGroups.get('geo-svg')!
    const box = renderedWorldBBox(group)
    const center = box.getCenter(new THREE.Vector3())
    expect(center.x).toBeCloseTo(group.position.x, 1)
    expect(center.y).toBeCloseTo(group.position.y, 1)
  })
})

describe('B5: deleting a layer re-derives the bounds the gizmo anchors to', () => {
  function installImportedGeo(): ImportedGeometry {
    const geo: ImportedGeometry = {
      id: 'geo-leadscrew',
      name: 'Leadscrew_Stepper_Mount',
      filename: 'Leadscrew_Stepper_Mount.svg',
      type: 'curves_2d',
      format: 'svg',
      boundingBox: result.boundingBox,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      loaded: true,
      loops: result.loops,
      layers2d: result.layers,
    }
    useCamStore.setState(s => ({
      project: { ...s.project, geometry: [] },
    }))
    useCamStore.getState().addGeometry(geo)
    return geo
  }

  it('real store action: remaining loops re-center, bounds + position re-derive, world placement unchanged', () => {
    installImportedGeo()
    const before = useCamStore.getState().project.geometry[0]
    const cyan = before.layers2d!.find(l => l.color === '#00ffff')!
    const survivorBefore = before.loops!.find(l => l.layerId !== cyan.id)!
    const worldBefore = transformLoopPoints(survivorBefore.points, before)

    useCamStore.getState().deleteGeometryLayer(before.id, cyan.id)

    const after = useCamStore.getState().project.geometry[0]
    expect(after.layers2d!.map(l => l.color).sort()).toEqual(['#00ff00', '#ff00ff'])
    expect(after.loops!.every(l => l.layerId !== cyan.id)).toBe(true)

    // Bounds re-derived: remaining loops centered, boundingBox matches them
    const bb = computeBBox2D(after.loops!)
    expect(bb.center.x).toBeCloseTo(0, 6)
    expect(bb.center.y).toBeCloseTo(0, 6)
    expect(after.boundingBox.size.x).toBeCloseTo(bb.size.x, 6)
    expect(after.boundingBox.size.y).toBeCloseTo(bb.size.y, 6)
    expect(after.boundingBox.center.x).toBe(0)
    expect(after.boundingBox.center.y).toBe(0)

    // The part did NOT move in world space: the recenter is compensated by
    // the position shift (same local->world convention as dispatch)
    const survivorAfter = after.loops!.find(l => l.id === survivorBefore.id)!
    const worldAfter = transformLoopPoints(survivorAfter.points, after)
    for (let i = 0; i < worldBefore.length; i++) {
      expect(worldAfter[i].x).toBeCloseTo(worldBefore[i].x, 6)
      expect(worldAfter[i].y).toBeCloseTo(worldBefore[i].y, 6)
    }
  })

  it('viewport rebuild from the updated store transform puts the gizmo on the part', () => {
    installImportedGeo()
    const id = useCamStore.getState().project.geometry[0].id
    const cyan = useCamStore.getState().project.geometry[0]
      .layers2d!.find(l => l.color === '#00ffff')!

    useCamStore.getState().deleteGeometryLayer(id, cyan.id)
    const updated = useCamStore.getState().project.geometry[0]

    // The DesignTree delete handler rebuilds with the UPDATED store transform
    const vp = makeVp()
    vp.add2DGeometry(id, updated.loops!, updated.layers2d!, updated.position, updated.rotation)
    const group = vp.geometry2dGroups.get(id)!
    const box = renderedWorldBBox(group)
    const center = box.getCenter(new THREE.Vector3())
    // Gizmo anchor (group origin) == post-delete rendered bounds center
    expect(center.x).toBeCloseTo(group.position.x, 1)
    expect(center.y).toBeCloseTo(group.position.y, 1)
  })
})
