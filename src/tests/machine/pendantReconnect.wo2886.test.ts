// WO-2886: the phone pendant reconnects by itself after the phone leaves the
// page and comes back (the operator, board session 2026-10-16: the page showed OFFLINE,
// LienCAM showed PENDANT 0, only a browser refresh brought it back).
//
// Desk reproduction through the production pieces: the real broker
// (pendant/server.mjs --bridge), the real desktop PendantBridgeClient and the
// real pendant page in headless Chromium at phone width. The phone's
// suspension is played by the page going hidden and its socket closing (or
// going silent) - what a phone browser does to a page it is not showing.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { PendantBridgeClient, type PendantCommand } from '../../lib/machine/pendantBridge'
import { useMachineControl } from '../../store/machineControlStore'

const ROOT = resolve(import.meta.dirname, '../../..')
// WO2886_CAPTURE=1 writes the journey receipt and phone screenshots;
// WO2886_CAPTURE_DIR redirects them (the before-fix run goes to before/).
const EVIDENCE = resolve(ROOT, process.env.WO2886_CAPTURE_DIR ?? 'src/tests/evidence/WO-2886')
const CAPTURE = process.env.WO2886_CAPTURE === '1'
const TOKEN = 'wo2886_reconnect_token_0001'

let broker: ChildProcess
let port = 0
let browser: Browser
let desktop: PendantBridgeClient
const received: PendantCommand[] = []
// While set, the desktop takes jog steps but does not answer them yet - a
// command still waiting when the phone leaves the page.
let holdAnswers = false
const heldAnswers: Array<() => void> = []
const journey: Array<Record<string, unknown>> = []

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port: found } = probe.address() as { port: number }
      probe.close(() => ok(found))
    })
  })
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`)
    await new Promise((ok) => setTimeout(ok, 25))
  }
}

function enableDesktop(): Promise<void> {
  desktop.enable(`ws://127.0.0.1:${port}/bridge`, TOKEN)
  return waitFor(() => desktop.snapshot().phase === 'connected', 'desktop bridge connected')
}

beforeAll(async () => {
  port = await freePort()
  broker = spawn(process.execPath, ['pendant/server.mjs', '--bridge', '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('Pendant broker did not start.')), 10_000)
    broker.stdout!.on('data', (chunk) => {
      if (!String(chunk).includes('Bridge LIVE')) return
      clearTimeout(timer)
      ok()
    })
  })
  // The desktop's executor stands in for the machine session: a jog step
  // moves the reported position, so the phone's DRO shows the move.
  desktop = new PendantBridgeClient((command) => {
    received.push(command)
    if (holdAnswers && command.kind === 'jog-step') {
      return new Promise((ok) => heldAnswers.push(() => ok({ ok: true })))
    }
    if (command.kind === 'jog-step') {
      const state = useMachineControl.getState()
      const at = state.mpos ?? { x: 0, y: 0, z: 0 }
      const key = command.axis.toLowerCase() as 'x' | 'y' | 'z'
      const next = { ...at, [key]: at[key] + command.deltaMm }
      useMachineControl.setState({ mpos: next, wpos: next, machineState: 'idle' })
    }
    return { ok: true }
  }, (url) => new WebSocket(url) as never)
  useMachineControl.setState({ machineState: 'idle', mpos: { x: 0, y: 0, z: 0 }, wpos: { x: 0, y: 0, z: 0 } })
  await enableDesktop()
  browser = await chromium.launch()
}, 30_000)

afterEach(async () => {
  if (desktop.snapshot().phase !== 'connected') await enableDesktop()
})

afterAll(async () => {
  desktop?.disable()
  await browser?.close()
  broker?.kill()
  if (CAPTURE) {
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(resolve(EVIDENCE, 'journey-reconnect.json'), `${JSON.stringify({
      wo: 'WO-2886',
      journey: 'pendant-reconnects-after-leaving',
      route: 'desk: pendant/server.mjs --bridge + desktop PendantBridgeClient + pendant page in headless Chromium 390x844',
      steps: journey,
    }, null, 2)}\n`)
  }
})

