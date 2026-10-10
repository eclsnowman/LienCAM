// @vitest-environment jsdom
//
// WO-346 (Operator, verdict on card Q-THE-AMBER-THEME-SEE-ALL-OF-IT-AN-1786569820206,
// 2026-08-12, "even in your screenshots there is some residual blue"): WO-326
// fixed viewportColors.ts's own cache (proven live by viewportThemeReread.wo326
// .test.ts) and wired tokens.css's amber overrides, but CNCViewport.ts still
// froze every scene colour it painted with in TWO ways:
//
//   1. `DARK_COLORS`, a module-scope object literal, called asNumber() exactly
//      ONCE at import time -- before any theme attribute could exist -- and
//      `private colors = DARK_COLORS` then pinned that stale snapshot to every
//      instance forever. Fixed by deleting the intermediate object: every
//      former DARK_COLORS field is now a direct asNumber(token) call inline at
//      its one use site (renderer.setClearColor, buildGrid, buildWCSIndicator,
//      buildStockBox, highlight2D/highlightProjectedLoops's selection default),
//      so each call re-resolves against whatever theme is active AT THAT
//      MOMENT -- proven in the "call-site colours re-resolve live" block below.
//
//   2. Even with live reads, nothing repainted an ALREADY-BUILT scene when the
//      theme flipped -- buildGrid()/rebuildStock() only run when something else
//      triggers them (a resize, a stock edit, construction). Fixed by
//      syncThemeIfChanged(), polled once per already-running rAF frame
//      (startRenderLoop), which re-runs buildGrid()/rebuildStock() the instant
//      `data-theme` differs from the last frame's value -- proven in the
//      "syncThemeIfChanged" block below.
//
// This WO's other half (rulebook-binding, from WO-326's own "Do not theme the
// colours that are not decoration"): axis convention, WCS origin, and part
// selection carry MEANING, not decoration, and tokens.css's amber block
// deliberately does not override them (see tokens.css's own WO-326 comment).
// The "non-decorative colours stay UNCHANGED" block proves CNCViewport keeps
// resolving them to the SAME value across a live switch -- the half that must
// not regress.

import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { describe, it, expect, afterEach } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { refreshViewportColors } from '../../theme/viewportColors'

// Real default/amber hex pairs, copied from tokens.css's :root and
// :root[data-theme="amber"] blocks (the WO-326 override list). jsdom cannot
// flatten an external stylesheet's var() chain via getComputedStyle, so -- the
// same stand-in technique src/tests/theme/viewportThemeReread.wo326.test.ts
// and src/tests/model3d/PushPullGizmo.test.tsx already use -- an inline style
// on document.documentElement plays the role of "whatever the real cascade
// would currently compute" for a given data-theme value.
const DECORATIVE: Record<string, readonly [string, string]> = {
  '--vp-canvas': ['#111418', '#111418'], // WO-360: scene background remains neutral
  '--vp-grid': ['#2a2f36', '#36312a'],
  '--vp-grid-accent': ['#1e4976', '#835e1f'], // chains through --role-identity-deep -> --blue-800
  '--vp-stock': ['#2a5c8a', '#8a662a'],
  '--vp-stock-edge': ['#4a9cd4', '#d4a04a'],
}

// tokens.css's amber block explicitly does NOT override these (see its own
// "Explicitly NOT touched" comment) -- axis convention, WCS origin, and part
// selection carry state meaning, not decoration. No inline stand-in is set
// for them in either phase below, matching production (no CSS rule touches
// them either), so asNumber() falls through to viewportColors.ts's own
// FALLBACK map both times -- the real mechanism, not a test-only shortcut.
const INVARIANT_TOKENS = ['--vp-axis-x', '--vp-axis-y', '--vp-axis-z', '--vp-wcs-origin', '--vp-select-part'] as const

function hexToNumber(hex: string): number {
  return parseInt(hex.slice(1), 16)
}

