// @vitest-environment jsdom

// WO-318: "you cannot see what you are picking on an STL" - Operator armed the
// loop picker on an STL, moved over an edge, and got no hover feedback.
//
// The machinery WO-257 built (updateLoopPickHover / refreshLoopColors /
// loopPickHoverId) already exists and already has coverage - but that
// coverage never drove it with BOTH real STL-derived coordinates AND the
// real NewOperationModalBody arming path at once. Its Part 1 harness hand-
// built synthetic squares directly on a bare CNCViewport (no modal). Its
// Part 2 harness armed a FAKE viewport stand-in from the real modal (no real
// raycast). Neither reproduces Operator's actual flow end to end.
//
// WO-319 (landed first, see its result in the queue file) found and fixed
// the actual defect: derived STL edge-chain points were expressed in the STL
// FILE's raw byte frame, not the recentered frame the displayed mesh
// actually renders in - so the pickable lines sat ~30mm+ from the visible
// mesh on this fixture, and a hover ray aimed at the mesh could never
// geometrically reach them. This file drives the real flow end to end -
// real derived coordinates (via the real loadMeshEdgeChains store action),
// real modal arming (NewOperationModalBody.startLoopPicking against a REAL
// CNCViewport instance, not a fake one), real raycast hover
// (updateLoopPickHover, unmocked) - to prove WO-319's fix is also what
// restores hover, and that no second highlight needs to be built.
//
// The "before" half of the fail-then-pass proof (below) temporarily
// reproduces the pre-WO-319 raw-frame coordinates to show this exact test
// fails without that fix and passes with it, rather than asserting the
// causal link from prose alone.

import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { importStl } from '../../mesh/stl'
import type { ImportedGeometry, Loop2D, Layer2D, Setup } from '../../types'

const stlCache = vi.hoisted(() => ({ load: vi.fn<() => Promise<ArrayBuffer | null>>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  loadCachedSTL: stlCache.load,
  cacheSTL: vi.fn(async () => {}),
  removeCachedSTL: vi.fn(async () => {}),
}))

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const GEO_ID = 'wo318-operator-plate'
const SETUP_ID = 'wo318-setup'
const TOOL_ID = 'wo318-tool'
const PLATTE_FIXTURE = 'src/tests/mesh/fixtures/obj_1_Platte C.stl'

// ── Real CNCViewport fixture (same shape as WO-257's Part 1 harness): a
// prototype-built instance so no WebGL renderer/DOM is required, but every
// method under test is production's, not a re-implementation. ─────────────

interface HoverHarness {
  raycaster: THREE.Raycaster
  loopPickHoverId: string | null
  pickedLoopIds: Set<string>
  updateLoopPickHover: (event: MouseEvent) => void
}

function priv(viewport: CNCViewport): HoverHarness {
  return viewport as unknown as HoverHarness
}

const CANVAS_W = 800
const CANVAS_H = 600
const FRUSTUM = 100 // camera spans -50..50 in x and y - the fixture's recentered footprint is well inside that

function clientAt(x: number, y: number): { clientX: number; clientY: number } {
  return {
    clientX: ((x / (FRUSTUM / 2)) + 1) / 2 * CANVAS_W,
    clientY: (1 - (y / (FRUSTUM / 2))) / 2 * CANVAS_H,
  }
}

function hoverEvent(x: number, y: number): MouseEvent {
  return clientAt(x, y) as unknown as MouseEvent
}

interface RealViewportFixture {
  viewport: CNCViewport
  listeners: Array<{ type: string; fn: unknown }>
  domStyle: { cursor: string }
  lineFor: (loopId: string) => THREE.Line
  /** The opaque STL/STEP body sitting where the real part sits - present so
   * this harness CAN fail on occlusion by a body, per the audit finding that
   * a bodyless harness stayed green through the whole defect. */
  body: THREE.Mesh
}

