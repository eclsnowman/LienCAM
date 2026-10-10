import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import type { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { asHex, asNumber } from '../../theme/viewportColors'
import { resolveSelectionGlowColors } from '../../lib/viewport/lighting/selectionGlowTokens'

// WO-351 ("an orange highlight on an orange body is no highlight"): Operator --
// "If I pick the part in the viewport option it turns the part orange, if I
// then go to select the edges I cannot see orange highlighting on an orange
// part... This is not the first time or place this has happened. So we need
// a solution to make this truly how I can do it."
//
// Root cause: partInteractionColor() (the whole-body 'selected' fill) and
// brepPickColor()/brepHoverColor() (the edge/face highlight) both resolve
// through resolveSelectionGlowColors()'s SAME {hover, selected} pair -- a
// picked edge on a selected body draws the mathematically IDENTICAL colour
// as that body's fill, for every glow candidate and viewport theme, not by
// coincidence but by construction. buildBrepHighlight's new
// brepHighlightColorFor() is the one place that resolves "is this body's
// fill actually painted opaque right now" + "which edge/face variant" into
// the final draw colour, so the two can never cancel again.
//
// Audit fix round 1: a first version of brepHighlightColorFor gated on
// currentShadingMode ('shaded-edges'/'shaded-no-edges' = opaque fill, else
// not) -- a FALSE PROXY. updateSelectedBodyMaterialTint sets opacity 1 /
// transparent false UNCONDITIONALLY whenever a body is selected and never
// touches wireframe, so a selected body renders fully opaque in Translucent
// too (and in Unshaded on a modeled body), not just the two "opaque" modes
// the proxy assumed -- the WO's own defect, reintroduced through a mode
// gate that did not match the live material. The resolver now reads the
// LIVE material (wireframe === false && transparent === false is the exact
// THREE contract for "an opaque triangle surface is being drawn"), which is
// correct under any ordering of select vs. mode-switch.
//
// Audit fix round 2: the fill-opaque predicate from round 1 is the right
// question for a FACE highlight (which sits on the fill), but the wrong one
// for an EDGE highlight. paintPartHighlight's createBodyInteractionOverlay
// paints a 5px amber topology-outline stroke along EVERY edge of a selected
// body, in every display mode, completely independent of whether the fill
// is opaque. So wherever the fill-opaque predicate went false (wireframe on
// an imported body, or a Translucent mode-switch landing after the pick),
// the edge highlight fell back to the SAME {selected} token the outline
// itself already draws on that same edge -- measured 1.00:1 in the real
// app. brepHighlightColorFor is now kind-aware: an edge highlight swaps to
// the dark on-selected tokens whenever the body is selected, full stop,
// because the outline is unconditional; a face highlight keeps the
// fill-opaque check from round 1, because a face highlight's collision
// surface is still the fill.

// WCAG 2.1 contrast ratio (the same formula the amber/high-contrast theme
// blocks in tokens.css already hand-compute and document).
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16)
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const r = channel((n >> 16) & 0xff)
  const g = channel((n >> 8) & 0xff)
  const b = channel(n & 0xff)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrastRatio(hexA: string, hexB: string): number {
  const a = luminance(hexA)
  const b = luminance(hexB)
  const [hi, lo] = a >= b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

// Non-text UI component floor (WCAG 1.4.11).
const NON_TEXT_CONTRAST_FLOOR = 3

interface Harness {
  partInteractionColor: (
    variant: 'hovered' | 'selected',
    nestMembershipSelected: boolean,
  ) => number
  buildBrepHighlight: (
    geoId: string,
    kind: 'face' | 'edge',
    index: number,
    variant?: 'picked' | 'hover',
  ) => THREE.Object3D | null
  brepHighlightColorFor: (geoId: string, kind: 'face' | 'edge', variant: 'picked' | 'hover') => number
  resyncBrepHighlightColorsFor: (geoId: string) => void
  selectedPartId: string | null
  selectionGlow: string
  viewportThemeId: string
  partSelectedMaterialStates: Map<string, unknown>
}

function priv(vp: CNCViewport): Harness {
  return vp as unknown as Harness
}

/** One B-rep part group: a picked-eligible mesh plus its pick-only edge
 *  twin, carrying exactly one edge (two points, one segment) at index 0 and
 *  exactly one face (one triangle) at index 0 -- the same shape addBrepModel
 *  builds in production. The material is returned separately so a test can
 *  flip wireframe/transparent directly, reproducing exactly what
 *  applyShadingMode's live material mutation (or
 *  updateSelectedBodyMaterialTint's unconditional opaque-tint) leaves
 *  behind, in whichever order they last ran. */
function brepPartGroup(): { group: THREE.Group; material: THREE.MeshStandardMaterial } {
  const material = new THREE.MeshStandardMaterial({ color: 0x8ab4cc })
  const meshGeometry = new THREE.BufferGeometry()
  meshGeometry.setIndex([0, 1, 2])
  meshGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-5, -5, 0, 5, -5, 0, 0, 5, 0]), 3),
  )
  meshGeometry.userData.faceRanges = new Uint32Array([0, 3])
  const mesh = new THREE.Mesh(meshGeometry, material)
  mesh.userData.isBrepMesh = true
  const edgeLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial(),
  )
  edgeLines.userData.isBrepEdges = true
  edgeLines.geometry.userData.edgeRanges = new Uint32Array([0, 2])
  edgeLines.geometry.userData.edgePositions = new Float32Array([-5, -5, 0, 5, 5, 0])
  const group = new THREE.Group()
  group.add(mesh)
  group.add(edgeLines)
  return { group, material }
}

