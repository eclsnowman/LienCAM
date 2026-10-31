// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { seedGenesisNodes, NODE_ID_BY_BASE_PLANE } from '../../components/model3d/workbench/basePlanes'
import { ExtrudeDialog } from '../../components/model3d/dialogs/ExtrudeDialog'
import { profilePickKey, openChainProfilePick } from '../../components/model3d/workbench/profileRegionPicker'
import { resolveOpenChainProfileSelector, resolveProfileSelector } from '../../components/model3d/workbench/regionSelector'
import * as headless from '../../lib/cam/modelWorkbenchHelpers'
import { reverseSweepPathSelector, type SketchChainPathSelector } from '../../geom/sweep-path'
import type { PlaneDef, ProfileRegion } from '../../geom/geom-service'
import type { SketchEntity } from '../../lib/sketch/types'

afterEach(cleanup)
const S = 'SK1'
const P = NODE_ID_BY_BASE_PLANE.xy
const line = (id: string, x: number, y: number, xx: number, yy: number, construction = false): SketchEntity =>
  ({ id, kind: 'line', start: { x, y }, end: { x: xx, y: yy }, construction })
const u = () => [line('a', 0, 10, 0, 0), line('b', 0, 0, 10, 0), line('c', 10, 0, 10, 10)]
const selector = (...ids: string[]): SketchChainPathSelector => ({ kind: 'sketch-chain', sketchId: S, steps: ids.map(entityId => ({ entityId, forward: true })) })
function fixture(entities = u()) {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  dag.insertNode({ id: S, kind: 'sketch', consumes: [P], payload: { planeNodeId: P, sketch: { id: S, entities, constraints: [], dimensions: [] } } })
  return dag
}
const lookup = (dag: FeatureDag) => (id: string) => dag.getNode(id)
function path(dag: FeatureDag, selected = selector('a', 'b', 'c')) {
  const result = resolveOpenChainProfileSelector(selected, lookup(dag))
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.diagnostic.message)
  return result.path
}

