import { type MachineSkew } from '../../../types'
import { type MachineConfig } from '../../../types'
import { machineSkew } from '../../../types'
import { formatSkewOffset } from '../../../types'


// ---------------------------------------------------------------------------
// GANTRY SKEW (WO-996) - the MEASUREMENT, and nothing that acts on it.
//
// Operator, 2026-08-25 at the machine: "We still do not have a software skew
// compensation that I can see in the Control->Machine->Definitions area."
// So it is here, where he went looking.
//
// THREE THINGS THIS SECTION IS BUILT NOT TO DO:
//
//  1. NOT IMPLY A CORRECTION. Nothing in LienCAM reads this number yet. The
//     sentence saying so is RENDERED, not a tooltip - a claim that the machine
//     is being corrected when it is not is the worst thing this surface could
//     say, and hover is not where truth lives.
//  2. NOT INVENT A MEASUREMENT. Unset is unset: the box is EMPTY rather than
//     zeroed, the reading beside it says "Not measured" in words, and an
//     unusable edit writes NOTHING to the record. A typed `0` is a different
//     thing entirely and is kept - that is somebody saying "I cut a square and
//     it was square".
//  3. NOT OFFER A SECOND WAY TO SAY THE SAME THING. ONE BOX, ONE STORED
//     VALUE. Two earlier attempts built a test-square entry, a second
//     representation and a selector between them, and both were failed at
//     audit inside that switching - an impossible edit deleted a saved
//     measurement, then switching back resurrected a superseded one. A later
//     measurement aid writes THIS field rather than creating another stored
//     representation.
//
//     THE FORM IS ALWAYS OPEN, with no "measure this" press in front of it. An
//     empty box says "nobody has put a number here" as plainly as a button
//     would and costs the same one row. Emptying it again is how a measurement
//     is taken back off - there is no separate clear verb to keep in step.
// ---------------------------------------------------------------------------

/**
 * WHAT THE BOX MEANS FOR THE RECORD - and there are THREE answers, not two.
 *
 * THE BUG THIS TYPE EXISTS TO MAKE UNSPELLABLE. Attempt 1 asked one question,
 * "does this box prove a skew", and treated every no as an instruction to take
 * the key off. So a saved measurement - somebody cut a square, measured it and
 * typed the result in - was DESTROYED by one stray keystroke. The audit failed
 * it on that line and was right.
 *
 * `cleared` and `refused` are not the same answer and never were:
 *
 *   cleared   THE BOX IS EMPTY. A person emptied it, which is this surface's
 *             only way of saying "take that measurement back off". An
 *             instruction, and it is obeyed.
 *   measured  the box holds a signed offset distance. It is written, and it
 *             REPLACES whatever was there - nothing keeps a copy of the old
 *             one, so nothing can resurrect it.
 *   refused   THE BOX IS NEITHER. A word where a number goes is NOT AN
 *             INSTRUCTION - it is somebody mid-keystroke, and the record is
 *             left exactly as it was.
 *
 * The mirror of the rule the rest of this work has run on. "Never render a
 * value you do not have" has a twin: NEVER DISCARD A VALUE YOU DO. A skew is a
 * MEASURED MACHINE FACT and a typo is not an argument against it.
 */
export type SkewVerdict =
  | { kind: 'cleared' }
  | { kind: 'measured'; skew: MachineSkew }
  | { kind: 'refused'; why: string }

/** What the box tells the record to do. Reasons are in WORDS because they are
 *  rendered - a refusal nobody can read is a field that silently ignores
 *  typing, which is its own kind of lie. */
