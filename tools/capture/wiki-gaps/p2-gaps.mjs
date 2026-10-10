// WO-2710 gap steps. Each gap drives a fresh first-start app to the state the
// audit names (docs/launch/WIKI-IMAGE-AUDIT-1009.md "Full per-gap details")
// through the real UI, then shoots it. See p2.mjs for the runner.
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { OUT } from './p2-lib.mjs'

/** Control > Main on the built-in simulator: connect, CLEAR, home, idle. */
async function controlSimulator(h, { home = true } = {}) {
  const { page, tid } = h
  await h.chooseStarterMachine()
  await tid('mode-tab-control').click()
  await tid('control-page').waitFor({ timeout: 60_000 })
  await h.chooseStarterMachine()
  await tid('control-kind-select').selectOption('simulator')
  await tid('control-connect').click()
  await tid('control-disconnect').waitFor({ timeout: 30_000 })
  if (/CLEAR/.test(await tid('control-estop').innerText())) await tid('control-estop').click()
  if (home) {
    await tid('control-home').click()
    await page.locator('[data-testid="control-homed-led"].control-led-ok').waitFor({ timeout: 60_000 })
    await waitIdle(h)
  }
}
const waitIdle = (h) => h.page.waitForFunction(() => /idle/i.test(document.querySelector('[data-testid="control-state-chip"]')?.textContent ?? ''), null, { timeout: 120_000 })

/**
 * Control > Machine > Definition: "Define this machine" (the starter has no
 * controller definition, so its X/Y/Z ranges are unknown to routines),
 * optionally the fixed tool setter position (Probing section), then Save.
 */
async function defineMachine(h, { setter = null, controller = null, save = true } = {}) {
  const { tid, page } = h
  await tid('control-view-machine').click()
  await tid('control-machine-tab-definition').click()
  await tid('machine-definition-panel').waitFor()
  if (controller) {
    await tid('machine-def-bar-controller').selectOption(controller)
    await page.waitForTimeout(800)
  }
  if (await tid('machine-def-panel-define').count()) {
    await tid('machine-def-panel-define').click()
    await page.waitForTimeout(1200)
  }
  if (setter) {
    await tid('machine-def-tab-probing').click()
    for (const axis of ['x', 'y', 'z']) {
      const input = page.getByLabel(`Tool setter ${axis.toUpperCase()} (machine mm)`)
      await input.fill(String(setter[axis]))
      await input.press('Enter')
    }
    await page.waitForTimeout(500)
  }
  if (save) {
    await tid('machine-def-panel-save').click()
    await page.waitForTimeout(1200)
    // Save may ask to confirm; take the affirmative answer if it does.
    const confirm = page.getByTestId('confirm-dialog-ok')
    if (await confirm.count()) { await confirm.click(); await page.waitForTimeout(800) }
    // A saved definition is "Pending - reconnect": reconnect and home so the
    // session runs on it (its soft limits give the routines their envelope).
    await tid('control-view-main').click()
    await tid('control-disconnect').click()
    await tid('control-connect').waitFor({ timeout: 30_000 })
    await tid('control-connect').click()
    await tid('control-disconnect').waitFor({ timeout: 30_000 })
    if (/CLEAR/.test(await tid('control-estop').innerText())) await tid('control-estop').click()
    await tid('control-home').click()
    await page.locator('[data-testid="control-homed-led"].control-led-ok').waitFor({ timeout: 60_000 })
    await waitIdle(h)
  }
}

/** Type one MDI line on Control > Main and wait for idle. */
async function mdi(h, line) {
  const { tid, page } = h
  await tid('control-view-main').click()
  await tid('control-mdi-input').fill(line)
  await tid('control-mdi-input').press('Enter')
  await page.waitForTimeout(600)
  await waitIdle(h)
}

/** Read the simulated part (Control > Machine > Diagnostics) as numbers. */
async function readSimulatedPart(h) {
  const { tid } = h
  await tid('control-view-machine').click()
  await tid('control-machine-tab-diagnostics').click()
  await tid('simulated-part-position').waitFor()
  const nums = async (id) => [...(await tid(id).innerText()).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => +m[0])
  const [x, y, top] = await nums('simulated-part-position')
  const [sx, sy, height] = await nums('simulated-part-size')
  const [boreD, boreDepth, boreX, boreY] = await nums('simulated-part-bore')
  const [bossD, bossH, bossX, bossY] = await nums('simulated-part-boss')
  return { x, y, top, sx, sy, height, bore: { d: boreD, depth: boreDepth, x: boreX, y: boreY }, boss: { d: bossD, h: bossH, x: bossX, y: bossY } }
}

