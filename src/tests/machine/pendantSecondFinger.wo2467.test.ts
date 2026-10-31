import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'

const APP = resolve(import.meta.dirname, '../../../pendant/app')
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }

let server: Server
let base = ''
let browser: Browser

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname
    try {
      const file = resolve(APP, '.' + (path === '/' ? '/index.html' : path))
      if (!file.startsWith(APP)) throw new Error('outside')
      const body = readFileSync(file)
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch()
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await new Promise((ok) => server?.close(ok))
})

async function session() {
  const page = await browser.newPage({ hasTouch: true })
  const calls: string[] = []
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/jog/')) calls.push(path.slice('/api/jog/'.length))
    return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' })
  })
  await page.goto(base)
  await page.locator('#btn-mode').dispatchEvent('click') // CONT
  await page.waitForFunction(() => document.querySelector('#btn-mode')?.textContent === 'CONT')
  return { page, calls }
}

const fire = (page: import('playwright').Page, selector: string, type: string, id: number) =>
  page.evaluate(([s, t, i]) => {
    document.querySelector(s as string)!.dispatchEvent(
      new PointerEvent(t as string, { pointerId: i as number, pointerType: 'touch', bubbles: true, cancelable: true }))
  }, [selector, type, id])

for (const order of ['first-then-second', 'second-then-first']) {
  it(`second finger on another jog button leaves no jog running (lift ${order})`, async () => {
    const { page, calls } = await session()
    try {
      const z = '[data-axis="Z"][data-sign="1"]'
      const y = '[data-axis="Y"][data-sign="-1"]'
      await fire(page, z, 'pointerdown', 1)
      await fire(page, y, 'pointerdown', 2)
      // The jog request reaches the route asynchronously; under a loaded CI shard it can arrive after this line runs.
      await expect.poll(() => calls.filter((c) => c === 'continuous').length).toBe(1)
      await page.waitForTimeout(400)
      const [a, b] = order === 'first-then-second' ? [[z, 1], [y, 2]] : [[y, 2], [z, 1]]
      await fire(page, a[0] as string, 'pointerup', a[1] as number)
      await fire(page, b[0] as string, 'pointerup', b[1] as number)
      await expect.poll(() => calls.at(-1)).toBe('cancel')
      const settled = calls.length
      await page.waitForTimeout(500)
      expect(calls.length).toBe(settled) // no keep-alive after the last release
    } finally {
      await page.close()
    }
  }, 30_000)
}

it('single finger still jogs with keep-alives and cancels once on release', async () => {
  const { page, calls } = await session()
  try {
    const x = '[data-axis="X"][data-sign="1"]'
    await fire(page, x, 'pointerdown', 1)
    await page.waitForTimeout(400)
    expect(calls.filter((c) => c === 'continuous').length).toBeGreaterThanOrEqual(3)
    await fire(page, x, 'pointerup', 1)
    await expect.poll(() => calls.filter((c) => c === 'cancel').length).toBe(1)
  } finally {
    await page.close()
  }
}, 30_000)