function makeRealViewportFixture(): RealViewportFixture {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  camera.position.set(0, 0, 100)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()

  const listeners: Array<{ type: string; fn: unknown }> = []
  const domStyle = { cursor: '' }
  const scene = new THREE.Group()

  Object.assign(viewport, {
    scene,
    partGroups: new Map<string, THREE.Group>(),
    projectedLoopGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    nestGroups: new Map<string, THREE.Group>(),
    fixedStockBoxes: new Map<string, THREE.Group>(),
    selectableObjects: [] as THREE.Object3D[],
    camera,
    raycaster: new THREE.Raycaster(),
    mouse: new THREE.Vector2(),
    viewportThemeId: 'classic',
    selectionGlow: 'current' as const,
    loopPickCallback: null,
    loopPickAllowedGeoId: null,
    pickedLoopIds: new Set<string>(),
    loopPickHoverId: null,
    handleLoopPickHoverMove: () => undefined,
    renderer: {
      domElement: {
        style: domStyle,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: CANVAS_W, height: CANVAS_H }),
        addEventListener: (type: string, fn: unknown) => { listeners.push({ type, fn }) },
        removeEventListener: (type: string, fn: unknown) => {
          const at = listeners.findIndex((l) => l.type === type && l.fn === fn)
          if (at >= 0) listeners.splice(at, 1)
        },
      },
    },
  })

  // addSTL names the part group by geoId - the loop-pick geo gate resolves a
  // `__proj__` line through its grandparent name, exactly as production does.
  const partGroup = new THREE.Group()
  partGroup.name = GEO_ID
  scene.add(partGroup)
  ;(viewport as unknown as { partGroups: Map<string, THREE.Group> }).partGroups.set(GEO_ID, partGroup)

  // The opaque body Operator actually sees. WO-318's fix-round audit named this
  // exact gap: "builds the part group with no mesh in it... a harness with no
  // body cannot fail on occlusion by a body." Match addSTL's own recenter
  // convention (CNCViewport.ts addSTL: geometry.translate(...,-bbox.min.z)) -
  // the geometry itself is translated so its bottom face sits at local Z=0,
  // mesh.position stays identity - because setPartProjectedLoops' minZ scan
  // (CNCViewport.ts:7236-7244) reads RAW local vertex data, not a transformed
  // world position, so a mesh.position-only offset would not be seen by it.
  // Footprint sized with margin over seedProject's boundingBox (a 54x54
  // rectangle) - the real derived chains only need to fall inside it, not
  // match it exactly. Height 6, 2mm taller than the fixture STL's own 0..4 Z
  // range (WO-350): the interior fallback now prefers the NEAREST pierced
  // chain, so a hover naturally resolves to whichever chain sits AT the
  // part's own top face (Z4) - this proxy body must stay taller than that so
  // the "hover finds a chain genuinely occluded by the body" proof below
  // still holds; a box the exact height of the part would leave its own top
  // face chain sitting flush with (not under) the proxy's top surface.
  const bodyGeometry = new THREE.BoxGeometry(80, 80, 6)
  bodyGeometry.translate(0, 0, 3) // local Z -3..3 -> 0..6, bottom face at Z=0
  const body = new THREE.Mesh(bodyGeometry, new THREE.MeshBasicMaterial({ color: 0x888888 }))
  body.name = 'body'
  partGroup.add(body)

  const lineFor = (loopId: string): THREE.Line => {
    let found: THREE.Line | null = null
    partGroup.traverse((child) => {
      if (child instanceof THREE.Line && child.name === loopId) found = child
    })
    if (!found) throw new Error(`no rendered loop line named "${loopId}"`)
    return found
  }

  return { viewport, listeners, domStyle, lineFor, body }
}

function fixtureBuffer(): ArrayBuffer {
  const bytes = readFileSync(PLATTE_FIXTURE)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function seedProject(): void {
  const geometry: ImportedGeometry[] = [{
    id: GEO_ID,
    name: 'Operator plate STL',
    filename: 'obj_1_Platte C.stl',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -27, y: -27, z: 0 },
      max: { x: 27, y: 27, z: 4 },
      size: { x: 54, y: 54, z: 4 },
      center: { x: 0, y: 0, z: 2 },
    },
  }]
  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular',
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [],
    notes: '',
  } as unknown as Setup
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [{
      id: TOOL_ID, name: 'WO-318 6mm Flat', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
    project: {
      ...current.project,
      geometry,
      setups: [setup],
      activeSetupId: SETUP_ID,
    },
  })
}

