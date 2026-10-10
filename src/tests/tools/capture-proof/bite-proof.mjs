#!/usr/bin/env node
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  captureProvenancedScreenshot,
  withViteCaptureServer,
} from '../../../../tools/capture/lib/provenance.mjs'
import { persistCaptureProvenance } from '../../../../tools/capture/shoot.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../..')
const OUT = path.join(HERE, 'output')
const mode = process.argv[2]
const port = Number(process.argv[3])
const fixturePath = 'src/tests/tools/capture-proof/fixture.html'

mkdirSync(OUT, { recursive: true })

const liveBranchPredicate = (page) => page.evaluate(
  () => document.body.dataset.branchProof === 'WO-092',
)
const staleBranchPredicate = (page) => page.evaluate(
  () => document.body.dataset.branchProof === 'some-other-branch',
)

async function shot(page, name, provenance = liveBranchPredicate) {
  return captureProvenancedScreenshot({
    page,
    outputPath: path.join(OUT, name),
    provenance,
  })
}

async function runMode(page) {
  if (mode === 'provenance-refusal') {
    const name = 'provenance-refused.png'
    try {
      await shot(page, name, staleBranchPredicate)
    } catch (error) {
      console.error(`[proof] thrown message: ${error.message}`)
      console.error(`[proof] target absent after refusal: ${!existsSync(path.join(OUT, name))}`)
      throw error
    }
    throw new Error('proof setup failed: false provenance unexpectedly wrote a PNG')
  }

  if (mode === 'provenance-pass') {
    const name = 'initial.png'
    const result = await shot(page, name)
    console.log(`[proof] passing predicate wrote ${name}: ${result.bytes} bytes`)
    return
  }

  if (mode === 'duplicate-refusal') {
    const firstName = 'initial.png'
    const secondName = 'duplicate-second.png'
    await shot(page, firstName)
    try {
      await shot(page, secondName)
    } catch (error) {
      console.error(`[proof] thrown message: ${error.message}`)
      console.error(`[proof] later target absent after refusal: ${!existsSync(path.join(OUT, secondName))}`)
      throw error
    }
    throw new Error('proof setup failed: byte-identical screenshots unexpectedly both survived')
  }

  if (mode === 'duplicate-pass') {
    const first = await shot(page, 'initial.png')
    await page.locator('#change').click()
    const second = await shot(page, 'changed.png')
    console.log(`[proof] changed views have distinct hashes: ${first.hash !== second.hash}`)
    return
  }

  throw new Error(
    'mode must be provenance-refusal, provenance-pass, duplicate-refusal, or duplicate-pass',
  )
}

function createSourceProofRepo() {
  const repoRoot = path.join(HERE, '.tmp-source-provenance')
  rmSync(repoRoot, { recursive: true, force: true })
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
  writeFileSync(path.join(repoRoot, 'src', 'app.mjs'), 'export const revision = "before"\n')
  execFileSync('git', ['init', '--quiet'], { cwd: repoRoot })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.email', 'capture-proof@example.invalid'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.name', 'Capture Proof'], { cwd: repoRoot })
  execFileSync('git', ['add', 'src/app.mjs'], { cwd: repoRoot })
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture baseline'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
  })
  return repoRoot
}

const SOURCE_PROOF_PNG = Buffer.from(
  Array.from({ length: 1_200 }, (_, index) => (index * 17 + 31) % 251),
)

async function captureSourceShot(repoRoot, proofDirectory, label) {
  const outputPath = path.join(proofDirectory, 'proof.png')
  const result = await captureProvenancedScreenshot({
    page: { sourceProof: true },
    target: {
      screenshot: async ({ path: screenshotPath }) => {
        writeFileSync(screenshotPath, SOURCE_PROOF_PNG)
      },
    },
    outputPath,
    provenance: async (page) => page.sourceProof === true,
    repoRoot,
  })
  const provenancePath = persistCaptureProvenance({
    provenancePath: path.join(proofDirectory, label, 'provenance.json'),
    shots: { 'proof.png': result },
  })
  return JSON.parse(readFileSync(provenancePath, 'utf8'))
}

async function runSourceProof() {
  const repoRoot = createSourceProofRepo()
  const proofDirectory = path.join(OUT, mode)
  rmSync(proofDirectory, { recursive: true, force: true })
  mkdirSync(proofDirectory, { recursive: true })

  try {
    const firstPersisted = await captureSourceShot(repoRoot, proofDirectory, 'first')
    const first = firstPersisted.shots['proof.png']

    if (mode === 'source-substitution') {
      writeFileSync(path.join(repoRoot, 'src', 'app.mjs'), 'export const revision = "after"\n')
      const secondPersisted = await captureSourceShot(repoRoot, proofDirectory, 'second')
      const second = secondPersisted.shots['proof.png']
      console.log('[proof] capture boundary calls persisted: 2')
      console.log(`[proof] legacy commit-only records identical: ${first.commit === second.commit}`)
      console.log(`[proof] before/after dirty: ${first.workingTreeDirty}/${second.workingTreeDirty}`)
      console.log(`[proof] source hashes distinct: ${first.sourceHash !== second.sourceHash}`)
      console.log(`[proof] screenshot hashes agree: ${first.screenshotSha256 === second.screenshotSha256}`)
      if (first.commit !== second.commit || first.sourceHash === second.sourceHash
        || first.screenshotSha256 !== second.screenshotSha256) {
        throw new Error('source substitution proof did not distinguish same-HEAD source trees')
      }
      return
    }

    const secondPersisted = await captureSourceShot(repoRoot, proofDirectory, 'second')
    const recordsAgree = JSON.stringify(firstPersisted) === JSON.stringify(secondPersisted)
    console.log('[proof] capture boundary calls persisted: 2')
    console.log(`[proof] unchanged source records agree: ${recordsAgree}`)
    if (!recordsAgree) throw new Error('unchanged source produced different provenance records')
  } finally {
    rmSync(path.join(proofDirectory, 'proof.png'), { force: true })
    rmSync(repoRoot, { recursive: true, force: true })
  }
}

async function main() {
  if (mode === 'source-substitution' || mode === 'source-control') {
    await runSourceProof()
    return
  }

  await withViteCaptureServer({ port, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
      await page.goto(new URL(fixturePath, baseUrl).href, { waitUntil: 'networkidle' })
      await runMode(page)
    } finally {
      await browser.close()
    }
  })
}

main().catch((error) => {
  console.error(`[proof] FATAL: ${error.message}`)
  process.exitCode = 1
})
