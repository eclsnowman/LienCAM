// Project / Use from other layers (Stage 6) - model-level predicates +
// the store-level click path (a baked rectangle loop projects into the
// active sketch as fixed real or deliberately construction geometry).
//
// The store talks to a solver Worker and zustand persist storage; both
// are stubbed before the store module is imported (node test env), same
// pattern as sketchEntry.test.ts.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import {
  isProjectableLayer,
  projectCandidates,
  resolveProjectHit,
  loopOutline,
  buildProjectCommit,
  PROJECT_SOURCE_KINDS,
  type ProjectCandidate,
  type ProjectSourceKind,
} from '../../lib/sketch/projectUse'
import type { ImportedGeometry, Loop2D } from '../../types'
import type { FixConstraint, SketchLineEntity } from '../../lib/sketch/types'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  // The store import binds the CAM document sink into the package (module-load
  // side effect), so it MUST come before anything drives sketcherTools.
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

// ---- Fixtures ----------------------------------------------------------

const rectLoop = (layerId: string, id = 'loop-rect'): Loop2D => ({
  id,
  points: [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 },
  ],
  closed: true,
  type: 'contour',
  layerId,
  area: 200,
})

function dxfGeo(overrides: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'dxf-1', name: 'part', filename: 'part.dxf', type: 'curves_2d',
    format: 'dxf', loaded: true,
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
      size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loops: [rectLoop('l1')],
    layers2d: [{ id: 'l1', name: 'Outline', color: '#fff', visible: true }],
    ...overrides,
  }
}

const candidate = (paths: readonly Loop2D[], kind: ProjectSourceKind = 'cam-layer-loop'): ProjectCandidate => ({
  paths,
  sourceKind: kind,
  sourceLabel: 'Outline',
  stablePickKey: `${kind}:fixture`,
})

// ---- Model-level predicates ---------------------------------------------