/** Open the Contour dialog on the STL, real derive-on-select path and all. */
async function openContourOnStl(): Promise<void> {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('WO-318 6mm Flat'))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
  await waitFor(() => {
    expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
  })
}

/** The real derived chains + layer, exactly as the store holds them after the modal's real derive-on-select ran. */
function realDerivedChains(): { loops: Loop2D[]; layers: Layer2D[] } {
  const geo = useCamStore.getState().project.geometry.find((g) => g.id === GEO_ID)!
  return { loops: geo.loops ?? [], layers: (geo.layers2d ?? []).filter((l) => !l.projectionPlane) }
}

/** Render derived loops into the real viewport exactly as Viewport.tsx's stlLoopsKey effect does in production. */
function renderRealChainsIntoViewport(fixture: RealViewportFixture, loops: Loop2D[], layers: Layer2D[]): void {
  fixture.viewport.setPartProjectedLoops(GEO_ID, loops, layers)
}

/** Z parsed from a chain's "...(Z <local Z>)" display name (CNCViewport's own
 *  chainZFromName convention), 0 for a chain with no such suffix. */
function chainZ(loop: Loop2D): number {
  const match = /\(Z\s*(-?\d+(?:\.\d+)?)\)\s*$/.exec(loop.name ?? '')
  return match ? Number(match[1]) : 0
}

/**
 * A closed chain safely interior-clickable for the raycast's interior
 * fallback - almost certainly a hole.
 *
 * WO-350: the interior fallback now prefers the NEAREST pierced loop, not
 * the globally smallest one (a chamfered/countersunk feature otherwise let a
 * small far-side face steal picks from the loop actually under the cursor -
 * see stlChamferContourPick.wo350.test.ts). This fixture's mounting holes are
 * themselves countersunk on BOTH faces - a wide ring at Z0/Z4 and a narrower
 * bore ring just inside it at Z0.5/Z3.5, all coaxial - so a dead-center
 * top-down click now correctly resolves to the wide ring on the face
 * actually FACING the camera (highest Z here), not whichever ring happened
 * to have the smallest area regardless of which side of the part it sat on.
 * Reproduces that exact resolution: find a hole-ish location via the
 * smallest chain overall, then return the nearest-Z (smallest-area tie-break)
 * chain actually overlapping that location - the same two-step rule
 * resolveLoopPickAtCurrentRay's case 2 now applies.
 */
function smallestClosedChain(loops: Loop2D[]): Loop2D {
  const closed = loops.filter((l) => l.closed && l.points.length >= 3)
  if (!closed.length) throw new Error('no closed chains derived')
  const seed = closed.reduce((best, l) => (l.area < best.area ? l : best))
  const seedCenter = bboxCenter(seed)
  const overlapping = closed.filter((l) => {
    const xs = l.points.map((p) => p.x)
    const ys = l.points.map((p) => p.y)
    return seedCenter.x >= Math.min(...xs) && seedCenter.x <= Math.max(...xs)
      && seedCenter.y >= Math.min(...ys) && seedCenter.y <= Math.max(...ys)
  })
  const nearestZ = Math.max(...overlapping.map(chainZ))
  return overlapping.filter((l) => chainZ(l) === nearestZ).reduce((best, l) => (l.area < best.area ? l : best))
}