export function readSkewBox(text: string): SkewVerdict {
  const trimmed = text.trim()
  // EMPTY IS NULL AND NEVER 0 - that distinction is the whole point of the
  // field, and `Number('')` is 0, so the empty case is answered before any
  // parse gets the chance to invent a measured square gantry.
  if (trimmed === '') return { kind: 'cleared' }
  const offsetMm = Number(trimmed)
  // A distance has no natural plausibility ceiling here. Axis back-off and
  // remaining travel bound it at the bridge, so every finite measurement is
  // stored rather than grading a machine this app cannot inspect.
  if (!Number.isFinite(offsetMm)) {
    return { kind: 'refused', why: 'That is not a number, so the saved skew is kept.' }
  }
  return { kind: 'measured', skew: { offsetMm } }
}

/** Put a skew on a machine, or TAKE THE KEY OFF ENTIRELY when there is none.
 *  Not `skew: undefined` and not `skew: null`: a record that never had a skew
 *  set must be indistinguishable from one this code has never touched, or
 *  "unset" quietly becomes two different things and the negative control -
 *  save, reload, no skew invented - stops meaning anything. */
export function withSkew(m: MachineConfig, skew: MachineSkew | null): MachineConfig {
  if (skew !== null) return { ...m, skew }
  if (!('skew' in m)) return m
  const next = { ...m }
  delete next.skew
  return next
}

/** THE SENTENCE THAT MUST NOT BE A LIE, and WO-1050 moved it onto the field.
 *
 *  WO-996 rendered these words as a paragraph over the tabs, because a surface
 *  implying the machine is being corrected when it is not is worse than no
 *  surface at all. Operator, 2026-08-27, on what that paragraph cost: *"gantry skew
 *  is a stupid place driving everything down."*
 *
 *  So the words are unchanged and they are still ATTACHED TO THE CONTROL - as
 *  its hover, which is how every other value on this page states its
 *  provenance - and the claim itself stays in RENDERED text beside the box as
 *  `not applied`, whenever there is a measurement for the claim to be about.
 *  Nothing here got quieter about what this software does not do. It stopped
 *  costing a full-width band to say it.
 */
export const SKEW_NOT_APPLIED =
  'Signed offset distance measured for the slaved gantry pair; the sign records the '
  + 'required direction. Nothing corrects for it yet - toolpaths, jogs and probing all '
  + 'run uncorrected, and Apply does not send it to the controller. It is written down '
  + 'here so the number exists before anything uses it.'

/**
 * THE SKEW FIELD. One small labelled box, and after WO-1050 it sits on the row
 * of the axis it is about instead of in a band above the tabs.
 *
 * Operator ruling 2026-08-27: *"skew should be a small value next to the axis which is
 * slaved, in Travel & Homing. Just a simple value field."* It is a per-axis
 * fact about a slaved pair, so it is grouped with that axis - which is the one
 * constraint he named on this whole order: *"we just need to keep the grouping
 * logical by setting types."*
 *
 * WHAT DID NOT MOVE IS THE FIELD CONTRACT WO-996 LANDED, and none of it is
 * restated here because none of it changed: one box and one stored value, with
 * no second entry surface to switch between; an empty box is unset and renders
 * empty rather than `0`; a typed `0` is a measured square gantry and is kept;
 * a word where a number goes is REFUSED, says so in words, and leaves the
 * saved measurement exactly where it was. See `SkewVerdict` and `withSkew`
 * above. THE SURFACE MOVED; THE RECORD DID NOT.
 *
 * THE TYPED TEXT BELONGS TO THE PANEL, NOT TO THIS COMPONENT (WO-1050). It used
 * to be held here behind a mount key, which was safe while the field sat
 * outside the tabs where nothing but a machine switch or a Revert could unmount
 * it. On an axis row inside Travel & Homing it unmounts every time somebody
 * looks at Motion, and a half-typed measurement vanishing on a tab click is
 * exactly the silently-swallowed keystroke this field exists not to do.
 */
