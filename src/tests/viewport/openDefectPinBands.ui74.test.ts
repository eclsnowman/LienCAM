// WO UI-74-R3 item 3 -- the OPEN-DEFECT-UI-76 pin's per-corner band table.
//
// The R3 audit's finding, verbatim: "OPEN-DEFECT-UI-76 does not enforce AM4's
// bounded measurements in both directions. The code treats each two-number entry
// as an outer containment envelope (min >= lower and max <= upper), so inward
// movement is always accepted while the surface remains clipped. That contradicts
// the bound rule that an improvement outside the +/-2 mm measurement tolerance
// makes the pin stale and red."
//
// Its evidence, verbatim: "datum:XZ is based on measured corners 75.27..164.73
// with +/-2 mm. A still-clipped improvement to 75.27..160.00 remains beyond the
// live far plane 157.42 but passes line 1334 because 75.27 >= 73.27 and 160.00 <=
// 166.73. Check 10 only requires a clipped inBand hit, so it also passes. The
// banked M7 proof moves the interval outward; no mutation exercises the required
// inward direction."
//
// That exact counter-example is the row named "the R3 audit's own counter-example"
// below, and it was GREEN against the pre-fix envelope (inBand === true) and is
// RED here. Every other row states the verdict in BOTH directions, because a
// table that only ever asserts PASS is the envelope bug in test form.
//
// Why this table is the item-3 artifact rather than a live census mutation: the
// census cannot run this round at all -- R3 item 4 binds AM1's literal walk,
// which fires AM1's own installed:false/STOP-DECISIONS clause on three 0.184 (see
// tools/diag/ui74-r3-am1-walk-probe.mjs and the round report). The band rule is
// still real, still bound, and still had to be corrected; extracting it to
// tools/capture/lib/ui74-open-defect-pins.mjs is what lets it be proved by
// something other than the mechanism that is currently stopped.

import { describe, it, expect } from 'vitest'
import { OPEN_DEFECT_PINS, evalPinBands } from '../support/ui74-open-defect-pins.mjs'

const PIN = OPEN_DEFECT_PINS.find(p => p.id === 'OPEN-DEFECT-UI-76')!

// The live slab the pinned surfaces are clipped against, from the audit's clean
// real-GPU run. Rows that claim "still clipped" are checked against it below so
// the table cannot drift into describing a surface that is actually inside.
const SLAB = { near: 68.01, far: 157.42 }

type Row = {
  what: string
  id: string
  min: number
  max: number
  inBand: boolean
  /** substring the drift message must contain -- a refusal that does not say
   *  WHICH way the pin moved cannot be acted on. */
  says?: string
}

const ROWS: Row[] = [
  // ── the measured truth: the pin describes exactly this, so exactly this passes
  { what: 'datum:XZ exactly as measured by the audit', id: 'datum:XZ', min: 75.27, max: 164.73, inBand: true },
  { what: 'datum:YZ exactly as measured by the audit', id: 'datum:YZ', min: 73.68, max: 166.32, inBand: true },

  // ── inside tolerance, both corners, both directions: still the same defect
  { what: 'datum:XZ drifting 1.9mm outward (inside tolerance)', id: 'datum:XZ', min: 73.37, max: 166.63, inBand: true },
  { what: 'datum:XZ drifting 1.9mm inward (inside tolerance)', id: 'datum:XZ', min: 77.17, max: 162.83, inBand: true },
  { what: 'datum:YZ drifting 1.9mm outward (inside tolerance)', id: 'datum:YZ', min: 71.78, max: 168.22, inBand: true },
  { what: 'datum:YZ drifting 1.9mm inward (inside tolerance)', id: 'datum:YZ', min: 75.58, max: 164.42, inBand: true },

  // ── THE R3 AUDIT'S OWN COUNTER-EXAMPLE. Green against R2's envelope, red here.
  {
    what: "the R3 audit's own counter-example: datum:XZ improved to 75.27..160.00, STILL CLIPPED",
    id: 'datum:XZ', min: 75.27, max: 160.00, inBand: false, says: 'IMPROVED',
  },

  // ── the inward direction on the other corner and the other id
  { what: 'datum:XZ near corner improved inward by >2mm', id: 'datum:XZ', min: 79.50, max: 164.73, inBand: false, says: 'IMPROVED' },
  { what: 'datum:YZ far corner improved inward by >2mm', id: 'datum:YZ', min: 73.68, max: 161.00, inBand: false, says: 'IMPROVED' },

  // ── the outward direction: the defect getting worse must still fail (this is
  //    the only direction R2's envelope caught, and it must not regress)
  { what: 'datum:XZ far corner worsened outward by >2mm', id: 'datum:XZ', min: 75.27, max: 170.00, inBand: false, says: 'WORSENED' },
  { what: 'datum:XZ near corner worsened outward by >2mm', id: 'datum:XZ', min: 70.00, max: 164.73, inBand: false, says: 'WORSENED' },
  { what: 'datum:YZ far corner worsened outward by >2mm', id: 'datum:YZ', min: 73.68, max: 172.00, inBand: false, says: 'WORSENED' },

  // ── charter 3: a NaN corner must be REFUSED, not slide through a comparison
  { what: 'a NON-FINITE far corner', id: 'datum:XZ', min: 75.27, max: NaN, inBand: false, says: 'NON-FINITE' },
  { what: 'a NON-FINITE near corner', id: 'datum:YZ', min: NaN, max: 166.32, inBand: false, says: 'NON-FINITE' },
]

