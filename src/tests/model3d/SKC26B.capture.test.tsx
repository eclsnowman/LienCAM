// @vitest-environment jsdom
//
// Headless PLAN 7.3 acceptance capture for SKC-26B. This drives the real
// WorkbenchToolRail, shared Sketcher pointer owner, workbench document port,
// session store, FeatureDag, and CommandHistory. The companion capture runner
// also invokes SolidsWorkbenchPage.sketchOnFace.test.tsx, which owns the real
// Project -> Finish -> Extrude kernel outcome.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedGenesisNodes, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { WorkbenchToolRail } from '../../components/model3d/workbench/WorkbenchToolRail'
import {
  WORKBENCH_ORIGIN_ENTITY_ID,
  WORKBENCH_ORIGIN_FIX_ID,
  WORKBENCH_AXIS_X_ENTITY_ID,
  WORKBENCH_AXIS_X_FIX_ID,
  WORKBENCH_AXIS_Y_ENTITY_ID,
  WORKBENCH_AXIS_Y_FIX_ID,
} from '../../components/model3d/workbench/workbenchOriginAnchor'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  __resetSketchDocumentPort,
  syncSketchSessionFromDag,
  workbenchSketchDocumentPort,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import {
  createWorkbenchSketcherHost,
  makePlaneFrameGroup,
} from '../../components/model3d/workbench/workbenchSketcherHost'
import { CommandHistory, ElementMap, FeatureDag, RegenScheduler } from '../../doc'
import type { ProjectCandidate, ProjectResolveResult } from '../../lib/sketch/projectUse'
import { Sketcher, sketcherToolStore, sketcherTools, type Sketch } from '../../lib/sketch/sketcher'
import type { Loop2D } from '../../types'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'

const SKETCH_NODE_ID = 'sketch3d:capture'

function blankSketch(): Sketch {
  return {
    id: 'capture',
    layerId: 'workbench',
    entities: [],
    constraints: [],
    dimensions: [],
    solveStatus: null,
  }
}

function projectPath(id: string, points: Loop2D['points'], closed: boolean): Loop2D {
  return {
    id,
    points,
    closed,
    type: closed ? 'contour' : 'open',
    layerId: 'model:capture-body',
    area: 0,
  }
}

function candidate(
  sourceKind: 'model-edge' | 'model-face',
  paths: readonly Loop2D[],
  stableId: string,
): ProjectCandidate {
  return {
    paths,
    sourceKind,
    sourceLabel: sourceKind === 'model-edge' ? 'Capture edge' : 'Capture face',
    stablePickKey: `${sourceKind}:capture-body:${stableId}`,
    sourceIdentity: { bodyId: 'capture-body', cacheVersion: 1, stableId },
  }
}

const EDGE = candidate('model-edge', [projectPath(
  'edge-path',
  [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 4 }],
  false,
)], 'edge-1')