// The page under test, with two levers a phone pulls on its own: whether the
// page is shown, and its socket (closed, or alive but carrying nothing).
async function phone(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    const sockets: WebSocket[] = []
    w.__sockets = sockets
    w.__visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => w.__visibility })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__visibility === 'hidden' })
    const Native = window.WebSocket
    const deferredCloses: Array<() => void> = []
    w.__deferredCloses = deferredCloses
    class Tracked extends Native {
      silent = false
      // Holds back the close event, so the page comes back while the old
      // socket is still CLOSING - an ordering a phone produces on its own.
      deferClose = false
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
        const deliver = (event: Event) => {
          if (typeof listener === 'function') listener.call(this, event)
          else listener.handleEvent(event)
        }
        if (type === 'close') {
          return super.addEventListener(type, (event: Event) => {
            if (this.deferClose) deferredCloses.push(() => deliver(event))
            else deliver(event)
          }, options)
        }
        if (type !== 'message') return super.addEventListener(type, listener, options)
        return super.addEventListener(type, (event: Event) => {
          if (this.silent) return
          deliver(event)
        }, options)
      }
    }
    window.WebSocket = Tracked as unknown as typeof WebSocket
  })
  await page.goto(`http://127.0.0.1:${port}/?pair=${TOKEN}`)
  return page
}

const setShown = (page: Page, shown: boolean) => page.evaluate((visible) => {
  (window as unknown as Record<string, unknown>).__visibility = visible ? 'visible' : 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
}, shown)

const dropSocket = (page: Page) => page.evaluate(() => {
  const sockets = (window as unknown as { __sockets: WebSocket[] }).__sockets
  sockets.at(-1)!.close()
})

const silenceSocket = (page: Page) => page.evaluate(() => {
  const sockets = (window as unknown as { __sockets: Array<WebSocket & { silent: boolean }> }).__sockets
  sockets.at(-1)!.silent = true
})

const socketCount = (page: Page) => page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.length)
const pill = (page: Page) => page.locator('#hdr-state').textContent()

const tap = (page: Page, selector: string, type: string) => page.evaluate(([s, t]) => {
  document.querySelector(s)!.dispatchEvent(
    new PointerEvent(t, { pointerId: 1, pointerType: 'touch', bubbles: true, cancelable: true }))
}, [selector, type] as const)

async function connected(page: Page): Promise<void> {
  await waitFor(() => desktop.snapshot().connectedPendants === 1, 'LienCAM counts one pendant')
  await expect.poll(() => pill(page)).not.toBe('OFFLINE')
}

async function shot(page: Page, name: string, step: string, extra: Record<string, unknown> = {}) {
  journey.push({
    step,
    pendants: desktop.snapshot().connectedPendants,
    pill: await pill(page),
    linkLine: await page.locator('#link-line').isVisible() ? await page.locator('#link-line').innerText() : null,
    ...extra,
  })
  if (CAPTURE) await page.screenshot({ path: resolve(EVIDENCE, `${name}.png`) })
}

it('leaving the page and coming back reconnects without a refresh, and a jog after return reaches LienCAM', async () => {
  const page = await phone()
  try {
    await connected(page)
    await shot(page, 's1-connected', 's1-pendant-connected-on-a-phone-width-page')

    await setShown(page, false)
    await dropSocket(page)
    await waitFor(() => desktop.snapshot().connectedPendants === 0, 'LienCAM sees the pendant leave')
    await expect.poll(() => pill(page)).toBe('OFFLINE')
    await shot(page, 's2-hidden-socket-closed', 's2-page-hidden-and-socket-closed')

    await setShown(page, true)
    // What the operator sees one second after coming back, recorded before
    // anything is asserted so the before-fix run shows it too.
    await page.waitForTimeout(1000)
    await shot(page, 's3-back-after-1s', 's3-page-visible-again-reconnects-without-refresh')
    await connected(page)
    await expect.poll(() => page.locator('#link-line').isVisible()).toBe(false)

    const before = received.length
    await tap(page, '[data-axis="X"][data-sign="1"]', 'pointerdown')
    await waitFor(() => received.slice(before).some((c) => c.kind === 'jog-step' && c.axis === 'X'), 'jog step reaches LienCAM')
    await expect.poll(() => page.locator('#dro-x').textContent()).toBe('1.000')
    await shot(page, 's4-jog-after-return', 's4-a-jog-after-return-moves-the-simulator', {
      desktopReceived: received.slice(before).map((c) => c.kind),
    })
  } finally {
    await page.close()
  }
}, 30_000)

it('a link that drops while the page is showing reconnects by itself', async () => {
  const page = await phone()
  try {
    await connected(page)
    await dropSocket(page)
    await waitFor(() => desktop.snapshot().connectedPendants === 0, 'LienCAM sees the pendant leave')
    await connected(page)
    expect(await socketCount(page)).toBe(2)
  } finally {
    await page.close()
  }
}, 30_000)