describe('WO-3236 open-chain Extrude selection', () => {
  it('keeps the saved open-chain selection in the dialog instead of highlighting the whole sketch', async () => {
    const dag = fixture()
    const saved = selector('a', 'b', 'c')
    // WO-3324: an open chain is a Thin-only profile since WO-3237 (9806f570b87 lists chains only while Thin is on).
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [S], payload: { opType: 'extrude', sketchId: S, profileSelector: saved, distance: 5, direction: 'up', boolMode: 'newBody', wallMode: 'thin', wallThickness: 1, wallSide: 'center' } })
    const onSelection = vi.fn()
    const onApplied = vi.fn()
    render(<ExtrudeDialog dag={dag} history={new CommandHistory(dag)} mode="edit" featureId="F1" sketchOptions={[{ id: S, label: 'U' }]} onProfileSelectionChange={onSelection} onApplied={onApplied} onClose={() => {}} />)
    expect(onSelection).toHaveBeenLastCalledWith({ sketchId: S, profileSelector: saved })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(dag.getNode('F1')!.payload.profileSelector).toEqual(saved)
    expect(onApplied).toHaveBeenCalledWith('F1')
  })

  it('resolves a U by saved order after entity reorder and coordinate edits', () => {
    const dag = fixture()
    expect(path(dag).segments.map(s => s.srcId)).toEqual(['a', 'b', 'c'])
    const edited = [line('c', 20, 0, 20, 15), line('a', 0, 15, 0, 0), line('b', 0, 0, 20, 0)]
    dag.setPayload(S, { ...dag.getNode(S)!.payload, sketch: { entities: edited, constraints: [] } })
    expect(path(dag).segments).toEqual([
      { kind: 'line', a: [0, 15], b: [0, 0], srcId: 'a' },
      { kind: 'line', a: [0, 0], b: [20, 0], srcId: 'b' },
      { kind: 'line', a: [20, 0], b: [20, 15], srcId: 'c' },
    ])
  })

  it('resolves a straight chain and preserves a deliberate reversal', () => {
    const dag = fixture([line('a', 0, 0, 10, 0), line('b', 10, 0, 20, 0)])
    const back = reverseSweepPathSelector(selector('a', 'b'))
    expect(path(dag, back).segments).toEqual([
      { kind: 'line', a: [20, 0], b: [10, 0], srcId: 'b' },
      { kind: 'line', a: [10, 0], b: [0, 0], srcId: 'a' },
    ])
    expect(profilePickKey(S, back)).not.toBe(profilePickKey(S, selector('a', 'b')))
    expect(profilePickKey(S, selector('a', 'b'))).toBe(profilePickKey(S, {
      kind: 'sketch-chain', sketchId: S, steps: [{ forward: true, entityId: 'a' }, { forward: true, entityId: 'b' }],
    }))
  })

  it('keeps an open arc exact in either direction', () => {
    const dag = fixture([{ id: 'arc', kind: 'arc', construction: false, center: { x: 3, y: 4 }, radius: 5, startAngle: 0, endAngle: Math.PI }])
    expect(path(dag, selector('arc')).segments).toEqual([{ kind: 'arc', c: [3, 4], r: 5, a0: 0, a1: Math.PI, ccw: true, srcId: 'arc' }])
    expect(path(dag, reverseSweepPathSelector(selector('arc'))).segments[0]).toMatchObject({ kind: 'arc', a0: Math.PI, a1: 0, ccw: false })
  })

  it.each([
    ['missing-entity', selector('a', 'gone')],
    ['repeated-entity', selector('a', 'a')],
    ['disconnected', { ...selector('a', 'b'), steps: [{ entityId: 'a', forward: false }, { entityId: 'b', forward: true }] }],
    ['disconnected', selector('a', 'c')],
    ['malformed-selector', { kind: 'sketch-chain', sketchId: S, steps: [] }],
  ])('names %s without substituting another region', (code, selected) => {
    const dag = fixture()
    for (const resolve of [resolveOpenChainProfileSelector, headless.resolveOpenChainProfileSelector]) {
      expect(resolve(selected, lookup(dag))).toMatchObject({ ok: false, diagnostic: { code } })
    }
  })

  it('expands a click through the shared authority and refuses an ambiguous branch', () => {
    const dag = fixture()
    const picked = openChainProfilePick(S, 'b', lookup(dag))
    expect(picked).toMatchObject({ ok: true, pick: { sketchId: S, profileSelector: selector('a', 'b', 'c') } })
    const branched = fixture([...u(), line('branch', 0, 0, -10, 0)])
    expect(openChainProfilePick(S, 'b', lookup(branched))).toMatchObject({ ok: false, diagnostic: { code: 'ambiguous-branch' } })
    // An explicit ordered path through the branch is unambiguous and remains legal.
    expect(path(branched).segments.map(s => s.srcId)).toEqual(['a', 'b', 'c'])
  })

  it.each(['package', 'native'])('excludes construction entities on the %s route', (route) => {
    const dag = fixture([...u(), line('guide', 0, 0, -10, 0, true)])
    if (route === 'native') dag.setPayload(S, { planeNodeId: P, document: { entities: [...u(), line('guide', 0, 0, -10, 0, true)], constraints: [] }, solveResult: { status: 'success' } })
    expect(openChainProfilePick(S, 'b', lookup(dag))).toMatchObject({ ok: true })
    for (const resolve of [resolveOpenChainProfileSelector, headless.resolveOpenChainProfileSelector]) {
      expect(resolve(selector('guide'), lookup(dag))).toMatchObject({ ok: false, diagnostic: { code: 'missing-entity', entityIds: ['guide'] } })
    }
  })

  it('excludes construction blocks and construction members after flattening', () => {
    const block = (construction: boolean): SketchEntity => ({
      id: 'block', kind: 'block', construction, origin: { x: 0, y: 0 }, rotation: 0, scale: 1,
      members: { entities: [line('member', 0, 0, 10, 0), line('guide', 10, 0, 20, 0, true)], constraints: [], dimensions: [] },
    })
    const dag = fixture([block(false)])
    expect(path(dag, selector('member')).segments[0]).toMatchObject({ srcId: 'member', a: [0, 0], b: [10, 0] })
    expect(resolveOpenChainProfileSelector(selector('guide'), lookup(dag))).toMatchObject({ ok: false, diagnostic: { code: 'missing-entity' } })
    const construction = fixture([block(true)])
    expect(resolveOpenChainProfileSelector(selector('member'), lookup(construction))).toMatchObject({ ok: false, diagnostic: { code: 'missing-entity' } })
  })

  it('re-resolves the current sketch frame and names a missing frame', () => {
    const dag = fixture()
    const frame: PlaneDef = { origin: { x: 3, y: 7, z: 11 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }
    dag.setPayload(P, { ...dag.getNode(P)!.payload, lastGoodFrame: frame })
    expect(path(dag).plane).toEqual(frame)
    expect(headless.resolveOpenChainProfileSelector(selector('a', 'b', 'c'), lookup(dag))).toEqual(resolveOpenChainProfileSelector(selector('a', 'b', 'c'), lookup(dag)))
    dag.setPayload(P, {})
    expect(resolveOpenChainProfileSelector(selector('a'), lookup(dag))).toMatchObject({ ok: false, diagnostic: { code: 'unresolved-plane' } })
  })

  it('leaves closed-profile semantics intact and never treats a chain as a face', () => {
    const closed: ProfileRegion = { sketchId: S, plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }, loops: [[{ kind: 'line', a: [0, 0], b: [1, 0], srcId: 'closed' }]] }
    for (const resolve of [resolveProfileSelector, headless.resolveProfileSelector]) {
      expect(resolve([closed], undefined)).toEqual({ ok: true, profiles: [closed] })
      expect(resolve([closed], { kind: 'region', signature: ['closed'] })).toEqual({ ok: true, profiles: [closed] })
      expect(resolve([closed], selector('a'))).toMatchObject({ ok: false, code: 'open-chain-requires-thin' })
    }
  })
})
