import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'

const root = resolve(import.meta.dirname, '../../..')
const dist = join(root, 'dist')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
let sourceHandler: ((event: MessageEvent<WorkerRequestMsg>) => Promise<void> | void) | undefined

describe('WO-2485 replaceable LGPL production modules (run npm run build first)', () => {
  it('names one separate engine and one separate OpenCAMLib WASM in the build manifest', () => {
    expect(files(dist).filter(file => /opencamlib.*\.wasm$/.test(file))).toHaveLength(1)
    expect(files(dist).filter(file => /adaptive2d-engine.*\.js$/.test(file))).toHaveLength(1)
    const manifest = json(join(dist, 'lgpl-modules.json'))
    expect(Object.keys(json(join(dist, '.vite/manifest.json'))).length).toBeGreaterThan(0)
    expect(manifest.adaptiveEngine).toBe('assets/adaptive2d-engine.js')
    expect(manifest.openCamLibWasm).toBe('assets/opencamlib.wasm')
    expect(files(dist).filter(file => /adaptive2d-engine.*\.js$/.test(file))).toHaveLength(1)
    expect(files(dist).filter(file => /opencamlib.*\.wasm$/.test(file))).toHaveLength(1)
    expect(statSync(join(dist, manifest.adaptiveEngine)).size).toBeGreaterThan(10000)
    const wasm = readFileSync(join(dist, manifest.openCamLibWasm))
    expect([...wasm.subarray(0, 8)]).toEqual([0, 97, 115, 109, 1, 0, 0, 0])
    const upstream = readFileSync(join(root, 'node_modules/@opencamlib/opencamlib/browser.js'), 'utf8')
    const base64 = upstream.match(/'data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)'/)![1]
    expect(wasm.equals(Buffer.from(base64, 'base64'))).toBe(true)
  })

  it('owns every engine source module exclusively in the shared file, including worker routes', () => {
    const manifest = json(join(dist, 'lgpl-modules.json'))
    const chunks = manifest.chunks as Record<string, string[]>
    const sources = readdirSync(join(root, 'src/lib/cam/adaptiveClearing2d/engine')).filter(name => name.endsWith('.ts'))
    for (const source of sources) {
      const owners = Object.entries(chunks).filter(([, modules]) => modules.some(id =>
        id.replaceAll('\\', '/').endsWith(`/adaptiveClearing2d/engine/${source}`))).map(([name]) => name)
      expect(owners, source).toEqual([manifest.adaptiveEngine])
    }
    expect(Object.keys(chunks).some(name => name.includes('toolpathWorker'))).toBe(true)
    expect(Object.keys(chunks).some(name => name.includes('cam3dWorker'))).toBe(true)
    expect(Object.keys(chunks).some(name => name.includes('plannerWorker'))).toBe(true)
    for (const file of files(dist).filter(file => file.endsWith('.js'))) {
      const code = readFileSync(file, 'utf8')
      // WASM magic's base64 prefix catches the old multi-megabyte inline binary.
      expect(code, file).not.toContain('AGFzbQEAAAAB0QVa')
      if (file !== join(dist, manifest.adaptiveEngine)) {
        expect(code, file).not.toContain('function processFeature(')
        expect(code, file).not.toContain('function buildAdaptiveClearingToolpath(')
      }
    }
    const importers = files(dist).filter(file => file.endsWith('.js') && file !== join(dist, manifest.adaptiveEngine))
      .filter(file => readFileSync(file, 'utf8').includes('adaptive2d-engine.js'))
    expect(importers.some(file => file.includes('toolpathWorker'))).toBe(true)
    expect(importers.some(file => file.includes('cam3dWorker') || file.includes('plannerWorker'))).toBe(true)
    expect(files(dist).filter(file => file.endsWith('.js')).some(file => readFileSync(file, 'utf8').includes('opencamlib.wasm'))).toBe(true)
  })

  it('keeps the packaging config, engine sources and loader inside the public release export', () => {
    const selection = json(join(root, 'tools/release/manifest.json')).selection as { action: string; path: string }[]
    for (const path of ['vite.config.mts', 'src/']) {
      expect(selection.some(rule => rule.action === 'include' && rule.path === path)).toBe(true)
    }
    expect(selection.some(rule => rule.action === 'exclude' && /adaptiveClearing2d\/engine|oclWaterline/.test(rule.path))).toBe(false)
  })

  it.each(['COMPUTE_POCKET', 'COMPUTE_VCARVE'])('runs %s with workholding in a fresh built worker', async (type) => {
    const manifest = json(join(dist, 'lgpl-modules.json'))
    const workerFile = Object.keys(manifest.chunks).find(name => /\/toolpathWorker-[^/]+\.js$/.test(name))!
    expect(workerFile).toBeTruthy()
    const server = createServer((request, response) => {
      const pathname = new URL(request.url!, 'http://localhost').pathname
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><title>Built worker regression</title>')
        return
      }
      const file = resolve(dist, '.' + pathname)
      if (!file.startsWith(dist + '/') && !file.startsWith(dist + '\\')) { response.writeHead(403).end(); return }
      try {
        response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        response.end(readFileSync(file))
      } catch { response.writeHead(404).end() }
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      const address = server.address() as { port: number }
      await page.goto(`http://127.0.0.1:${address.port}/`)
      const result = await page.evaluate(async ({ workerFile, type }) => {
        // The same 100 x 60 pocket and strap geometry as WO-1579. Each
        // request starts a new production worker: Adaptive never warms it up.
        const positions: number[] = []
        for (const z of [10, 16]) for (const y of [-45, 45]) for (const x of [-7.5, 7.5]) positions.push(x, y, z)
        const indices: number[] = []
        for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) {
          indices.push(a, b, c, a, c, d)
        }
        const payload = {
          opId: 'built-workholding', setupId: 'setup',
          params: type === 'COMPUTE_POCKET'
            ? { loopIds: [], direction: 'climb', fillStrategy: 'outside_in', finishContour: false }
            : { geometryId: 'g', loopIds: [], role: 'flat_clearing', startDepthMm: 0, allowanceMm: 0,
                vbit: { angleFromAxisDeg: 45, tipDiameter: 0 }, flatClearing: { mode: 'tool', clearingToolDiameter: 6, stepoverMm: 2.4 }, tolerance: 0.01 },
          heights: { clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
            topHeight: 10, topHeightMode: 'absolute', bottomHeight: 5, bottomHeightMode: 'absolute' },
          passes: { stepdown: 2.5, stepover: 2.4, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
          linking: { entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
          tool: { id: 'flat6', name: '6 mm flat end mill', type: 'flat_end_mill', diameter: 6, fluteLength: 20,
            shankDiameter: 6, overallLength: 60, lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
            feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2.5, stepover: 2.4 } } },
          loops: [{ id: 'pocket', closed: true, type: 'contour', points: [{ x: -50, y: -30 }, { x: 50, y: -30 }, { x: 50, y: 30 }, { x: -50, y: 30 }] }],
          wcsOrigin: { x: 0, y: 0, z: 0 }, clearanceAllowanceMm: 0.25,
          workholding: [{ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }],
          holder: { id: 'holder', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] },
          stockBlock: { min: { x: -60, y: -40, z: 0 }, max: { x: 60, y: 40, z: 10 } },
        }
        const response = await new Promise<{ type: string; message?: string; moves?: { type: string; role?: string; x: number; y: number; z: number }[]; notices?: string[] }>((done, reject) => {
          const worker = new Worker('/' + workerFile, { type: 'module' })
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('Built worker timed out')) }, 20000)
          worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)) }
          worker.onmessage = event => {
            if (event.data.type === 'TOOLPATH_PROGRESS') return
            clearTimeout(timer); worker.terminate(); done(event.data)
          }
          worker.postMessage({ type, payload })
        })
        return { ...response, sourcePayload: { ...payload, workholding: [{ positions, indices }] } }
      }, { workerFile, type })
      expect(result.type, result.message).toBe('TOOLPATH_COMPLETE')
      const cuts = result.moves!.filter(move => move.type === 'feed' && move.role === 'cut')
      expect(cuts.length).toBeGreaterThan(10)
      expect(cuts.some(move => move.x < -10.75)).toBe(true)
      expect(cuts.some(move => move.x > 10.75)).toBe(true)
      for (const cut of cuts) expect(Math.abs(cut.x)).toBeGreaterThanOrEqual(10.75 - 0.001)
      // These strategy/worker bytes are unchanged from main (identity evidence
      // records git diff). Compare every move with the unmodified source route.
      const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
      const sourceMessages: WorkerResponseMsg[] = []
      try {
        Object.defineProperty(globalThis, 'self', { configurable: true, value: {
          set onmessage(handler: typeof sourceHandler) { sourceHandler = handler },
          postMessage(message: WorkerResponseMsg) { sourceMessages.push(message) },
        } })
        await import('../../lib/cam/toolpathWorker')
        const payload = { ...result.sourcePayload, workholding: result.sourcePayload.workholding.map(mesh => ({
          positions: Float32Array.from(mesh.positions), indices: Uint32Array.from(mesh.indices),
        })) }
        await sourceHandler!({ data: { type, payload } } as unknown as MessageEvent<WorkerRequestMsg>)
        const terminal = sourceMessages.filter(message => message.type !== 'TOOLPATH_PROGRESS')
        expect(terminal).toHaveLength(1)
        expect(terminal[0].type).toBe('TOOLPATH_COMPLETE')
        if (terminal[0].type === 'TOOLPATH_COMPLETE') expect(result.moves).toEqual(terminal[0].moves)
      } finally {
        if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf)
        else Reflect.deleteProperty(globalThis, 'self')
      }
      console.log(`${type}: ${result.moves!.length} moves, ${cuts.length} cutting moves, both sides clear of strap`)
      const clipperOwners = Object.entries(manifest.chunks as Record<string, string[]>).filter(([, modules]) =>
        modules.some(id => id.replaceAll('\\', '/').endsWith('/face2d/clipperOffset.ts'))).map(([name]) => name)
      expect(clipperOwners).toEqual([manifest.adaptiveEngine])
    } finally {
      await browser?.close()
      server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    }
  }, 30000)
})