function applyPhase(phase: 0 | 1) {
  for (const [token, values] of Object.entries(DECORATIVE)) {
    document.documentElement.style.setProperty(token, values[phase])
  }
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-color-mode')
  for (const token of Object.keys(DECORATIVE)) document.documentElement.style.removeProperty(token)
  refreshViewportColors()
})

// Deliberately NOT `CNCViewport & {...}` -- gridGroup/wcsGroup are PRIVATE
// members of the real class, and TS collapses a public/private field clash
// in an intersection to `never`. A standalone interface (the same idiom
// geometry3dMoveGizmoPivot.test.ts's VpUnderTest uses) sidesteps that.
interface Receiver {
  gridGroup: THREE.Group
  wcsGroup: THREE.Group
  geometry2dGroups: Map<string, THREE.Group>
  buildWCSIndicator: (wcs: { origin: { x: number; y: number; z: number } }) => void
}

// Same Object.create(CNCViewport.prototype) + manual field harness this
// class's other unit tests use (e.g. geometry3dMoveGizmoPivot.test.ts,
// geometryMoveGizmoPivot.test.ts) to drive real prototype methods -- including
// ones a method under test calls internally (buildStockBox -> this.
// drawingBufferResolution()) -- without standing up a WebGL context.
function makeReceiver(overrides: Record<string, unknown> = {}): Receiver {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    gridGroup: new THREE.Group(),
    machineGroup: new THREE.Group(),
    machineTravelBorderGroup: new THREE.Group(),
    stockGroup: new THREE.Group(),
    wcsGroup: new THREE.Group(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    machineTravelX: 800,
    machineTravelY: 600,
    gridSpacing: 25,
    // Truthy machinePreviewFrame routes buildGrid() through its addLines()
    // branch (plain LineBasicMaterial.color), not THREE.GridHelper's baked
    // vertex-colour path -- simpler and sufficient to prove the colour
    // resolution itself is live; GridHelper's own vertex-colour wiring is
    // three.js's code, not this WO's.
    machinePreviewFrame: { minX: -100, maxX: 0, minY: -100, maxY: 0, z: 0, originMachine: { x: 0, y: 0, z: 0 } },
    setupSupportPlane: null,
    ...overrides,
  })
  return vp as unknown as Receiver
}

