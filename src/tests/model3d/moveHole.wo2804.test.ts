// @vitest-environment jsdom
// Real Model screen import, viewport picks, preview and Apply; kernel reads measure the result.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createFakeGeomClient } from './fakeGeomClient'
import { createMeshEditRecord, resolveEditedStlMesh } from '../../mesh/edit'
import { solidShellCount } from '../../mesh/manifoldOps'
import * as manifoldOps from '../../mesh/manifoldOps'
import { buildStlModelBodyModel } from '../../components/model3d/workbench/stlModelBody'
import { corridorObstructions } from '../../mesh/recognition/ends'
import { weldMesh } from '../../mesh/recognition/topology'
import { measureMesh } from '../../mesh/analysis'
import { meshFeatureTargets, counterborePocketTarget } from '../../mesh/recognition/toolpathTargets'
import { recognizeMeshFeatures } from '../../mesh/recognition'
import { planStlFeatureEdits } from '../../components/model3d/workbench/stlFeatureEdits'
import { primeBoringKernel, enlargeHoleOperation } from '../../mesh/edit/operations/enlargeHole'
import type { MeshBuffers } from '../../mesh/types'
import { typedMock } from '../support/typedMock'
import type { BodyHandle, StableId } from '../../geom/geom-service'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const { stepCache, stlCache } = vi.hoisted(() => ({ stepCache: new Map<string, ArrayBuffer>(), stlCache: new Map<string,ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({cacheSTL: async(id,bytes)=>{stlCache.set(id,bytes)}, loadCachedSTL: async id=>stlCache.get(id)??null,removeCachedSTL:async id=>{stlCache.delete(id)}}))

// jsdom's localStorage is broken under Vitest's node launch flags (same shim
// directEditAudit.wo2757.test.ts installs before importing the page).
const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { useCamStore } = await import('../../store')

const EVIDENCE = resolve(process.cwd(),'src/tests/evidence/WO-2804')
mkdirSync(EVIDENCE,{recursive:true})
const cells: Record<string,unknown> = {}
const statusOf = (id:string) => screen.queryByTestId(id)?.getAttribute('data-status')
const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const part = (name: string) => resolve(PARTS, name)

type V3 = { x: number; y: number; z: number }

let consoleLines: string[] = []
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  stlCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  consoleLines = []
  useCamStore.getState().addConsoleEvent = (event) => { consoleLines.push(event.message) }
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? ''

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

interface StepSession { runtime: FakeSceneRuntime; volume: number }

/** Mount the Model screen on the real kernel and import `path` through the
 *  screen's own Import input. */
async function openStep(path: string, importBytes = bytesOf(path)): Promise<StepSession> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  const name = path.split(/[\\/]/).pop()!
  fireEvent.change(input, { target: { files: [new File([importBytes], name, { type: 'application/octet-stream' })] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
  return { runtime, volume: await volumeOf('IMP1') }
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

interface FaceInfo { id: StableId; type: string; centroid: V3; normal: V3; min: V3; max: V3; aim: { point: V3; normal: V3 } }

/** Every face of a live body: kernel surface class, area-weighted centroid and
 *  normal, bounds, and the largest triangle to aim a ray at. */
async function facesOf(featureId: string): Promise<FaceInfo[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const acc = mesh.faceIds.map(() => ({ a: 0, c: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 }, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, best: -1, bestA: 0 }))
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  const tri = (t: number) => {
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const cr = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
    return { a, b, c, cr, area: Math.hypot(cr.x, cr.y, cr.z) / 2 }
  }
  for (let t = 0; t < mesh.triFace.length; t++) {
    const f = acc[mesh.triFace[t]]
    const { a, b, c, cr, area } = tri(t)
    f.a += area
    for (const k of ['x', 'y', 'z'] as const) {
      f.c[k] += area * (a[k] + b[k] + c[k]) / 3
      f.n[k] += cr[k] / 2
      f.min[k] = Math.min(f.min[k], a[k], b[k], c[k])
      f.max[k] = Math.max(f.max[k], a[k], b[k], c[k])
    }
    if (area > f.bestA) { f.bestA = area; f.best = t }
  }
  const out: FaceInfo[] = []
  for (let i = 0; i < mesh.faceIds.length; i++) {
    const f = acc[i]
    if (f.best < 0) continue
    const { a, b, c, cr } = tri(f.best)
    const cl = Math.hypot(cr.x, cr.y, cr.z)
    const nl = Math.hypot(f.n.x, f.n.y, f.n.z) || 1
    out.push({
      id: mesh.faceIds[i],
      type: await hooks().client.classifyFace(h, mesh.faceIds[i]),
      centroid: { x: f.c.x / f.a, y: f.c.y / f.a, z: f.c.z / f.a },
      normal: { x: f.n.x / nl, y: f.n.y / nl, z: f.n.z / nl },
      min: f.min, max: f.max,
      aim: { point: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 }, normal: { x: cr.x / cl, y: cr.y / cl, z: cr.z / cl } },
    })
  }
  return out
}

function findFace(faces: FaceInfo[], label: string, test: (f: FaceInfo) => boolean): FaceInfo {
  const hit = faces.find(test)
  if (hit === undefined) throw new Error(`no face matches ${label}: ${JSON.stringify(faces.map((f) => [f.type, f.centroid, f.normal]))}`)
  return hit
}

/** Aim the viewport ray straight down a face's own outward normal. */
function aimAtFace(runtime: FakeSceneRuntime, f: FaceInfo): void {
  const { point, normal } = f.aim
  runtime.rayOverride = {
    origin: { x: point.x + normal.x * 0.5, y: point.y + normal.y * 0.5, z: point.z + normal.z * 0.5 },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

function click(): void {
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}


interface StlSession { runtime: FakeSceneRuntime; id: string; bytes: ArrayBuffer; volume: number }
const journalOf = (id:string) => useCamStore.getState().project.geometry.find(g=>g.id===id)?.meshEdits
function stlMesh(s:StlSession): MeshBuffers {
  const result=resolveEditedStlMesh(s.bytes,journalOf(s.id))
  expect(result.stopped).toBeUndefined()
  return result.mesh
}
async function openStl(bytes=bytesOf(part('stepped_holes.stl')), maxX=70): Promise<StlSession> {
  const id='stepped-holes', name='stepped_holes.stl'
  stlCache.set(id,bytes)
  act(()=>useCamStore.setState(st=>({project:{...st.project,geometry:[{
    id,name,filename:name,type:'mesh',format:'stl',loaded:true,
    boundingBox:{min:{x:0,y:0,z:0},max:{x:maxX,y:40,z:15},size:{x:maxX,y:40,z:15},center:{x:maxX/2,y:20,z:7.5}},
    position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},
  }]}})))
  await act(async()=>{expect((await useCamStore.getState().wrapImportedGeometryAsModelItem(id)).ok).toBe(true)})
  const runtime=createFakeSceneRuntime()
  runtime.projectToCanvasResult={x:300,y:200}
  render(createElement(SolidsWorkbenchPage,{createClient:()=>createFakeGeomClient(),createSceneRuntime:()=>runtime}))
  await waitFor(()=>expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(),{timeout:30000})
  const s={id,bytes,runtime,volume:0};s.volume=measureMesh(stlMesh(s)).volume
  return s
}

// Preserve the imported triangle order/identities while adding an untouched
// remote solid. No fixture or shared install is modified.
function twoSolidBytes(): ArrayBuffer {
  const original=readFileSync(part('stepped_holes.stl')), n=original.readUInt32LE(80)
  const bytes=Buffer.alloc(84+100*n)
  original.copy(bytes,0,0,84+50*n)
  original.copy(bytes,84+50*n,84,84+50*n)
  bytes.writeUInt32LE(2*n,80)
  for(let t=n;t<2*n;t++) for(let v=0;v<3;v++) {
    const at=84+50*t+12+12*v
    bytes.writeFloatLE(bytes.readFloatLE(at)+100,at)
  }
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer
}
function remoteSolid(mesh:MeshBuffers):MeshBuffers {
  const indices:number[]=[]
  for(let i=0;i<mesh.indices.length;i+=3) {
    const tri=Array.from(mesh.indices.slice(i,i+3))
    if(tri.every(v=>mesh.positions[v*3]>=100)) indices.push(...tri)
  }
  return {positions:mesh.positions,indices:Uint32Array.from(indices)}
}

async function stepMesh(id:string):Promise<MeshBuffers> {
  const m=await hooks().client.tessellate(hooks().getBodyHandle(id)!,{deflection:.01})
  return {positions:m.position,indices:m.index}
}
type Segment=[number,number,number,number]
function section(mesh:MeshBuffers): Segment[] {
  const lines:Segment[]=[]
  for(let i=0;i<mesh.indices.length;i+=3){
    const p=[0,1,2].map(k=>Array.from(mesh.positions.slice(mesh.indices[i+k]*3,mesh.indices[i+k]*3+3)))
    const q:number[][]=[]
    for(let k=0;k<3;k++){
      const a=p[k],b=p[(k+1)%3],da=a[1]-20,db=b[1]-20
      if((da<0&&db>=0)||(db<0&&da>=0)) {const t=da/(da-db);q.push([a[0]+t*(b[0]-a[0]),a[2]+t*(b[2]-a[2])])}
    }
    if(q.length===2)lines.push([q[0][0],q[0][1],q[1][0],q[1][1]])
  }
  return lines
}
function crossings(mesh:MeshBuffers,z:number):number[] {
  const xs=section(mesh).flatMap(([x1,z1,x2,z2])=>((z1<z&&z2>=z)||(z2<z&&z1>=z))?[x1+(z-z1)*(x2-x1)/(z2-z1)]:[]).sort((a,b)=>a-b)
  return xs.filter((x,i)=>i===0||x-xs[i-1]>.001)
}
function assertSections(mesh:MeshBuffers,centres:number[]) {
  const measured:Record<string,number[]>={}
  for(const z of [2,8.49,8.51,10,11.79,11.81,14,14.99]){
    const cb=z>8.5?5.5:3.3,cs=z>11.8?3.3+z-11.8:3.3
    const expected=[0,centres[0]-cb,centres[0]+cb,centres[1]-cs,centres[1]+cs,centres[2]-2.5,centres[2]+2.5,70]
    const actual=crossings(mesh,z)
    expect(actual).toHaveLength(expected.length)
    actual.forEach((x,i)=>expect(Math.abs(x-expected[i]),`z=${z} crossing ${i}: ${actual}`).toBeLessThan(.03))
    measured[String(z)]=actual
  }
  return measured
}
function captureSection(cell:string,before:MeshBuffers,after:MeshBuffers,delta=10){
  const draw=(mesh:MeshBuffers,color:string,width:number)=>section(mesh).map(([x,z,u,v])=>`<line x1="${20+x*10}" y1="${220-z*10}" x2="${20+u*10}" y2="${220-v*10}" stroke="${color}" stroke-width="${width}"/>`).join('')
  writeFileSync(resolve(EVIDENCE,`${cell}-section.svg`),`<svg xmlns="http://www.w3.org/2000/svg" width="740" height="260"><rect width="100%" height="100%" fill="white"/><text x="20" y="25">${cell}: section at Y=20 mm. Grey before; red after +${delta} mm X.</text>${draw(before,'#999',4)}${draw(after,'#c22',1.5)}</svg>`)
}
function record(cell:string,detail:unknown){cells[cell]={verdict:'WORKS',detail};writeFileSync(resolve(EVIDENCE,'cells.json'),JSON.stringify(cells,null,2)+'\n')}
async function typeMove(x:number,y=0,z=0){
  for(const [axis,value] of [['x',x],['y',y],['z',z]] as const) fireEvent.change(screen.getByTestId(`move-hole-${axis}`),{target:{value:String(value)}})
  await waitFor(()=>expect(['ready','refused']).toContain(statusOf('move-hole-status')),{timeout:30000})
}
async function pickStep(s:StepSession,id:string,x:number){
  expect(screen.queryByTestId('workbench-move-hole'),'Move Hole must have a production route').not.toBeNull()
  if(screen.queryByTestId('solids-workbench-resizehole-hint')===null) fireEvent.click(screen.getByTestId('workbench-move-hole'))
  await waitFor(()=>expect(text('solids-workbench-resizehole-hint')).not.toMatch(/recognizing/i))
  const f=findFace(await facesOf(id),'hole wall',f=>f.type==='cylinder'&&Math.abs(f.centroid.x-x)<.1)
  aimAtFace(s.runtime,f);click()
  await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
}
function aimStl(s:StlSession,x:number){
  s.runtime.rayOverride={origin:{x,y:20,z:7},direction:{x:0,y:1,z:0}}
  click()
}
const repeatHoles = [
  { x: 55, kind: 'through-hole', diameter: 6, deltaVolume: -15 * Math.PI * (9 - 6.25) },
  { x: 35, kind: 'countersink', diameter: 7, deltaVolume: -Math.PI * ((3.5 ** 2 - 3.3 ** 2) * 11.8 + 3.5 ** 2 * .2 - (3.5 ** 3 - 3.3 ** 3) / 3) },
  { x: 15, kind: 'counterbore', diameter: 7, deltaVolume: -8.5 * Math.PI * (12.25 - 10.89) },
]
async function applyDiameter(diameter:number){
  await waitFor(()=>expect(screen.queryByTestId('resize-hole-anchor-entry'),JSON.stringify({
    entries:[...document.querySelectorAll('[data-testid]')].filter(e=>/move-hole|resizehole|resize-hole/.test(e.getAttribute('data-testid')!)).map(e=>[e.getAttribute('data-testid'),e.textContent,e.getAttribute('disabled')]),
    consoleLines:consoleLines.slice(-5),
  })).not.toBeNull())
  fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'),{target:{value:String(diameter)}})
  await waitFor(()=>expect(['ready','refused']).toContain(statusOf('resize-hole-anchor-entry-status')),{timeout:30000})
  expect(statusOf('resize-hole-anchor-entry-status'),text('resize-hole-anchor-entry-status')).toBe('ready')
  fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
  await waitFor(()=>expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull())
}
// Operator 2026-10-14 2:38 PM CT: arbitrary stacks, not just countersinks.
// Axial stations/radii are fixture truth; no edit algorithm constructs them.
type ProfileBand = readonly [z0:number,z1:number,r0:number,r1:number]
const stackCases: {name:string; bands:ProfileBand[]; heightMm?:number; moveMm?:number}[] = [
  {name:'plain bore',bands:[[0,15,2.5,2.5]]},
  {name:'single counterbore',bands:[[0,10,2.5,2.5],[10,15,4.5,4.5]]},
  {name:'countersink each end',bands:[[0,2,4.5,2.5],[2,13,2.5,2.5],[13,15,2.5,4.5]]},
  {name:'counterbore plus countersink',bands:[[0,8,2.5,2.5],[8,13,4,4],[13,15,4,6]]},
  {name:'three-step bore',bands:[[0,7,2.5,2.5],[7,11,4,4],[11,15,6,6]]},
  {name:'blind stepped hole',bands:[[3,10,2.5,2.5],[10,15,4.5,4.5]]},
  {name:'counterbore at both ends',bands:[[0,3,5,5],[3,11,2.5,2.5],[11,15,4,4]]},
  {name:'internal taper and step',bands:[[0,5,2.5,2.5],[5,8,2.5,4],[8,11,4,4],[11,15,6,6]]},
  {name:'blind stepped countersink',bands:[[3,8,2.5,2.5],[8,13,4,4],[13,15,4,6]]},
  // Round 7: cones meet shoulders directly; no cylinder at the cone's rim.
  {name:'round7 cone shoulder wall',heightMm:12,moveMm:15,bands:[[0,5,3,3],[5,8,3,5],[8,12,6,6]]},
  {name:'round7 wall shoulder cone',heightMm:12,moveMm:15,bands:[[0,4,6,6],[4,7,5,3],[7,12,3,3]]},
  {name:'round7 repeated cone shoulders',bands:[[0,3,2,2],[3,6,2,3],[6,9,4,5],[9,12,6,6],[12,15,6,7]]},
]
const stackFixtureCache = new Map<string,{step:ArrayBuffer;stl:ArrayBuffer;volume:number}>()
async function stackFixture(profile:typeof stackCases[number]) {
  const cached = stackFixtureCache.get(profile.name)
  if(cached) return cached
  const { OcctKernel } = await import('occt-wasm')
  const k = await OcctKernel.init()
  try {
    const pieces = profile.bands.map(([a,b,r,s])=>k.translate(r===s?k.makeCylinder(r,b-a):k.makeCone(r,s,b-a),25,20,a))
    const tool = pieces.slice(1).reduce((a,b)=>k.fuse(a,b),pieces[0])
    const body = k.cut(k.makeBox(70,40,profile.heightMm??15),tool)
    const mesh = k.tessellate(body,{linearDeflection:.005,angularDeflection:.12})
    const stl = new ArrayBuffer(84+50*mesh.triangleCount), view = new DataView(stl)
    view.setUint32(80,mesh.triangleCount,true)
    for(let f=0;f<mesh.triangleCount;f++) for(let c=0;c<3;c++) for(let a=0;a<3;a++) {
      view.setFloat32(84+50*f+12+12*c+4*a,mesh.positions[3*mesh.indices[3*f+c]+a],true)
    }
    const value = {step:new TextEncoder().encode(k.exportStep(body)).buffer,stl,
      volume:70*40*(profile.heightMm??15)-profile.bands.reduce((n,[a,b,r,s])=>n+Math.PI*(b-a)*(r*r+r*s+s*s)/3,0)}
    stackFixtureCache.set(profile.name,value)
    return value
  } finally { k[Symbol.dispose]() }
}
function stackSections(mesh:MeshBuffers,profile:typeof stackCases[number],centre:number) {
  const heights = [...new Set([.01,(profile.heightMm??15)-.01,...profile.bands.flatMap(([a,b])=>[a+.01,(a+b)/2,b-.01])])].sort((a,b)=>a-b)
  const sections:Record<string,number[]>={}
  for(const z of heights) {
    const band=profile.bands.find(([a,b])=>z>a&&z<b)
    const radius=band?band[2]+(band[3]-band[2])*(z-band[0])/(band[1]-band[0]):0
    const expected=radius?[0,centre-radius,centre+radius,70]:[0,70]
    const actual=crossings(mesh,z)
    expect(actual,`${profile.name}: all steps at z=${z}`).toHaveLength(expected.length)
    actual.forEach((x,i)=>expect(Math.abs(x-expected[i]),`${profile.name} z=${z}`).toBeLessThan(.03))
    sections[String(z)]=actual
  }
  return sections
}
// Round 5 audit fixtures: dimensions and volumes come from the drawing,
// independent of recognition and the editing operation.
const consumerCases = [
  {name:'blind floor',bands:[[3,8,3,3],[8,12,5,5]] as ProfileBand[]},
  {name:'internal cone',bands:[[0,5,3,3],[5,8,3,5],[8,12,5,5]] as ProfileBand[]},
]
async function consumerFixture(profile:{bands:ProfileBand[]}) {
  const { OcctKernel } = await import('occt-wasm')
  const k=await OcctKernel.init()
  try {
    const parts=profile.bands.map(([a,b,r,s])=>k.translate(r===s?k.makeCylinder(r,b-a):k.makeCone(r,s,b-a),20,20,a))
    const body=k.cut(k.makeBox(40,40,12),parts.slice(1).reduce((a,b)=>k.fuse(a,b),parts[0]))
    const mesh=k.tessellate(body,{linearDeflection:.005,angularDeflection:.12})
    const bytes=new ArrayBuffer(84+50*mesh.triangleCount),v=new DataView(bytes)
    v.setUint32(80,mesh.triangleCount,true)
    for(let f=0;f<mesh.triangleCount;f++) for(let c=0;c<3;c++) for(let a=0;a<3;a++)
      v.setFloat32(84+50*f+12+12*c+4*a,mesh.positions[3*mesh.indices[3*f+c]+a],true)
    return bytes
  } finally {k[Symbol.dispose]()}
}
function shiftedBytes(bytes:ArrayBuffer,offset:readonly number[]) {
  const out=bytes.slice(0),v=new DataView(out)
  for(let f=0;f<v.getUint32(80,true);f++) for(let c=0;c<3;c++) for(let a=0;a<3;a++) {
    const at=84+50*f+12+12*c+4*a
    v.setFloat32(at,v.getFloat32(at,true)+offset[a],true)
  }
  return out
}
function shiftMesh(mesh:MeshBuffers,offset:readonly number[]):MeshBuffers {
  return {positions:Float32Array.from(mesh.positions,(v,i)=>v+offset[i%3]),indices:mesh.indices}
}
function consumerSections(mesh:MeshBuffers,profile:{bands:ProfileBand[]},wideRadius=5) {
  for(const z of [.1,2.9,3.1,5.1,7.9,8.1,11.9]) {
    const b=profile.bands.find(([a,b])=>z>a&&z<b)
    const r=b?(b[0]===8?wideRadius:b[2]+(b[3]-b[2])*(z-b[0])/(b[1]-b[0])):0
    const expected=r?[0,20-r,20+r,40]:[0,40],actual=crossings(mesh,z)
    expect(actual,`unchanged pilot/floor/cone at z=${z}`).toHaveLength(expected.length)
    actual.forEach((x,i)=>expect(Math.abs(x-expected[i]),`section z=${z}`).toBeLessThan(.03))
  }
}
describe('WO-2804 Move Hole',()=>{
  it.each([1,-1])('round6 chamfered counterbore resize exits the mouth with orientation %s',async(sign)=>{
    const original=await consumerFixture({bands:[[0,8,3,3],[8,11,5,5],[11,12,5,6]]})
    // Reflect the physical opening as well as the test's section coordinates.
    // Reversing winding preserves outward normals after the reflection.
    const bytes=original.slice(0),view=new DataView(bytes)
    if(sign===-1) for(let f=0;f<view.getUint32(80,true);f++) {
      const at=84+50*f+12
      for(let c=0;c<3;c++) view.setFloat32(at+12*c+8,12-view.getFloat32(at+12*c+8,true),true)
      for(let a=0;a<3;a++) {
        const x=view.getFloat32(at+12+a*4,true)
        view.setFloat32(at+12+a*4,view.getFloat32(at+24+a*4,true),true)
        view.setFloat32(at+24+a*4,x,true)
      }
    }
    const s=await openStl(bytes,40)
    const sections=(mesh:MeshBuffers,radius:number)=>{
      const measured:Record<string,number[]>={}
      for(const z of [.01,4,7.99,8.01,10.99,11.01,11.5,11.99]) {
        const expected=[0,20-(z<8?3:radius),20+(z<8?3:radius),40]
        const actual=crossings(mesh,sign===1?z:12-z)
        expect(actual,`pilot/shoulder/open mouth z=${z}`).toHaveLength(4)
        actual.forEach((x,i)=>expect(Math.abs(x-expected[i]),`no inward lip z=${z}`).toBeLessThan(.03))
        measured[String(z)]=actual
      }
      return measured
    }
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    s.runtime.rayOverride={origin:{x:20,y:20,z:sign===1?10:2},direction:{x:0,y:1,z:0}};click()
    await waitFor(()=>expect(screen.queryByTestId('resize-hole-anchor-entry-input')).not.toBeNull())
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'),{target:{value:'12'}})
    await waitFor(()=>expect(statusOf('resize-hole-anchor-entry-status')).toBe('ready'))
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-cancel'))
    expect(journalOf(s.id)??[]).toHaveLength(0)
    expect(measureMesh(stlMesh(s)).volume).toBeCloseTo(s.volume,4)
    if(screen.queryByTestId('solids-workbench-resizehole-hint')===null) fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    click()
    await applyDiameter(12)
    const mesh=stlMesh(s),removed=s.volume-measureMesh(mesh).volume
    const handRemoved=Math.PI*(4*36-3*25-(25+30+36)/3)
    expect(Math.abs(removed-handRemoved),'d12 bore goes from shoulder through the mouth, not just the old cylinder').toBeLessThan(.6)
    const measured=sections(mesh,6)
    const journal=JSON.parse(JSON.stringify(journalOf(s.id)))
    const resumed=resolveEditedStlMesh(bytes,journal)
    expect(resumed.stopped).toBeUndefined();sections(resumed.mesh,6)
    const model=buildStlModelBodyModel({geoId:s.id,name:'resized chamfer',bytes,meshEdits:journal})
    const feature=model.features.find(f=>f.kind==='counterbore')
    const welded=weldMesh(mesh),zeroArea=Array.from(welded.areas).flatMap((a,f)=>a===0?[f]:[])
    const noZero={positions:mesh.positions,indices:Uint32Array.from(Array.from(mesh.indices).filter((_,i)=>welded.areas[Math.floor(i/3)]!==0))}
    writeFileSync(resolve(EVIDENCE,`round6-recognition-${sign}.json`),JSON.stringify({topology:{zeroArea,overusedEdges:welded.edges.filter(e=>e.facets.length>2),exactRemovalControl:recognizeMeshFeatures(noZero).features.map(f=>({kind:f.kind,diametersMm:f.diametersMm}))},withoutIds:recognizeMeshFeatures(mesh),withIds:recognizeMeshFeatures(resumed.mesh,resumed.sourceFacetIds),modelFeatures:model.features.map(f=>({kind:f.kind,facets:f.facets.length})),removed,handRemoved,parameters:journal[0].parameters},null,2))
    expect(zeroArea,'no collapsed triangles in the published mesh').toHaveLength(0)
    expect(welded.edges.every(e=>e.facets.length===2),'closed unambiguous published topology').toBe(true)
    expect(feature,'new bore remains a selectable 6/12 counterbore').toBeDefined()
    if(feature?.target.family!=='round') throw Error('no counterbore')
    expect(feature.target.feature.diameterMm).toBeCloseTo(6,2)
    const diameters=feature.target.feature.bands.filter(b=>b.surface==='cylinder').map(b=>b.diameterMm).sort((a,b)=>a-b)
    expect(diameters).toHaveLength(2)
    // Each radius carries the operation's 0.005 mm chord budget.
    for(const [i,expected] of [6,12].entries()) expect(Math.abs(diameters[i]-expected)).toBeLessThan(.011)
    // Replay boundaries still reject stale witnesses and invalid opening data.
    const stale=JSON.parse(JSON.stringify(journal));stale[0].witness.facetCount++
    expect(resolveEditedStlMesh(bytes,stale).stopped).toBeDefined()
    expect(()=>enlargeHoleOperation.validate({...journal[0].parameters,boreOpenEnd:'sideways'})).toThrow()
    const withoutRange={...journal[0].parameters};delete withoutRange.boreRangeMm
    expect(()=>enlargeHoleOperation.validate(withoutRange)).toThrow()
    expect(()=>enlargeHoleOperation.validate({...journal[0].parameters,depthMm:10,fromDepthMm:9})).toThrow()
    const legacy=JSON.parse(JSON.stringify(journal));delete legacy[0].parameters.boreOpenEnd
    expect(resolveEditedStlMesh(bytes,legacy).stopped,'older range-bounded records still replay').toBeUndefined()
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(()=>expect(journalOf(s.id)??[]).toHaveLength(0))
    expect(measureMesh(stlMesh(s)).volume).toBeCloseTo(s.volume,4)
    fireEvent.click(screen.getByTestId('workbench-redo'));await waitFor(()=>sections(stlMesh(s),6))
    cleanup();await openStl(bytes,40)
    // Reopen the serialized persisted journal through the actual Model screen.
    await act(async()=>useCamStore.setState(st=>({project:{...st.project,geometry:st.project.geometry.map(g=>g.id===s.id?{...g,meshEdits:journal}:g)}})))
    await waitFor(()=>sections(stlMesh(s),6))
    // A planner control isolates the shrink consumer without a stale viewport driver.
    const resolved=resolveEditedStlMesh(bytes,journal)
    const shrink=planStlFeatureEdits({...resolved,roundFeatures:recognizeMeshFeatures(resolved.mesh,resolved.sourceFacetIds).features},
      [{tool:'resize-hole',feature,step:'counterbore',diameterMm:10}])
    expect(shrink.ok).toBe(true)
    if(!shrink.ok) throw Error(shrink.reason)
    sections(shrink.mesh,5)
    const draw=(m:MeshBuffers,color:string,width:number)=>section(m).map(([x,z,u,v])=>`<line x1="${20+x*12}" y1="${220-z*12}" x2="${20+u*12}" y2="${220-v*12}" stroke="${color}" stroke-width="${width}"/>`).join('')
    writeFileSync(resolve(EVIDENCE,`round6-mouth-${sign}-section.svg`),`<svg xmlns="http://www.w3.org/2000/svg" width="560" height="260"><rect width="100%" height="100%" fill="white"/><text x="20" y="25">Counterbore opening ${sign===1?'up':'down'}: grey before, red d12 after</text>${draw(resolveEditedStlMesh(bytes,undefined).mesh,'#999',4)}${draw(mesh,'#c22',1.5)}</svg>`)
    record(`round6-chamfer-mouth-${sign}`,{removed,handRemoved,sections:measured,recognition:'6/12 counterbore',replay:true,undo:true,redo:true,remount:true,shrinkControl:true})
  },120000)
  it.each(consumerCases)('round5 counterbore resize preserves $name and pilot',async(profile)=>{
    const s=await openStl(await consumerFixture(profile),40),before=stlMesh(s)
    consumerSections(before,profile)
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    s.runtime.rayOverride={origin:{x:20,y:20,z:10},direction:{x:0,y:1,z:0}};click()
    await applyDiameter(12)
    const mesh=stlMesh(s),removed=s.volume-measureMesh(mesh).volume
    expect(Math.abs(removed-4*Math.PI*(36-25)),'only the 4 mm counterbore is bored').toBeLessThan(.6)
    consumerSections(mesh,profile,6)
    const completeAfterResize = () => {
      const model=buildStlModelBodyModel({geoId:s.id,name:profile.name,bytes:s.bytes,meshEdits:journalOf(s.id)})
      const holes=model.features.filter(f=>f.target.family==='round'&&f.target.feature.kind!=='boss')
      expect(holes,`${profile.name}: round7 resized void stays one complete counterbore`).toHaveLength(1)
      expect(holes[0].target.family).toBe('round')
      if(holes[0].target.family!=='round') throw new Error('not round')
      expect(holes[0].target.feature.kind,`${profile.name}: round7 resized void keeps its shoulder`).toBe('counterbore')
      expect(holes[0].target.feature.bands).toHaveLength(profile.bands.length)
    }
    completeAfterResize()
    const resumed=resolveEditedStlMesh(s.bytes,JSON.parse(JSON.stringify(journalOf(s.id))))
    expect(resumed.stopped).toBeUndefined();consumerSections(resumed.mesh,profile,6)
    expect(meshFeatureTargets(resumed.mesh,resumed.sourceFacetIds).pockets).toHaveLength(1)
    fireEvent.click(screen.getByTestId('workbench-undo'));await waitFor(()=>consumerSections(stlMesh(s),profile))
    fireEvent.click(screen.getByTestId('workbench-redo'));await waitFor(()=>consumerSections(stlMesh(s),profile,6))
    completeAfterResize()
    // CAM target publication creates its own history entry: measure it only
    // after the resize Undo/Redo sequence, so Undo still targets the resize.
    let targets!: Awaited<ReturnType<ReturnType<typeof useCamStore.getState>['loadMeshFeatureTargets']>>
    await act(async()=>{targets=await useCamStore.getState().loadMeshFeatureTargets(s.id)})
    expect(targets.pockets,`${profile.name}: round7 resized shoulder reaches CAM`).toHaveLength(1)
    const pocket=targets.pockets[0]
    expect(pocket.diameterMm).toBeCloseTo(12,1)
    expect(pocket.floorZ).toBeCloseTo(8,3)
    expect(pocket.topZ).toBeCloseTo(12,3)
    record(`round5-resize-${profile.name}`,{removed,handRemoved:44*Math.PI,pilotAndFloorPreserved:true,replay:true,undo:true,redo:true,pocket,completeRecognition:true,productionCamLoad:true})
  },120000)
  it.each([1,-1])('round5 CAM chamfered counterbore pocket uses cylinder with axis %s',async(sign)=>{
    const bytes=await consumerFixture({bands:[[0,8,3,3],[8,11,5,5],[11,12,5,6]]})
    const mesh=resolveEditedStlMesh(bytes,undefined).mesh
    const rec=recognizeMeshFeatures(mesh).features.find(f=>f.kind==='counterbore')!
    // The same measured feature has two equivalent signed axis frames. Reverse
    // stations with the axis; rotating a mesh does not force a seed's sign.
    const oriented=sign===1?rec:{...rec,axis:{...rec.axis,direction:rec.axis.direction.map(v=>-v) as [number,number,number]},
      bands:rec.bands.map(b=>({...b,axialRangeMm:[-b.axialRangeMm[1],-b.axialRangeMm[0]] as [number,number],
        ...(b.surface==='cone'?{diameterMm:b.endDiameterMm!,endDiameterMm:b.diameterMm}:{})}))}
    expect(Math.sign(oriented.axis.direction[2])).toBe(sign)
    const pocket=counterborePocketTarget(oriented,[0,0,0])
    expect(pocket.diameterMm).toBeCloseTo(10,3)
    expect(pocket.floorZ).toBeCloseTo(8,3)
    expect(pocket.topZ).toBeCloseTo(11,3)
    expect(meshFeatureTargets(mesh).pockets[0]).toMatchObject({diameterMm:pocket.diameterMm,floorZ:8,topZ:11})
    record(`round5-cam-axis-${sign}`,{pocket,axis:oriented.axis})
  },120000)
  it('round5 large-coordinate STL Move preserves sections and replays without a sliver refusal',async()=>{
    const offset=[1000.123,2000.456,77.7]
    const s=await openStl(shiftedBytes(bytesOf(part('stepped_holes.stl')),offset))
    const model=()=>buildStlModelBodyModel({geoId:s.id,name:'offset',bytes:s.bytes,meshEdits:journalOf(s.id)})
    const ids=model().features.filter(f=>f.target.family==='round').map(f=>f.id)
    for(const [n,x] of [55,35,15].entries()) {
      fireEvent.click(screen.getByTestId('workbench-move-hole'))
      s.runtime.rayOverride={origin:{x:x+offset[0],y:20+offset[1],z:7+offset[2]},direction:{x:0,y:1,z:0}};click()
      await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
      await typeMove(10)
      expect(statusOf('move-hole-status'),'valid offset hole move; numerical debris is not another original solid').toBe('ready')
      fireEvent.click(screen.getByTestId('move-hole-apply'))
      await waitFor(()=>expect(journalOf(s.id)).toHaveLength(n+1))
      await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
    }
    assertSections(shiftMesh(stlMesh(s),offset.map(v=>-v)),[25,45,65])
    const resumed=resolveEditedStlMesh(s.bytes,JSON.parse(JSON.stringify(journalOf(s.id))))
    expect(resumed.stopped).toBeUndefined()
    assertSections(shiftMesh(resumed.mesh,offset.map(v=>-v)),[25,45,65])
    expect(model().features.filter(f=>f.target.family==='round').map(f=>f.id)).toEqual(ids)
    record('round5-large-coordinates',{offset,volumeBefore:s.volume,volumeAfter:measureMesh(resumed.mesh).volume,replay:true,pickIdentity:true})
  },120000)
  it('round5 offset Move discounts injected post-Boolean numerical slivers but preserves real shells',async()=>{
    const offset=[1000.123,2000.456,77.7],s=await openStl(shiftedBytes(bytesOf(part('stepped_holes.stl')),offset))
    const originalBoolean=manifoldOps.booleanMeshWithAncestry
    let injected=0
    // An explicit boundary fault injection: the unforced offset fixture above
    // passes on this kernel. Preserve that fact; do not claim this debris was
    // naturally generated by it. The condition must handle the reported state.
    const spy=vi.spyOn(manifoldOps,'booleanMeshWithAncestry').mockImplementation((...args)=>{
      const step=originalBoolean(...args)
      const mesh=step.result.mesh,n=mesh.positions.length/3
      const x=offset[0]+80,y=offset[1]+50,z=offset[2]+1
      const positions=Float32Array.from([...mesh.positions,x,y,z,x+.01,y,z,x,y+.01,z,x,y,z+.0001])
      const indices=Uint32Array.from([...mesh.indices,n,n+2,n+1,n,n+1,n+3,n,n+3,n+2,n+1,n+2,n+3])
      const sliverMesh={positions,indices},measures=measureMesh(sliverMesh)
      expect(measures.componentCount).toBe(2)
      injected++
      return {...step,result:{...step.result,mesh:sliverMesh,measures},
        leftTriangle:Int32Array.from([...step.leftTriangle,-1,-1,-1,-1]),
        rightTriangle:Int32Array.from([...step.rightTriangle,-1,-1,-1,-1])}
    })
    try {
      fireEvent.click(screen.getByTestId('workbench-move-hole'))
      s.runtime.rayOverride={origin:{x:55+offset[0],y:20+offset[1],z:7+offset[2]},direction:{x:0,y:1,z:0}};click()
      await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
      await typeMove(10)
      expect(statusOf('move-hole-status'),'sub-tolerance numerical shell must not invent wall/overlap refusal').toBe('ready')
      expect(injected).toBeGreaterThan(0)
      fireEvent.click(screen.getByTestId('move-hole-apply'))
      await waitFor(()=>expect(journalOf(s.id)).toHaveLength(1))
      await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
      assertSections(shiftMesh(stlMesh(s),offset.map(v=>-v)),[15,35,65])
      record('round5-injected-sliver',{offset,injected,kind:'post-Boolean fault injection',volumeThresholdMm3:1e-4,meaningfulShells:1})
    } finally {spy.mockRestore()}
    // A genuine small but above-budget separate solid is never discounted.
    const base=resolveEditedStlMesh(twoSolidBytes(),undefined).mesh
    expect(solidShellCount(base,.001)).toBe(2)
  },120000)
  it('round5 blind stepped Defeature and pilot resize retain their complete selection',async()=>{
    const profile=consumerCases[0],s=await openStl(await consumerFixture(profile),40)
    const model=buildStlModelBodyModel({geoId:s.id,name:'blind',bytes:s.bytes,meshEdits:undefined})
    const feature=model.features.find(f=>f.kind==='counterbore')!
    const resolved=resolveEditedStlMesh(s.bytes,undefined)
    await primeBoringKernel()
    // This is a production-planner control, supplementing the screen tests.
    const removed=planStlFeatureEdits({...resolved,roundFeatures:recognizeMeshFeatures(resolved.mesh,resolved.sourceFacetIds).features},[{tool:'defeature',feature}])
    expect(removed.ok).toBe(true)
    if(!removed.ok) throw Error(removed.reason)
    expect(measureMesh(removed.mesh).volume).toBeCloseTo(19200,2)
    const deepened=planStlFeatureEdits({...resolved,roundFeatures:recognizeMeshFeatures(resolved.mesh,resolved.sourceFacetIds).features},
      [{tool:'resize-hole',feature,diameterMm:6,depth:10}])
    expect(deepened.ok).toBe(true)
    if(!deepened.ok) throw Error(deepened.reason)
    expect(Math.abs(s.volume-measureMesh(deepened.mesh).volume-9*Math.PI),'pilot depth grows one mm, counterbore unchanged').toBeLessThan(.1)
    expect(crossings(deepened.mesh,2.5)).toHaveLength(4)
    consumerSections(deepened.mesh,{bands:[[2,8,3,3],[8,12,5,5]] as ProfileBand[]})
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    s.runtime.rayOverride={origin:{x:20,y:20,z:5},direction:{x:0,y:1,z:0}};click()
    await applyDiameter(7)
    const mesh=stlMesh(s)
    expect(Math.abs(s.volume-measureMesh(mesh).volume-5*Math.PI*(12.25-9))).toBeLessThan(.6)
    const pilot={bands:[[3,8,3.5,3.5],[8,12,5,5]] as ProfileBand[]}
    consumerSections(mesh,pilot)
  },120000)

  it.each(stackCases.flatMap(profile=>['STEP','STL'].map(route=>({profile,route}))))(
    '$route arbitrary stack: $profile.name',async({profile,route})=>{
      const fixture=await stackFixture(profile),delta=profile.moveMm??10,target=25+delta
      if(route==='STEP') {
        const s=await openStep(`${profile.name}.step`,fixture.step)
        expect(screen.queryByTestId('workbench-move-hole'),'production Move Hole route').not.toBeNull()
        expect(Math.abs(s.volume-fixture.volume)).toBeLessThan(fixture.volume*1e-6)
        const featureOf=async(id:string)=>{
          const features=await hooks().client.recognizeFeatures(hooks().getBodyHandle(id)!)
          const holes=features.filter(f=>['throughHole','blindHole','counterboreStack'].includes(f.featureClass))
          expect(holes,`${profile.name}: one complete recognized hole`).toHaveLength(1)
          expect(holes[0].removable).toBe(true)
          const types=await Promise.all(holes[0].faceIds.map(face=>hooks().client.classifyFace(hooks().getBodyHandle(id)!,face)))
          expect(types.filter(t=>t==='cylinder')).toHaveLength(profile.bands.filter(b=>b[2]===b[3]).length)
          expect(types.filter(t=>t==='cone')).toHaveLength(profile.bands.filter(b=>b[2]!==b[3]).length)
          return holes[0]
        }
        const beforeFeature=await featureOf('IMP1')
        stackSections(await stepMesh('IMP1'),profile,25)
        await pickStep(s,'IMP1',25);await typeMove(delta)
        expect(statusOf('move-hole-status'),`${profile.name}: whole stack can move`).toBe('ready')
        const before=hooks().dag.featureOrder()
        fireEvent.click(screen.getByTestId('move-hole-apply'))
        await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
        const id=hooks().dag.featureOrder().find(f=>!before.includes(f))!
        expect(Math.abs(await volumeOf(id)-s.volume)).toBeLessThan(s.volume*1e-6)
        const mesh=await stepMesh(id)
        expect(solidShellCount(mesh)).toBe(1)
        const afterFeature=await featureOf(id)
        // A through-hole recognizer may seed from either opening. The axis
        // LINE and profile must survive; its signed direction is not geometry.
        const {axisX:bx,axisY:by,axisZ:bz,...beforeParams}=beforeFeature.params
        const {axisX:ax,axisY:ay,axisZ:az,...afterParams}=afterFeature.params
        expect(Math.abs(Number(ax)*Number(bx)+Number(ay)*Number(by)+Number(az)*Number(bz))).toBeCloseTo(1,6)
        expect(afterParams).toEqual(beforeParams)
        const sections=stackSections(mesh,profile,target)
        captureSection(`${route}-stack-${profile.name.replaceAll(' ','-')}`,route==='STEP'?await stepMesh('IMP1'):resolveEditedStlMesh(fixture.stl,undefined).mesh,mesh,delta)
        await pickStep(s,id,target);await typeMove(1)
        expect(statusOf('move-hole-status'),`${profile.name}: fresh moved-hole pick`).toBe('ready')
        fireEvent.click(screen.getByTestId('move-hole-cancel'))
        record(`HM-1-stack-${profile.name}`,{volumeBefore:s.volume,volumeAfter:await volumeOf(id),handVolume:fixture.volume,sections,profile:profile.bands,freshPick:true})
      } else {
        const s=await openStl(fixture.stl)
        expect(screen.queryByTestId('workbench-move-hole'),'production Move Hole route').not.toBeNull()
        const model=()=>buildStlModelBodyModel({geoId:s.id,name:profile.name,bytes:s.bytes,meshEdits:journalOf(s.id)})
        const featureOf=(centre:number)=>{
          const holes=model().features.filter(f=>f.target.family==='round'&&f.target.feature.kind!=='boss')
          expect(holes,`${profile.name}: one complete selectable hole`).toHaveLength(1)
          const feature=holes[0]
          expect(feature.facets.length).toBeGreaterThan(0)
          if(feature.target.family!=='round') throw new Error('not round')
          const f=feature.target.feature
          expect(Math.abs(f.axis.origin[0]-centre)).toBeLessThan(.03)
          const bands=f.bands.map(b=>{
            const z=b.axialRangeMm.map(t=>f.axis.origin[2]+t*f.axis.direction[2])
            const radii=[b.diameterMm/2,(b.endDiameterMm??b.diameterMm)/2]
            return z[0]<z[1]?[z[0],z[1],...radii]:[z[1],z[0],radii[1],radii[0]]
          }).sort((a,b)=>a[0]-b[0])
          expect(bands,`${profile.name}: recognition includes every original band`).toHaveLength(profile.bands.length)
          bands.forEach((b,i)=>b.forEach((v,j)=>expect(Math.abs(v-profile.bands[i][j]),`${profile.name}: band ${i} field ${j}`).toBeLessThan(.03)))
          return feature.id
        }
        if(profile.name.startsWith('round7')) {
          writeFileSync(resolve(EVIDENCE,`${profile.name.replaceAll(' ','-')}.stl`),new Uint8Array(fixture.stl))
          writeFileSync(resolve(EVIDENCE,`${profile.name.replaceAll(' ','-')}-recognition.json`),JSON.stringify(recognizeMeshFeatures(stlMesh(s)),null,2))
        }
        const identity=featureOf(25)
        stackSections(stlMesh(s),profile,25)
        const aim=(x:number)=>{s.runtime.rayOverride={origin:{x,y:20,z:(profile.bands[0][0]+profile.bands[0][1])/2},direction:{x:0,y:1,z:0}};click()}
        fireEvent.click(screen.getByTestId('workbench-move-hole'));aim(25)
        await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
        await typeMove(delta)
        expect(statusOf('move-hole-status'),`${profile.name}: whole stack can move`).toBe('ready')
        const redraw=s.runtime.addedObjects.length
        fireEvent.click(screen.getByTestId('move-hole-apply'))
        await waitFor(()=>expect(journalOf(s.id)).toHaveLength(1))
        await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
        await waitFor(()=>expect(s.runtime.addedObjects.length).toBeGreaterThan(redraw))
        const mesh=stlMesh(s)
        expect(Math.abs(measureMesh(mesh).volume-s.volume)).toBeLessThan(s.volume*1e-6)
        expect(solidShellCount(mesh)).toBe(1)
        expect(featureOf(target),`${profile.name}: moved stack keeps pick identity`).toBe(identity)
        const sections=stackSections(mesh,profile,target)
        captureSection(`${route}-stack-${profile.name.replaceAll(' ','-')}`,route==='STEP'?await stepMesh('IMP1'):resolveEditedStlMesh(fixture.stl,undefined).mesh,mesh,delta)
        const resumed=resolveEditedStlMesh(s.bytes,JSON.parse(JSON.stringify(journalOf(s.id))))
        expect(resumed.stopped).toBeUndefined()
        stackSections(resumed.mesh,profile,target)
        fireEvent.click(screen.getByTestId('workbench-move-hole'));aim(target)
        await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
        await typeMove(1);expect(statusOf('move-hole-status')).toBe('ready')
        fireEvent.click(screen.getByTestId('move-hole-cancel'))
        expect(journalOf(s.id)).toHaveLength(1)
        record(`SHM-1-stack-${profile.name}`,{volumeBefore:s.volume,volumeAfter:measureMesh(mesh).volume,sections,profile:profile.bands,identity,freshPick:true,serializedReplay:true})
      }
    },120000)
  it('classifies numeric end-plane touches as endpoints but still detects interior and near-end ribs',()=>{
    // Numerical control, separate from the production-screen acceptance:
    // a one-facet rim face, then ribs whose vertices are outside the bore
    // while their triangle interiors span it. The fit axis has tiny tilt.
    const obstacles=(points:number[])=>corridorObstructions(weldMesh({positions:Float32Array.from(points),indices:new Uint32Array([0,1,2])}),
      [0,0,0],[-1e-8,0,1],0,15,2.49,2.51,new Set())
    expect(obstacles([2.5,0,15,5,0,15,5,5,15])).toEqual([])
    for(const z of [7,14.9999]) expect(obstacles([-3,-3,z,3,-3,z,0,3,z])).toEqual([0])
  })
  it('STEP moves a two-cone hole as an exact void through Apply, Edit, Undo, Redo and a fresh pick',async()=>{
    // Audit's independently reproducible two-ended chamfered bore. Construct
    // only the imported fixture here; all editing uses the production screen.
    const { OcctKernel } = await import('occt-wasm')
    const k = await OcctKernel.init()
    let bytes: ArrayBuffer
    try {
      const bore = k.makeCylinder(2.5,15)
      const bottom = k.makeCone(4.5,2.5,2)
      const top = k.translate(k.makeCone(2.5,4.5,2),0,0,13)
      const tool = k.translate(k.fuse(k.fuse(bore,bottom),top),25,20,0)
      bytes = new TextEncoder().encode(k.exportStep(k.cut(k.makeBox(70,40,15),tool))).buffer
    } finally { k[Symbol.dispose]() }
    const s = await openStep('two-cone.step',bytes)
    const handVolume = 42000 - Math.PI * (2.5**2 * 15 + 2 * (2/3 * (4.5**2 + 4.5*2.5 + 2.5**2) - 2*2.5**2))
    expect(Math.abs(s.volume-handVolume)).toBeLessThan(1e-5)
    const verify = async(id:string,centre:number)=>{
      expect(Math.abs(await volumeOf(id)-handVolume)).toBeLessThan(1e-5)
      const mesh = await stepMesh(id)
      const sections:Record<string,number[]> = {}
      for(const z of [.01,1,1.99,2.01,7,12.99,13.01,14,14.99]) {
        const r = z<2 ? 4.5-z : z>13 ? z-10.5 : 2.5
        const actual = crossings(mesh,z), expected = [0,centre-r,centre+r,70]
        expect(actual).toHaveLength(4)
        actual.forEach((x,i)=>expect(Math.abs(x-expected[i]),`two-cone z=${z}`).toBeLessThan(.03))
        sections[String(z)] = actual
      }
      return sections
    }
    await verify('IMP1',25)
    const originalOrder = hooks().dag.featureOrder()
    const body = hooks().getBodyHandle('IMP1')!
    const recognized = await hooks().client.recognizeFeatures(body)
    const hole = recognized.find(f=>f.featureClass==='counterboreStack')!
    const missing=await hooks().client.editFeature({featureId:'MOVE-MISSING',body:hooks().getBodyHandle('IMP1')!,featureKey:'missing-hole',kind:'holeMove',delta:0,translation:[10,0,0]})
    expect(missing.ok).toBe(false)
    expect(missing.diagnostics.map(d=>String(d.params?.reason)).join(' ')).toMatch(/Move Hole: feature missing-hole not found/)

    expect(hole).toBeDefined()
    expect(hole.params.openings).toBe(2)
    // The service boundary also protects replay/imported payloads that bypass
    // the number-input UI. Invalid data must not produce an adopted body.
    for(const translation of [[0,0,0],[NaN,0,0],[Infinity,0,0],[0,0,1]]) {
      const refused = await hooks().client.editFeature({featureId:'invalid-move',body,
        featureKey:hole.featureKey,kind:'holeMove',delta:0,translation:translation as [number,number,number]})
      expect(refused.ok).toBe(false)
      expect(refused.body).toBeUndefined()
      expect(refused.diagnostics[0].params?.reason).toMatch(/finite|nonzero|same face/)
    }
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    await pickStep(s,'IMP1',25);await typeMove(10)
    expect(statusOf('move-hole-status'),'recognized two-cone exact void can move without reconstructing cones').toBe('ready')
    // Cancel a valid preview, then use a fresh pick; no row may be published.
    fireEvent.click(screen.getByTestId('move-hole-cancel'))
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    await pickStep(s,'IMP1',25);await typeMove(10)
    expect(statusOf('move-hole-status')).toBe('ready')
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('move-hole-apply'))
    await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
    const id = hooks().dag.featureOrder().find(f=>!before.includes(f))!
    const sections = await verify(id,35)
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(()=>expect(screen.getByTestId('move-hole-x')).toBeTruthy())
    await typeMove(9);expect(statusOf('move-hole-status')).toBe('ready')
    fireEvent.click(screen.getByTestId('move-hole-apply'))
    await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
    await verify(id,34)
    fireEvent.click(screen.getByTestId('workbench-undo'));await waitFor(async()=>{await verify(id,35)})
    fireEvent.click(screen.getByTestId('workbench-redo'));await waitFor(async()=>{await verify(id,34)})
    await pickStep(s,id,34);await typeMove(1)
    expect(statusOf('move-hole-status')).toBe('ready')
    const previous = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('move-hole-apply'))
    await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
    const repeated = hooks().dag.featureOrder().find(f=>!previous.includes(f))!
    await verify(repeated,35)
    record('HM-1-two-cones',{handVolume,volumeBefore:s.volume,volumeAfter:await volumeOf(repeated),
      sections,cones:2,cancel:true,edit:true,undo:true,redo:true,freshPick:true})
  },120000)
  it('STEP repicks every moved hole for another move and Resize Hole with hand volumes',async()=>{
    const s=await openStep(part('stepped_holes.step'))
    let id='IMP1'
    const move=async(x:number,delta:number)=>{
      const beforeVolume=await volumeOf(id)
      const before=hooks().dag.featureOrder()
      await pickStep(s,id,x);await typeMove(delta)
      expect(statusOf('move-hole-status'),text('move-hole-status')).toBe('ready')
      fireEvent.click(screen.getByTestId('move-hole-apply'))
      await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
      id=hooks().dag.featureOrder().find(f=>!before.includes(f))!
      expect(hooks().scheduler.statusOf(id)).toBe('ok')
      expect(Math.abs(await volumeOf(id)-beforeVolume)).toBeLessThan(beforeVolume*.001)
    }
    for(const h of repeatHoles) await move(h.x,10)
    const measurements=[]
    for(const h of repeatHoles){
      await move(h.x+10,-1)
      const beforeVolume=await volumeOf(id)
      fireEvent.click(screen.getByTestId('workbench-resize-hole')) // Disarm Move Hole's persistent STEP mode.
      fireEvent.click(screen.getByTestId('workbench-resize-hole'))
      await waitFor(()=>expect(text('solids-workbench-resizehole-hint')).not.toMatch(/recognizing/i))
      const pilot=findFace(await facesOf(id),'moved pilot',f=>f.type==='cylinder'&&Math.abs(f.centroid.x-h.x-9)<.1&&f.min.z<1)
      aimAtFace(s.runtime,pilot);click()
      const before=hooks().dag.featureOrder()
      await applyDiameter(h.diameter)
      id=hooks().dag.featureOrder().find(f=>!before.includes(f))!
      const deltaVolume=await volumeOf(id)-beforeVolume
      expect(Math.abs(deltaVolume-h.deltaVolume),h.kind).toBeLessThan(.5)
      measurements.push({kind:h.kind,deltaVolume,expected:h.deltaVolume})
      fireEvent.click(screen.getByTestId('workbench-resize-hole')) // Disarm before returning to Move Hole.
    }
    record('HM-1-repeat',{measurements,secondMove:true,resize:true})
  },180000)
  it('STL repicks every moved hole for another move and Resize Hole with hand volumes',async()=>{
    const s=await openStl()
    const model=()=>buildStlModelBodyModel({geoId:s.id,name:'stepped_holes',bytes:s.bytes,meshEdits:journalOf(s.id)})
    const identities=new Map(model().features.filter(f=>f.target.family==='round').map(f=>[f.kind,f.id]))
    const move=async(x:number,delta:number)=>{
      const count=journalOf(s.id)?.length??0
      fireEvent.click(screen.getByTestId('workbench-move-hole'));aimStl(s,x)
      await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
      await typeMove(delta);expect(statusOf('move-hole-status'),text('move-hole-status')).toBe('ready')
      const objectsBefore=s.runtime.addedObjects.length
      fireEvent.click(screen.getByTestId('move-hole-apply'))
      await waitFor(()=>expect(journalOf(s.id)).toHaveLength(count+1))
      await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
      // A committed journal redraws asynchronously; wait for its presentation
      // before clicking the next tool, just as openStl waits for its body row.
      await waitFor(()=>expect(screen.getByTestId(`body-row-stl-body:${s.id}`)).toBeTruthy())
      await waitFor(()=>expect(s.runtime.addedObjects.length).toBeGreaterThan(objectsBefore))
    }
    for(const h of repeatHoles) await move(h.x,10)
    const measurements=[]
    for(const h of repeatHoles){
      const moved=model().features.find(f=>f.target.family==='round'&&f.kind===h.kind)
      expect(moved?.id,`${h.kind}: moved hole retains its selectable source identity`).toBe(identities.get(h.kind))
      await move(h.x+10,-1)
      expect(model().features.find(f=>f.target.family==='round'&&f.kind===h.kind)?.id,
        `${h.kind}: second move retains its selectable source identity`).toBe(identities.get(h.kind))
      expect(Math.abs(measureMesh(stlMesh(s)).volume-s.volume)).toBeLessThan(s.volume*.001)
      const beforeVolume=measureMesh(stlMesh(s)).volume,count=journalOf(s.id)!.length
      fireEvent.click(screen.getByTestId('workbench-resize-hole'));aimStl(s,h.x+9)
      const objectsBefore=s.runtime.addedObjects.length
      await applyDiameter(h.diameter)
      await waitFor(()=>expect(journalOf(s.id)).toHaveLength(count+1))
      await waitFor(()=>expect(screen.getByTestId(`body-row-stl-body:${s.id}`)).toBeTruthy())
      await waitFor(()=>expect(s.runtime.addedObjects.length).toBeGreaterThan(objectsBefore))
      const deltaVolume=measureMesh(stlMesh(s)).volume-beforeVolume
      expect(Math.abs(deltaVolume-h.deltaVolume),h.kind).toBeLessThan(Math.max(.5,Math.abs(h.deltaVolume)*.03))
      measurements.push({kind:h.kind,deltaVolume,expected:h.deltaVolume})
      // The following move's volume reference includes this requested resize.
      s.volume=measureMesh(stlMesh(s)).volume
    }
    record('SHM-1-repeat',{measurements,secondMove:true,resize:true})
  },180000)
  it('HM-1: moves every STEP hole 10 mm, preserves sections, Undo and tree Edit',async()=>{
    const s=await openStep(part('stepped_holes.step'));const beforeMesh=await stepMesh('IMP1')
    assertSections(beforeMesh,[15,35,55])
    let id='IMP1'
    // Rightmost first avoids an intentional overlap with the unmoved countersink.
    for(const x of [55,35,15]){
      const before=hooks().dag.featureOrder()
      await pickStep(s,id,x);await typeMove(10)
      expect(statusOf('move-hole-status'),text('move-hole-status')).toBe('ready')
      fireEvent.click(screen.getByTestId('move-hole-apply'))
      await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
      id=hooks().dag.featureOrder().find(f=>!before.includes(f))!
      expect(id).toBeDefined();expect(hooks().scheduler.statusOf(id)).toBe('ok')
      expect(Math.abs(await volumeOf(id)-s.volume)).toBeLessThan(s.volume*.001)
    }
    const result=await stepMesh(id);const sections=assertSections(result,[25,45,65]);captureSection('HM-1',beforeMesh,result)
    // Tree Edit resolves against the pre-feature owner even though the hole moved.
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(()=>expect(screen.getByTestId('move-hole-x')).toBeTruthy())
    expect((screen.getByTestId('move-hole-x') as HTMLInputElement).value).toBe('10')
    await typeMove(9);fireEvent.click(screen.getByTestId('move-hole-apply'))
    await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
    expect(hooks().dag.featureOrder().filter(f=>f===id)).toHaveLength(1)
    assertSections(await stepMesh(id),[24,45,65])
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(async()=>{assertSections(await stepMesh(id),[25,45,65])})
    for(let n=0;n<3;n++) {fireEvent.click(screen.getByTestId('workbench-undo'));await waitFor(()=>expect(hooks().dag.featureOrder().filter(f=>hooks().dag.getNode(f)?.payload.opType==='resizeHole')).toHaveLength(2-n))}
    assertSections(await stepMesh('IMP1'),[15,35,55]);record('HM-1',{sections,volumeBefore:s.volume,undo:true,edit:true})
  },180000)
  it('STEP refuses wall breakout, overlap and an axial delta without publishing',async()=>{
    const s=await openStep(part('stepped_holes.step'));await pickStep(s,'IMP1',55)
    const before=hooks().dag.featureOrder()
    for(const d of [[14,0,0],[-20,0,0],[0,0,1]]){
      await typeMove(...d as [number,number,number])
      expect(statusOf('move-hole-status'),text('move-hole-status')).toBe('refused')
      expect(text('move-hole-status')).toMatch(/wall|overlap|same face/)
      expect(hooks().dag.featureOrder()).toEqual(before)
    }
  },120000)
  it('SHM-1: moves every STL hole 10 mm, preserves sections, Undo and tree Edit',async()=>{
    const s=await openStl();const before=stlMesh(s);assertSections(before,[15,35,55])
    for(const x of [55,35,15]){
      const count=journalOf(s.id)?.length??0
      fireEvent.click(screen.getByTestId('workbench-move-hole'));aimStl(s,x)
      await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
      await typeMove(10);expect(statusOf('move-hole-status'),text('move-hole-status')).toBe('ready')
      fireEvent.click(screen.getByTestId('move-hole-apply'))
      await waitFor(()=>expect(journalOf(s.id)).toHaveLength(count+1))
      await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
      expect(Math.abs(measureMesh(stlMesh(s)).volume-s.volume)).toBeLessThan(s.volume*.001)
    }
    const result=stlMesh(s),sections=assertSections(result,[25,45,65]);captureSection('SHM-1',before,result)
    const recordId=journalOf(s.id)!.at(-1)!.id
    fireEvent.click(screen.getByTestId(`stl-edit-reopen-${recordId}`))
    await waitFor(()=>expect(screen.getByTestId('move-hole-x')).toBeTruthy())
    expect((screen.getByTestId('move-hole-x') as HTMLInputElement).value).toBe('10')
    await typeMove(9);expect(statusOf('move-hole-status'),text('move-hole-status')).toBe('ready');fireEvent.click(screen.getByTestId('move-hole-apply'))
    await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
    expect(journalOf(s.id)).toHaveLength(3);assertSections(stlMesh(s),[24,45,65])
    fireEvent.click(screen.getByTestId('workbench-undo'));await waitFor(()=>{assertSections(stlMesh(s),[25,45,65])})
    for(let n=0;n<3;n++){fireEvent.click(screen.getByTestId('workbench-undo'));await waitFor(()=>expect(journalOf(s.id)?.length??0).toBe(2-n))}
    assertSections(stlMesh(s),[15,35,55]);record('SHM-1',{sections,volumeBefore:s.volume,undo:true,edit:true})
  },180000)
  it('STL keeps two existing solids through move, interrupted preview, Edit, Undo, Redo and reload',async()=>{
    const s=await openStl(twoSolidBytes(),170), original=stlMesh(s)
    const remoteBefore=measureMesh(remoteSolid(original)).volume
    const identity=()=>buildStlModelBodyModel({geoId:s.id,name:'two solids',bytes:s.bytes,meshEdits:journalOf(s.id)})
      .features.find(f=>f.kind==='through-hole'&&f.target.family==='round'&&f.target.feature.axis.origin[0]<100)
    const originalId=identity()!.id
    const verify=(centre:number)=>{
      const mesh=stlMesh(s)
      expect(solidShellCount(mesh),'retain both disconnected input solids').toBe(2)
      // Moving the same void has hand volume delta 0 mm3.
      expect(Math.abs(measureMesh(mesh).volume-s.volume)).toBeLessThan(.003)
      expect(Math.abs(measureMesh(remoteSolid(mesh)).volume-remoteBefore)).toBeLessThan(.003)
      expect(identity()?.id,'moved hole remains selectable').toBe(originalId)
      for(const z of [2,8.49,8.51,10,11.79,11.81,14,14.99]) {
        const expected=crossings(original,z)
        // Only the first block's through hole moves; remote block and steps stay.
        expected[5]+=centre-55;expected[6]+=centre-55
        const actual=crossings(mesh,z)
        expect(actual).toHaveLength(expected.length)
        actual.forEach((x,i)=>expect(Math.abs(x-expected[i]),`z=${z}, crossing ${i}`).toBeLessThan(.03))
      }
    }
    const pick=async(x:number)=>{
      fireEvent.click(screen.getByTestId('workbench-move-hole'));aimStl(s,x)
      await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
    }
    const apply=async(delta:number,count:number)=>{
      await typeMove(delta)
      expect(statusOf('move-hole-status'),'valid same-face move on an existing two-solid STL').toBe('ready')
      const objects=s.runtime.addedObjects.length
      fireEvent.click(screen.getByTestId('move-hole-apply'))
      await waitFor(()=>expect(journalOf(s.id)).toHaveLength(count))
      await waitFor(()=>expect(screen.queryByTestId('move-hole-entry')).toBeNull())
      await waitFor(()=>expect(s.runtime.addedObjects.length).toBeGreaterThan(objects))
    }
    verify(55)
    await pick(55)
    for(const d of [[14,0,0],[-20,0,0],[0,0,1]]) {
      await typeMove(...d as [number,number,number])
      expect(statusOf('move-hole-status')).toBe('refused')
      expect(text('move-hole-status')).toMatch(/wall|overlap|same face/)
      expect(screen.getByTestId('move-hole-apply').hasAttribute('disabled')).toBe(true)
      expect(journalOf(s.id)?.length??0).toBe(0);verify(55)
    }
    // Interrupt a launched preview before its asynchronous completion. The
    // generation guard must prevent a late ready result reopening the tool.
    fireEvent.change(screen.getByTestId('move-hole-x'),{target:{value:'10'}})
    fireEvent.change(screen.getByTestId('move-hole-z'),{target:{value:'0'}})
    fireEvent.click(screen.getByTestId('move-hole-cancel'))
    await act(async()=>{await Promise.resolve()})
    expect(screen.queryByTestId('move-hole-entry')).toBeNull()
    expect(journalOf(s.id)?.length??0).toBe(0);verify(55)
    await pick(55);await apply(10,1);verify(65)
    // Replay-stop control: a real wall breakout must preserve the valid prefix,
    // and skip this invalid record and the record after it.
    const live=stlMesh(s), feature=identity()!
    expect(feature.target.family).toBe('round')
    if(feature.target.family!=='round') throw Error('missing round target')
    const invalid=createMeshEditRecord(live,{kind:'move-hole',facets:feature.facets,
      parameters:{translation:[4,0,0],axisDirection:[...feature.target.feature.axis.direction]}})
    const stopped=resolveEditedStlMesh(s.bytes,[...journalOf(s.id)!,invalid,invalid])
    expect(stopped.appliedCount).toBe(1);expect(stopped.stopped?.index).toBe(1)
    expect(stopped.stopped?.reason).toMatch(/wall|overlap/)
    expect(solidShellCount(stopped.mesh)).toBe(2)
    expect(measureMesh(stopped.mesh).volume).toBe(measureMesh(live).volume)
    const recordId=journalOf(s.id)![0].id
    fireEvent.click(screen.getByTestId(`stl-edit-reopen-${recordId}`))
    await waitFor(()=>expect(screen.getByTestId('move-hole-x')).toBeTruthy())
    expect((screen.getByTestId('move-hole-x') as HTMLInputElement).value).toBe('10')
    await apply(9,1);verify(64)
    fireEvent.click(screen.getByTestId('workbench-undo'));await waitFor(()=>verify(65))
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(()=>expect(journalOf(s.id)?.length??0).toBe(0));verify(55)
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(()=>expect(journalOf(s.id)).toHaveLength(1));verify(65)
    // Remount the production screen on a serialized journal, then freshly pick
    // the moved hole. Stored tree rows alone are not the pick-readiness oracle.
    cleanup()
    act(()=>useCamStore.setState(st=>({project:{...st.project,geometry:st.project.geometry.map(g=>g.id===s.id?
      {...g,meshEdits:JSON.parse(JSON.stringify(g.meshEdits))}:g)}})))
    s.runtime=createFakeSceneRuntime();s.runtime.projectToCanvasResult={x:300,y:200}
    render(createElement(SolidsWorkbenchPage,{createClient:()=>createFakeGeomClient(),createSceneRuntime:()=>s.runtime}))
    await waitFor(()=>expect(screen.getByTestId(`body-row-stl-body:${s.id}`)).toBeTruthy(),{timeout:30000})
    verify(65);await pick(65);await apply(-1,2);verify(64)
    record('SHM-1-two-solids',{componentCount:2,volumeBefore:s.volume,volumeAfter:measureMesh(stlMesh(s)).volume,
      handDeltaVolume:0,remoteBefore,remoteAfter:measureMesh(remoteSolid(stlMesh(s))).volume,
      identity:originalId,interruptedPreview:true,edit:true,undo:true,redo:true,reload:true,replayStop:true,
      actualWallBreakoutRefused:true,overlapRefused:true,axialRefused:true})
  },180000)
  it('STL refuses wall breakout, overlap and an axial delta without recording',async()=>{
    const s=await openStl();fireEvent.click(screen.getByTestId('workbench-move-hole'));aimStl(s,55)
    await waitFor(()=>expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
    for(const d of [[14,0,0],[-20,0,0],[0,0,1]]){
      await typeMove(...d as [number,number,number]);expect(statusOf('move-hole-status'),text('move-hole-status')).toBe('refused')
      expect(text('move-hole-status')).toMatch(/wall|overlap|same face/);expect(journalOf(s.id)?.length??0).toBe(0)
    }
  },120000)
})
