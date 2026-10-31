// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as stockAdapter from '../../store/operationStockInputs'
import { getOperationStockDomain, useCamStore } from '../../store'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'
import { CommandHistory, FeatureDag } from '../../doc'
import { formFromBody, type BodyMesh } from '../../form/fromMesh'
import { trimToToolReachOffPage, lowerFinishLinksOffPage, offPageStockBackend } from '../../store/toolpathPostprocess'
import { trimToToolReachInPartFrame, type ToolReachInPartFrameInput } from '../../store/toolReachInputs'
import { lowerFinishLinksAfterEarlierOperations } from '../../store/finishLinks'
import { applyConservativeStockOperation, createConservativeStockColumns, type ConservativeStockColumns, type StockCut } from '../../lib/cam/stockState'
import { createStockState } from '../../lib/cam/stockState'
import type { Project } from '../../types'

const donor = JSON.parse(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8')) as Project
const mesh: BodyMesh = { position: [0,0,0, 10,0,0, 10,10,0, 0,10,0], index: [0,1,2, 0,2,3], triFace: [0,0] }
class HeldWorker {
  static instances: HeldWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminate = vi.fn()
  private mesh = mesh
  postMessage = vi.fn((body: BodyMesh) => { this.mesh = body })
  constructor() { HeldWorker.instances.push(this) }
  finish() { this.onmessage?.({ data: formFromBody(this.mesh) } as MessageEvent) }
}
afterEach(() => {
  act(() => useFormStore.getState().closeSession())
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function mountForm() {
  HeldWorker.instances = []
  vi.stubGlobal('Worker', HeldWorker)
  const dag = new FeatureDag()
  const showBody = vi.fn()
  const selectedBodyMesh = vi.fn(async () => ({ featureId: 'source', mesh }))
  const hook = renderHook(() => useFormSession({runtime:null,canvasRef:{current:null},dag,
    history:new CommandHistory(dag),onApplied:vi.fn(),showBody,selectedBodyMesh}))
  act(() => hook.result.current.open())
  const bodyTool = () => hook.result.current.railSections.flatMap(s => s.tools).find(t => t.testId === 'form-starter-body')!
  return { ...hook, bodyTool, showBody, selectedBodyMesh }
}

describe('WO-3085: responsive regeneration through the production store adapter', () => {
  it('progress and selection writes do not rebuild every remaining-stock request', () => {
    const project = structuredClone(donor)
    project.id = 'wo3085-progress'
    useCamStore.setState({project,toolLibrary:project.toolLibrary})
    const {authority} = getOperationStockDomain(project.setups[0].id,project.stocks![0].id)
    const reconcile = vi.spyOn(authority,'reconcile')
    useCamStore.setState({activePanelId:useCamStore.getState().activePanelId})
    reconcile.mockClear()
    for (let n=0;n<20;n++) useCamStore.setState(s => ({project:{...s.project,setups:s.project.setups.map((setup,i) => i ? setup : {
      ...setup,operations:setup.operations.map((op,j) => j ? op : {...op,progress:n/20,progressPhase:'working'})})}}))
    expect(reconcile, 'a worker progress message must not clone/replay all completed toolpaths').not.toHaveBeenCalled()
    useCamStore.setState({activePanelId:'properties'})
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('publishes worker progress without entering authoring or stock reconstruction', () => {
    const project = structuredClone(donor)
    project.id = 'wo3085-progress-action'
    useCamStore.setState({project,toolLibrary:project.toolLibrary,projectHistory:[]})
    const observe = vi.spyOn(stockAdapter, 'observeOperationStockState')
    const setup = project.setups[0], op = setup.operations[0]
    const before = structuredClone(op)
    useCamStore.getState().updateOperation(setup.id,op.id,{progress:0.25,progressPhase:'working'})
    expect(observe, 'progress is a display write, not a stock or authoring edit').not.toHaveBeenCalled()
    expect(useCamStore.getState().project.setups[0].operations[0]).toEqual({...before,progress:0.25,progressPhase:'working'})
    expect(useCamStore.getState().projectHistory).toEqual([])
    useCamStore.setState({project:useCamStore.getState().project})
    expect(observe, 'raw writes still inspect actual move bytes').toHaveBeenCalledTimes(1)
  })

  it('still reconciles result, in-place move, semantic, order and lifetime changes', () => {
    const project = structuredClone(donor)
    project.id = 'wo3085-edits'
    useCamStore.setState({project,toolLibrary:project.toolLibrary})
    const {authority} = getOperationStockDomain(project.setups[0].id,project.stocks![0].id)
    const reconcile = vi.spyOn(authority,'reconcile')
    useCamStore.setState({project})
    reconcile.mockClear()
    const op = project.setups[0].operations[0]
    op.status = 'computing'
    useCamStore.setState({project})
    expect(reconcile).toHaveBeenCalledTimes(1)
    op.status = 'ready'; op.toolpathMoves = [{type:'feed',x:0,y:0,z:0,feed:100}]
    useCamStore.setState({project})
    expect(reconcile).toHaveBeenCalledTimes(2)
    op.toolpathMoves[0].z = -1
    useCamStore.setState({project})
    expect(reconcile).toHaveBeenCalledTimes(3)
    op.params = {...op.params,wo3085:1}
    useCamStore.setState({project})
    expect(reconcile).toHaveBeenCalledTimes(4)
    project.setups[0].operations.reverse()
    useCamStore.setState({project})
    expect(reconcile).toHaveBeenCalledTimes(5)
    project.id = 'wo3085-reopened'
    const dispose = vi.spyOn(authority,'disposeProject')
    useCamStore.setState({project})
    expect(dispose).toHaveBeenCalled()
  })
})

describe('WO-3085: From body remains interactive while the worker shapes the body', () => {
  it('shows work in progress immediately and keeps From body available', async () => {
    const form = mountForm()
    await act(async () => { form.bodyTool().onClick() })
    expect(form.bodyTool().label).toMatch(/computing/i)
    expect(form.bodyTool().disabled, 'pending work must not prevent selecting another body').not.toBe(true)
    expect(form.selectedBodyMesh).toHaveBeenCalledTimes(1)
    expect(HeldWorker.instances).toHaveLength(1)
    await act(async () => HeldWorker.instances[0].finish())
    expect(useFormStore.getState().startedFrom).toBe('body')
    expect(form.bodyTool().label).not.toMatch(/computing/i)
    expect(form.bodyTool().disabled).not.toBe(true)
    expect(form.showBody).toHaveBeenCalledWith('source',false)
  })

  it('replaces a converting body and ignores its late reply without clearing the new progress', async () => {
    const form = mountForm()
    await act(async () => { form.bodyTool().onClick() })
    const old = HeldWorker.instances[0]
    const secondMesh = { ...mesh, position: Array.from(mesh.position, n => n * 2) }
    form.selectedBodyMesh.mockResolvedValue({ featureId: 'second', mesh: secondMesh })
    const cage = useFormStore.getState().cage
    await act(async () => { form.bodyTool().onClick() })
    expect(form.selectedBodyMesh, 'a new request must acquire the newly selected body').toHaveBeenCalledTimes(2)
    expect(old.terminate).toHaveBeenCalledOnce()
    expect(HeldWorker.instances).toHaveLength(2)
    await act(async () => old.finish())
    expect(useFormStore.getState().cage).toBe(cage)
    expect(form.showBody).not.toHaveBeenCalled()
    expect(form.bodyTool().label).toMatch(/computing/i)
    await act(async () => HeldWorker.instances[1].finish())
    expect(useFormStore.getState().cage).toEqual(formFromBody(secondMesh).cage)
    expect(useFormStore.getState().sourceBodyId).toBe('second')
    expect(form.showBody).toHaveBeenCalledExactlyOnceWith('second', false)
    expect(form.bodyTool().label).not.toMatch(/computing/i)
  })

  it('accepts a newer body while an older tessellation is still pending', async () => {
    const form = mountForm()
    let resolveOld!: (source: { featureId: string; mesh: BodyMesh }) => void
    form.selectedBodyMesh.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    await act(async () => { form.bodyTool().onClick() })
    expect(HeldWorker.instances).toHaveLength(0)
    form.selectedBodyMesh.mockResolvedValue({ featureId: 'second', mesh })
    await act(async () => { form.bodyTool().onClick() })
    expect(form.selectedBodyMesh, 'mesh acquisition cannot block a replacement request').toHaveBeenCalledTimes(2)
    expect(HeldWorker.instances).toHaveLength(1)
    await act(async () => resolveOld({ featureId: 'source', mesh }))
    expect(HeldWorker.instances).toHaveLength(1)
    expect(form.bodyTool().label).toMatch(/computing/i)
    await act(async () => HeldWorker.instances[0].finish())
    expect(useFormStore.getState().sourceBodyId).toBe('second')
    expect(form.showBody).toHaveBeenCalledExactlyOnceWith('second', false)
  })

  it('Cancel stays usable and a late conversion cannot replace a reopened form', async () => {
    const form = mountForm()
    await act(async () => { form.bodyTool().onClick() })
    const old = HeldWorker.instances[0]
    act(() => { form.result.current.cancel(); form.result.current.open() })
    const cage = useFormStore.getState().cage
    await act(async () => old.finish())
    expect(useFormStore.getState().cage).toBe(cage)
    expect(useFormStore.getState().startedFrom).not.toBe('body')
    expect(form.showBody).not.toHaveBeenCalledWith('source',false)
  })
})


describe('WO-3085: off-page 3D postprocess keeps the existing safety calculations', () => {
  class PostprocessWorker {
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: ErrorEvent) => void) | null = null
    terminate = vi.fn()
    static latest: PostprocessWorker
    constructor(_url: URL, options: WorkerOptions) {
      expect(options.name).toBe('toolpath-postprocess')
      PostprocessWorker.latest = this
    }
    addEventListener() {}
    postMessage(message: {request: {kind:'reach';input:ToolReachInPartFrameInput} | {kind:'links';input:Parameters<typeof lowerFinishLinksAfterEarlierOperations>[0]} | {kind:'stock';input:{stock:ConservativeStockColumns;cuts:readonly StockCut[]}}}) {
      const request = structuredClone(message.request)
      setTimeout(() => this.onmessage?.({data:{ok:true,result:request.kind === 'reach'
        ? trimToToolReachInPartFrame(request.input) : request.kind === 'links' ? lowerFinishLinksAfterEarlierOperations(request.input) : applyConservativeStockOperation(request.input.stock,request.input.cuts)}} as MessageEvent),10)
    }
  }
  const input = (): ToolReachInPartFrameInput => ({
    operation:'WO-3085 reach parity',
    moves:[{type:'rapid',x:-5,y:0,z:20},{type:'feed',x:-5,y:0,z:0,feed:100},{type:'feed',x:5,y:0,z:0,feed:100}],
    tool:{...donor.toolLibrary[0],type:'flat_end_mill',diameter:2,fluteLength:1,shankDiameter:6,lengthBelowHolder:30},
    plungeRate:100,part:{positions:[],indices:[]},partToleranceMm:0.1,params:{},workholding:[],noEarlierOperations:true,
    stockBounds:{minX:-10,minY:-10,minZ:0,maxX:10,maxY:10,maxZ:10},
  })
  it('returns the same reach stops and moves after a page timer has run', async () => {
    const request = input()
    const expected = trimToToolReachInPartFrame(request)
    vi.stubGlobal('Worker',PostprocessWorker)
    let pageTick = false
    const timer = setTimeout(() => {pageTick=true},0)
    try {
      expect(await trimToToolReachOffPage(request)).toEqual(expected)
      expect(pageTick).toBe(true)
      expect(PostprocessWorker.latest.terminate).toHaveBeenCalledOnce()
    } finally {clearTimeout(timer)}
  })
  it('returns identical finish links, air feeds and predecessor dependencies', async () => {
    const request = input()
    const links = {op:donor.setups[0].operations[0],tool:request.tool,moves:[...request.moves],
      remaining:createStockState(request.stockBounds!,1),workholding:[],clearanceZ:20,operationLabel:'WO-3085 link parity'}
    const expected = lowerFinishLinksAfterEarlierOperations(links)
    vi.stubGlobal('Worker',PostprocessWorker)
    expect(await lowerFinishLinksOffPage(links)).toEqual(expected)
  })
  it('replays shared stock off the page with identical whole-cell columns', async () => {
    const bounds = {minX:0,minY:0,minZ:0,maxX:10,maxY:10,maxZ:10}
    const stock = createConservativeStockColumns(bounds,0.5)
    const cuts: StockCut[] = [{cutter:{kind:'flat',diameter:4},move:{x0:0,y0:5,z0:5,x1:10,y1:5,z1:5}}]
    const expected = applyConservativeStockOperation(stock,cuts)
    vi.stubGlobal('Worker',PostprocessWorker)
    const pending = offPageStockBackend.apply(stock,cuts)
    expect(pending).toBeInstanceOf(Promise)
    const result = await pending
    expect(result).toEqual(expected)
    expect(Object.isFrozen(result.topZ)).toBe(true)
    expect(result.topZ.some(z => z < 10)).toBe(true)
  })
  it('terminates a cancelled check and does not publish its late reply', async () => {
    vi.stubGlobal('Worker',PostprocessWorker)
    const controller = new AbortController()
    const reply = trimToToolReachOffPage(input(),controller.signal)
    const rejected = expect(reply).rejects.toMatchObject({name:'AbortError'})
    controller.abort()
    await rejected
    expect(PostprocessWorker.latest.terminate).toHaveBeenCalledOnce()
  })
})