function bboxCenter(loop: Loop2D): { x: number; y: number } {
  const xs = loop.points.map((p) => p.x)
  const ys = loop.points.map((p) => p.y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}


beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  stlCache.load.mockReset()
  stlCache.load.mockResolvedValue(fixtureBuffer())
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-318: cause - STL chains are unreachable pre-WO-319, reachable post-WO-319', () => {
  it('a hover ray at the real derived chain coordinates misses in the pre-WO-319 raw STL-file frame, and hits in the recentered (post-fix) frame', async () => {
    // The pre-WO-319 bug, reproduced directly: meshContourLoops used to hand
    // back points in the STL FILE's own raw byte frame instead of the
    // recentered frame addSTL displays the mesh in. Reproduce that frame by
    // re-deriving from the raw bytes with NO recentering and rendering those
    // (buggy) coordinates into the same viewport the fix now renders correctly
    // into - same raycast, same camera, only the input coordinates differ.
    const raw = importStl(fixtureBuffer()).mesh
    let minX = Infinity, minY = Infinity
    let maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i + 1 < raw.positions.length; i += 3) {
      minX = Math.min(minX, raw.positions[i]); maxX = Math.max(maxX, raw.positions[i])
      minY = Math.min(minY, raw.positions[i + 1]); maxY = Math.max(maxY, raw.positions[i + 1])
    }
    // This fixture's raw footprint does not straddle the origin (confirmed by
    // WO-319's audit: X/Y 98..158) - if that ever changed, the reproduction
    // below would no longer demonstrate anything, so pin the precondition.
    expect(Math.max(Math.abs(minX), Math.abs(maxX))).toBeGreaterThan(FRUSTUM / 2)

    await openContourOnStl()
    const { loops: fixedLoops, layers } = realDerivedChains()
    const target = smallestClosedChain(fixedLoops)
    const center = bboxCenter(target)

    // Recover this chain's un-recentered (buggy) coordinates by adding back
    // the exact offset WO-319's fix subtracts (mesh bbox center).
    const recenterX = (minX + maxX) / 2
    const recenterY = (minY + maxY) / 2
    const buggyLoops: Loop2D[] = fixedLoops.map((l) => ({
      ...l,
      points: l.points.map((p) => ({ x: p.x + recenterX, y: p.y + recenterY })),
    }))

    // Pre-WO-319 frame: hovering at the same screen position the FIXED chain
    // actually occupies hits nothing - the chain the operator sees is not
    // where the pickable line is drawn.
    const missFixture = makeRealViewportFixture()
    renderRealChainsIntoViewport(missFixture, buggyLoops, layers)
    missFixture.viewport.setLoopPickMode(() => {}, GEO_ID)
    act(() => { priv(missFixture.viewport).updateLoopPickHover(hoverEvent(center.x, center.y)) })
    expect(priv(missFixture.viewport).loopPickHoverId).toBeNull()

    // Post-WO-319 (current) frame: the same hover at the same screen position
    // hits the chain.
    const hitFixture = makeRealViewportFixture()
    renderRealChainsIntoViewport(hitFixture, fixedLoops, layers)
    hitFixture.viewport.setLoopPickMode(() => {}, GEO_ID)
    act(() => { priv(hitFixture.viewport).updateLoopPickHover(hoverEvent(center.x, center.y)) })
    expect(priv(hitFixture.viewport).loopPickHoverId).toBe(target.id)
  })
})