describe('isProjectableLayer / projectCandidates', () => {
  const formatCensus = {
    stl: false,
    step: false,
    iges: false,
    obj: false,
    dxf: true,
    svg: true,
    sketch: true,
    model: false,   // INT-17A: a model-backed entry is not a projectable 2D layer source
  } satisfies Record<ImportedGeometry['format'], boolean>

  it.each(Object.entries(formatCensus))(
    'derives format eligibility from the complete ImportedGeometry domain: %s -> %s',
    (format, expected) => {
      const geo = dxfGeo({ format: format as ImportedGeometry['format'] })
      expect(isProjectableLayer(geo, geo.layers2d![0], 'sketch-layer')).toBe(expected)
    },
  )

  it('runtime source-kind census has one constructible candidate for every shared source kind', () => {
    const fixtures = Object.fromEntries(
      PROJECT_SOURCE_KINDS.map((kind) => [kind, candidate([rectLoop('l1')], kind)]),
    ) as Record<ProjectSourceKind, ProjectCandidate>
    expect(Object.keys(fixtures).sort()).toEqual([...PROJECT_SOURCE_KINDS].sort())
    for (const kind of PROJECT_SOURCE_KINDS) expect(fixtures[kind].sourceKind).toBe(kind)
  })

  it('a visible 2D layer that is not the active sketch layer is projectable', () => {
    const geo = dxfGeo()
    expect(isProjectableLayer(geo, geo.layers2d![0], 'sketch-layer')).toBe(true)
    expect(projectCandidates([geo], 'sketch-layer')).toHaveLength(1)
  })

  it('a NON-VISIBLE layer is not hoverable (model-level predicate)', () => {
    const geo = dxfGeo({
      layers2d: [{ id: 'l1', name: 'Outline', color: '#fff', visible: false }],
    })
    expect(isProjectableLayer(geo, geo.layers2d![0], 'sketch-layer')).toBe(false)
    expect(projectCandidates([geo], 'sketch-layer')).toHaveLength(0)
  })

  it('the active sketch own layer is excluded (edit, not project)', () => {
    const geo = dxfGeo()
    expect(isProjectableLayer(geo, geo.layers2d![0], 'l1')).toBe(false)
    expect(projectCandidates([geo], 'l1')).toHaveLength(0)
  })

  it('LOCKED visible layers remain projectable (read-only consume)', () => {
    const geo = dxfGeo({
      layers2d: [{ id: 'l1', name: 'Outline', color: '#fff', visible: true, locked: true }],
    })
    expect(isProjectableLayer(geo, geo.layers2d![0], 'sketch-layer')).toBe(true)
  })

  it('STL-projection layers (off-plane) and STL geometry are excluded', () => {
    const planeLayer = {
      id: 'l1', name: 'Proj', color: '#fff', visible: true,
      projectionPlane: {
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
    }
    expect(isProjectableLayer(dxfGeo(), planeLayer, 'other')).toBe(false)
    const stl = dxfGeo({ format: 'stl' })
    expect(isProjectableLayer(stl, { id: 'l1', name: 'x', color: '#fff', visible: true } as never, 'other')).toBe(false)
  })
})

describe('resolveProjectHit', () => {
  const candidates = projectCandidates([dxfGeo()], 'sketch-layer')

  it('clicking near an edge hits the loop (closing edge included)', () => {
    const first = resolveProjectHit(candidates, { x: 10, y: 0.3 }, 0.5)
    expect(first.ok && first.candidate.paths[0].id).toBe('loop-rect')
    // Closing edge (0,10)-(0,0):
    const closing = resolveProjectHit(candidates, { x: 0.3, y: 5 }, 0.5)
    expect(closing.ok && closing.candidate.paths[0].id).toBe('loop-rect')
  })

  it('clicking far from every loop misses', () => {
    expect(resolveProjectHit(candidates, { x: 50, y: 50 }, 0.5)).toMatchObject({ ok: false, reason: 'miss' })
    // Interior is not the outline: the loop is hit by its edges.
    expect(resolveProjectHit(candidates, { x: 10, y: 5 }, 0.5)).toMatchObject({ ok: false, reason: 'miss' })
  })

  it('loopOutline closes the highlight polyline', () => {
    const outline = loopOutline(candidates[0].paths[0])
    expect(outline).toHaveLength(5)
    expect(outline[4]).toEqual(outline[0])
  })
})

describe('buildProjectCommit', () => {
  it('a baked rectangle loop -> 4 construction lines, each FIXED, plus its 4 chain-joint coincidents', () => {
    let n = 0
    const built = buildProjectCommit(candidate([rectLoop('l1')]), true, () => `id${n++}`)
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error(built.message)
    const commit = built.commit
    const lines = commit.entities as SketchLineEntity[]
    expect(lines).toHaveLength(4)
    expect(lines.every((l) => l.kind === 'line' && l.construction)).toBe(true)
    expect(lines.every((l) => l.provenance === 'projected')).toBe(true)
    // Geometry mirrors the loop exactly (lift mapping).
    expect(lines[0]).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 20, y: 0 } })
    expect(lines[3]).toMatchObject({ start: { x: 0, y: 10 }, end: { x: 0, y: 0 } })
    // WO-1476: one whole-entity fix per entity PLUS the lift's chain-joint
    // coincidents (kept, not dropped) so an untouched joint stays tied
    // together even after a later edit frees a neighboring entity's fix.
    expect(commit.constraints).toHaveLength(8)
    const fixes = commit.constraints.filter((c) => c.kind === 'fix') as FixConstraint[]
    const coincidents = commit.constraints.filter((c) => c.kind === 'coincident')
    expect(fixes).toHaveLength(4)
    expect(coincidents).toHaveLength(4)
    expect(fixes.every((c) => c.projectionGrounding === true)).toBe(true)
    expect(lines.every((entity) => entity.projectionDetached === undefined)).toBe(true)
    expect(fixes.map((c) => c.entityId).sort()).toEqual(lines.map((l) => l.id).sort())
  })

  it('respects construction=false (normal projection)', () => {
    const built = buildProjectCommit(candidate([rectLoop('l1')]), false)
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error(built.message)
    expect(built.commit.entities.every((e) => !e.construction)).toBe(true)
    expect(built.commit.entities.every((e) => e.provenance === 'projected')).toBe(true)
  })

  it('commits a face outer+hole group atomically and fixes every emitted entity', () => {
    const hole = {
      ...rectLoop('l1', 'hole'),
      points: [{ x: 5, y: 3 }, { x: 15, y: 3 }, { x: 15, y: 7 }, { x: 5, y: 7 }],
      type: 'hole' as const,
      area: 40,
    }
    const built = buildProjectCommit(candidate([rectLoop('l1'), hole], 'model-face'), false)
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error(built.message)
    expect(built.commit.entities).toHaveLength(8)
    // WO-1476: 8 whole-entity fixes + 4 chain-joint coincidents per closed
    // 4-line loop (outer + hole) = 16.
    expect(built.commit.constraints).toHaveLength(16)
    expect(built.commit.constraints.filter((constraint) => constraint.kind === 'fix')).toHaveLength(8)
    expect(built.commit.constraints.filter((constraint) => constraint.kind === 'coincident')).toHaveLength(8)
  })

  it('an edge is one open path and never invents a closing segment', () => {
    const edge: Loop2D = {
      id: 'edge', layerId: 'model', type: 'open', closed: false, area: 0,
      points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }],
    }
    const built = buildProjectCommit(candidate([edge], 'model-edge'), false)
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error(built.message)
    const lines = built.commit.entities as SketchLineEntity[]
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => [line.start, line.end])).not.toContainEqual([
      { x: 5, y: 5 }, { x: 0, y: 0 },
    ])
  })

  it('refuses the whole group by name when any path is unliftable', () => {
    const collapsed: Loop2D = {
      id: 'collapsed', layerId: 'model', type: 'open', closed: false, area: 0,
      points: [{ x: 2, y: 2 }, { x: 2, y: 2 }],
    }
    expect(buildProjectCommit(candidate([rectLoop('l1'), collapsed], 'model-face'), false))
      .toMatchObject({ ok: false, reason: 'unliftable-path' })
  })

  it('repeated manual projections use the injected UUID source without collisions', () => {
    let n = 0
    const ids = () => `uuid-${n++}`
    const a = buildProjectCommit(candidate([rectLoop('l1')]), false, ids)
    const b = buildProjectCommit(candidate([rectLoop('l1')]), false, ids)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) throw new Error('expected two commits')
    const first = new Set([...a.commit.entities, ...a.commit.constraints].map((item) => item.id))
    expect([...b.commit.entities, ...b.commit.constraints].every((item) => !first.has(item.id))).toBe(true)
  })
})