/** Control > Main: Load > Open file... through the browser's own file picker. */
async function loadProgram(h, file) {
  const { tid, page } = h
  await tid('control-view-main').click()
  await tid('control-load-menu').click()
  const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), tid('control-open-file').click()])
  await fc.setFiles(path.resolve(file))
  await page.waitForFunction(() => document.querySelector('[data-testid="control-progress-text"]')?.textContent?.includes('/'), null, { timeout: 30_000 })
  await page.waitForTimeout(1500)
}

/**
 * Put the simulated part under a known machine point (its bore centre at
 * X-150 Y-150) and set G54 at the part's front-left top corner with MDI.
 */
async function partAndWorkZero(h, { dx = 0, dy = 0 } = {}) {
  const { tid, page } = h
  await mdi(h, 'G21 G90 G53 G0 Z-5')
  await mdi(h, 'G21 G90 G53 G0 X-150 Y-150')
  await tid('control-view-machine').click()
  await tid('control-machine-tab-diagnostics').click()
  await tid('simulated-part-place-under-probe').click()
  await page.waitForTimeout(600)
  const part = await readSimulatedPart(h)
  await mdi(h, `G21 G90 G53 G0 X${(part.x + dx).toFixed(3)} Y${(part.y + dy).toFixed(3)}`)
  await mdi(h, `G21 G90 G53 G0 Z${(part.top + 10).toFixed(3)}`)
  await mdi(h, 'G10 L20 P1 X0 Y0 Z10')
  return part
}

/** Wait until every operation has finished computing (console strip reads Ready). */
async function waitCompute(h, timeout = 600_000) {
  await h.page.waitForFunction(() => /Ready\s*\(\s*\d+\s+operations?\s*\)/.test(document.body.innerText), null, { timeout })
  await h.page.waitForTimeout(1000)
}

