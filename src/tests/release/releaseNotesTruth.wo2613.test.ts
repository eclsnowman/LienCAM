import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
// A pinned main control reads git blobs in this worktree; it never swaps sources,
// makes a checkout or touches the shared dependency install.
const read = (path: string) => (process.env.WO2613_TEXT_REF
  ? execFileSync('git', ['show', `${process.env.WO2613_TEXT_REF}:${path}`], { cwd: root, encoding: 'utf8', windowsHide: true })
  : readFileSync(join(root, path), 'utf8')).replace(/\s+/g, ' ')
const announcement = (name: string) => read(`docs/launch/announcements/${name}.md`)

// WO-2660 (the operator 12:55 PM approved the README before/after): the M0 / From line / Held / probing claims moved
// from README.md to CHANGELOG.md; the claims are pinned where they now live. the operator 2:36 PM 10-07 approved the
// release-notes before/after too ("Land it + add back the starter-kit line"), so they leave the release notes.
describe.each(['CHANGELOG.md'])('WO-2613 claims in %s', path => {
  const text = read(path)

  it('distinguishes explicit M0 from the M6 stop and names the two ways to end a program hold', () => {
    expect(text).toMatch(/Every explicit M0 holds the program; CYCLE START resumes it, and Stop\/Reset at an M0 ends it/)
    expect(text).toMatch(/UCCNC post adds no redundant M0 after `T# M6`/)
    expect(text).toMatch(/Stop program on a program's tool-change card ends the job/)
  })

  it('describes UCCNC posted-setup restart with original lines and reconstructed modal state', () => {
    expect(text).toMatch(/On UCCNC, \*\*From line\*\* and \*\*Plan\*\* restart a posted setup at its original file line/)
    expect(text).toMatch(/(?:with|restoring) the tool, work offset and spindle/)
  })

  it('names the three Held routes without claiming every paused job is Held', () => {
    expect(text).toMatch(/amber \*\*Held\*\* chip marks an M0, controller Feed Hold or a stationary tool-change card waiting for you/)
  })

  it('uses original file lines and execution-based view and readouts', () => {
    expect(text).toMatch(/listing uses original file line numbers/)
    expect(text).toMatch(/3D view, progress, feed and spindle readouts follow the executing move/)
  })

  it('keeps probing Pause/Resume/Stop separate from the loaded program and applies connected defaults with overrides', () => {
    expect(text).toMatch(/Probing-screen \*\*Pause\*\*, \*\*Resume\*\* and \*\*Stop\*\* act on probing only, leaving the loaded program in place/)
    expect(text).toMatch(/saved probing settings for the connected machine apply immediately/i)
    expect(text).toMatch(/operator overrides (?:still take precedence|preserved)/)
  })

  it('describes probe visibility, inside seeks and setter retry without extra parking', () => {
    expect(text).toMatch(/PROBE lamp appears on every probing screen/)
    expect(text).toMatch(/inside-feature probing uses probe seeks/i)
    expect(text).toMatch(/\*\*Retry measure\*\* re-probes at the setter without another park move/)
    if (path !== 'CHANGELOG.md') { // README's old exemption; the claims now live in CHANGELOG (WO-2660)
      expect(text).toContain('the probe picture uses its real height when it is at the part')
      expect(text).toContain('each approach to a face is one probe move')
    }
  })

  it('limits G28 to a stored home in the configured order and names the experimental LinuxCNC card', () => {
    expect(text).toMatch(/On UCCNC, a G28 loaded into Control returns to the stored home position in the machine's configured homing order/)
    expect(text).toMatch(/experimental LinuxCNC route shows its tool-change card when LinuxCNC is waiting for a tool/)
  })

  it('starts with Full Suite, uses plain filenames and does not promise posted G-code for every part', () => {
    // WO-2660: the README's quick start became one line (the operator 12:55 PM); this quick-start claim set stays pinned
    // on the release notes, which keep it word for word.
    if (path === 'CHANGELOG.md') return
    expect(text).toMatch(/\*\*Full Suite\*\*.*first.*\*\*Try an example\*\*/)
    expect(text).toMatch(/example filenames use plain names/)
    expect(text).toMatch(/eight (?:posted )?machining examples have G-code for all five dialects/i)
    expect(text).toMatch(/other parts need your own CAM or posting/)
    expect(text).not.toContain('machining examples come with their G-code already posted for each dialect')
    expect(text).toMatch(/tool storage bar drills each hole from one side, the gear profiles cut through, and the knob example combines roughing and finishing to make the saved shape/)
    // WO-2622 (07eddcca0) also posted the nested kit sheet (09) in all five
    // dialects. Check the entire inventory, including that deliberate addition.
    const posts = readdirSync(join(root, 'examples/gcode')).filter(name => name.endsWith('.nc'))
    expect(posts).toHaveLength(45)
    for (let part = 1; part <= 9; part++) {
      const prefix = `${String(part).padStart(2, '0')}-`
      expect(posts.filter(name => name.startsWith(prefix))).toHaveLength(5)
    }
  })
})

describe('WO-2613 venue-specific announcement accuracy', () => {
  it.each(['w2-reddit-hobbycnc', 'w3-show-hn'])('%s separates UCCNC desktop control from browser Web Serial', name => {
    const text = announcement(name)
    expect(text).toMatch(/Full Suite.*first/)
    expect(text).toMatch(/UCCNC machine control needs the Windows desktop/)
    expect(text).toMatch(/GRBL and grblHAL can connect over Web Serial in Chrome or Edge, but are not hardware-verified/)
    expect(text).not.toMatch(/Everything works in the browser except driving a real machine|desktop build \(Electron, Windows\) adds real machine control/)
  })

  it('links the short profile draft directly to the demo and its first example', () => {
    const text = announcement('w1-printables-makerworld')
    const demo = read('README.md').match(/\[Try it in your browser\]\((https:\/\/[^\s)]+)\)/)?.[1]
    expect(demo).toBeDefined()
    expect(text).toContain(`Try Full Suite, the first example, in your browser, nothing to install: ${demo}`)
  })

  it('gives UCCNC users explicit M0, M6 and restart behavior', () => {
    const text = announcement('w2-cncdrive-uccnc-forum')
    expect(text).toContain('Every explicit M0 holds the program; the UCCNC post adds no redundant M0 after T# M6.')
    expect(text).toContain('From line and Plan restart a posted setup at its original file line; Stop program at a tool-change card ends the job.')
  })

  it('describes the LinuxCNC card and probing controls with its hardware caveat intact', () => {
    const text = announcement('w2-linuxcnc-forum')
    expect(text).toContain('The tool-change card shows when LinuxCNC is waiting for a tool; Stop program at the card ends the job.')
    expect(text).toContain('Probing-screen Pause, Resume and Stop act on probing only, leaving the loaded program in place.')
    expect(text).toContain('only been tested against the LinuxCNC simulator, not on real hardware')
  })

  it('describes grblHAL executing-move feedback and probing isolation while preserving experimental status', () => {
    const text = announcement('w2-grblhal-discussions')
    expect(text).toContain('The G-code line and 3D view follow the executing move; probing-screen Pause, Resume and Stop act on probing only, leaving the loaded program in place.')
    expect(text).toContain('this route is experimental until people with real machines confirm it')
  })
})

// the operator 2:36 PM 10-07: the trimmed release notes keep the starter-kit line.
describe('release notes name the starter kit', () => {
  it('says the examples folder holds the 13 example parts', () => {
    expect(read('docs/release/notes-0.36.0-alpha.1.md')).toMatch(/\*\*The starter kit:\*\* 13 example parts in the `examples` folder/)
  })
})