const FACE = candidate('model-face', [
  projectPath(
    'outer-path',
    [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
    true,
  ),
  projectPath(
    'hole-path',
    [{ x: 5, y: 3 }, { x: 15, y: 3 }, { x: 15, y: 7 }, { x: 5, y: 7 }],
    true,
  ),
], 'face-1')

const INVALID = candidate('model-edge', [projectPath(
  'invalid-path',
  [{ x: 0, y: 0 }, { x: Number.NaN, y: 2 }],
  false,
)], 'invalid-1')

type ResolverMode = 'edge' | 'face' | 'miss' | 'invalid'

interface CaptureMount {
  canvas: HTMLCanvasElement
  dag: FeatureDag
  history: CommandHistory
  historySteps: string[]
  notices: string[]
  overlayRoot: THREE.Group
  sketcher: Sketcher
  setMode(mode: ResolverMode): void
  resolverCalls(): number
  dispose(): void
}

function mountCapture(): CaptureMount {
  const canvas = document.createElement('canvas')
  const container = document.createElement('div')
  container.appendChild(canvas)
  document.body.appendChild(container)

  const rect = {
    left: 0, top: 0, width: 800, height: 600,
    right: 800, bottom: 600, x: 0, y: 0,
  } as DOMRect
  canvas.getBoundingClientRect = () => rect
  container.getBoundingClientRect = () => rect
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => (
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        ? canvas
        : null
    ),
  })

  const runtime = createFakeSceneRuntime()
  const frame = BASE_PLANE_FRAMES.xy
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  camera.position.set(0, 0, 100)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  runtime.camera = camera

  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  const history = new CommandHistory(dag)
  const scheduler = new RegenScheduler(dag, new ElementMap())
  dag.insertNode({
    id: SKETCH_NODE_ID,
    kind: 'sketch',
    consumes: [],
    refs: [],
    payload: { sketch: blankSketch(), externalRefs: [], dimensionDiagnostics: [] },
  }, dag.featureOrder().length)

  let mode: ResolverMode = 'edge'
  let calls = 0
  let disposed = false
  const historySteps: string[] = []
  const notices: string[] = []
  const resolveProjectSource = (): ProjectResolveResult => {
    calls++
    if (mode === 'miss') {
      return { ok: false, reason: 'miss', message: 'Project: no visible model source here' }
    }
    return { ok: true, candidate: mode === 'edge' ? EDGE : mode === 'face' ? FACE : INVALID }
  }

  const overlayRoot = makePlaneFrameGroup(frame)
  const sketcher = new Sketcher(createWorkbenchSketcherHost({
    canvas,
    container,
    runtime,
    overlayRoot,
    getFrame: () => frame,
  }))
  sketchSessionStore.bindDeps({
    dag,
    history,
    scheduler,
    wrapper: null,
    notice: (message) => { notices.push(message) },
    resolveProjectSource,
    onDocumentChanged: () => {
      sketcher.updateSketch(sketchSessionStore.getState().sketch)
    },
    onHistoryStep: (id) => { historySteps.push(id) },
  })
  sketcher.setDocumentPort(workbenchSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => { workbenchSketchDocumentPort.beginStep() } })
  sketchSessionStore.begin(SKETCH_NODE_ID, frame, blankSketch())
  sketcher.enter()
  sketcher.updateSketch(sketchSessionStore.getState().sketch)

  render(
    <WorkbenchToolRail
      sketchActive
      modelingSections={[]}
      sketchHistoryTools={[]}
      onFinishSketch={() => {}}
    />,
  )

  return {
    canvas,
    dag,
    history,
    historySteps,
    notices,
    overlayRoot,
    sketcher,
    setMode: (next) => { mode = next },
    resolverCalls: () => calls,
    dispose: () => {
      if (disposed) return
      disposed = true
      sketcher.dispose()
    },
  }
}

function persistedSketch(mount: CaptureMount): Sketch {
  return (mount.dag.getNode(SKETCH_NODE_ID)!.payload as { sketch: Sketch }).sketch
}

function persistedSnapshot(mount: CaptureMount): string {
  const payload = mount.dag.getNode(SKETCH_NODE_ID)!.payload as {
    sketch: Sketch
    externalRefs: unknown[]
  }
  return JSON.stringify({ sketch: payload.sketch, externalRefs: payload.externalRefs })
}

function previewLines(mount: CaptureMount): THREE.Line[] {
  return mount.overlayRoot.children.filter((child): child is THREE.Line => child instanceof THREE.Line)
}

function pointer(target: EventTarget, type: string, x = 400, y = 300): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  target.dispatchEvent(event)
}

function occlusionTarget(x = 400, y = 300): EventTarget {
  const target = document.elementFromPoint(x, y)
  if (!(target instanceof HTMLCanvasElement)) {
    throw new Error('capture pointer was occluded before reaching the sketch canvas')
  }
  return target
}

function hover(mount: CaptureMount): void {
  expect(occlusionTarget()).toBe(mount.canvas)
  pointer(occlusionTarget(), 'pointermove')
}

