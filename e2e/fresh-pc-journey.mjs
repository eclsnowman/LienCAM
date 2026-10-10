#!/usr/bin/env node
// The fresh-PC journey (release gate G5): what a new user does with a freshly
// installed LienCAM, driven through the PACKAGED app's own buttons, menus,
// dialogs and keyboard. See e2e/README.md.
//
//   node e2e/fresh-pc-journey.mjs --app <LienCAM.exe> --out <dir> [--shots]
//        [--samples <Sample Parts dir>] [--profile <empty dir>] [--only 1,2,3]
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Journey } from './lib/harness.mjs'
import { closeLeftoverDialogs } from './lib/app.mjs'
import { buildToolLibrary, chooseSettings, defineMachine, firstLaunch, machineSurvivesRestart } from './steps/setup-steps.mjs'
import { importParts, modelPart, sketchPart } from './steps/design-steps.mjs'
import { OPERATIONS, setupAndToolpaths } from './steps/cam-steps.mjs'
import { simulateToEnd } from './steps/simulate-steps.mjs'
import { saveCloseReopen } from './steps/project-steps.mjs'
import { postEveryDialect } from './steps/post-steps.mjs'
import { runOnSimulator } from './steps/control-steps.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = { shots: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--shots') args.shots = true
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i]
  }
  return args
}

// WO-2333: exercise the automatic finished plane, rather than the old explicit
// Face-depth workaround. Other operation choices remain exactly as declared.
export function automaticFaceOperations(operations) {
  return operations.map(op => {
    if (op.type !== '2D Face') return op
    const { face: _manualFinishedFace, ...automatic } = op
    return automatic
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.app || !args.out) {
    console.error('usage: node e2e/fresh-pc-journey.mjs --app <path to LienCAM.exe> --out <dir> [--shots]')
    process.exit(2)
  }
  const appPath = path.resolve(args.app)
  const outDir = path.resolve(args.out)
  const samplesDir = path.resolve(args.samples ?? path.join(HERE, '..', 'Sample Parts'))
  const profileDir = path.resolve(args.profile ?? path.join(outDir, 'profile'))
  if (!existsSync(appPath)) throw new Error(`no app at ${appPath}`)
  if (!existsSync(samplesDir)) throw new Error(`no Sample Parts at ${samplesDir}`)

  // A fresh PC: the profile directory is created empty for this run.
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  const filesDir = path.join(outDir, 'files')
  rmSync(filesDir, { recursive: true, force: true })
  mkdirSync(filesDir, { recursive: true })

  const journey = new Journey({ appPath, outDir, shots: args.shots })
  const ctx = { journey, samplesDir, profileDir, filesDir, outDir, data: {} }

  try {
    await journey.step(1, 'first launch on an empty profile', async () => {
      const leftovers = readdirSync(profileDir)
      if (leftovers.length) throw new Error(`the profile is not empty before launch: ${leftovers.join(', ')}`)
      await journey.launch(profileDir)
      await firstLaunch(journey)
    })

    await journey.step(2, 'settings and a machine defined from scratch, kept across a restart', async () => {
      await chooseSettings(journey)
      await defineMachine(journey)
      await journey.close()
      await journey.launch(profileDir)
      await machineSurvivesRestart(journey)
    })

    await closeLeftoverDialogs(journey)
    await journey.step(3, 'tool library: end mill, drill, V-bit', async () => {
      await buildToolLibrary(journey)
    })

    await closeLeftoverDialogs(journey)
    await journey.step(4, 'new project: sketch, model, and STEP/DXF/SVG imports', async () => {
      await sketchPart(journey)
      await modelPart(journey)
      await importParts(journey, samplesDir)
    })

    await closeLeftoverDialogs(journey)
    await journey.step(5, 'setup and toolpaths: face, adaptive, contour, drill, pocket, 3D finish', async () => {
      // createOperation already waits (bounded at 60 s) for Create to enable.
      // The former face.targetWcs option entered its manual Heights branch first.
      OPERATIONS.splice(0, OPERATIONS.length, ...automaticFaceOperations(OPERATIONS))
      await setupAndToolpaths(ctx)
    })

    await closeLeftoverDialogs(journey)
    await journey.step(6, 'simulate to the end', async () => {
      await simulateToEnd(ctx)
    })

    await closeLeftoverDialogs(journey)
    await journey.step(7, 'save, close, reopen: identical operations, toolpaths and G-code', async () => {
      await saveCloseReopen(ctx)
    })

    await closeLeftoverDialogs(journey)
    await journey.step(8, 'post process with every shipped dialect', async () => {
      await postEveryDialect(ctx)
    })

    await closeLeftoverDialogs(journey)
    await journey.step(9, 'control: simulator connect, home, zero, load, run, pause, jog, resume, finish', async () => {
      await runOnSimulator(ctx)
    })
  } finally {
    await journey.close()
    journey.finish({ samplesDir, profileDir, data: ctx.data })
  }
  const failed = journey.steps.filter((s) => s.status !== 'PASS')
  console.log(failed.length ? `JOURNEY FAIL (${failed.length} of ${journey.steps.length} steps)` : `JOURNEY PASS (${journey.steps.length} steps)`)
  process.exit(failed.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
