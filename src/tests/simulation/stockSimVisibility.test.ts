// B9 (docs/planning/POST-MERGE-WORKPLAN.md): the stock-removal simulation
// surface stayed visible in the SETUP tab after computing a drill op (drill op
// + brep drill wizard sightings). Root cause: SimulationPanel's frames-rebuild
// effect fires on every toolpathKey change (an op finishing its compute) and
// its stock-sim block was guarded only by `if (stockSimEnabled)` - no mode
// check - so initStockSim created + showed the surface (and hid the wireframe
// stock) while the user sat in Setup. Only the mode-TRANSITION effect disposed
// it, hence "switch to Simulate and back clears it".
//
// Fix: syncStockSimSurface (exported from SimulationPanel) creates the surface
// ONLY when mode === 'simulation' and disposes it in every other mode. These
// tests drive it with the REAL store actions (setViewerMode /
// setStockSimEnabled - what the tab strip and the panel checkbox call) and the
// REAL CNCViewport initStockSim / disposeStockSim methods bound to a minimal
// instance with a real THREE scene (typedZTransform.test.ts pattern).

import * as THREE from 'three'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { syncStockSimSurface } from '../../components/simulation/SimulationPanel'

interface SimVpUnderTest {
  initStockSim: CNCViewport['initStockSim']
  disposeStockSim: CNCViewport['disposeStockSim']
  updateStockSimHeights: CNCViewport['updateStockSimHeights']
  scene: THREE.Scene
  stockGroup: THREE.Group
  stockSimGroup: THREE.Group | null
}

function makeVp(): SimVpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  const scene = new THREE.Scene()
  const stockGroup = new THREE.Group()
  scene.add(stockGroup)
  Object.assign(vp, {
    scene,
    stockGroup,
    fixedStockBoxes: new Map<string, THREE.Group>(),
    _stockBounds: {
      min: new THREE.Vector3(0, 0, 0),
      max: new THREE.Vector3(40, 30, 10),
    },
    stockSimGroup: null,
    stockSimGeometry: null,
    stockSimNx: 0,
    stockSimNy: 0,
  })
  return vp as SimVpUnderTest
}

const state = () => useCamStore.getState()

/** The args the rebuild effect passes - read from the live store, exactly as
 *  the effect does after a compute-complete re-render. */
const argsFromStore = () => ({
  mode: state().viewer.mode,
  enabled: state().viewer.stockSimEnabled,
  resolution: state().viewer.stockSimResolution,
})

const surfaceInScene = (vp: SimVpUnderTest) =>
  vp.stockSimGroup !== null && vp.scene.children.includes(vp.stockSimGroup)

/** The panel's VpHandle is structural (all-optional methods); the bound
 *  instance satisfies it. */
const asHandle = (vp: SimVpUnderTest) =>
  vp as unknown as Parameters<typeof syncStockSimSurface>[0]

describe('B9: stock-sim surface exists ONLY in Simulate mode', () => {
  let vp: SimVpUnderTest

  beforeEach(() => {
    vp = makeVp()
    vi.stubGlobal('window', { __cncViewport: vp })
    useCamStore.setState((s) => ({
      viewer: { ...s.viewer, mode: 'setup', stockSimEnabled: false },
      activeSketch: null,
    }))
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('compute-complete while activeTab=setup does NOT create the surface', () => {
    // The user enabled stock sim earlier in the session (panel checkbox)...
    state().setStockSimEnabled(true)
    // ...and is now on the Setup tab when a drill op finishes computing,
    // which re-runs the rebuild effect with the current store state.
    expect(state().viewer.mode).toBe('setup')
    const bounds = syncStockSimSurface(asHandle(vp), argsFromStore())

    expect(bounds).toBeNull()
    expect(surfaceInScene(vp)).toBe(false)       // no sim surface in the scene
    expect(vp.stockGroup.visible).toBe(true)     // wireframe stock NOT hidden
  })

  it('switching to Simulate shows it; back to Setup hides it again', () => {
    state().setStockSimEnabled(true)

    // Tab strip: Setup -> Simulate (real store action the mode tabs call).
    state().setViewerMode('simulation')
    const bounds = syncStockSimSurface(asHandle(vp), argsFromStore())
    expect(bounds).not.toBeNull()
    expect(surfaceInScene(vp)).toBe(true)        // surface present in Simulate
    expect(vp.stockGroup.visible).toBe(false)    // wireframe swapped out

    // Tab strip: Simulate -> Setup.
    state().setViewerMode('setup')
    const bounds2 = syncStockSimSurface(asHandle(vp), argsFromStore())
    expect(bounds2).toBeNull()
    expect(surfaceInScene(vp)).toBe(false)       // disposed on the way out
    expect(vp.stockGroup.visible).toBe(true)     // wireframe restored
  })

  it('a compute landing while IN Simulate keeps/recreates the surface', () => {
    state().setStockSimEnabled(true)
    state().setViewerMode('simulation')
    syncStockSimSurface(asHandle(vp), argsFromStore())
    expect(surfaceInScene(vp)).toBe(true)

    // toolpathKey change re-runs the effect in simulation mode: still there.
    const bounds = syncStockSimSurface(asHandle(vp), argsFromStore())
    expect(bounds).not.toBeNull()
    expect(surfaceInScene(vp)).toBe(true)
  })

  it('unchecking "Simulate Stock Removal" disposes the surface even in Simulate', () => {
    state().setStockSimEnabled(true)
    state().setViewerMode('simulation')
    syncStockSimSurface(asHandle(vp), argsFromStore())
    expect(surfaceInScene(vp)).toBe(true)

    state().setStockSimEnabled(false)
    const bounds = syncStockSimSurface(asHandle(vp), argsFromStore())
    expect(bounds).toBeNull()
    expect(surfaceInScene(vp)).toBe(false)
    expect(vp.stockGroup.visible).toBe(true)
  })
})
