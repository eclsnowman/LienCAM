// WO SKC-8 criterion 3 ("share-do-not-fork proof"): the draw-tool state machine (POINTS_NEEDED)
// is defined EXACTLY ONCE in the whole repo, in src/components/sketch3d-shared/drawTool.ts, and
// both consuming pages (the sketch3d lab, the SolidsWorkbenchPage editing session) import it from
// there rather than keeping a local copy. A plain source-text scan (not a runtime import check)
// is the honest way to prove "grep-able single source" -- an import-based check could pass even
// if a SECOND, unused definition still existed elsewhere in the tree.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC_ROOT = join(__dirname, '..', '..')

/**
 * WO SKC-15C: comments are prose, not capability. The severed page's header comments NAME the
 * functions they no longer call ("this page once imported `stepDrawTool`..."), which is exactly the
 * documentation a reader needs and exactly the text a raw grep would mistake for a call site. Same
 * helper, same reason, as src/tests/sketch/oneSketchPointerOwner.test.ts:104. The `[^:]` guard keeps
 * `https://` inside a string literal from eating the rest of its line.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      collectTsFiles(full, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
}

function countDefinitions(pattern: RegExp): { file: string; count: number }[] {
  const files: string[] = []
  collectTsFiles(SRC_ROOT, files)
  const hits: { file: string; count: number }[] = []
  for (const file of files) {
    // Test files themselves may legitimately reference the pattern in comments/strings -- only
    // scan production source, matching this WO's own ownership manifest scope.
    if (file.includes(`${join('src', 'tests')}`)) continue
    const content = readFileSync(file, 'utf8')
    const matches = content.match(pattern)
    if (matches) hits.push({ file, count: matches.length })
  }
  return hits
}

describe('WO SKC-8 criterion 3: share-do-not-fork (POINTS_NEEDED single source)', () => {
  it('SKETCH3D_DRAW_POINTS_NEEDED is DEFINED exactly once, in the shared module', () => {
    const definitions = countDefinitions(/(?:export\s+)?const\s+SKETCH3D_DRAW_POINTS_NEEDED\s*:/g)
    expect(definitions).toHaveLength(1)
    expect(definitions[0].file.replace(/\\/g, '/')).toMatch(/src\/components\/sketch3d-shared\/drawTool\.ts$/)
  })

  it('no OTHER file defines a local "POINTS_NEEDED"-shaped draw-tool-count map', () => {
    // Fails-if: reintroducing a per-page local POINTS_NEEDED (the pre-WO shape Sketch3dLabPage
    // used to keep) would show up here as a SECOND definition site.
    const definitions = countDefinitions(/const\s+POINTS_NEEDED\s*:/g)
    expect(definitions).toHaveLength(0)
  })

  it('the sketch3d lab page imports the draw-tool machine from the shared module (not a local copy)', () => {
    const labSource = readFileSync(join(SRC_ROOT, 'components', 'sketch3dlab', 'Sketch3dLabPage.tsx'), 'utf8')
    expect(labSource).toMatch(/from ['"]\.\.\/sketch3d-shared\/drawTool['"]/)
    expect(labSource).toMatch(/stepDrawTool/)
  })

  // WO SKC-15C (THE SEVERING) -- this test used to read:
  //
  //   it('the workbench editing session imports the SAME draw-tool machine + grab-site resolver
  //       from the shared module', () => {
  //     expect(workbenchSource).toMatch(/from ['"]\.\.\/sketch3d-shared['"]/)
  //     expect(workbenchSource).toMatch(/stepDrawTool/)
  //     expect(workbenchSource).toMatch(/pickGrabTarget/)
  //   })
  //
  // It was the RIGHT test while the workbench ran an inline sketch3d draw session: given two draw
  // machines, it proved they shared one state machine instead of forking. SKC-15C deletes the
  // workbench's draw machine outright, so "does the workbench import stepDrawTool" now has the
  // opposite correct answer, and the inverted assertion below is a STRICTLY STRONGER claim than the
  // one it replaces: sharing a state machine prevents divergence, but not having a second machine
  // at all makes divergence unwriteable (the critic's law, docs/3d/SKETCH-CRITIC-REPORT.md).
  //
  // The full-strength version of this -- a capability scan over the whole of src/components/model3d,
  // with committed non-vacuity fixtures -- lives in
  // src/tests/model3d/oneWorkbenchSketchPointerOwner.test.ts. This one keeps the lab honest and pins
  // the single surviving import.
  it('the workbench does NOT call the draw-tool machine or the grab-site resolver at all (SKC-15C: it has no draw machine)', () => {
    const raw = readFileSync(join(SRC_ROOT, 'components', 'model3d', 'SolidsWorkbenchPage.tsx'), 'utf8')
    const workbenchSource = stripComments(raw)
    // FAILS-IF the inline sketch3d draw/select session is reintroduced in the workbench page.
    expect(workbenchSource).not.toMatch(/\bstepDrawTool\s*\(/)
    expect(workbenchSource).not.toMatch(/\bpickGrabTarget\s*\(/)
    expect(workbenchSource).not.toMatch(/\bisSketch3dDrawTool\s*\(/)
    // Non-vacuity: the stripped source is still the real file, not an empty string a `not.toMatch`
    // would trivially satisfy. Without this, deleting the page would make the three lines above pass.
    expect(workbenchSource).toMatch(/export function SolidsWorkbenchPage\(/)
    // The ONE thing it still takes from the shared module is arc tessellation for the finished
    // sketch's 3D outline -- geometry sampling, not interaction. Asserted positively so a future
    // rewrite that quietly forks a local `sampleArcPoints` shows up here.
    expect(raw).toMatch(/import \{ sampleArcPoints \} from ['"]\.\.\/sketch3d-shared['"]/)
  })

  it('the sketch3d lab -- the one page that still runs the inline draw machine -- still shares it', () => {
    // FAILS-IF the lab forks its own copy now that it is the machine's only consumer. A single
    // consumer is exactly when "share, do not fork" stops being enforced by a second caller and
    // starts needing a test.
    const labSource = readFileSync(join(SRC_ROOT, 'components', 'sketch3dlab', 'Sketch3dLabPage.tsx'), 'utf8')
    expect(labSource).toMatch(/pickGrabTarget/)
    const definitions = countDefinitions(/export function pickGrabTarget\(/g)
    expect(definitions).toHaveLength(1)
    expect(definitions[0].file.replace(/\\/g, '/')).toMatch(/src\/components\/sketch3d-shared\//)
  })

  it('makeArcEntity (start/end/through construction) is defined exactly once, in the shared module', () => {
    const definitions = countDefinitions(/export function makeArcEntity\(/g)
    expect(definitions).toHaveLength(1)
    expect(definitions[0].file.replace(/\\/g, '/')).toMatch(/src\/components\/sketch3d-shared\/draftEntities\.ts$/)
  })
})

// WO SKC-12 (5d, the critic's DE-2 finding): a name-match ("is there a function called
// makeArcEntity") is satisfiable while a SECOND arc-math version forks elsewhere under a
// different name -- exactly what happened pre-SKC-12 (SolidsWorkbenchPage.tsx's private
// withPointAt re-derived arc angles via its own Math.atan2 calls, never named makeArcEntity, and
// no existing test caught it). This is a CAPABILITY scan instead: within the sketch3d ecosystem
// (sketch3d/, sketch3d-shared/, sketch3dlab/, SolidsWorkbenchPage.tsx -- NOT CAM's own
// src/lib/sketch/**, which legitimately owns its own mirrored version of this same math as the
// canonical SOURCE), exactly one file may contain the capability "derive a NEW arc angle from
// Math.atan2". Any other file gaining that capability -- construction, drag, or otherwise -- is
// exactly the fork this WO closes.
describe('WO SKC-12 (5d): capability scan -- exactly one module derives arc angles via atan2', () => {
  const ECOSYSTEM_ROOTS = [
    join(SRC_ROOT, 'sketch3d'),
    join(SRC_ROOT, 'components', 'sketch3d-shared'),
    join(SRC_ROOT, 'components', 'sketch3dlab'),
  ]
  const ECOSYSTEM_SINGLE_FILES = [join(SRC_ROOT, 'components', 'model3d', 'SolidsWorkbenchPage.tsx')]
  // The one allowed definition site: the shared canonicalizing constructor + the point-override
  // primitive next to it (both derive angles via canonicalArcFromThreePoints's Math.atan2 calls).
  const ALLOWED = new Set([join(SRC_ROOT, 'components', 'sketch3d-shared', 'draftEntities.ts')])

  function collectEcosystemFiles(): string[] {
    const files: string[] = []
    for (const root of ECOSYSTEM_ROOTS) collectTsFiles(root, files)
    files.push(...ECOSYSTEM_SINGLE_FILES)
    return files.filter((f) => !f.includes(`${join('src', 'tests')}`))
  }

  it('no file outside the shared constructor derives a NEW arc angle via Math.atan2', () => {
    const offenders: string[] = []
    for (const file of collectEcosystemFiles()) {
      if (ALLOWED.has(file)) continue
      const content = readFileSync(file, 'utf8')
      // A file "derives arc angles" if it both CALLS Math.atan2(...) (not merely mentions it in
      // prose) AND assigns an object-literal startAngle:/endAngle: key (not a ternary's `? a :
      // b`, nor a property READ like `arc.startAngle`, nor a doc comment) -- reading an
      // already-stored angle (pointSamples.ts, inference.ts's tangent-angle helper,
      // constraintGeometry.ts) never assigns those keys, so this only trips on genuine
      // re-derivation.
      if (/Math\.atan2\(/.test(content) && /(startAngle|endAngle):/.test(content)) {
        offenders.push(file.replace(/\\/g, '/'))
      }
    }
    // FAILS-IF: reintroducing SolidsWorkbenchPage.tsx's old private withPointAt (or any new
    // page-level arc-math fork) would show up here as a second offender.
    expect(offenders).toEqual([])
  })

  it('sanity: the allowed file really does derive arc angles (proves the scan pattern is not vacuous)', () => {
    const content = readFileSync(join(SRC_ROOT, 'components', 'sketch3d-shared', 'draftEntities.ts'), 'utf8')
    expect(/Math\.atan2/.test(content) && /(startAngle|endAngle)\s*:/.test(content)).toBe(true)
  })
})