/** `paintedFill: false` reproduces the "selected but nothing to tint" edge
 *  case (a body with no material, e.g. 2D-only geometry) the resolver must
 *  also fall back safely on -- mirrors what paintPartHighlight really does:
 *  applySelectedBodyMaterialTint only records a tint state when it actually
 *  tints something. `wireframe`/`transparent` are set directly on the part
 *  material to reproduce whatever the LIVE render state actually is at the
 *  moment brepHighlightColorFor runs, independent of currentShadingMode --
 *  the exact thing the audit-fix round's predicate got wrong. */
function makeHarness(
  selectedPartId: string | null,
  opts: { wireframe?: boolean; transparent?: boolean; paintedFill?: boolean; shadingMode?: string } = {},
) {
  const { wireframe = false, transparent = false, paintedFill = true, shadingMode = 'shaded-edges' } = opts
  const vp = Object.create(CNCViewport.prototype) as CNCViewport
  const { group, material } = brepPartGroup()
  material.wireframe = wireframe
  material.transparent = transparent
  const brepHighlights = new Map<string, THREE.Object3D>()
  const partMaterials = new Map<string, THREE.MeshStandardMaterial>([['part-1', material]])
  const partSelectedMaterialStates = new Map<string, unknown>()
  if (selectedPartId !== null && paintedFill) {
    partSelectedMaterialStates.set(selectedPartId, {
      color: new THREE.Color(0x8ab4cc),
      vertexColors: false,
      opacity: 1,
      transparent: false,
    })
  }
  Object.assign(vp, {
    renderer: {
      getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600),
    },
    currentShadingMode: shadingMode,
    partGroups: new Map<string, THREE.Group>([['part-1', group]]),
    geometry2dGroups: new Map<string, THREE.Group>(),
    projectedLoopGroups: new Map<string, THREE.Group>(),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    selectedPartId,
    partPickSelectedIds: new Set<string>(),
    partPickHoverId: null,
    partPickPresentation: null,
    selectionGlow: 'current',
    viewportThemeId: 'classic',
    partSelectedMaterialStates,
    partMaterials,
    // setShadingMode()/applyShadingMode() plumbing -- only exercised by the
    // mode-switch re-resolve test below, but harmless to stub unconditionally.
    materialBaselines: new Map<THREE.MeshStandardMaterial, unknown>(),
    partEdgePositions: new Map<string, Float32Array>(),
    stockGroup: new THREE.Group(),
    partInteractionOutlines: new Map<string, THREE.Object3D>(),
    brepHighlights,
    brepHoverObj: null,
    brepHoverKey: null,
  })
  return { vp, h: priv(vp), group, material, brepHighlights }
}