describe('WO-346: CNCViewport call-site colours re-resolve live (no frozen DARK_COLORS snapshot)', () => {
  it('buildGrid() paints the default colours, then the amber colours, from the SAME method with no reload', () => {
    const vp = makeReceiver()
    const buildGrid = (vp as unknown as { buildGrid: () => void }).buildGrid.bind(vp)

    applyPhase(0)
    buildGrid()
    const defaultColors = vp.gridGroup.children.map(
      (c) => ((c as THREE.LineSegments).material as THREE.LineBasicMaterial).color.getHex(),
    )
    expect(defaultColors).toEqual([hexToNumber(DECORATIVE['--vp-grid'][0]), hexToNumber(DECORATIVE['--vp-grid-accent'][0])])

    document.documentElement.setAttribute('data-theme', 'amber')
    applyPhase(1)
    buildGrid()
    const amberColors = vp.gridGroup.children.map(
      (c) => ((c as THREE.LineSegments).material as THREE.LineBasicMaterial).color.getHex(),
    )

    expect(amberColors).toEqual([hexToNumber(DECORATIVE['--vp-grid'][1]), hexToNumber(DECORATIVE['--vp-grid-accent'][1])])
    expect(amberColors).not.toEqual(defaultColors)
  })

  it('buildStockBox() (via the private prototype method) paints stock fill + edge from the CURRENT theme', () => {
    const vp = makeReceiver()
    const buildStockBox = (vp as unknown as {
      buildStockBox: (
        stock: { width: number; height: number; depth: number },
        origin: THREE.Vector3,
        stockId: string,
        movable: boolean,
      ) => THREE.Group
    }).buildStockBox.bind(vp)

    // Note: buildStockBox's wireframe child is a LineSegments2, which is
    // itself a THREE.Mesh subclass (fat-line rendering trick) -- filter on
    // the fill's actual material type, not `instanceof THREE.Mesh`, or this
    // grabs the wireframe's --vp-stock-edge colour instead of the fill's
    // --vp-stock colour.
    const findFill = (group: THREE.Group) =>
      (group.children.find((c) => (c as THREE.Mesh).material instanceof THREE.MeshStandardMaterial) as THREE.Mesh)
        .material as THREE.MeshStandardMaterial
    const findEdge = (group: THREE.Group) =>
      (group.children.find((c) => !((c as THREE.Mesh).material instanceof THREE.MeshStandardMaterial)) as unknown as
        { material: { color: THREE.Color } }).material

    applyPhase(0)
    const defaultBox = buildStockBox({ width: 10, height: 10, depth: 10 }, new THREE.Vector3(0, 0, 0), 'a', false)
    const defaultFill = findFill(defaultBox)
    const defaultEdge = findEdge(defaultBox)

    document.documentElement.setAttribute('data-theme', 'amber')
    applyPhase(1)
    const amberBox = buildStockBox({ width: 10, height: 10, depth: 10 }, new THREE.Vector3(0, 0, 0), 'b', false)
    const amberFill = findFill(amberBox)
    const amberEdge = findEdge(amberBox)

    expect(amberFill.color.getHex()).not.toBe(defaultFill.color.getHex())
    expect(amberFill.color.getHex()).toBe(hexToNumber(DECORATIVE['--vp-stock'][1]))
    expect(defaultFill.color.getHex()).toBe(hexToNumber(DECORATIVE['--vp-stock'][0]))

    expect(amberEdge.color.getHex()).not.toBe(defaultEdge.color.getHex())
    expect(amberEdge.color.getHex()).toBe(hexToNumber(DECORATIVE['--vp-stock-edge'][1]))
    expect(defaultEdge.color.getHex()).toBe(hexToNumber(DECORATIVE['--vp-stock-edge'][0]))
  })
})

describe('WO-346: non-decorative colours stay UNCHANGED across a live theme switch (must not regress)', () => {
  it('buildWCSIndicator() paints the SAME axis + origin colours under default and amber', () => {
    const vp = makeReceiver()

    vp.buildWCSIndicator({ origin: { x: 0, y: 0, z: 0 } })
    const defaultArrowColors = vp.wcsGroup.children
      .filter((c): c is THREE.ArrowHelper => c instanceof THREE.ArrowHelper)
      .map((a) => (a.line.material as THREE.LineBasicMaterial).color.getHex())
    const defaultSphere = vp.wcsGroup.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh
    const defaultOriginColor = (defaultSphere.material as THREE.MeshStandardMaterial).color.getHex()
    expect(defaultArrowColors).toHaveLength(3)

    document.documentElement.setAttribute('data-theme', 'amber')
    vp.buildWCSIndicator({ origin: { x: 0, y: 0, z: 0 } })
    const amberArrowColors = vp.wcsGroup.children
      .filter((c): c is THREE.ArrowHelper => c instanceof THREE.ArrowHelper)
      .map((a) => (a.line.material as THREE.LineBasicMaterial).color.getHex())
    const amberSphere = vp.wcsGroup.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh
    const amberOriginColor = (amberSphere.material as THREE.MeshStandardMaterial).color.getHex()

    expect(amberArrowColors).toEqual(defaultArrowColors)
    expect(amberOriginColor).toBe(defaultOriginColor)
  })

  it('highlight2D()\'s selection default resolves to the SAME colour under default and amber', () => {
    const vp = makeReceiver()
    const group = new THREE.Group()
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]),
      new THREE.LineBasicMaterial(),
    )
    group.add(line)
    vp.geometry2dGroups.set('part-a', group)
    const highlight2D = (vp as unknown as { highlight2D: (id: string, on: boolean) => void }).highlight2D.bind(vp)

    highlight2D('part-a', true)
    const defaultColor = (line.material as THREE.LineBasicMaterial).color.getHex()

    document.documentElement.setAttribute('data-theme', 'amber')
    highlight2D('part-a', true)
    const amberColor = (line.material as THREE.LineBasicMaterial).color.getHex()

    expect(amberColor).toBe(defaultColor)
  })

  it('tokens.css genuinely does not override the invariant tokens under amber (regression guard, not a no-op assertion)', () => {
    const css = readFileSync('src/theme/tokens.css', 'utf8')
    const amberMatch = css.match(/:root\[data-theme="amber"\]\s*\{([\s\S]*?)\n\}/)
    expect(amberMatch, ':root[data-theme="amber"] block not found in tokens.css').not.toBeNull()
    const amberBlock = amberMatch![1]
    for (const token of INVARIANT_TOKENS) {
      expect(amberBlock.includes(`${token}:`), `${token} should not appear in the amber override block`).toBe(false)
    }
  })
})

