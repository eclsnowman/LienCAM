// IS THE AXIS COLOUR THE SAME COLOUR EVERYWHERE?
//
// MOVED HERE FROM `tools/` ON 2026-08-26, AND THE REASON IS A CLASSIFICATION
// ONE, NOT A LINE-COUNT ONE. `tools/guard.mjs` counts everything under
// `tools/` as PIPELINE MACHINERY - the code that gates, dispatches and lands
// work orders - unless it sits in the short explicit app list, which already
// contains `tools/capture/`. This file is not machinery: nothing runs it in a
// lane, no gate consults it, and it drives a real browser through the capture
// harness it imports on the line below. It is a hand-run visual diagnostic,
// which is what `tools/capture/` IS. Counting it against the pipeline ceiling
// was measuring it on the wrong axis.
//
// It was reclassified rather than DELETED, which was the other option on the
// table. An audit established that deleting it would lose real capability:
// `src/tests/viewport/axisColourTokens.wo961.test.ts` only stops `ViewCube.tsx`
// re-hardcoding its six literals. It does NOT check that the three variable
// families below still resolve to one colour per axis per THEME, and it does
// not sweep the rest of `src/` for new hardcoded axis colours. This project's
// norm for an instrument that has answered its question is "demoted, not
// cancelled".
//
//   node tools/capture/axis-colour-audit.mjs [port]
//
// Operator ruling 2026-08-24: "we just need to confirm our color for specific axis is
// consistent throughout the app. on cam axis gizmos, on workspace coordinate
// references, in the model space, and in the control space."
//
// There are THREE naming families for the same idea, which is why this is worth
// MEASURING rather than reading:
//
//   --axis-x/y/z        the base definition        (theme/tokens.css:205)
//   --x-axis/y-axis/..  alias, used by Control UI  (styles/app.css:74)
//   --vp-axis-x/y/z     alias, used by the 3D viewport, view cube, workbench
//                       triad and probe diagrams   (theme/tokens.css:293)
//
// All three should resolve to ONE colour per axis in EVERY theme. A token that
// merely LOOKS like an alias is not one: the amber theme already re-pins
// --axis-z on purpose, because it chains through --blue-500 which that theme
// overrides. Reading the chain is how you get that wrong; resolving it in a
// real browser is how you get it right.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startDevServer, openControl, macroSeed } from '../../src/tests/evidence/WO-103/capture.mjs'

const PORT = Number(process.argv[2] || 5451)
const THEMES = [null, 'high-contrast', 'amber']
const FAMILIES = {
  base: ['--axis-x', '--axis-y', '--axis-z'],
  control: ['--x-axis', '--y-axis', '--z-axis'],
  viewport: ['--vp-axis-x', '--vp-axis-y', '--vp-axis-z'],
}

// ---------------------------------------------------------------------------
// PART 2 - who paints an axis WITHOUT asking the token?
//
// A literal that happens to equal the DEFAULT theme is the dangerous kind: it
// agrees today, stops agreeing the moment a theme moves, and nothing goes red.
// `src/theme/viewportColors.ts` is exempt - it is a DECLARED fallback map whose
// own header requires every value to equal the production token, and it has a
// test enforcing exactly that. A guarded duplicate is not the same as a stray
// literal.
// ---------------------------------------------------------------------------
const AXIS_HEX = /(0x|#)(e05252|5ca85c|4a90d9)/i
// Axis context may come from a COMMENT, but the literal itself must be in
// CODE. First version of this got both halves wrong: it flagged
// ViewportOverlay's `asHex('--vp-axis-z')  // #4a90d9` - which reads the token
// correctly and merely names the value in a comment - and it MISSED
// ViewCube's three axis arrows, because `addArrow(new THREE.Vector3(1,0,0),
// corner, 0xe05252)` never says the word "axis" on its own line. A report with
// a false positive and a false negative is one nobody reads.
const NAMES_AN_AXIS = /axis|\bVector3\(\s*[01]\s*,\s*[01]\s*,\s*[01]\s*\)|\b[XYZ]\b/
const CONTEXT = 4
const EXEMPT = ['theme/viewportColors.ts', 'theme/tokens.css']

/** Strip line and block comments so a hex mentioned in prose is not a paint. */
const stripComments = (line) => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name).replaceAll('\\', '/')
    if (full.includes('/tests/') || full.includes('node_modules')) continue
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|css)$/.test(full)) out.push(full)
  }
  return out
}

const offenders = []
for (const file of walk('src')) {
  if (EXEMPT.some((e) => file.endsWith(e))) continue
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (!AXIS_HEX.test(stripComments(line))) return
    const near = lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).join(' ')
    if (!NAMES_AN_AXIS.test(near)) return
    offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 88)}`)
  })
}

const server = await startDevServer({ port: PORT })
const browser = await chromium.launch()
let problems = 0
try {
  const { page } = await openControl(browser, { width: 1280, height: 800 }, macroSeed(), server.base)
  await page.waitForTimeout(500)

  for (const theme of THEMES) {
    const resolved = await page.evaluate(({ theme, FAMILIES }) => {
      const root = document.documentElement
      const had = root.getAttribute('data-theme')
      if (theme) root.setAttribute('data-theme', theme)
      else root.removeAttribute('data-theme')
      // Resolve through a real element so the var() chains actually collapse.
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      const out = {}
      for (const [family, tokens] of Object.entries(FAMILIES)) {
        out[family] = tokens.map((t) => {
          probe.style.color = ''
          probe.style.color = `var(${t})`
          return getComputedStyle(probe).color
        })
      }
      probe.remove()
      if (had) root.setAttribute('data-theme', had)
      else root.removeAttribute('data-theme')
      return out
    }, { theme, FAMILIES })

    console.log(`\nTHEME ${theme ?? '(default)'}`)
    for (const axis of [0, 1, 2]) {
      const vals = Object.entries(resolved).map(([f, v]) => [f, v[axis]])
      const agree = new Set(vals.map(([, v]) => v)).size === 1
      if (!agree) problems += 1
      console.log(
        `  ${'XYZ'[axis]}  ${agree ? 'AGREE' : '*** DISAGREE ***'}  `
        + vals.map(([f, v]) => `${f}=${v}`).join('  '),
      )
    }
  }
} finally {
  await browser.close()
  await server.close?.()
}

console.log(problems === 0
  ? '\nTOKENS: all three families resolve to one colour per axis, in every theme.'
  : `\nTOKENS: ${problems} axis/theme combinations DISAGREE - see above.`)

console.log('\nSURFACES THAT PAINT AN AXIS WITHOUT ASKING THE TOKEN')
console.log('-'.repeat(62))
if (offenders.length === 0) {
  console.log('  none - every axis surface reads the token')
} else {
  for (const o of offenders) console.log('  ' + o)
  console.log(`\n  ${offenders.length} hardcoded axis colours. They match the DEFAULT`)
  console.log('  theme and DIVERGE from every other one, silently.')
}
process.exit(offenders.length === 0 && problems === 0 ? 0 : 1)
