// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  captureSketchClipboard,
  instantiateSketchClipboard,
} from '../../lib/sketch/clipboard'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import { Sketcher } from '../../lib/sketch/sketcher'
import type {
  SketchDocumentPort,
  SketcherHost,
} from '../../lib/sketch/sketcher/ports'
import {
  __resetSketchClipboardForTest,
  bindSketcherDocument,
  copySelection,
  pasteSelection,
} from '../../lib/sketch/sketcher/toolController'
import type { Sketch } from '../../lib/sketch/types'
import { camSketchDocumentPort, useCamStore } from '../../store'
import { CommandHistory, ElementMap, FeatureDag, RegenScheduler } from '../../doc'
import { seedGenesisNodes, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  __resetSketchDocumentPort,
  workbenchSketchDocumentPort,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'

function sourceSketch(): Sketch {
  return {
    ...createBlankSketch('layer'),
    id: 'source',
    entities: [
      {
        id: 'a', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
      },
      {
        id: 'b', kind: 'line', construction: false,
        start: { x: 0, y: 5 }, end: { x: 10, y: 5 },
      },
      {
        id: 'outside', kind: 'line', construction: false,
        start: { x: 20, y: 0 }, end: { x: 20, y: 10 },
      },
    ],
    constraints: [
      { id: 'h-a', kind: 'horizontal', line: 'a' },
      { id: 'parallel-internal', kind: 'parallel', a: 'a', b: 'b' },
      { id: 'parallel-external', kind: 'parallel', a: 'b', b: 'outside' },
      { id: 'absolute-fix', kind: 'fix', entityId: 'a' },
    ],
    dimensions: [
      {
        id: 'distance-internal',
        kind: 'distance',
        driving: true,
        value: 5,
        a: { entityId: 'a', site: 'start' },
        b: { entityId: 'b', site: 'start' },
      },
    ],
    solveStatus: { dof: 3, conflicting: [], redundant: [] },
  }
}

function idFactory(prefix: string): () => string {
  let next = 0
  return () => `${prefix}-${++next}`
}

describe('Sketch clipboard pure transform', () => {
  it('captures selected entities plus wholly internal constraints, but not external constraints or dimensions', () => {
    const sketch = sourceSketch()
    const payload = captureSketchClipboard(
      sketch,
      ['a', 'b', 'parallel-internal', 'parallel-external', 'distance-internal'],
    )

    expect(payload?.entities.map((entity) => entity.id)).toEqual(['a', 'b'])
    expect(payload?.constraints.map((constraint) => constraint.id)).toEqual([
      'h-a',
      'parallel-internal',
    ])
    expect(sketch.entities.map((entity) => entity.id)).toEqual(['a', 'b', 'outside'])
    expect(sketch.dimensions).toHaveLength(1)
  })

  it('re-ids every pasted object/reference, translates the group anchor to the cursor, and never collides on repeat', () => {
    const payload = captureSketchClipboard(sourceSketch(), ['a', 'b'])
    if (payload === null) throw new Error('test setup failed to capture')
    const ids = idFactory('paste')
    const first = instantiateSketchClipboard(payload, { x: 100, y: 50 }, ids, ['paste-1'])
    const second = instantiateSketchClipboard(
      payload,
      { x: 120, y: 80 },
      ids,
      [
        ...first.entities.map((entity) => entity.id),
        ...first.constraints.map((constraint) => constraint.id),
      ],
    )

    const lineA = first.entities[0]
    const lineB = first.entities[1]
    if (lineA.kind !== 'line' || lineB.kind !== 'line') throw new Error('expected lines')
    const groupMidpoint = {
      x: (lineA.start.x + lineA.end.x + lineB.start.x + lineB.end.x) / 4,
      y: (lineA.start.y + lineA.end.y + lineB.start.y + lineB.end.y) / 4,
    }
    expect(groupMidpoint).toEqual({ x: 100, y: 50 })
    expect(lineA.end.x - lineA.start.x).toBe(10)
    expect(lineB.start.y - lineA.start.y).toBe(5)

    const firstEntityIds = new Set(first.entities.map((entity) => entity.id))
    expect(first.constraints.every((constraint) => {
      if (constraint.kind === 'horizontal') return firstEntityIds.has(constraint.line ?? '')
      if (constraint.kind === 'parallel') {
        return firstEntityIds.has(constraint.a) && firstEntityIds.has(constraint.b)
      }
      return true
    })).toBe(true)
    expect(new Set([
      ...first.entities.map((entity) => entity.id),
      ...second.entities.map((entity) => entity.id),
    ]).size).toBe(4)
    expect(second.entities.map((entity) => entity.id))
      .not.toEqual(first.entities.map((entity) => entity.id))
  })

  it.each(['inline', 'definition'] as const)(
    'freshens %s block top-level/member IDs and remaps internal constraint/dimension refs without aliasing',
    (shape) => {
      const members = {
        entities: [
          {
            id: 'member-path', kind: 'line' as const, construction: false,
            start: { x: 0, y: 0 }, end: { x: 8, y: 0 },
          },
          {
            id: 'member-text', kind: 'text' as const, construction: false,
            at: { x: 1, y: 2 }, text: 'B', height: 2, fontStyle: 'single-line' as const,
            pathId: 'member-path', pathOffsetMm: 3, pathAlign: 'free' as const,
          },
          {
            id: 'member-external-text', kind: 'text' as const, construction: false,
            at: { x: 3, y: 4 }, text: 'DETACHED', height: 2, fontStyle: 'single-line' as const,
            pathId: 'outside-path', pathOffsetMm: 5, pathFlip: true, pathAlign: 'right' as const,
          },
        ],
        constraints: [
          { id: 'member-horizontal', kind: 'horizontal' as const, line: 'member-path' },
        ],
        dimensions: [
          {
            id: 'member-length', kind: 'distance' as const, driving: true, value: 8,
            a: { entityId: 'member-path', site: 'start' as const },
            b: { entityId: 'member-path', site: 'end' as const },
          },
        ],
      }
      const block = {
        id: 'block', kind: 'block' as const, construction: false,
        origin: { x: 4, y: 5 }, rotation: 0, scale: 1,
        ...(shape === 'definition' ? { defId: 'def' } : {}),
        members: shape === 'definition'
          ? { entities: [], constraints: [], dimensions: [] }
          : members,
      }
      const sketch: Sketch = {
        ...createBlankSketch('layer'),
        entities: [block],
        ...(shape === 'definition'
          ? { blockDefs: { def: { id: 'def', members } } }
          : {}),
      }
      const payload = captureSketchClipboard(sketch, ['block'])
      if (payload === null) throw new Error('block capture failed')
      const pasted = instantiateSketchClipboard(payload, { x: 20, y: 30 }, idFactory(shape))
      const copy = pasted.entities[0]
      if (copy.kind !== 'block') throw new Error('expected pasted block')

      expect(copy.id).not.toBe('block')
      expect(copy.defId).toBeUndefined()
      expect(copy.members.entities.map((entity) => entity.id))
        .not.toEqual(members.entities.map((entity) => entity.id))
      const path = copy.members.entities.find((entity) => entity.kind === 'line')
      const text = copy.members.entities.find((entity) => entity.kind === 'text')
      const detachedText = copy.members.entities.find(
        (entity) => entity.kind === 'text' && entity.text === 'DETACHED',
      )
      if (
        !path
        || !text
        || text.kind !== 'text'
        || !detachedText
        || detachedText.kind !== 'text'
      ) {
        throw new Error('block member paste incomplete')
      }
      expect(text.pathId).toBe(path.id)
      expect(detachedText).toMatchObject({
        text: 'DETACHED',
        at: { x: 3, y: 4 },
        height: 2,
        fontStyle: 'single-line',
      })
      expect(detachedText).not.toHaveProperty('pathId')
      expect(detachedText).not.toHaveProperty('pathOffsetMm')
      expect(detachedText).not.toHaveProperty('pathFlip')
      expect(detachedText).not.toHaveProperty('pathAlign')
      expect(copy.members.constraints[0]).toMatchObject({
        id: expect.not.stringMatching(/^member-horizontal$/),
        kind: 'horizontal',
        line: path.id,
      })
      expect(copy.members.dimensions[0]).toMatchObject({
        id: expect.not.stringMatching(/^member-length$/),
        kind: 'distance',
        a: { entityId: path.id },
        b: { entityId: path.id },
      })
      expect(copy.members).not.toBe(members)
      expect(copy.members.entities[0]).not.toBe(members.entities[0])
      ;(copy.members.entities[0] as typeof path).id = 'mutated-copy'
      expect(members.entities[0].id).toBe('member-path')
      if (shape === 'definition') {
        expect(sketch.blockDefs?.def.members.entities[0].id).toBe('member-path')
      }
    },
  )

  it('remaps top-level text path references when copied together and drops all path fields when copied alone', () => {
    const path = {
      id: 'path', kind: 'line' as const, construction: false,
      start: { x: 0, y: 0 }, end: { x: 20, y: 0 },
    }
    const text = {
      id: 'text', kind: 'text' as const, construction: false,
      at: { x: 2, y: 3 }, text: 'CUT', height: 3, fontStyle: 'single-line' as const,
      pathId: 'path', pathOffsetMm: 6, pathFlip: true, pathAlign: 'right' as const,
    }
    const sketch: Sketch = {
      ...createBlankSketch('layer'),
      entities: [path, text],
    }

    const togetherPayload = captureSketchClipboard(sketch, ['path', 'text'])
    const alonePayload = captureSketchClipboard(sketch, ['text'])
    if (togetherPayload === null || alonePayload === null) throw new Error('text capture failed')
    const together = instantiateSketchClipboard(
      togetherPayload, { x: 50, y: 60 }, idFactory('together'),
    )
    const pastedPath = together.entities.find((entity) => entity.kind === 'line')
    const pastedText = together.entities.find((entity) => entity.kind === 'text')
    if (!pastedPath || !pastedText || pastedText.kind !== 'text') throw new Error('paired paste failed')
    expect(pastedText.pathId).toBe(pastedPath.id)

    const alone = instantiateSketchClipboard(alonePayload, { x: 70, y: 80 }, idFactory('alone'))
    const freeText = alone.entities[0]
    if (freeText.kind !== 'text') throw new Error('text-only paste failed')
    expect(freeText).not.toHaveProperty('pathId')
    expect(freeText).not.toHaveProperty('pathOffsetMm')
    expect(freeText).not.toHaveProperty('pathFlip')
    expect(freeText).not.toHaveProperty('pathAlign')
    expect(freeText.at).toEqual({ x: 70, y: 80 })
  })
})

interface KeyboardFixture {
  sketcher: Sketcher
  canvas: HTMLCanvasElement
  getSketch: () => Sketch
  getSelection: () => string[]
  setSelection: (ids: string[]) => void
  beginStep: ReturnType<typeof vi.fn>
  notices: Array<{ message: string; severity?: string }>
}

function keyboardFixture(): KeyboardFixture {
  let sketch = sourceSketch()
  let selection = ['a', 'b']
  const beginStep = vi.fn()
  const notices: Array<{ message: string; severity?: string }> = []
  const port: SketchDocumentPort = {
    getSketch: () => sketch,
    ensureSketch: () => sketch,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 1,
    getProjectCandidates: () => [],
    getSelection: () => selection,
    setSelection: (ids) => { selection = ids },
    getLastStagedSize: () => null,
    setLastStagedSize: () => {},
    notice: (message, severity) => { notices.push({ message, severity }) },
    beginStep,
    append: (commit, inferred) => {
      sketch = {
        ...sketch,
        entities: [...sketch.entities, ...commit.entities],
        constraints: [...sketch.constraints, ...commit.constraints, ...inferred],
        dimensions: [...sketch.dimensions, ...(commit.dimensions ?? [])],
      }
    },
    replace: () => {},
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: () => false,
    dragMove: () => {},
    dragEnd: () => {},
    moveDimLabel: () => {},
    openDimEditor: () => {},
    getTextEditId: () => null,
    getPickPathForTextId: () => null,
    editText: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    cancelPickTextPath: () => {},
    placeText: () => {},
    bindTextPath: () => {},
  }
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const host: SketcherHost = {
    domElement: canvas,
    container: canvas,
    overlayHost: canvas,
    overlayRoot: new THREE.Group(),
    camera: new THREE.OrthographicCamera(),
    controls: { enableRotate: false },
    clientToPlaneWorld: (x, y) => ({ x, y }),
    worldPerPixel: () => 1,
    saveCameraPose: () => ({}),
    restoreCameraPose: () => {},
    frameNormalToPlane: () => {},
  }
  const sketcher = new Sketcher(host)
  sketcher.setDocumentPort(port)
  sketcher.setUndoSink({ beginGesture: beginStep })
  sketcher.enter()
  sketcher.updateSketch(sketch)
  return {
    sketcher,
    canvas,
    getSketch: () => sketch,
    getSelection: () => selection,
    setSelection: (ids) => { selection = ids },
    beginStep,
    notices,
  }
}

describe('Sketch clipboard shared keyboard surface', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    __resetSketchClipboardForTest()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('Ctrl+C / Ctrl+V pastes at the active workspace point, selects the result, and opens one step', () => {
    const fixture = keyboardFixture()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    fixture.canvas.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: 70, clientY: 90, bubbles: true, cancelable: true,
    }))
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', ctrlKey: true, bubbles: true, cancelable: true,
    }))

    expect(fixture.getSketch().entities).toHaveLength(5)
    expect(fixture.getSketch().constraints).toHaveLength(6)
    expect(fixture.getSelection()).toHaveLength(2)
    expect(fixture.beginStep).toHaveBeenCalledTimes(1)
    const pasted = fixture.getSketch().entities.slice(-2)
    const a = pasted[0]
    const b = pasted[1]
    if (a.kind !== 'line' || b.kind !== 'line') throw new Error('expected pasted lines')
    expect({
      x: (a.start.x + a.end.x + b.start.x + b.end.x) / 4,
      y: (a.start.y + a.end.y + b.start.y + b.end.y) / 4,
    }).toEqual({ x: 70, y: 90 })
    fixture.sketcher.dispose()
  })

  it('keeps typing fields native and gives legible empty-selection/empty-clipboard notices', () => {
    const fixture = keyboardFixture()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    expect(fixture.notices).toHaveLength(0)

    __resetSketchClipboardForTest()
    fixture.setSelection([])
    expect(copySelection()).toBe(false)
    expect(pasteSelection()).toBe(false)
    expect(fixture.notices.map((notice) => notice.message)).toEqual([
      'Copy: select one or more sketch entities first.',
      'Paste: the sketch clipboard is empty.',
    ])
    fixture.sketcher.dispose()
  })
})