describe('WO-346: syncThemeIfChanged() repaints on a live data-theme flip, no reload, no redundant repaint', () => {
  function makeSyncReceiver() {
    const calls: string[] = []
    const vp = Object.create(CNCViewport.prototype)
    Object.assign(vp, {
      lastSeenThemeAttr: `${document.documentElement.getAttribute('data-theme') ?? ''}|${document.documentElement.getAttribute('data-color-mode') ?? ''}`, // seed like the constructor does
      renderer: { setClearColor: () => calls.push('setClearColor') },
      buildGrid: () => calls.push('buildGrid'),
      rebuildStock: () => calls.push('rebuildStock'),
      refreshZeroPointChoiceTheme: () => calls.push('refreshZeroPointChoiceTheme'),
    })
    // syncThemeIfChanged/refreshThemeColors themselves are NOT overridden --
    // they resolve through the prototype (the real implementation under
    // test), which then calls the three stubs above via `this`.
    return { vp: vp as unknown as CNCViewport, calls }
  }

  it('does nothing on a frame where data-theme has not changed since the last check', () => {
    const { vp, calls } = makeSyncReceiver()
    const syncThemeIfChanged = (vp as unknown as { syncThemeIfChanged: () => void }).syncThemeIfChanged.bind(vp)

    syncThemeIfChanged()
    syncThemeIfChanged()

    expect(calls).toEqual([])
  })

  it('repaints exactly once the frame data-theme flips, then goes quiet again -- no reload, no re-render per idle frame', () => {
    const { vp, calls } = makeSyncReceiver()
    const syncThemeIfChanged = (vp as unknown as { syncThemeIfChanged: () => void }).syncThemeIfChanged.bind(vp)

    document.documentElement.setAttribute('data-theme', 'amber')
    syncThemeIfChanged()
    expect(calls).toEqual(['setClearColor', 'buildGrid', 'rebuildStock', 'refreshZeroPointChoiceTheme'])

    calls.length = 0
    syncThemeIfChanged()
    syncThemeIfChanged()
    expect(calls).toEqual([])

    document.documentElement.removeAttribute('data-theme')
    syncThemeIfChanged()
    expect(calls).toEqual(['setClearColor', 'buildGrid', 'rebuildStock', 'refreshZeroPointChoiceTheme'])
  })

  it('repaints exactly once when the color-mode axis flips under the same theme', () => {
    const { vp, calls } = makeSyncReceiver()
    const syncThemeIfChanged = (vp as unknown as { syncThemeIfChanged: () => void }).syncThemeIfChanged.bind(vp)

    document.documentElement.setAttribute('data-color-mode', 'light')
    syncThemeIfChanged()
    expect(calls).toEqual(['setClearColor', 'buildGrid', 'rebuildStock', 'refreshZeroPointChoiceTheme'])

    calls.length = 0
    syncThemeIfChanged()
    expect(calls).toEqual([])
  })
})