// ---- Store-level click path ----------------------------------------------

describe('project tool in the store (sketchToolClick)', () => {
  beforeEach(() => {
    useCamStore.setState((s) => ({
      activeSketch: null,
      sketchSolveStatus: null,
      sketchSelectedIds: [],
      sketchNotice: null,
      viewer: { ...s.viewer, mode: 'setup' },
      project: { ...s.project, geometry: [dxfGeo()] },
    }))
    // Armed tool, chain and construction mode now live in the package.
    sketcherToolStore.__reset()
  })

  it('arming Project preserves the current construction mode instead of forcing it on', () => {
    expect(sketcherToolStore.getState().constructionMode).toBe(false)
    sketcherTools.armTool('project')
    expect(sketcherToolStore.getState().constructionMode).toBe(false)
    sketcherTools.toggleConstruction()
    expect(sketcherToolStore.getState().constructionMode).toBe(true)
    sketcherTools.armTool('select')
    expect(sketcherToolStore.getState().constructionMode).toBe(true)
    sketcherTools.armTool('project')
    expect(sketcherToolStore.getState().constructionMode).toBe(true)
  })

  it('clicking a baked rectangle loop projects 4 fixed real lines into the active sketch by default', () => {
    const s = useCamStore.getState()
    s.setViewerMode('sketch') // auto-creates a blank "Sketch 1" document
    sketcherTools.armTool('project')
    // Click on the rectangle's bottom edge.
    sketcherTools.click({ x: 10, y: 0.1 }, 0.5, null, false)
    const sk = useCamStore.getState().activeSketch!
    // WO SKC-49: 4 projected lines + 3 injected origin/axis anchors.
    expect(sk.entities).toHaveLength(7)
    const projected = sk.entities.filter((e) => !e.construction)
    expect(projected).toHaveLength(4)
    expect(projected.every((e) => e.kind === 'line')).toBe(true)
    // WO-1476: 4 projected fixes + 4 chain-joint coincidents (closed loop) + 3 injected anchor fixes.
    expect(sk.constraints).toHaveLength(11)
    expect(sk.constraints.filter((c) => c.kind === 'fix')).toHaveLength(7)
    expect(sk.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(4)
    expect(useCamStore.getState().sketchNotice).toMatch(/Projected 4 entities/)
    expect(useCamStore.getState().sketchNotice).not.toMatch(/construction entities/)
    // Static copy honesty is surfaced to the user.
    expect(useCamStore.getState().sketchNotice).toMatch(/no live link/)
  })

  // WO-1864: a model source carries its identity, so its pieces commit LINKED and the notice says
  // so; the CAM loop above has no model to follow and keeps the static-copy wording.
  const modelEdge = (): ProjectCandidate => ({
    paths: [{
      id: 'model-edge:F1:e:0', points: [{ x: 0, y: 5 }, { x: 30, y: 5 }], closed: false,
      type: 'open', layerId: 'model:F1', area: 0,
    }],
    sourceKind: 'model-edge',
    sourceLabel: 'Edge (F1:a∧F1:b)',
    stablePickKey: 'model-edge:F1:(F1:a∧F1:b)',
    sourceIdentity: { bodyId: 'F1', cacheVersion: 1, stableId: '(F1:a∧F1:b)' },
  })

  it('WO-1864: a linked model projection says it follows the model, and its pieces carry the link', () => {
    useCamStore.getState().setViewerMode('sketch')
    sketcherTools.armTool('project')
    sketcherTools.click({ x: 10, y: 5 }, 0.5, null, false, undefined, { ok: true, candidate: modelEdge() })
    const notice = useCamStore.getState().sketchNotice ?? ''
    expect(notice).toMatch(/Projected 1 entity from "Edge \(F1:a∧F1:b\)"/)
    expect(notice).toMatch(/linked - follows the model/)
    expect(notice).not.toMatch(/no live link/)
    const linked = useCamStore.getState().activeSketch!.entities.filter((e) => e.projectionLink !== undefined)
    expect(linked).toHaveLength(1)
    expect(linked[0].projectionLink).toMatchObject({
      sourceKind: 'model-edge', bodyId: 'F1', stableId: '(F1:a∧F1:b)', path: 0, piece: 0, pathPieces: 1,
    })
    expect(linked[0].provenance).toBe('projected')
  })

  it('WO-1864: Break model link keeps the piece exactly where it is, grounded, and is one undo step', () => {
    useCamStore.getState().setViewerMode('sketch')
    sketcherTools.armTool('project')
    sketcherTools.click({ x: 10, y: 5 }, 0.5, null, false, undefined, { ok: true, candidate: modelEdge() })
    const before = useCamStore.getState().activeSketch!
    const piece = before.entities.find((e) => e.projectionLink !== undefined) as SketchLineEntity
    // Nothing selected: explains itself, changes nothing.
    useCamStore.getState().setSketchSelection([])
    sketcherTools.breakProjectionLink()
    expect(useCamStore.getState().sketchNotice).toMatch(/select projected geometry that follows the model/)
    expect(useCamStore.getState().activeSketch).toBe(before)

    useCamStore.getState().setSketchSelection([piece.id])
    sketcherTools.breakProjectionLink()
    const after = useCamStore.getState().activeSketch!
    const broken = after.entities.find((e) => e.id === piece.id) as SketchLineEntity
    expect(broken.projectionLink).toBeUndefined()
    expect(broken.provenance).toBe('projected')
    expect(broken.start).toEqual(piece.start)
    expect(broken.end).toEqual(piece.end)
    expect(after.constraints.some((c) => c.kind === 'fix' && c.entityId === piece.id)).toBe(true)
    expect(useCamStore.getState().sketchNotice).toMatch(/Model link broken on 1 entity/)
    useCamStore.getState().undo()
    const undone = useCamStore.getState().activeSketch!.entities.find((e) => e.id === piece.id)
    expect(undone?.projectionLink).toEqual(piece.projectionLink)
  })

  it('Construction/Q mode deliberately projects fixed construction geometry', () => {
    const s = useCamStore.getState()
    s.setViewerMode('sketch')
    sketcherTools.toggleConstruction()
    sketcherTools.armTool('project')
    sketcherTools.click({ x: 10, y: 0.1 }, 0.5, null, false)
    const sk = useCamStore.getState().activeSketch!
    // WO SKC-49: 4 projected construction lines + 3 injected anchors (also construction:true).
    expect(sk.entities).toHaveLength(7)
    expect(sk.entities.every((entity) => entity.construction)).toBe(true)
    // WO-1476: 4 projected fixes + 4 chain-joint coincidents (closed loop) + 3 injected anchor fixes.
    expect(sk.constraints.filter((constraint) => constraint.kind === 'fix')).toHaveLength(7)
    expect(sk.constraints.filter((constraint) => constraint.kind === 'coincident')).toHaveLength(4)
    expect(useCamStore.getState().sketchNotice).toMatch(/Projected 4 construction entities/)
  })

  it('a miss explains itself and changes nothing', () => {
    const s = useCamStore.getState()
    s.setViewerMode('sketch')
    sketcherTools.armTool('project')
    sketcherTools.click({ x: 100, y: 100 }, 0.5, null, false)
    // WO SKC-49: a miss adds no NEW entities, but the blank sketch already owns the three
    // injected origin/axis anchors (not zero).
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(3)
    expect(useCamStore.getState().sketchNotice).toMatch(/Project: click a loop/)
  })

  it('a loop on a hidden layer cannot be projected', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [dxfGeo({
          layers2d: [{ id: 'l1', name: 'Outline', color: '#fff', visible: false }],
        })],
      },
    }))
    const s = useCamStore.getState()
    s.setViewerMode('sketch')
    sketcherTools.armTool('project')
    sketcherTools.click({ x: 10, y: 0.1 }, 0.5, null, false)
    // WO SKC-49: a miss adds no NEW entities, but the blank sketch already owns the three
    // injected origin/axis anchors (not zero).
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(3)
  })

  it('a LOCKED layer still projects (read-only consume)', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [dxfGeo({
          layers2d: [{
            id: 'l1', name: 'Outline', color: '#fff', visible: true, locked: true,
          }],
        })],
      },
    }))
    const s = useCamStore.getState()
    s.setViewerMode('sketch')
    sketcherTools.armTool('project')
    sketcherTools.click({ x: 10, y: 0.1 }, 0.5, null, false)
    // WO SKC-49: 4 projected lines + 3 injected anchors.
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(7)
  })
})