describe('Sketch clipboard CAM history integration', () => {
  beforeEach(() => {
    __resetSketchClipboardForTest()
    bindSketcherDocument(camSketchDocumentPort)
  })

  it('paste is one real CAM undo/redo action', () => {
    const original = sourceSketch()
    const solveSketch = vi.fn()
    useCamStore.setState({
      activeSketch: original,
      sketchSelectedIds: ['a', 'b'],
      sketchSolveStatus: original.solveStatus,
      projectHistory: [],
      sketchHistory: [],
      projectFuture: [],
      sketchFuture: [],
      canUndo: false,
      canRedo: false,
      solveSketch,
    })

    expect(copySelection()).toBe(true)
    expect(pasteSelection({ x: 100, y: 50 })).toBe(true)
    const pasted = useCamStore.getState().activeSketch
    if (pasted === null) throw new Error('paste removed active sketch')
    expect(pasted.entities).toHaveLength(5)
    expect(useCamStore.getState().sketchHistory).toEqual([original])

    useCamStore.getState().undo()
    expect(useCamStore.getState().activeSketch?.entities.map((entity) => entity.id))
      .toEqual(original.entities.map((entity) => entity.id))
    expect(useCamStore.getState().canRedo).toBe(true)

    useCamStore.getState().redo()
    expect(useCamStore.getState().activeSketch?.entities.map((entity) => entity.id))
      .toEqual(pasted.entities.map((entity) => entity.id))
    expect(solveSketch).toHaveBeenCalledTimes(3)
  })
})

