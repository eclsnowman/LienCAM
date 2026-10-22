// WO-3044: the Model page's AO bake no longer runs on the page thread. An opted-in body
// (geometry.userData.aoOffThread, set by SolidsWorkbenchPage) over a small vertex count
// gets a flat all-1 attribute at once and is baked in a worker; the values that land are
// the ones computeVertexAO gives on the page thread; the coarse pass is not baked.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  AO_ATTRIBUTE,
  AO_OFF_THREAD_KEY,
  AO_OFF_THREAD_MIN_VERTICES,
  AO_SKIP_KEY,
  applyBodyAO,
  computeVertexAO,
  onBodyAoLanded,
  runAoJob,
  setAoWorkerFactory,
  type AoJob,
  type AoWorkerLike,
} from '../../lib/viewport/lighting/vertexAO'

/** A plate top as a height field with a square pocket in the middle. */
function pocketPlate(n: number): THREE.BufferGeometry {
  const pos = new Float32Array(n * n * 3)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 60, y = (j / (n - 1)) * 60
      const inPocket = Math.abs(x - 30) < 9 && Math.abs(y - 30) < 9
      const k = (j * n + i) * 3
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = inPocket ? -12 : 0
    }
  }
  const index = new Uint32Array((n - 1) * (n - 1) * 6)
  let t = 0
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1
      index[t++] = a; index[t++] = b; index[t++] = d
      index[t++] = a; index[t++] = d; index[t++] = c
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.computeVertexNormals()
  return g
}

function bodyMesh(n: number, userData: Record<string, boolean>): THREE.Mesh {
  const geometry = pocketPlate(n)
  Object.assign(geometry.userData, userData)
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
}

const aoOf = (mesh: THREE.Mesh) => (mesh.geometry.getAttribute(AO_ATTRIBUTE) as THREE.BufferAttribute | undefined)

/** An in-process stand-in for the worker: it holds the job and bakes it only when the
 *  test says so, the way a worker answers after the caller has already returned. */
function fakeWorkers() {
  const started: Array<AoWorkerLike & { job: AoJob | null; terminated: boolean; answer(): void }> = []
  setAoWorkerFactory(() => {
    const worker = {
      job: null as AoJob | null,
      terminated: false,
      onmessage: null as AoWorkerLike['onmessage'],
      onerror: null as AoWorkerLike['onerror'],
      postMessage(job: AoJob) { worker.job = job },
      terminate() { worker.terminated = true },
      answer() { worker.onmessage?.({ data: { ao: runAoJob(worker.job as AoJob) } }) },
    }
    started.push(worker)
    return worker
  })
  return started
}

beforeEach(() => vi.stubGlobal('window', {}))
afterEach(() => { setAoWorkerFactory(undefined); vi.unstubAllGlobals() })