describe('WO-351 edge/face highlight stays visible on a selected (fill-painted) body', () => {
  it('documents the BEFORE collision: the old tokens do not survive contact', () => {
    // Body fill vs the plain --vp-brep-pick/--vp-brep-hover tokens the
    // highlight used before this fix.
    expect(contrastRatio(asHex('--vp-select-part'), asHex('--vp-brep-pick'))).toBeCloseTo(1, 2)
    expect(contrastRatio(asHex('--vp-select-part'), asHex('--vp-brep-hover'))).toBeLessThan(1.5)
    // Body fill vs the SHIPPED default (GEO-26 'signature' glow): both
    // partInteractionColor('selected', ...) and the pre-fix brepPickColor()
    // read resolveSelectionGlowColors(candidate, theme).selected -- the
    // SAME field -- so a picked edge on a selected body was not just close,
    // it was the mathematically identical number, for every theme.
    const glow = resolveSelectionGlowColors('signature', 'classic')
    expect(glow).not.toBeNull()
    const bodySelectedFill = glow!.selected
    const oldEdgePickColor = glow!.selected // pre-fix brepPickColor() read
    expect(oldEdgePickColor).toBe(bodySelectedFill)
    expect(contrastRatio(
      '#' + bodySelectedFill.toString(16).padStart(6, '0'),
      '#' + oldEdgePickColor.toString(16).padStart(6, '0'),
    )).toBe(1)
  })

  it('the new on-selected tokens clear the non-text contrast floor against both the default and high-contrast body fill', () => {
    const pickRatio = contrastRatio(asHex('--vp-select-part'), asHex('--vp-brep-pick-on-selected'))
    const hoverRatio = contrastRatio(asHex('--vp-select-part'), asHex('--vp-brep-hover-on-selected'))
    expect(pickRatio).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR)
    expect(hoverRatio).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR)
    expect(pickRatio).toBeCloseTo(9.89, 1)
    expect(hoverRatio).toBeCloseTo(8.23, 1)
  })

  it('buildBrepHighlight resolves the on-selected token when the target body is selected and its fill is actually opaque', () => {
    const { h } = makeHarness('part-1', { wireframe: false, transparent: false })
    const picked = h.buildBrepHighlight('part-1', 'edge', 0, 'picked') as Line2
    const hovered = h.buildBrepHighlight('part-1', 'edge', 0, 'hover') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick-on-selected'))
    expect((hovered.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-hover-on-selected'))

    // The whole point: distinguishable from the body's OWN fill colour.
    const highlightHex = '#' + (picked.material as LineMaterial).color.getHexString()
    expect(contrastRatio(asHex('--vp-select-part'), highlightHex)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR)
    // And picked vs hover must still read as two distinct states.
    expect((picked.material as LineMaterial).color.getHex())
      .not.toBe((hovered.material as LineMaterial).color.getHex())
  })

  it('leaves the highlight untouched when the body is NOT selected (no regression)', () => {
    const { h } = makeHarness(null)
    const picked = h.buildBrepHighlight('part-1', 'edge', 0, 'picked') as Line2
    const hovered = h.buildBrepHighlight('part-1', 'edge', 0, 'hover') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))
    expect((hovered.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-hover'))
  })

  it('the picked-body indication is untouched: partInteractionColor still resolves the exact pre-WO-351 selected fill colour', () => {
    // This is the function paintPartHighlight calls to paint the whole-body
    // fill -- WO-351 does not touch it. A selected body still reads as
    // picked; only the edge/face highlight drawn ON it changed.
    const { h } = makeHarness('part-1')
    expect(h.partInteractionColor('selected', false)).toBe(asNumber('--vp-select-part'))
  })
})

