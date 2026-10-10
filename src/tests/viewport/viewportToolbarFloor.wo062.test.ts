// WO-062: real-layout regression for the supported 960px viewport floor.
// jsdom cannot prove bounding boxes or collision freedom, so this test drives
// the real app in Chromium and exercises no-selection -> selection -> deselect.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'

const PORT = 4363
const BASE = `http://localhost:${PORT}/`
const WIDTH = 960
const HEIGHT = 900
const WIDE_MACHINE_NAME = 'Haas VF-2SS with TRT160 trunnion'

interface ToolbarMeasurement {
  left: number
  top: number
  right: number
  machineLeft: number
  machineWidth: number
  machineName: string
  overlapArea: number
  presetControls: string[]
  visibilityControls: number
  manipulationControls: number
}

function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      http.get(url, (response) => {
        response.resume()
        resolve()
      }).on('error', () => {
        if (Date.now() - started >= timeoutMs) reject(new Error(`Vite did not start at ${url}`))
        else setTimeout(poll, 250)
      })
    }
    poll()
  })
}

function stopProcessTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

async function dismissMachineChoice(page: Page): Promise<void> {
  const backdrop = page.locator('.modal-backdrop').first()
  try {
    await backdrop.waitFor({ state: 'visible', timeout: 4_000 })
  } catch {
    return
  }
  await page.getByRole('button', { name: /use this machine/i }).first().click()
  await backdrop.waitFor({ state: 'detached', timeout: 5_000 })
}

async function setSelected(page: Page, selectedGeometryId: string | null): Promise<void> {
  await page.evaluate((id) => {
    const store = Reflect.get(window, '__camStore')
    if (!store?.setState) throw new Error('live CAM store hook missing')
    store.setState((state: { viewer: Record<string, unknown> }) => ({
      viewer: { ...state.viewer, selectedGeometryId: id },
    }))
  }, selectedGeometryId)
  if (selectedGeometryId) {
    await page.waitForSelector('[data-testid="viewport-manipulation-tools"]')
  } else {
    await page.waitForSelector('[data-testid="viewport-manipulation-tools"]', { state: 'detached' })
  }
}

async function setMachineName(page: Page, name: string): Promise<void> {
  await page.evaluate((machineName) => {
    const store = Reflect.get(window, '__camStore')
    if (!store?.setState) throw new Error('live CAM store hook missing')
    store.setState((state: { project: { machine: Record<string, unknown> } }) => ({
      project: {
        ...state.project,
        machine: { ...state.project.machine, name: machineName },
      },
    }))
  }, name)
  await page.waitForFunction(
    (machineName) => document.querySelector('.machine-name')?.textContent === machineName,
    name,
  )
}

async function measure(page: Page): Promise<ToolbarMeasurement> {
  return page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('.viewport-toolbar')
    const machine = document.querySelector<HTMLElement>('.viewport-machine-info')
    if (!toolbar || !machine) throw new Error('WO-062 layout targets missing')
    const toolbarRect = toolbar.getBoundingClientRect()
    const machineRect = machine.getBoundingClientRect()
    const overlapX = Math.max(0, Math.min(toolbarRect.right, machineRect.right) - Math.max(toolbarRect.left, machineRect.left))
    const overlapY = Math.max(0, Math.min(toolbarRect.bottom, machineRect.bottom) - Math.max(toolbarRect.top, machineRect.top))
    const presetControls = Array.from(toolbar.querySelectorAll('button'))
      .map((button) => button.dataset.tooltip ?? button.textContent?.trim() ?? '')
      .filter((label) => /^(iso|top|front|right)( view)?$/i.test(label))
    return {
      left: toolbarRect.left,
      top: toolbarRect.top,
      right: toolbarRect.right,
      machineLeft: machineRect.left,
      machineWidth: machineRect.width,
      machineName: machine.querySelector('.machine-name')?.textContent ?? '',
      overlapArea: overlapX * overlapY,
      presetControls,
      visibilityControls: toolbar.querySelectorAll('[data-testid="viewport-visibility-tools"] button').length,
      manipulationControls: toolbar.querySelectorAll('[data-testid="viewport-manipulation-tools"] button').length,
    }
  })
}

describe('WO-062 toolbar 960px dock', () => {
  let server: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined

  beforeAll(async () => {
    server = spawn(process.execPath, [
      'node_modules/vite/bin/vite.js',
      '--port', String(PORT),
      '--strictPort',
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(BASE)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await dismissMachineChoice(page)
    await page.waitForSelector('.viewport-toolbar', { timeout: 30_000 })
    await setMachineName(page, WIDE_MACHINE_NAME)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    stopProcessTree(server)
  })

  it('keeps the machine card clear and one fixed dock through selection lifecycle', async () => {
    if (!page) throw new Error('browser page not initialized')

    const withoutSelection = await measure(page)
    await setSelected(page, 'wo062-selected-part')
    const withSelection = await measure(page)
    await setSelected(page, null)
    const afterDeselect = await measure(page)

    for (const [state, result] of Object.entries({ withoutSelection, withSelection, afterDeselect })) {
      expect(result.overlapArea, `${state}: toolbar overlaps machine card`).toBe(0)
      expect(result.right, `${state}: toolbar reaches machine card`).toBeLessThan(result.machineLeft)
      expect(result.machineName, `${state}: wider machine fixture was not rendered`).toBe(WIDE_MACHINE_NAME)
      expect(result.machineWidth, `${state}: wider machine fixture did not exercise the card width`).toBeGreaterThan(200)
      expect(result.presetControls, `${state}: camera presets remain`).toEqual([])
      expect(result.visibilityControls, `${state}: visibility cluster changed`).toBe(4)
    }
    expect(withSelection.manipulationControls).toBe(6)
    expect(withoutSelection.manipulationControls).toBe(0)
    expect(afterDeselect.manipulationControls).toBe(0)
    expect(withSelection.left).toBe(withoutSelection.left)
    expect(afterDeselect.left).toBe(withoutSelection.left)
    expect(withSelection.top).toBe(withoutSelection.top)
    expect(afterDeselect.top).toBe(withoutSelection.top)
  }, 60_000)
})