function click(mount: CaptureMount): void {
  expect(occlusionTarget()).toBe(mount.canvas)
  pointer(occlusionTarget(), 'pointerdown')
  pointer(occlusionTarget(), 'pointerup')
}

function armProject(): void {
  fireEvent.click(screen.getByTestId('workbench-package-tool-project'))
}

let restoreCanvas: (() => void) | null = null
let mounted: CaptureMount | null = null

beforeEach(() => {
  restoreCanvas = stubCanvas2d()
  sketcherToolStore.__reset()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
})

afterEach(() => {
  mounted?.dispose()
  mounted = null
  cleanup()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
  sketcherToolStore.__reset()
  restoreCanvas?.()
  restoreCanvas = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('SKC-26B headless capture acceptance', () => {
  it('starts persisted-blank with the session origin and arms the shared Utility Project tool', () => {
    mounted = mountCapture()
    const payload = mounted.dag.getNode(SKETCH_NODE_ID)!.payload as {
      sketch: Sketch
      externalRefs: unknown[]
    }

    expect(payload.sketch.entities).toEqual([])
    expect(payload.sketch.constraints).toEqual([])
    expect(payload.externalRefs).toEqual([])

    const active = sketchSessionStore.getState().sketch!
    // WO SKC-49: session begin() now injects the origin point PLUS both axis lines (three
    // anchors), deliberately (not accidentally) -- this was one of the three preflight-named
    // hard-coded injected-set==origin-only assertions due to break.
    expect(active.entities.map((entity) => entity.id)).toEqual([
      WORKBENCH_ORIGIN_ENTITY_ID, WORKBENCH_AXIS_X_ENTITY_ID, WORKBENCH_AXIS_Y_ENTITY_ID,
    ])
    expect(active.constraints.map((constraint) => constraint.id)).toEqual([
      WORKBENCH_ORIGIN_FIX_ID, WORKBENCH_AXIS_X_FIX_ID, WORKBENCH_AXIS_Y_FIX_ID,
    ])

    const utility = screen.getByTestId('workbench-rail-section-utility')
    const projectButtons = screen.getAllByTestId('workbench-package-tool-project')
    expect(projectButtons).toHaveLength(1)
    expect(utility.contains(projectButtons[0])).toBe(true)
    expect(projectButtons[0].textContent).toContain('Project / Use')

    armProject()
    expect(sketcherToolStore.getState().tool).toBe('project')
    expect(projectButtons[0].getAttribute('aria-pressed')).toBe('true')
  })

  it('previews and commits an edge and grouped face as one history step each', () => {
    mounted = mountCapture()
    armProject()

    mounted.setMode('edge')
    hover(mounted)
    expect(previewLines(mounted)).toHaveLength(1)
    const beforeEdgeSteps = mounted.historySteps.length
    click(mounted)

    expect(mounted.historySteps).toHaveLength(beforeEdgeSteps + 1)
    expect(persistedSketch(mounted).entities).toHaveLength(2)
    expect(persistedSketch(mounted).entities.every((entity) => entity.construction === false)).toBe(true)
    // WO-1476: one fix per projected entity plus the open edge chain's single joint coincident.
    expect(persistedSketch(mounted).constraints).toHaveLength(3)
    expect(persistedSketch(mounted).constraints.filter((constraint) => constraint.kind === 'fix')).toHaveLength(2)
    expect(persistedSketch(mounted).constraints.filter((constraint) => constraint.kind === 'coincident')).toHaveLength(1)

    mounted.history.undo()
    syncSketchSessionFromDag()
    mounted.sketcher.updateSketch(sketchSessionStore.getState().sketch)
    expect(persistedSketch(mounted).entities).toEqual([])
    expect(persistedSketch(mounted).constraints).toEqual([])

    mounted.setMode('face')
    hover(mounted)
    expect(previewLines(mounted)).toHaveLength(2)
    const beforeFaceSteps = mounted.historySteps.length
    click(mounted)

    expect(mounted.historySteps).toHaveLength(beforeFaceSteps + 1)
    expect(persistedSketch(mounted).entities).toHaveLength(8)
    expect(persistedSketch(mounted).entities.every((entity) => entity.construction === false)).toBe(true)
    // WO-1476: 8 fixes plus 4 joint coincidents per closed 4-line loop (outer + hole).
    expect(persistedSketch(mounted).constraints).toHaveLength(16)
    expect(persistedSketch(mounted).constraints.filter((constraint) => constraint.kind === 'fix')).toHaveLength(8)
    expect(persistedSketch(mounted).constraints.filter((constraint) => constraint.kind === 'coincident')).toHaveLength(8)

    mounted.history.undo()
    syncSketchSessionFromDag()
    expect(persistedSketch(mounted).entities).toEqual([])
    expect(persistedSketch(mounted).constraints).toEqual([])
  })

  it('keeps misses and invalid sources immutable and clears every lifecycle tail', () => {
    mounted = mountCapture()
    armProject()
    const initial = persistedSnapshot(mounted)
    const initialSteps = mounted.historySteps.length

    // DOM occlusion: dispatch through the browser-resolved target, exactly as
    // a real overlay blocking the canvas would receive the gesture. Because
    // the package's one pointer owner is attached to the canvas, the blocker
    // must not reach the Project resolver or open a history step.
    const blocker = document.createElement('div')
    blocker.dataset.testid = 'capture-pointer-blocker'
    document.body.appendChild(blocker)
    const priorElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => blocker),
    })
    try {
      const resolvedTarget = document.elementFromPoint(400, 300)
      expect(resolvedTarget).toBe(blocker)
      const callsBeforeOcclusion = mounted.resolverCalls()
      pointer(resolvedTarget!, 'pointerdown')
      pointer(resolvedTarget!, 'pointerup')
      expect(mounted.resolverCalls()).toBe(callsBeforeOcclusion)
      expect(mounted.historySteps).toHaveLength(initialSteps)
      expect(persistedSnapshot(mounted)).toBe(initial)
    } finally {
      blocker.remove()
      if (priorElementFromPoint === undefined) {
        delete (document as Partial<Document>).elementFromPoint
      } else {
        Object.defineProperty(document, 'elementFromPoint', priorElementFromPoint)
      }
    }

    mounted.setMode('miss')
    hover(mounted)
    expect(previewLines(mounted)).toHaveLength(0)
    expect(mounted.canvas.style.cursor).toBe('crosshair')
    click(mounted)
    expect(persistedSnapshot(mounted)).toBe(initial)
    expect(mounted.historySteps).toHaveLength(initialSteps)
    expect(sketcherToolStore.getState().tool).toBe('project')

    mounted.setMode('invalid')
    click(mounted)
    expect(persistedSnapshot(mounted)).toBe(initial)
    expect(mounted.historySteps).toHaveLength(initialSteps)
    expect(mounted.notices.join('\n')).toMatch(/invalid coordinate/i)

    mounted.setMode('edge')
    hover(mounted)
    expect(previewLines(mounted)).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(previewLines(mounted)).toHaveLength(0)
    expect(sketcherToolStore.getState().tool).not.toBe('project')

    armProject()
    hover(mounted)
    expect(previewLines(mounted)).toHaveLength(1)
    act(() => { sketcherTools.armTool('select') })
    mounted.sketcher.onFrame(1, 800, 600)
    expect(previewLines(mounted)).toHaveLength(0)

    armProject()
    hover(mounted)
    expect(previewLines(mounted)).toHaveLength(1)
    const callsBeforeUnmount = mounted.resolverCalls()
    mounted.dispose()
    expect(previewLines(mounted)).toHaveLength(0)
    pointer(mounted.canvas, 'pointermove')
    expect(mounted.resolverCalls()).toBe(callsBeforeUnmount)
    expect(persistedSnapshot(mounted)).toBe(initial)
  })
})