describe('WO-318: hovering an STL edge chain in the real picking flow paints it', () => {
  it('arms the REAL viewport from NewOperationModalBody, and a hover over a real derived chain paints hover before any click, distinguishable from picked', async () => {
    const fixture = makeRealViewportFixture()
    ;(window as unknown as Record<string, unknown>).__cncViewport = fixture.viewport

    await openContourOnStl()
    const { loops, layers } = realDerivedChains()
    expect(loops.length).toBeGreaterThan(0)
    renderRealChainsIntoViewport(fixture, loops, layers)

    const target = smallestClosedChain(loops)
    const center = bboxCenter(target)
    const targetMat = fixture.lineFor(target.id).material as THREE.LineBasicMaterial
    const origColor = targetMat.color.getHex()
    // Resting state depth-tests normally, same as before this fix round -
    // this order's concern is HOVERED/PICKED visibility, not resting.
    expect(targetMat.depthTest).toBe(true)

    // Real modal arming: clicking "Pick from viewport" runs the REAL
    // startLoopPicking(), which calls getVp()?.setLoopPickMode?.(...) against
    // window.__cncViewport - our real viewport fixture, not a fake stand-in.
    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    expect(fixture.listeners.filter((l) => l.type === 'mousemove')).toHaveLength(1)

    // Before any click: hovering paints the hover state.
    act(() => { priv(fixture.viewport).updateLoopPickHover(hoverEvent(center.x, center.y)) })
    expect(priv(fixture.viewport).loopPickHoverId).toBe(target.id)
    const hoverColor = (fixture.lineFor(target.id).material as THREE.LineBasicMaterial).color.getHex()
    expect(hoverColor).not.toBe(origColor)
    expect(fixture.domStyle.cursor).toBe('pointer')

    // The audit's exact defect: with the body VISIBLE, the ray this hover just
    // reused hits the opaque body FIRST, nearer to the camera than the flat
    // Z-plane the hovered chain is actually drawn on - proof the occlusion
    // this order is about is really present in this harness, not just
    // asserted in prose. A direct Line raycast can't make this comparison:
    // target is deliberately an interior hole center (safely away from any
    // edge, see smallestClosedChain above), so it tests against the chain's
    // real rendered Z-plane instead (read off the live line, not an assumed
    // constant) - exactly the comparison a WebGL depth test performs.
    const hoverRay = priv(fixture.viewport).raycaster
    const bodyHits = hoverRay.intersectObject(fixture.body, true)
    const lineWorldZ = new THREE.Box3().setFromObject(fixture.lineFor(target.id)).min.z
    const linePoint = new THREE.Vector3()
    hoverRay.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -lineWorldZ), linePoint)
    const lineDistance = hoverRay.ray.origin.distanceTo(linePoint)
    expect(bodyHits.length).toBeGreaterThan(0)
    expect(bodyHits[0].distance).toBeLessThan(lineDistance)
    // The fix: the hovered chain's material now bypasses depth testing, so it
    // draws through that occluding body instead of being buried under it.
    expect(targetMat.depthTest).toBe(false)

    // Selecting it (the real click handler's effect: add to pickedLoopIds,
    // recolor) reads as picked, and picked is visually distinct from hovered.
    fixture.viewport.setPickedLoops([target.id])
    const pickedColor = (fixture.lineFor(target.id).material as THREE.LineBasicMaterial).color.getHex()
    expect(pickedColor).not.toBe(hoverColor)
    expect(pickedColor).not.toBe(origColor)
    // Picked also bypasses depth testing, through the same VISIBLE body.
    expect(targetMat.depthTest).toBe(false)

    // Moving off: hover clears, cursor reverts, picked stays picked - and
    // stays visible through the body (still depthTest:false) even though
    // hover itself is gone.
    act(() => { priv(fixture.viewport).updateLoopPickHover(hoverEvent(45, 45)) })
    expect(priv(fixture.viewport).loopPickHoverId).toBeNull()
    expect(fixture.domStyle.cursor).toBe('crosshair')
    expect((fixture.lineFor(target.id).material as THREE.LineBasicMaterial).color.getHex()).toBe(pickedColor)
    expect(targetMat.depthTest).toBe(false)
  })
})

describe('WO-318: a STEP-derived (B-rep) chain is unaffected', () => {
  it('still hovers correctly through the same shared render/hover path, and the fix-round depth-test bypass applies uniformly rather than special-casing STL', () => {
    // STEP/B-rep derived chains were never re-parsed from a second byte
    // source the way meshContourLoops was, so they never had WO-319's
    // coordinate-frame bug, and attempt 1 made no production change at all.
    // The fix round DID change shared plumbing (refreshLoopColors now toggles
    // depthTest for a hovered/picked line), because a STEP chain sits on a
    // B-rep body exactly as an STL chain sits on a mesh body - the same
    // occlusion, the same fix, no format-specific branch. This pins that the
    // selection/color mechanics a STEP chain relies on are still exactly what
    // they were, using coordinates the way a B-rep derive actually hands them
    // back: already local, already on the part.
    const fixture = makeRealViewportFixture()
    const stepChain: Loop2D = {
      id: 'mec:wo318-step-chain', points: [
        { x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 },
      ], closed: true, type: 'contour', layerId: 'step-derived-chains', area: 100,
    }
    const layer: Layer2D = { id: 'step-derived-chains', name: 'STEP edge chains', color: '#58a6ff', visible: true }
    fixture.viewport.setPartProjectedLoops(GEO_ID, [stepChain], [layer])
    const stepMat = fixture.lineFor(stepChain.id).material as THREE.LineBasicMaterial
    const origColor = stepMat.color.getHex()
    expect(stepMat.depthTest).toBe(true)

    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)
    act(() => { priv(fixture.viewport).updateLoopPickHover(hoverEvent(0, 0)) })
    expect(priv(fixture.viewport).loopPickHoverId).toBe(stepChain.id)
    expect((fixture.lineFor(stepChain.id).material as THREE.LineBasicMaterial).color.getHex()).not.toBe(origColor)
    expect(stepMat.depthTest).toBe(false)
  })
})
