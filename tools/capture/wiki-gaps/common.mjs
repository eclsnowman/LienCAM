// WO-2709 shared bits for the wiki-gap capture routes: output folder, the
// per-picture JSON sidecar (source identity + route + viewport + app state),
// and a CPU gate so a browser only starts when the dev box has room.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { captureSourceProvenance } from '../lib/provenance.mjs'

export const ROOT = process.cwd()
export const OUT = path.resolve(ROOT, 'src/tests/evidence/WO-2709/candidates')
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until the dev box CPU is under the limit before launching a browser. */
export async function waitForCpu(limit = 60, maxWaitMs = 20 * 60_000) {
  const started = Date.now()
  for (;;) {
    let load = 0
    try {
      load = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command',
        '(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average'],
      { encoding: 'utf8', windowsHide: true }).trim())
    } catch { load = 0 }
    console.log(`[cpu] ${load}%`)
    if (load < limit) return load
    if (Date.now() - started > maxWaitMs) throw new Error(`CPU stayed at/above ${limit}%`)
    await sleep(30_000)
  }
}

/** Delete-first: remove a candidate and its JSON before it is re-made. */
export function clearCandidate(name) {
  for (const file of [name, name.replace(/\.(png|webp)$/, '.json')]) fs.rmSync(path.join(OUT, file), { force: true })
}

/** Write the sidecar JSON next to a finished candidate picture. */
export function writeSidecar(name, { gap, route, viewport, appState, sourcePaths, extra = {} }) {
  const file = path.join(OUT, name)
  if (!fs.existsSync(file)) throw new Error('candidate missing: ' + name)
  const source = captureSourceProvenance({ repoRoot: ROOT, sourcePaths, sourceExcludePaths: ['src/tests'] })
  const json = {
    gap,
    picture: name,
    bytes: fs.statSync(file).size,
    capturedAt: new Date().toISOString(),
    sourceCommit: source.commit,
    sourceTreeDirty: source.workingTreeDirty,
    sourceScope: source.workingTreeScope,
    sourceHash: source.sourceHash,
    route,
    viewport,
    appState,
    ...extra,
  }
  fs.writeFileSync(file.replace(/\.(png|webp)$/, '.json'), JSON.stringify(json, null, 2) + '\n')
  console.log('candidate', name, json.bytes, 'bytes')
  return json
}
