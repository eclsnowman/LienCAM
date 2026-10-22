// NOT part of the test gate. Run deliberately:
//   node tools/capture/shoot.mjs <dedicated-port> <predicate-module> [outDir]
// The predicate module must default-export (or export `provenance`) an async
// function that evaluates the live page and returns exactly true only when it
// proves this checkout's behavior. There is deliberately no default port or
// skippable provenance mode.

import { isMain } from '../lib/is-main.mjs';
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { persistCaptureProvenance, runCaptureHarness } from './lib/harness.mjs'

export { dismissMachineModal, persistCaptureProvenance } from './lib/harness.mjs'

export async function shoot({
  port,
  outDir,
  provenance,
  repoRoot = process.cwd(),
  sourcePaths,
  sourceExcludePaths,
}) {
  if (typeof provenance !== 'function') {
    throw new TypeError('PROVENANCE HARD-FAIL: shoot() requires a live-page provenance predicate')
  }
  const outputDirectory = resolve(outDir || 'tools/capture/out')
  const provenancePath = resolve(outputDirectory, 'provenance.json')
  rmSync(provenancePath, { force: true })

  const result = await runCaptureHarness({
    port, outDir: outputDirectory, repoRoot, viewport: { width: 1280, height: 800 },
  }, async ({ page, capture }) => {
      await page.waitForTimeout(3_000)
      const gl = await page.evaluate(() => {
        const c = document.querySelector('canvas')
        if (!c) return { ok: false, reason: 'no canvas' }
        const ctx = c.getContext('webgl2') || c.getContext('webgl')
        if (!ctx) return { ok: false, reason: 'no gl context' }
        const dbg = ctx.getExtension('WEBGL_debug_renderer_info')
        return {
          ok: true,
          w: c.width, h: c.height,
          renderer: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
        }
      })
      console.log('GL:', JSON.stringify(gl))

      const backdropCount = await page.locator('.modal-backdrop').count()
      console.log('MODAL-CHECK: backdrops =', backdropCount,
        backdropCount === 0 ? '(backdrop GONE)' : '(BACKDROP STILL PRESENT!)')

      const full = await capture('full.png', {
        provenance, sourcePaths, sourceExcludePaths,
      })
      const viewport = await capture('viewport.png', {
        target: page.locator('canvas').first(),
        provenance, sourcePaths, sourceExcludePaths,
      })
      console.log('Wrote full.png + viewport.png to', outputDirectory)
      return { full, viewport }
  })
  const { full, viewport } = result.value
  try {
    persistCaptureProvenance({ provenancePath, shots: { 'full.png': full, 'viewport.png': viewport } })
  } catch (error) {
    rmSync(full.outputPath, { force: true })
    rmSync(viewport.outputPath, { force: true })
    throw error
  }
  console.log('Wrote per-shot source provenance to', provenancePath)
  return { full, viewport, provenancePath }
}

async function main() {
  const port = Number(process.argv[2])
  const predicatePath = process.argv[3]
  if (!Number.isInteger(port) || !predicatePath) {
    throw new Error(
      'Usage: node tools/capture/shoot.mjs <dedicated-port> <predicate-module> [outDir]',
    )
  }
  const predicateModule = await import(pathToFileURL(resolve(predicatePath)).href)
  const provenance = predicateModule.default || predicateModule.provenance
  await shoot({ port, provenance, outDir: process.argv[4] })
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