// Audit fix round 1 (attempt 2 FAIL): "updateSelectedBodyMaterialTint sets
// opacity 1 / transparent false no matter what the display mode is, so
// gating the swap on currentShadingMode is a false proxy... In Translucent -
// and in Unshaded on a modeled body - a picked body is a solid amber fill
// and the edge highlight falls back to the byte-identical hex, measured
// 1.00:1." The resolver must read the LIVE material state instead of
// inferring it from the mode. This predicate applies to FACE highlights,
// which sit on the fill -- see the round-2 block below for why EDGE
// highlights no longer take this path at all.
describe('WO-351 audit fix round 1: a FACE highlight\'s on-selected swap must read the LIVE material, not infer opacity from the display mode', () => {
  it('selected + an opaque fill actually drawn (wireframe false, transparent false) swaps a FACE highlight to the dark on-selected tokens -- regardless of which mode nominally produced that state', () => {
    // Selection tinted the material opaque LAST (the common real-world
    // order), so Translucent or Unshaded-on-a-modeled-body both leave
    // wireframe=false, transparent=false, same as shaded-edges/
    // shaded-no-edges would -- the fill-opaque check must hold in all four.
    for (const shadingMode of ['shaded-edges', 'shaded-no-edges', 'translucent', 'unshaded']) {
      const { h } = makeHarness('part-1', { wireframe: false, transparent: false, shadingMode })
      const picked = h.buildBrepHighlight('part-1', 'face', 0, 'picked') as Line2
      expect((picked.material as LineMaterial).color.getHex(), `mode=${shadingMode}`)
        .toBe(asNumber('--vp-brep-pick-on-selected'))
    }
  })

  it('selected + wireframe (Unshaded on an imported STEP/STL body -- the tint never touches wireframe) falls back to the bright tokens for a FACE highlight: the face itself is not painted while wireframe, so there is nothing to collide with', () => {
    const { h } = makeHarness('part-1', { wireframe: true, transparent: false, shadingMode: 'unshaded' })
    const picked = h.buildBrepHighlight('part-1', 'face', 0, 'picked') as Line2
    const hovered = h.buildBrepHighlight('part-1', 'face', 0, 'hover') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))
    expect((hovered.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-hover'))

    const canvas = asHex('--vp-canvas')
    const pickHex = '#' + (picked.material as LineMaterial).color.getHexString()
    const hoverHex = '#' + (hovered.material as LineMaterial).color.getHexString()
    expect(contrastRatio(canvas, pickHex)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR)
    expect(contrastRatio(canvas, hoverHex)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR)
  })

  it('selected + genuinely non-opaque (transparent true, e.g. a mode-switch to Translucent that ran AFTER the tint applied) falls back to the bright tokens for a FACE highlight', () => {
    const { h } = makeHarness('part-1', { wireframe: false, transparent: true, shadingMode: 'translucent' })
    const picked = h.buildBrepHighlight('part-1', 'face', 0, 'picked') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))
  })

  it('falls back to the bright tokens if the body is selected but nothing was actually tinted (defensive: no fill to collide with)', () => {
    const { h } = makeHarness('part-1', { wireframe: false, transparent: false, paintedFill: false })
    const picked = h.buildBrepHighlight('part-1', 'face', 0, 'picked') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))
  })

  it('a live display-mode switch re-resolves an ALREADY-BUILT FACE highlight through the real material mutation applyShadingMode performs, so it cannot strand a stale colour when the fill\'s paint state changes under it', () => {
    const { vp, h, brepHighlights, material } = makeHarness('part-1', { wireframe: false, transparent: false, shadingMode: 'shaded-edges' })
    const picked = h.buildBrepHighlight('part-1', 'face', 0, 'picked') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick-on-selected'))
    // Register it exactly where rebuildBrepHighlights/applyShadingMode look for it.
    brepHighlights.set('part-1|face|0', picked)

    vp.setShadingMode('unshaded' as Parameters<typeof vp.setShadingMode>[0])
    // The REAL applyShadingMode -> applyShadingToMaterial path (this mesh
    // has no isModelBodyMesh flag, so it takes the generic/imported-body
    // branch) flips wireframe true for Unshaded -- verify the mutation
    // actually happened, not just the resolved highlight colour. The face
    // is no longer painted, so the highlight must fall back.
    expect(material.wireframe).toBe(true)
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))

    vp.setShadingMode('shaded-edges' as Parameters<typeof vp.setShadingMode>[0])
    expect(material.wireframe).toBe(false)
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick-on-selected'))
  })
})