export function SkewField({ machine, typed, onTyped, onChange, standalone = false }: {
  machine: MachineConfig
  /** What is in the box as typed. `null` means "nobody has typed here since
   *  the panel opened on this machine", and then the box shows THE RECORD - so
   *  a skew saved elsewhere appears here with nothing to synchronise. */
  typed: string | null
  onTyped: (next: string | null) => void
  onChange: (mut: (m: MachineConfig) => MachineConfig) => void
  /** Rendered on its own rather than inside an axis row's cell, in which case
   *  it carries its own name. Two call sites, and both are machines with no
   *  slaved-axis row to sit on: one with a definition that declares no gantry
   *  pairing, one with no controller definition at all. */
  standalone?: boolean
}) {
  const stored = machineSkew(machine)
  const shown = typed ?? (stored ? String(stored.offsetMm) : '')
  const verdict = readSkewBox(shown)

  /** THE ONE PLACE THE RECORD IS TOUCHED, and a refusal never reaches it. */
  const write = (next: string) => {
    onTyped(next)
    const nextVerdict = readSkewBox(next)
    if (nextVerdict.kind === 'refused') {
      // THE RECORD IS LEFT EXACTLY AS IT WAS. But there is now unsaved typing
      // on screen, and a Revert button greyed out as "no unsaved changes" over
      // a box with a typo in it is its own small lie - and it is the only way
      // to get the typo back off in one press. An IDENTITY mutation says "an
      // edit is in progress" without the edit touching a single value.
      onChange((m) => m)
      return
    }
    onChange((m) => withSkew(m, nextVerdict.kind === 'measured' ? nextVerdict.skew : null))
  }

  return (
    <div data-testid="machine-def-skew-section" data-skew-set={stored ? '' : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {/* ONE BOX. Empty means unset and renders empty - never `0`. The whole
            explanation of what this number is, and of what nothing does with
            it, hangs off this label. */}
        <label
          data-not-applied=""
          data-testid="machine-def-skew-not-applied"
          data-tooltip={SKEW_NOT_APPLIED}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
          }}
        >
          {standalone && <span style={{ flex: 'none' }}>Gantry skew</span>}
          <input
            className="mform-input mform-input-mono"
            type="text"
            inputMode="decimal"
            aria-label="Gantry skew offset in millimetres"
            data-testid="machine-def-skew-offset"
            value={shown}
            placeholder="unset"
            onChange={(e) => write(e.target.value)}
            style={{ flex: 'none', width: 78 }}
          />
          <span style={{ flex: 'none' }}>mm</span>
        </label>

        {/* THE STATUS OF THE RECORD, IN WORDS, always rendered - and note that
            it reads the RECORD, not the box. An empty form says "Not measured"
            because that is what the machine holds. A REFUSED form over a saved
            measurement says the saved number, because that is ALSO what the
            machine holds: the refusal did not touch it, and a reading that
            flickered to "Not measured" while a typo sat in the box would be
            telling the operator his measurement was gone at the exact moment
            the whole point is that it is not. */}
        <span
          data-testid="machine-def-skew-stored"
          className="mform-input-mono"
          style={{
            fontSize: 'var(--font-size-sm)',
            color: stored ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          {stored ? formatSkewOffset(stored.offsetMm) : 'Not measured'}
        </span>

        {/* AND THE CLAIM ITSELF, STILL IN RENDERED TEXT. Somebody looking at a
            measured skew reads that nothing acts on it without hovering
            anything. There is nothing to say when there is no measurement. */}
        {stored !== null && (
          <span
            data-testid="machine-def-skew-not-applied-mark"
            style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
          >
            not applied
          </span>
        )}
      </div>

      {/* WHY THE TYPING DID NOT TAKE. A field that quietly ignores keystrokes
          is its own kind of lie, so the refusal is RENDERED and says both what
          is wrong and what happened to the stored value. `role="status"` so a
          screen reader hears it without the focus leaving the box being typed
          into. */}
      {verdict.kind === 'refused' && (
        <div
          data-testid="machine-def-skew-refused"
          role="status"
          style={{
            marginTop: 4,
            fontSize: 'var(--font-size-sm)',
            color: 'var(--warning)',
          }}
        >
          {verdict.why}
        </div>
      )}
    </div>
  )
}