describe('OPEN-DEFECT-UI-76: per-corner bands, both directions (R3 item 3, correcting AM4)', () => {
  it('pins exactly the two adjudicated genesis ids, and nothing else', () => {
    expect(PIN.ids).toEqual(['datum:XZ', 'datum:YZ'])
    expect(PIN.identify({ genesisNodeId: 'datum:XZ' })).toBe(true)
    expect(PIN.identify({ genesisNodeId: 'datum:YZ' })).toBe(true)
    // (d) "any OTHER clipped surface, any new genesis root ... turns the census RED"
    expect(PIN.identify({ genesisNodeId: 'datum:XY' })).toBe(false)
    expect(PIN.identify({ genesisNodeId: 'some:new:root' })).toBe(false)
    expect(PIN.identify({ genesisNodeId: undefined })).toBe(false)
  })

  it('carries the bands the R3 contract bound, to the number', () => {
    // Bound verbatim by R3 required-shape item 3. If someone widens a band, this
    // row is the thing that says so.
    expect(PIN.bands['datum:XZ']).toEqual({ min: [73.27, 77.27], max: [162.73, 166.73] })
    expect(PIN.bands['datum:YZ']).toEqual({ min: [71.68, 75.68], max: [164.32, 168.32] })
  })

  it('is labelled as an open defect on a board row, never as a knownGap', () => {
    expect(PIN.id).toBe('OPEN-DEFECT-UI-76')
    expect(PIN.board).toContain('UI-76')
    expect(JSON.stringify(PIN)).not.toMatch(/knownGap/i)
  })

  for (const row of ROWS) {
    it(`${row.inBand ? 'ACCEPTS' : 'REFUSES'}: ${row.what}`, () => {
      const v = evalPinBands(PIN, row.id, row.min, row.max)
      expect(v.inBand).toBe(row.inBand)
      if (row.inBand) {
        expect(v.drift).toEqual([])
      } else {
        expect(v.drift.length).toBeGreaterThan(0)
        expect(v.drift.join(' ; ')).toContain(row.says!)
      }
    })
  }

  it("the audit's counter-example is genuinely STILL CLIPPED -- the row is not a strawman", () => {
    // The whole force of the finding is that 160.00 is an improvement that is
    // still a defect. If it were inside the slab, refusing it would be wrong.
    expect(160.0).toBeGreaterThan(SLAB.far)
    const v = evalPinBands(PIN, 'datum:XZ', 75.27, 160.0)
    expect(v.inBand).toBe(false)
    expect(v.drift.join(' ; ')).toContain('STALE')
  })

  it("R2's outer envelope would have ACCEPTED the counter-example -- this is what regressed", () => {
    // The exact pre-fix predicate, reconstructed from the audit's citation of
    // line 1334: `min >= band[0] && max <= band[1]` over the old envelope
    // datum:XZ [73.27, 166.73]. Keeping it here means the fix cannot be quietly
    // reverted to something equivalent without this row going red.
    const oldEnvelope = [73.27, 166.73]
    const oldVerdict = 75.27 >= oldEnvelope[0] && 160.0 <= oldEnvelope[1]
    expect(oldVerdict).toBe(true)                                   // R2: green
    expect(evalPinBands(PIN, 'datum:XZ', 75.27, 160.0).inBand).toBe(false)  // R3: red
  })

  it('refuses a pinned id the pin declares no band for', () => {
    const bandless = { ...PIN, bands: {} as Record<string, never> }
    const v = evalPinBands(bandless, 'datum:XZ', 75.27, 164.73)
    expect(v.inBand).toBe(false)
    expect(v.drift.join(' ')).toContain('NO BAND')
  })
})