it('a link left open but silent after the page comes back is replaced', async () => {
  const page = await phone()
  try {
    await connected(page)
    await setShown(page, false)
    await silenceSocket(page)
    await setShown(page, true)
    await expect.poll(() => socketCount(page), { timeout: 8000 }).toBe(2)
    await connected(page)
    const before = received.length
    await tap(page, '[data-axis="Y"][data-sign="1"]', 'pointerdown')
    await waitFor(() => received.slice(before).some((c) => c.kind === 'jog-step' && c.axis === 'Y'), 'jog step reaches LienCAM')
  } finally {
    await page.close()
  }
}, 30_000)

it('a held jog is released when the page is hidden and no keep-alive revives it after the reconnect', async () => {
  const page = await phone()
  try {
    await connected(page)
    await page.locator('#btn-mode').dispatchEvent('click') // CONT
    await expect.poll(() => page.locator('#btn-mode').textContent()).toBe('CONT')
    const start = received.length
    await tap(page, '[data-axis="Z"][data-sign="1"]', 'pointerdown')
    await waitFor(() => received.slice(start).some((c) => c.kind === 'jog-continuous'), 'held jog reaches LienCAM')

    await setShown(page, false)
    await waitFor(() => received.slice(start).some((c) => c.kind === 'jog-cancel'), 'hiding the page cancels the held jog')
    await dropSocket(page)
    await waitFor(() => desktop.snapshot().connectedPendants === 0, 'LienCAM sees the pendant leave')
    await setShown(page, true)
    await connected(page)
    const afterReconnect = received.length
    await page.waitForTimeout(600)
    expect(received.slice(afterReconnect).filter((c) => c.kind === 'jog-continuous')).toEqual([])
  } finally {
    await page.close()
  }
}, 30_000)

it('when LienCAM keeps refusing, the page says so with a refresh control, and still reconnects once it can', async () => {
  const page = await phone()
  try {
    await connected(page)
    desktop.disable()
    await dropSocket(page)
    await expect.poll(() => page.locator('#btn-refresh').isVisible(), { timeout: 10_000 }).toBe(true)
    const line = await page.locator('#link-text').innerText()
    expect(line).toContain('refresh this page')
    await shot(page, 's5-cannot-reconnect-offers-refresh', 's5-if-it-cannot-reconnect-it-says-so-and-offers-refresh', { line })

    await enableDesktop()
    await waitFor(() => desktop.snapshot().connectedPendants === 1, 'the page reconnects once LienCAM shares the pairing again', 12_000)
    await expect.poll(() => page.locator('#link-line').isVisible()).toBe(false)
  } finally {
    await page.close()
  }
}, 30_000)

it('a command still waiting when the page comes back while its old link is closing is answered at once, never resent', async () => {
  const page = await phone()
  try {
    await connected(page)
    holdAnswers = true
    const before = received.length
    await tap(page, '[data-axis="X"][data-sign="1"]', 'pointerdown')
    await waitFor(() => received.slice(before).some((c) => c.kind === 'jog-step'), 'jog step reaches LienCAM')

    // Hidden, the socket starts closing, and the page is shown again before
    // the old close event has been delivered.
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & { __sockets: Array<WebSocket & { deferClose: boolean }> }
      const old = w.__sockets.at(-1)!
      old.deferClose = true
      w.__visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      old.close()
      w.__visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect.poll(() => page.evaluate(() => (window as unknown as { __deferredCloses: unknown[] }).__deferredCloses.length)).toBeGreaterThan(0)
    await page.evaluate(() => (window as unknown as { __deferredCloses: Array<() => void> }).__deferredCloses.splice(0).forEach((f) => f()))

    // The desktop never answered: the phone says the link went away, at once
    // (well inside the 10 s a command waits for its answer).
    await expect.poll(() => page.locator('#command-feedback').textContent(), { timeout: 1500 }).toBe('Pendant bridge disconnected.')
    expect(await page.locator('#command-feedback').isVisible()).toBe(true)
    expect(await socketCount(page)).toBe(2)
    await connected(page)
    // Nothing waiting on the old link was sent again on the new one.
    await page.waitForTimeout(300)
    expect(received.slice(before).filter((c) => c.kind === 'jog-step')).toHaveLength(1)
  } finally {
    holdAnswers = false
    heldAnswers.splice(0).forEach((answer) => answer())
    await page.close()
  }
}, 30_000)