export const GAPS = {
  XCAM: {
    async run(h) {
      const { page } = h
      await h.chooseStarterMachine()
      await h.openProject('examples/05-name-sign/name-sign.camproject')
      await h.debug('01-opened')
      await page.locator('.tree-section-regen-btn').click()
      await page.waitForTimeout(3000)
      await waitCompute(h)
      await h.debug('02-regen')
      await page.getByTestId('mode-tab-toolpath').click().catch(() => page.getByRole('button', { name: /^Toolpath$/ }).click())
      await page.waitForTimeout(1500)
      await page.locator('.tree-op-label', { hasText: /carve/i }).first().click()
      await page.waitForTimeout(1500)
      await h.debug('03-selected')
      await page.locator('.tree-op-label', { hasText: /carve/i }).first().dblclick()
      await page.waitForTimeout(1500)
      await h.debug('04-edit')
    },
  },
  XUI: {
    async run(h) {
      const { page } = h
      await h.chooseStarterMachine()
      await page.getByRole('button', { name: /Tool Library/ }).first().click()
      await page.waitForTimeout(1500)
      await h.debug('01-tool-library')
      await page.locator('.modal-close-btn').first().click()
      await page.waitForTimeout(500)
      await page.getByRole('button', { name: 'Application settings', exact: true }).click()
      await page.waitForTimeout(1500)
      await h.debug('02-settings')
      await page.getByTestId('user-data-storage-panel').scrollIntoViewIfNeeded().catch(() => {})
      await page.waitForTimeout(800)
      await h.debug('03-user-data')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await page.getByTestId('mode-tab-sketch').click().catch(() => page.getByRole('button', { name: /^Sketch$/ }).click())
      await page.waitForTimeout(2000)
      await h.debug('04-sketch')
    },
  },
  XDEF: {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await tid('control-view-machine').click()
      await tid('control-machine-tab-definition').click()
      await tid('machine-definition-panel').waitFor()
      const ctl = await tid('machine-def-bar-controller').evaluate((el) => [...el.options].map((o) => o.value + '=' + o.textContent))
      const kind = await tid('control-kind-select').evaluate((el) => [...el.options].map((o) => o.value + '=' + o.textContent))
      console.log('controllers', ctl, 'kinds', kind)
      await tid('machine-def-panel-define').click()
      await page.waitForTimeout(1500)
      await h.debug('01-defined')
      for (const t of ['machine', 'probing', 'controller']) {
        await tid('machine-def-tab-' + t).click(); await page.waitForTimeout(1000); await h.debug('02-' + t)
      }
    },
  },
  // G11 - Control > Machine > Diagnostics, the Simulated part card (crop).
  G11: {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await tid('control-view-machine').click()
      await tid('control-machine-tab-diagnostics').click()
      await tid('simulated-part-position').waitFor()
      await page.waitForTimeout(800)
      const text = await tid('simulated-part-body').innerText()
      if (!/Position \(machine\)/.test(text) || !/Bore:/.test(text) || !/Boss:/.test(text)) throw new Error('G11 card incomplete: ' + text)
      const full = 'G11-simulated-part-full.png'
      await h.shot(full)
      h.sidecar(full, { appState: 'Control > Machine > Diagnostics, built-in simulator connected, CLEAR pressed, homed, idle (starter machine Sample hobby router (GRBL)). Whole frame.', extra: { cardText: text } })
      const panel = await h.box(tid('simulated-part-panel'))
      const reset = await h.box(tid('simulated-part-reset'))
      const crop = { x: panel.x, y: panel.y, width: 760, height: reset.y + reset.height + 16 - panel.y }
      const name = 'G11-simulated-part.png'
      await h.crop(full, name, crop)
      h.sidecar(name, { appState: 'Same frame as G11-simulated-part-full.png, cropped to the Simulated part card: position, size, surface bow, bore, boss, Place under probe, Reset.', crop, wholeFrame: full, extra: { cardText: text } })
    },
  },

  // C-4 - Control > Offsets: one value typed (not sent), Push changed (1).
  'C-4': {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await tid('control-view-offsets').click()
      await tid('offsets-workspace').waitFor()
      await tid('offsets-workspace-label-g55').fill('Vise jaw')
      await tid('offsets-workspace-g55-x').fill('120.5')
      // Leave the field by clicking the empty part of the panel (no focus ring left on a cell).
      await page.mouse.click(1100, 900)
      await page.waitForTimeout(600)
      const push = await tid('offsets-workspace-push-all').innerText()
      if (!/Push changed \((1|2)\)/.test(push)) throw new Error('C-4 push-all reads ' + push)
      const name = 'C-4-offsets-typed.png'
      await h.shot(name)
      h.sidecar(name, { appState: `Control > Offsets, built-in simulator connected and homed. G55 row: fixture name "Vise jaw" and X 120.5 typed, not sent yet; the header reads "${push.trim()}". Push on each row and Set from position. Whole frame.`, extra: { pushAll: push } })
    },
  },

  // G09 - Control > Routines: factory Bore picked, inputs, Check, preview, path-clear tick, Run.
  G09: {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await defineMachine(h)
      await mdi(h, 'G21 G90 G53 G0 Z-5')
      await mdi(h, 'G21 G90 G53 G0 X-150 Y-150')
      await tid('control-view-machine').click()
      await tid('control-machine-tab-diagnostics').click()
      await tid('simulated-part-place-under-probe').click()
      await page.waitForTimeout(600)
      const part = await readSimulatedPart(h)
      await mdi(h, `G21 G90 G53 G0 Z${(part.top + 10).toFixed(3)}`)
      await tid('control-view-routines').click()
      const select = tid('probe-routine-select')
      await select.waitFor()
      const opts = await select.evaluate((el) => [...el.options].map((o) => ({ v: o.value, t: o.textContent, g: o.parentElement?.getAttribute('label') })))
      const bore = opts.find((o) => o.g === 'Factory' && /bore/i.test(o.t))
      if (!bore) throw new Error('G09 no factory bore routine: ' + JSON.stringify(opts))
      await select.selectOption(bore.v)
      await page.waitForTimeout(800)
      // The hole's top: the simulated part's top (machine Z), typed in the value column.
      await page.getByPlaceholder('default 0', { exact: true }).fill(String(part.top))
      await page.keyboard.press('Tab')
      await h.debug('01-picked')
      await tid('probe-routine-check').click()
      await page.waitForTimeout(1500)
      const tick = tid('probe-routine-path-clear-tick')
      if (await tick.count()) await tick.check()
      await page.waitForTimeout(500)
      const preview = await tid('probe-routine-preview').innerText()
      const name = 'G09-routines-check-preview.png'
      await h.shot(name)
      h.sidecar(name, { appState: `Control > Routines, built-in simulator connected and homed. Probe stood 10 mm over the simulated part's bore (part placed under the probe at machine X-150 Y-150; top Z ${part.top}). Factory routine "${bore.t.trim()}" picked, "Top of the hole" typed as ${part.top}, other inputs at their defaults, Check pressed: Preview column with the numbered machine-coordinate steps and diagram, path-clear tick ticked, Run. Whole frame.`, extra: { routines: opts, previewText: preview } })
    },
  },

  // G03 - 4x3 sheet of the 12 routines' BEFORE START pictures.
  G03: {
    async run(h) {
      const { tid, page } = h
      const src = fs.readFileSync('src/components/machine/ProbingPanel.tsx', 'utf8')
      const shorts = Object.fromEntries([...src.matchAll(/\{ kind: '(\w+)', label: '([^']+)', short: '([^']+)' \}/g)].map((m) => [m[1], m[3]]))
      await controlSimulator(h)
      await tid('control-view-probing').click()
      await tid('control-probing-panel').waitFor()
      const kinds = await page.locator('[data-testid^="control-work-probe-routine-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('control-work-probe-routine-', '')))
      if (kinds.length !== 12) throw new Error('G03 expected 12 routines, got ' + kinds.join(','))
      const tiles = []
      for (const kind of kinds) {
        await tid('control-work-probe-routine-' + kind).click()
        await page.waitForTimeout(900)
        const label = (await tid('control-work-probe-routine-' + kind).innerText()).trim()
        const card = await tid('probing-step-card').innerText().catch(() => '')
        const full = `G03-tmp-${kind}.png`
        await h.shot(full)
        const box = await h.box(tid('probing-picture-box'))
        const buf = await sharp(path.join(OUT, full)).extract({ left: Math.floor(box.x), top: Math.floor(box.y), width: Math.floor(box.width), height: Math.floor(box.height) }).png().toBuffer()
        fs.rmSync(path.join(OUT, full))
        tiles.push({ kind, label, short: shorts[kind] ?? '', buf, w: Math.floor(box.width), hgt: Math.floor(box.height), beforeStart: /BEFORE START/.test(card) })
      }
      const TW = 600, LABEL = 46, GAP = 14
      const th = Math.round(TW * tiles[0].hgt / tiles[0].w)
      const W = GAP + 4 * (TW + GAP), H = GAP + 3 * (th + LABEL + GAP)
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      const comp = []
      for (let i = 0; i < tiles.length; i++) {
        const x = GAP + (i % 4) * (TW + GAP), y = GAP + Math.floor(i / 4) * (th + LABEL + GAP)
        comp.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TW}" height="${LABEL}"><text x="4" y="31" font-family="Segoe UI, Arial" font-size="26" font-weight="700" fill="#e8eef7">${esc(tiles[i].label)}<tspan font-size="22" font-weight="400" fill="#9fb0c6" dx="14">${esc(tiles[i].short)}</tspan></text></svg>`), left: x, top: y })
        comp.push({ input: await sharp(tiles[i].buf).resize({ width: TW, height: th, fit: 'contain', background: '#141820' }).png().toBuffer(), left: x, top: y + LABEL })
      }
      const name = 'G03-routine-chooser.png'
      for (const f of [name, name.replace('.png', '.json')]) fs.rmSync(path.join(OUT, f), { force: true })
      await sharp({ create: { width: W, height: H, channels: 3, background: '#0f1218' } }).composite(comp).png().toFile(path.join(OUT, name))
      h.sidecar(name, { appState: 'Control > Probing, built-in simulator connected and homed. Each of the 12 routine buttons clicked in screen order; the picture box (step 1, setup defaults) of each cropped from a 1920x1080 frame and laid out 4 x 3, labelled with the button label and the routine short text from ROUTINE_OPTIONS (ProbingPanel.tsx). Sheet composed by the capture script.', extra: { tiles: tiles.map((t) => ({ kind: t.kind, label: t.label, short: t.short, beforeStart: t.beforeStart })) } })
    },
  },

  // C-1 - Control > Machine > Definition: the catalog sections, and All settings with its Show list.
  'C-1': {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await defineMachine(h)
      await tid('machine-def-tab-overview').click()
      await page.waitForTimeout(800)
      const a = 'C-1a-definition-overview.png'
      await h.shot(a)
      h.sidecar(a, { appState: 'Control > Machine > Definition, built-in simulator connected and homed. The starter machine had no controller definition: "Define this machine" pressed, then Save. Overview tab: the Machine, Spindle, Outputs & coolant, Probing and Controller catalog sections with their Open buttons. Whole frame.' })
      await tid('machine-def-tab-allSettings').click()
      await page.waitForTimeout(1200)
      await h.debug('01-all-settings')
      const b = 'C-1b-definition-all-settings.png'
      await h.shot(b)
      h.sidecar(b, { appState: 'Same session as C-1a: All settings tab open, with the Show list (Everything / Stated by the profile / Changed by me) and the "Only settings LienCAM uses" box above the full settings table. Whole frame.' })
    },
  },

  // G07 - Probing > Calibrate on the simulated 25 mm boss: reference, plan, result radius.
  G07: {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await defineMachine(h)
      // Stand the probe at a known place, move the simulated part's bore under it.
      await mdi(h, 'G21 G90 G53 G0 Z-5')
      await mdi(h, 'G21 G90 G53 G0 X-150 Y-150')
      await tid('control-view-machine').click()
      await tid('control-machine-tab-diagnostics').click()
      await tid('simulated-part-place-under-probe').click()
      await page.waitForTimeout(600)
      const part = await readSimulatedPart(h)
      // Over the 25 mm boss centre, 5 mm above its top.
      const bossTop = part.top + part.boss.h
      await mdi(h, `G21 G90 G53 G0 X${part.boss.x.toFixed(3)} Y${part.boss.y.toFixed(3)}`)
      await mdi(h, `G21 G90 G53 G0 Z${(bossTop + 5).toFixed(3)}`)
      await tid('control-view-probing').click()
      await tid('control-probing-panel').waitFor()
      await tid('control-work-probe-routine-calibrate').click()
      await page.waitForTimeout(1000)
      const refs = await tid('control-calibrate-reference').evaluate((el) => [...el.options].map((o) => o.textContent))
      const a = 'G07a-calibrate-plan.png'
      await h.shot(a)
      h.sidecar(a, { appState: `Control > Probing, built-in simulator connected and homed, machine defined. Simulated part placed under the probe; probe stood over its ${part.boss.d} mm boss centre (machine X${part.boss.x} Y${part.boss.y}), 5 mm above the boss top. Calibrate picked: Reference list, BEFORE START plan picture. Nothing run yet. Whole frame.`, extra: { references: refs, part } })
      await tid('control-probe-run-guided').click()
      await tid('control-calibrate-radii').waitFor({ timeout: 120_000 })
      await waitIdle(h)
      await page.waitForTimeout(800)
      const result = await tid('control-calibrate-result').innerText()
      const b = 'G07b-calibrate-result.png'
      await h.shot(b)
      h.sidecar(b, { appState: 'Same session as G07a after Start probing: the calibration run finished on the simulator; the result line with the measured X / Y radius and Confirm (not pressed). Whole frame.', extra: { result, references: refs } })
    },
  },

  // G06 - Control > Tools with a fixed setter: Ref star, Measure, Apply length.
  G06: {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await defineMachine(h)
      await mdi(h, 'G21 G90 G53 G0 Z-5')
      await mdi(h, 'G21 G90 G53 G0 X-150 Y-150')
      await tid('control-view-machine').click()
      await tid('control-machine-tab-diagnostics').click()
      await tid('simulated-part-place-under-probe').click()
      await page.waitForTimeout(600)
      const part = await readSimulatedPart(h)
      // The setter stands on the simulated part's flat top, clear of bore and boss.
      const setter = { x: part.x + part.sx - 15, y: part.y + part.sy - 15, z: part.top }
      await defineMachine(h, { setter })
      await tid('control-view-tools').click()
      await tid('control-tools-panel').waitFor()
      for (const n of ['1', '2']) {
        await tid('control-tool-add-input').fill(n)
        await tid('control-tool-add').click()
        await page.waitForTimeout(300)
      }
      await h.debug('01-tools')
      await tid('control-tool-ref-1').click()
      await tid('control-tool-row-1').locator('.control-tool-num').click()
      await tid('control-probe-measure').click()
      await page.waitForTimeout(1500)
      await waitIdle(h)
      await h.debug('02-measured-1')
      await tid('control-tool-row-2').locator('.control-tool-num').click()
      await tid('control-probe-measure').click()
      await page.waitForTimeout(1500)
      await waitIdle(h)
      await h.debug('03-measured-2')
      const applyEnabled = await tid('control-tool-apply').isEnabled()
      if (applyEnabled) {
        await tid('control-tool-apply').click()
        await page.waitForTimeout(1200)
        await waitIdle(h)
      }
      const status = await tid('control-probe-status').innerText().catch(() => '')
      const name = 'G06-tools-setter-apply.png'
      await h.shot(name)
      h.sidecar(name, { appState: `Control > Tools, built-in simulator connected and homed. Machine defined with a fixed tool setter at machine X${setter.x} Y${setter.y} Z${setter.z} (on the simulated part top). T1 and T2 added; T1 starred as Ref and measured on the setter; T2 selected and measured (the simulator's tools all touch at the same height, so the two lengths are equal). Apply length ${applyEnabled ? 'pressed' : 'shown (not enabled)'}. Whole frame.`, extra: { setter, status, applyEnabled } })
      const crop = { x: 0, y: 100, width: 1920, height: 670 }
      const c = 'G06-tools-setter.png'
      await h.crop(name, c, crop)
      h.sidecar(c, { appState: 'G06-tools-setter-apply.png cropped to the Tools table, the probe settings and the Probe card with Measure T2 and its result line.', crop, wholeFrame: name, extra: { setter, status, applyEnabled } })
    },
  },

  // G05 - Probing > Z surface over a loaded program's cutting area; then the measured mesh and Confirm.
  // The simulated part is 100 x 80 with a bore at its centre and a boss near
  // its front-left; the toe-clamps program (63 x 55) sits on it with G54 14 mm
  // in from the front edge, and a 3 x 3 mesh keeps every point on flat top.
  G05: {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await defineMachine(h)
      const part = await partAndWorkZero(h, { dx: 0, dy: 14 })
      await loadProgram(h, 'examples/gcode/02-toe-clamps-grbl.nc')
      await tid('control-view-probing').click()
      await tid('control-probing-panel').waitFor()
      await tid('control-work-probe-routine-zSurface').click()
      await page.waitForTimeout(1200)
      for (const id of ['control-surface-mesh-points-x', 'control-surface-mesh-points-y']) {
        await tid(id).fill('3')
        await tid(id).press('Enter')
        await page.waitForTimeout(300)
      }
      await page.mouse.move(1, 1)
      await page.waitForTimeout(800)
      await h.debug('01-zsurface')
      const plan = await tid('control-surface-mesh-plan-error').innerText().catch(() => null)
      if (plan) throw new Error('G05 mesh plan refused: ' + plan)
      const a = 'G05a-z-surface-setup.png'
      await h.shot(a)
      h.sidecar(a, { appState: 'Control > Probing, built-in simulator connected and homed, machine defined. Simulated part placed under the probe; G54 set by MDI (G10 L20 P1) at the part top, 14 mm in from its front-left corner. examples/gcode/02-toe-clamps-grbl.nc loaded through Load > Open file. Z surface picked, Points X and Y set to 3: margin, fade, points and the cutting-area bounds, the grid of points over the stock. Nothing run yet. Whole frame.', extra: { part } })
      await tid('control-probe-run-guided').click()
      await tid('control-work-probe-apply').waitFor({ state: 'visible', timeout: 300_000 })
      await waitIdle(h)
      await page.mouse.move(1, 1)
      await page.waitForTimeout(1000)
      const result = await tid('control-work-probe-result').innerText().catch(() => '')
      const b = 'G05b-z-surface-measured.png'
      await h.shot(b)
      h.sidecar(b, { appState: 'Same session as G05a after Start probing: the 3 x 3 mesh run finished on the simulator (its part has a 0.3 mm bow); measured heights coloured in the picture, Confirm (not pressed). Whole frame.', extra: { part, result } })
    },
  },

  // C-6 - the guided M6 tool change on the simulator (UCCNC dialect program).
  'C-6': {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      // Where Place under probe at X-150 Y-150 will put the part, from its default
      // placement; the setter stands on the part's flat top near its back-right.
      const before = await readSimulatedPart(h)
      const ox = -150 - before.bore.x + before.x, oy = -150 - before.bore.y + before.y
      const setter = { x: ox + before.sx - 15, y: oy + before.sy - 15, z: before.top }
      await defineMachine(h, { controller: 'uccnc', setter })
      const part = await partAndWorkZero(h)
      if (Math.abs(part.x - ox) > 0.01 || Math.abs(part.y - oy) > 0.01) throw new Error('C-6 part not where expected: ' + JSON.stringify({ part, ox, oy }))
      await loadProgram(h, 'examples/01-fixture-plate/uccnc.nc')
      await h.debug('01-loaded')
      await tid('control-cyclestart').click()
      const card = page.locator('[data-testid="control-toolchange-card"], [data-testid="control-toolchange-banner"]').first()
      await card.waitFor({ timeout: 300_000 })
      await page.waitForTimeout(1500)
      await h.debug('02-m6')
      const a = 'C-6a-m6-tool-change.png'
      await h.shot(a)
      const cardA = await card.innerText()
      h.sidecar(a, { appState: `Control > Main, built-in simulator, starter machine re-declared as UCCNC and defined with a fixed tool setter on the simulated part top (machine X${setter.x} Y${setter.y} Z${setter.z}). G54 at the part's front-left top corner. examples/01-fixture-plate/uccnc.nc loaded through Load > Open file and started with CYCLE START; the program reached its first M6: the tool-change card asking for the next tool. Whole frame.`, extra: { card: cardA, setter } })
      const cont = tid('control-tc-continue')
      if (await cont.count()) {
        await cont.click()
        await page.waitForTimeout(2000)
        await tid('control-tc-continue').filter({ hasText: /Continue from the M6/ }).waitFor({ timeout: 120_000 }).catch(() => {})
        await h.debug('03-after-measure')
        const b = 'C-6b-m6-measured.png'
        await h.shot(b)
        const cardB = await tid('control-toolchange-card').innerText().catch(() => '')
        h.sidecar(b, { appState: 'Same run as C-6a after the swap was confirmed with the card\'s Continue: the new tool measured on the setter, the card offering Continue from the M6 (not pressed). Whole frame.', extra: { card: cardB } })
      }
    },
  },

  // C-2 - Definition > Controller for a UCCNC machine: install folder, profile, board.
  'C-2': {
    async run(h) {
      const { tid, page } = h
      await controlSimulator(h)
      await defineMachine(h, { controller: 'uccnc' })
      await tid('control-view-main').click()
      await tid('control-disconnect').click()
      await tid('control-connect').waitFor()
      const kinds = await tid('control-kind-select').evaluate((el) => [...el.options].map((o) => o.value))
      const bridge = kinds.find((k) => k === 'bridge')
      if (bridge) await tid('control-kind-select').selectOption(bridge)
      await tid('control-view-machine').click()
      await tid('control-machine-tab-definition').click()
      await tid('machine-def-tab-controller').click()
      await page.waitForTimeout(1000)
      const install = tid('machine-controller-uccnc-install-input')
      if (await install.count()) { await install.fill('C:\\UCCNC12115'); await install.press('Tab') }
      await page.mouse.click(1500, 1000)
      await page.waitForTimeout(800)
      await h.debug('01-controller')
      const name = 'C-2-uccnc-controller.png'
      await h.shot(name)
      h.sidecar(name, { appState: `Control > Machine > Definition > Controller. Starter machine re-declared as UCCNC (Controller list), defined and saved; connection kind ${bridge ?? '(no bridge kind offered)'} picked but NOT connected (browser build: no bridge on this computer, no Browse button). Install folder typed as the standard C:\\UCCNC12115. Whole frame.`, extra: { kinds } })
    },
  },
}