describe('WO-3044 the Model page AO bake runs off the calling thread', () => {
  it('returns before the bake, then lands the same AO the page thread computes', () => {
    const workers = fakeWorkers()
    const mesh = bodyMesh(40, { [AO_OFF_THREAD_KEY]: true })
    const expected = computeVertexAO(pocketPlate(40)).ao
    const landed = vi.fn()
    const off = onBodyAoLanded(landed)

    const result = applyBodyAO(mesh)

    expect(workers).toHaveLength(1)
    expect(result.vertices).toBe(0)
    const flat = aoOf(mesh)
    expect(flat?.count).toBe(1600)
    expect((flat?.array as Float32Array).every((v) => v === 1)).toBe(true)
    expect(landed).not.toHaveBeenCalled()

    workers[0].answer()

    expect(Array.from(aoOf(mesh)?.array as Float32Array)).toEqual(Array.from(expected))
    expect(aoOf(mesh)).toBe(flat)
    expect(workers[0].terminated).toBe(true)
    expect(landed).toHaveBeenCalledWith(mesh)
    off()
  })

  it('does not bake the coarse pass and starts no worker for it', () => {
    const workers = fakeWorkers()
    const mesh = bodyMesh(40, { [AO_OFF_THREAD_KEY]: true, [AO_SKIP_KEY]: true })
    applyBodyAO(mesh)
    expect(workers).toHaveLength(0)
    expect((aoOf(mesh)?.array as Float32Array).every((v) => v === 1)).toBe(true)
  })

  it('a replaced geometry stops the old bake and its late answer writes nothing', () => {
    const workers = fakeWorkers()
    const mesh = bodyMesh(40, { [AO_OFF_THREAD_KEY]: true })
    applyBodyAO(mesh)
    const first = mesh.geometry
    const second = pocketPlate(41)
    Object.assign(second.userData, { [AO_OFF_THREAD_KEY]: true })
    mesh.geometry = second
    applyBodyAO(mesh)
    expect(workers).toHaveLength(2)
    expect(workers[0].terminated).toBe(true)
    workers[0].answer()
    expect((first.getAttribute(AO_ATTRIBUTE).array as Float32Array).every((v) => v === 1)).toBe(true)
    workers[1].answer()
    expect(Array.from(second.getAttribute(AO_ATTRIBUTE).array as Float32Array)).toEqual(Array.from(computeVertexAO(pocketPlate(41)).ao))
  })

  it('stops the bake when the geometry is disposed', () => {
    const workers = fakeWorkers()
    const mesh = bodyMesh(40, { [AO_OFF_THREAD_KEY]: true })
    applyBodyAO(mesh)
    expect(workers).toHaveLength(1)
    mesh.geometry.dispose()
    expect(workers[0].terminated).toBe(true)
  })

  it('a small body, a body that did not opt in, and a cached AO keep the synchronous bake', () => {
    const workers = fakeWorkers()
    const small = bodyMesh(10, { [AO_OFF_THREAD_KEY]: true })
    expect(10 * 10).toBeLessThan(AO_OFF_THREAD_MIN_VERTICES)
    expect(applyBodyAO(small).vertices).toBe(100)

    const cam = bodyMesh(40, {})
    const camResult = applyBodyAO(cam)
    expect(camResult.vertices).toBe(1600)
    expect(Array.from(camResult.ao as Float32Array)).toEqual(Array.from(computeVertexAO(pocketPlate(40)).ao))

    const cached = bodyMesh(40, { [AO_OFF_THREAD_KEY]: true })
    expect(applyBodyAO(cached, camResult.ao).vertices).toBe(1600)
    expect(workers).toHaveLength(0)
  })

  it('bakes here when no worker can start', () => {
    setAoWorkerFactory(null)
    const mesh = bodyMesh(40, { [AO_OFF_THREAD_KEY]: true })
    expect(applyBodyAO(mesh).vertices).toBe(1600)
  })

  it('the worker entry answers a job with the same AO', async () => {
    const posted: Array<{ ao: Float32Array }> = []
    const scope = globalThis as unknown as { self?: unknown }
    const prior = scope.self
    const fake = { onmessage: null as ((e: { data: AoJob }) => void) | null, postMessage: (m: { ao: Float32Array }) => { posted.push(m) } }
    scope.self = fake
    try {
      await import('../../lib/viewport/lighting/vertexAO.worker')
      const g = pocketPlate(40)
      fake.onmessage?.({ data: { position: g.getAttribute('position').array as Float32Array, normal: g.getAttribute('normal').array as Float32Array, index: g.getIndex()?.array as Uint32Array } })
    } finally {
      scope.self = prior
    }
    expect(posted).toHaveLength(1)
    expect(Array.from(posted[0].ao)).toEqual(Array.from(computeVertexAO(pocketPlate(40)).ao))
  })
})

describe('WO-3044 committed measurements (src/tests/evidence/WO-3044, one machine)', () => {
  const read = (name: string) => JSON.parse(readFileSync(join(__dirname, '../evidence/WO-3044', name), 'utf8'))

  it('the browser bake: same AO bytes, the call returns at once, no long task', () => {
    const rows = read('measured.json').rows as Array<{ label: string; identicalAo: boolean; sync: Record<string, number>; offThread: Record<string, number> }>
    const big = rows.find((r) => r.label === 'portal-47k')!
    expect(big.identicalAo).toBe(true)
    expect(big.offThread.applyBodyAOReturnedAfterMs).toBeLessThan(100)
    expect(big.offThread.longestLongTaskMs).toBeLessThan(big.sync.longestLongTaskMs / 4)
  })

  it('the real Model page import: the AO bake leaves the page thread', () => {
    const main = read('journey-main.json'), branch = read('journey-branch.json')
    const settled = (j: { steps: Array<Record<string, unknown>> }) => j.steps.find((s) => s.step === 'import settled') as { aoBakes: Array<{ offThread?: boolean }>; longestMs: number }
    expect(main.errors).toEqual([])
    expect(branch.errors).toEqual([])
    expect(settled(main).aoBakes.some((b) => b.offThread)).toBe(false)
    expect(settled(branch).aoBakes.length).toBeGreaterThan(0)
    expect(settled(branch).aoBakes.every((b) => b.offThread === true)).toBe(true)
    expect(settled(branch).longestMs).toBeLessThan(settled(main).longestMs / 4)
  })
})