// Audit fix round 2 (attempt 2 FAIL): "the amber a user sees at an edge on a
// picked body is the selected-body TOPOLOGY OUTLINE (paintPartHighlight ->
// createBodyInteractionOverlay, a 5px stroke along every edge, visible in
// every display mode), so wherever the fill predicate is false the
// highlight falls back to the byte-identical amber that outline already
// draws on that same edge - reproduced in the real app at 1.00:1 in
// Translucent and in Unshaded." An edge highlight's collision surface is the
// body's own selected-outline stroke, which is unconditional -- it does not
// depend on the fill being opaque at all. So an edge highlight must swap to
// the dark on-selected tokens whenever the body is selected, regardless of
// wireframe/transparent.
describe('WO-351 audit fix round 2: an EDGE highlight collides with the selected-body topology OUTLINE, which is drawn in every mode independent of the fill', () => {
  it('selected + wireframe (Unshaded on an imported STEP/STL body, the WO\'s own subject) swaps an EDGE highlight to the dark on-selected tokens -- the body\'s own selected-outline stroke is drawn along this edge in every mode, wireframe or not', () => {
    const { h } = makeHarness('part-1', { wireframe: true, transparent: false, shadingMode: 'unshaded' })
    const picked = h.buildBrepHighlight('part-1', 'edge', 0, 'picked') as Line2
    const hovered = h.buildBrepHighlight('part-1', 'edge', 0, 'hover') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick-on-selected'))
    expect((hovered.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-hover-on-selected'))

    // Distinguishable from the outline it actually lands on -- not the
    // canvas, which is not what is drawn behind a picked body's edge.
    const outlineHex = '#' + h.partInteractionColor('selected', false).toString(16).padStart(6, '0')
    const pickHex = '#' + (picked.material as LineMaterial).color.getHexString()
    const hoverHex = '#' + (hovered.material as LineMaterial).color.getHexString()
    expect(contrastRatio(outlineHex, pickHex)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR)
    expect(contrastRatio(outlineHex, hoverHex)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR)
  })

  it('selected + genuinely non-opaque (transparent true, Translucent landing after the pick, the other reproduced case) swaps an EDGE highlight to the dark on-selected tokens', () => {
    const { h } = makeHarness('part-1', { wireframe: false, transparent: true, shadingMode: 'translucent' })
    const picked = h.buildBrepHighlight('part-1', 'edge', 0, 'picked') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick-on-selected'))
    const outlineHex = '#' + h.partInteractionColor('selected', false).toString(16).padStart(6, '0')
    const pickHex = '#' + (picked.material as LineMaterial).color.getHexString()
    expect(contrastRatio(outlineHex, pickHex)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR)
  })

  it('an EDGE highlight stays on the dark on-selected tokens across every live display-mode switch while the body remains selected -- the outline it collides with never turns off, so the resolved colour must not either', () => {
    const { vp, h, brepHighlights, material } = makeHarness('part-1', { wireframe: false, transparent: false, shadingMode: 'shaded-edges' })
    const picked = h.buildBrepHighlight('part-1', 'edge', 0, 'picked') as Line2
    brepHighlights.set('part-1|edge|0', picked)
    for (const mode of ['unshaded', 'translucent', 'shaded-no-edges', 'shaded-edges'] as const) {
      vp.setShadingMode(mode as Parameters<typeof vp.setShadingMode>[0])
      expect((picked.material as LineMaterial).color.getHex(), `mode=${mode}, wireframe=${material.wireframe}, transparent=${material.transparent}`)
        .toBe(asNumber('--vp-brep-pick-on-selected'))
    }
  })

  it('falls back to the bright tokens if the body is selected but nothing was actually tinted (defensive: no outline was built either, since paintPartHighlight only builds one alongside the tint)', () => {
    const { h } = makeHarness('part-1', { wireframe: false, transparent: false, paintedFill: false })
    const picked = h.buildBrepHighlight('part-1', 'edge', 0, 'picked') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))
  })

  it('resyncBrepHighlightColorsFor updates an existing EDGE overlay when the body-side selection state changes out from under it, even when the fill is left wireframe (the reverse-order case: edge highlighted first, body selection toggles after, on an imported body)', () => {
    const { h, brepHighlights, material } = makeHarness(null, { wireframe: false, transparent: false })
    const picked = h.buildBrepHighlight('part-1', 'edge', 0, 'picked') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))
    brepHighlights.set('part-1|edge|0', picked)

    // Body becomes selected + its fill gets tinted, WITHOUT going through
    // the full paintPartHighlight call graph -- this is exactly the state
    // paintPartHighlight leaves behind right before it calls
    // resyncBrepHighlightColorsFor(id). wireframe stays true here (an
    // imported STEP/STL body, updateSelectedBodyMaterialTint never touches
    // it) -- the exact audit-2 case, now exercised through the resync path.
    h.selectedPartId = 'part-1'
    h.partSelectedMaterialStates.set('part-1', {
      color: new THREE.Color(0x8ab4cc), vertexColors: false, opacity: 1, transparent: false,
    })
    material.wireframe = true
    material.transparent = false
    h.resyncBrepHighlightColorsFor('part-1')
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick-on-selected'))
  })

  it('resyncBrepHighlightColorsFor still applies the fill-opaque check to a FACE overlay in the same reverse-order case (faces did not regress)', () => {
    const { h, brepHighlights, material } = makeHarness(null, { wireframe: false, transparent: false })
    const picked = h.buildBrepHighlight('part-1', 'face', 0, 'picked') as Line2
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))
    brepHighlights.set('part-1|face|0', picked)

    h.selectedPartId = 'part-1'
    h.partSelectedMaterialStates.set('part-1', {
      color: new THREE.Color(0x8ab4cc), vertexColors: false, opacity: 1, transparent: false,
    })
    material.wireframe = true
    material.transparent = false
    h.resyncBrepHighlightColorsFor('part-1')
    // Wireframe: the face itself is not painted, so a face highlight still
    // falls back -- only the edge overlay above is unconditional.
    expect((picked.material as LineMaterial).color.getHex()).toBe(asNumber('--vp-brep-pick'))
  })
})