describe('Sketch clipboard real Model-workbench FeatureDag integration', () => {
  const nodeId = 'clipboard-workbench-sketch'

  beforeEach(() => {
    __resetSketchClipboardForTest()
    sketchSessionStore.__reset()
    __resetSketchDocumentPort()
  })
  afterEach(() => {
    bindSketcherDocument(null)
    sketchSessionStore.__reset()
    __resetSketchDocumentPort()
  })

  it('paste creates one real CommandHistory step; undo removes it and redo restores it', () => {
    const initial = sourceSketch()
    const dag = new FeatureDag()
    seedGenesisNodes(dag)
    dag.insertNode({
      id: nodeId,
      kind: 'sketch',
      consumes: [],
      refs: [],
      payload: { sketch: initial, externalRefs: [], dimensionDiagnostics: [] },
    }, dag.featureOrder().length)
    const history = new CommandHistory(dag)
    const scheduler = new RegenScheduler(dag, new ElementMap())
    const historySteps: string[] = []
    sketchSessionStore.bindDeps({
      dag,
      history,
      scheduler,
      wrapper: null,
      notice: () => {},
      onDocumentChanged: () => {},
      onHistoryStep: (id) => { historySteps.push(id) },
    })
    sketchSessionStore.begin(nodeId, BASE_PLANE_FRAMES.xy, initial)
    bindSketcherDocument(workbenchSketchDocumentPort)
    workbenchSketchDocumentPort.setSelection(['a', 'b'])

    expect(copySelection()).toBe(true)
    expect(pasteSelection({ x: 100, y: 50 })).toBe(true)
    const afterPaste = dag.getNode(nodeId)?.payload.sketch as Sketch
    expect(afterPaste.entities).toHaveLength(5)
    expect(history.canUndo()).toBe(true)
    expect(historySteps).toEqual([nodeId])

    expect(history.undo()).toBe(true)
    const afterUndo = dag.getNode(nodeId)?.payload.sketch as Sketch
    expect(afterUndo.entities.map((entity) => entity.id))
      .toEqual(initial.entities.map((entity) => entity.id))
    expect(history.canRedo()).toBe(true)

    expect(history.redo()).toBe(true)
    const afterRedo = dag.getNode(nodeId)?.payload.sketch as Sketch
    expect(afterRedo).toEqual(afterPaste)
    expect(history.canUndo()).toBe(true)
  })
})
