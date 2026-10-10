import { type AxisName } from '../../../types'
import { DEFAULT_HOMING_ORDER } from '../../../types'
import { UCCNC_SETTING_FIELDS } from '../../../lib/machine/uccncProfileImport'
import { type ControllerDefinition } from '../../../types'
import { type PinRef } from '../../../types'
import { isPinAssigned } from '../../../types'
import { controllerSettingValue } from '../../../types'
import { withControllerSetting } from '../../../types'
import { definitionStatesKey } from '../../../types'
import { NumericInput } from '../../ui/NumericInput'
import { type ControllerSettingField } from '../../../types'
import { type ControllerType } from '../../../types'
import { type ControllerSettingValue } from '../../../types'
import { withUccncCataloguedSetting } from '../../../lib/machine/uccncProfileImport'
import { type UnsentSetting } from '../../../types'
import { formatUccncSettingValue } from '../../../lib/machine/uccncProfileImport'
import { parseUccncSettingValue } from '../../../lib/machine/uccncProfileImport'
import { axisDriveAppKey } from '../../../lib/machine/uccncProfileImport'
import { uccncCatalogueRefusal } from '../../../lib/machine/uccncProfileImport'
import { memo } from 'react'


// ---------------------------------------------------------------------------
// Small parts. Deliberately local rather than lifted out of MachineLibraryModal
// - that file is not this lane's to edit, and a panel that cannot be rendered
// without a modal is not self-contained.
// ---------------------------------------------------------------------------

/** Only X/Y/Z carry an axis colour token; A/B/C render in the default tier. */
export function axisColorVar(axis: AxisName): string | undefined {
  return axis === 'X' || axis === 'Y' || axis === 'Z'
    ? `var(--${axis.toLowerCase()}-axis)`
    : undefined
}

/** Put a newly enabled axis where the SAFE order would put it - Z, then X,
 *  then Y, then anything else. Appending blindly lets a re-enabled Z home
 *  LAST, which is the one order that can drive a tool through the work on its
 *  way to a switch. */
export function insertIntoHomingOrder(order: AxisName[], axis: AxisName): AxisName[] {
  if (order.includes(axis)) return order
  const rank = (a: AxisName): number => {
    const i = DEFAULT_HOMING_ORDER.indexOf(a)
    return i === -1 ? DEFAULT_HOMING_ORDER.length : i
  }
  const at = order.findIndex((a) => rank(a) > rank(axis))
  return at === -1
    ? [...order, axis]
    : [...order.slice(0, at), axis, ...order.slice(at)]
}

/** One port or pin box. Whole numbers only; EMPTY MEANS UNASSIGNED (0), and
 *  unassigned renders blank rather than "port 0 pin 0". */
export function PinNumberBox({ value, onChange, ariaLabel, invalid }: {
  value: number
  onChange: (v: number) => void
  ariaLabel: string
  invalid: boolean
}) {
  return (
    <input
      className="mform-input mform-input-mono"
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={value === 0 ? '' : String(value)}
      onChange={(e) => {
        const digits = e.target.value.replace(/[^0-9]/g, '')
        onChange(digits === '' ? 0 : Number(digits))
      }}
      style={{
        flex: 'none', width: 38, textAlign: 'center',
        borderColor: invalid ? 'var(--accent-red)' : undefined,
      }}
    />
  )
}

/**
 * THE PROFILE KEY EACH NAMED FIELD CAN BE HOLDING, taken from the catalogue's
 * own `ownedBy` rather than from a second list beside it - a hand-kept table of
 * "which key belongs to which pin" is the thing that starts disagreeing with
 * the catalogue the first time a wire is added. Built once at module load
 * because the panel asks it on every pin keystroke and the catalogue is ~1680
 * entries long.
 */
export const SETTING_KEY_BY_OWNER = new Map<string, string>(
  UCCNC_SETTING_FIELDS
    .filter((field): field is typeof field & { ownedBy: string } => field.ownedBy !== null)
    .map((field) => [field.ownedBy, field.key]),
)

/** `io.probe2` / `axes[X].stepPin` -> the polarity key that triple holds, or
 *  `undefined` for a wire this controller has no polarity key for. */
export function pinPolarityKey(owner: string): string | undefined {
  return SETTING_KEY_BY_OWNER.get(`${owner}.negate`)
}

/**
 * OWNERSHIP MOVES WHEN A PIN IS ASSIGNED, AND THIS IS WHERE IT MOVES.
 *
 * THE DEFECT THIS CLOSES (audit 2026-08-27, round 3). `readPin` RELEASES an
 * unassigned pin's polarity to `settings`, because no named field can hold a
 * polarity for a wire that does not exist - so Operator's profile arrives with
 * `io.probe2 = {0, 0, null}` and `IOsetupsettings.Probepin2negate=False` in
 * `settings`. Filling in the port and pin USED to change `io` and nothing
 * else: the key stayed in `settings`, so `ownedElsewhere` kept giving the
 * generic box ownership while the triple went on rendering its own checkbox,
 * and `exportUccncProfile` - which asks `settings` FIRST - wrote the stale
 * value. The page could show Probe 2 active low and the file say active high.
 *
 * ASSIGNING A PIN IS THEREFORE A HANDOFF, and it is exactly the one the
 * IMPORTER would have made had the file been written with the wire in place:
 * the polarity goes ONTO the triple and the key comes OFF `settings`. The
 * value is CARRIED, never dropped - a profile that said `False` still says
 * `False` after the wire is filled in - and it is carried only into an UNKNOWN
 * polarity, so a person who states one themselves is not overruled by the file.
 *
 * AND THE KEY IS STILL STATED. Presence in `settings` IS a statement; taking
 * it out of `settings` would un-say it and the export would stop emitting a
 * key the profile really carries. `stated` is where a named field's provenance
 * lives, so the ref moves there in the same edit.
 */
export function claimPinPolarity(
  definition: ControllerDefinition, owner: string, pin: PinRef,
): { definition: ControllerDefinition; pin: PinRef } {
  const key = pinPolarityKey(owner)
  // An UNASSIGNED pin keeps releasing its polarity to the box: there is no
  // named field for a wire that does not exist, and hiding the box would lose
  // a value the profile really states.
  if (key === undefined || !isPinAssigned(pin)) return { definition, pin }
  const held = controllerSettingValue(definition.settings, 'uccnc', key)
  if (held === null) return { definition, pin }
  const settings = withControllerSetting(definition.settings, 'uccnc', key, null)
  const stated = definitionStatesKey({ settings, stated: definition.stated }, 'uccnc', key)
    ? definition.stated
    : [...(definition.stated ?? []), { controller: 'uccnc' as const, key }]
  return {
    definition: { ...definition, settings, stated },
    pin: pin.negate === null && held.kind === 'boolean' ? { ...pin, negate: held.value } : pin,
  }
}

/** port [ ] pin [ ] [x] negate - the only shape the UI ever shows for a pin.
 *  A validation complaint rides the field's OWN hover context and its colour;
 *  it never becomes a banner that pushes the form down.
 *  A `null` polarity - nobody has told us - renders as the checkbox's
 *  indeterminate dash, never as an unchecked box (WO-995). */
export function PinField({ label, name, testId, value, onChange, problem, polarityBox }: {
  label: string
  name: string
  testId: string
  value: PinRef
  onChange: (p: PinRef) => void
  problem?: string
  /**
   * THE KEY OF THE GENERIC BOX THAT OWNS THIS PIN'S POLARITY, when one does.
   *
   * An UNASSIGNED pin has no named field to hold a polarity in, so `readPin`
   * releases the key to `settings` and its box becomes the key's editor - and
   * the one the export follows, because `exportUccncProfile` asks `settings`
   * first. This checkbox still SHOWS the triple's own polarity, because a
   * polarity is part of a pin and hiding it would make the wire look like it
   * had none; it must not also WRITE it, or one machine fact has two editors
   * and the file quietly follows the other one (audit 2026-08-27).
   *
   * Filling in the port and pin hands the key back here - see
   * `claimPinPolarity` - and the checkbox becomes this pin's own again.
   */
  polarityBox?: string
}) {
  const negateElsewhere = polarityBox !== undefined
  return (
    <div
      data-testid={testId}
      data-wired=""
      data-tooltip={problem ?? `${name} - port, pin, negate`}
      data-pin-problem={problem === undefined ? undefined : ''}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 'var(--font-size-sm)',
        color: problem === undefined ? 'var(--text-secondary)' : 'var(--accent-red)',
      }}
    >
      {label !== '' && <span style={{ flex: 'none', width: 44 }}>{label}</span>}
      <PinNumberBox
        value={value.port} ariaLabel={`${name} port`} invalid={problem !== undefined}
        onChange={(v) => onChange({ ...value, port: v })}
      />
      <PinNumberBox
        value={value.pin} ariaLabel={`${name} pin`} invalid={problem !== undefined}
        onChange={(v) => onChange({ ...value, pin: v })}
      />
      <input
        type="checkbox"
        aria-label={`${name} negate`}
        // A pin nothing is wired to has its polarity in a box of its own, and
        // that box is what the exported file follows. Disabled rather than
        // hidden: the polarity belongs to the wire and is shown with it.
        disabled={negateElsewhere}
        data-negate-elsewhere={negateElsewhere ? '' : undefined}
        data-tooltip={negateElsewhere
          ? `Negate - this machine states this polarity as ${polarityBox}, `
            + 'which is the value the exported profile follows. Edit it in that box; '
            + 'assigning this pin hands the polarity back to this checkbox.'
          : value.negate === null
            ? 'Negate - UNKNOWN. Nobody has said whether this signal is inverted.'
            : 'Negate - the signal is active low'}
        // An unknown polarity is shown as the checkbox's INDETERMINATE dash,
        // never as an empty box: an empty box is a confident claim that the
        // pin is not inverted, and that claim about an e-stop is how someone
        // gets hurt. `indeterminate` is a DOM property with no React prop, so
        // it is written on the node itself.
        ref={(el) => { if (el) el.indeterminate = value.negate === null }}
        data-negate-unknown={value.negate === null ? '' : undefined}
        checked={value.negate === true}
        // Clicking an unknown RESOLVES it - the browser reports `checked` as
        // true for the first click on an indeterminate box - so a person
        // stating a polarity is the only thing that ever removes the unknown.
        onChange={(e) => onChange({ ...value, negate: e.target.checked })}
        style={{ margin: 0 }}
      />
    </div>
  )
}

/** A short labelled number. The definition's numbers are shown RAW, in the
 *  machine's own units, and are deliberately NOT put through the display-unit
 *  conversion the CAM half uses: these are the values a person copies off a
 *  motor spec into a controller profile, and steps/unit does not even convert
 *  in the same direction as a length. */
export function DefNumber({ label, name, value, onChange, min, step, width = 74 }: {
  label: string
  name: string
  value: number
  onChange: (v: number) => void
  min?: number
  step?: number
  width?: number
}) {
  return (
    <label
      data-wired=""
      data-tooltip={name}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
      }}
    >
      <span style={{ flex: 'none' }}>{label}</span>
      <NumericInput
        value={value} onChange={onChange} min={min} step={step} ariaLabel={name}
        className="mform-input mform-input-mono"
        style={{ flex: 'none', width }}
      />
    </label>
  )
}

/**
 * WHERE A SETTING FIELD GETS ITS VALUE AND WHERE AN EDIT GOES (WO-1039).
 *
 * ONE OBJECT INSTEAD OF ~90 THREADED ARGUMENTS. Every field on this page that
 * shows a `.pro` key used to be handed `(controller, unsentSettings)` and call
 * `unsentSettingValue` itself. That was fine while the answer was a lookup in
 * a flat text list. It is not fine now: the answer comes off the typed model,
 * an edit has to be parsed against that model's own catalogue, a half-typed
 * number has to stay on screen while it is not yet a number, and an absent key
 * has to say so somewhere. Five concerns, one seam.
 *
 * IT IS ALSO THE CONTROLLER SEAM (ADR-0042). `read` and `write` speak the
 * CONTROLLER'S OWN vocabulary and nothing above them knows whose it is: a
 * `.pro` names a setting `axessettingscontrolX.Compaccel`, GRBL numbers it
 * `$130`, and a GRBL source would be built from a GRBL catalogue and formatter
 * without one field on this page changing. The panel body builds exactly one
 * of these, for the machine it is editing.
 */
export interface SettingSource {
  /**
   * TRUE WHEN THE MACHINE ON SCREEN IS THE CONTROLLER THIS CATALOGUE DESCRIBES
   * (audit 2026-08-27, round 6), and therefore whether the `.pro` catalogue
   * exists on this page at all.
   *
   * THE DEFECT THIS CLOSES. The panel built one source pairing
   * `controller: draft.controller` - the MACHINE'S identity - with
   * `field: uccncSettingField` - UCCNC'S catalogue. So a GRBL, LinuxCNC or
   * generic machine was shown 1489 boxes for keys it does not have, and typing
   * in one stored `Generalsettings.Lookaheadlines` under that machine's own
   * identity: a UCCNC setting wearing another controller's name. That is the
   * identity-blindness WO-1024 names, on this page.
   *
   * A machine that is not this catalogue's controller sees ITS OWN fields -
   * axes, homing, pins, skew, apply - and nothing from the catalogue. Not empty
   * boxes, not a legend counting keys it does not have, not a section head over
   * an empty table: those all say "your machine states nothing here", which is
   * a claim about the machine, and the truth is that this software has nothing
   * to ask it. The day a GRBL catalogue is written it arrives as a second
   * catalogue behind this same flag and every field below it renders unchanged.
   */
  catalogued: boolean
  /** This machine's own text for the key, or null when it has not stated one.
   *  Null is ABSENCE and renders empty - never a zero this software chose. */
  read: (key: string) => string | null
  /** Did this machine state the key at all? Same question as `read() !== null`,
   *  named because several sections ask it to decide whether to draw a row. */
  has: (key: string) => boolean
  /** Does this machine state ANY key under a section prefix? A `.pro` carries
   *  a whole `[Section]` or none of it, and a table that would draw 96 empty
   *  rows for a plugin the machine does not have is worse than one that says
   *  the section is absent. */
  hasPrefix: (prefix: string) => boolean
  /** Record an edit. Empty text takes the key back OFF the definition -
   *  "states nothing here" is a different answer from "states zero". */
  write: (key: string, text: string) => void
  /** True when what is in the box is not a value this key can hold, so the box
   *  can say so without the record having taken it. */
  invalid: (key: string) => boolean
  /** Say once, in the machine console, that the profile never stated this key.
   *  On the page there is only an empty box: 1489 fields cannot each carry a
   *  sentence, and nothing new may push this layout around. */
  reportAbsent: (key: string) => void
  /** What the controller says this setting IS, when this software has a model
   *  for it - the meaning for a tooltip and the shape for a box width. */
  describe: (key: string) => ControllerSettingField | undefined
  /** TRUE WHEN APPLY AND THE BRIDGE ACT ON THIS CATALOGUED VALUE. The answer
   *  comes from the same raw-key to app-key mapping import and bridge reads;
   *  it is provenance, never a second value or capability list. */
  driven: (key: string) => boolean
  /**
   * TRUE WHEN THE VALUE ON SCREEN IS ONLY TEXT - this machine states the key,
   * and the typed model could not take it (no model for the key, or a value
   * that would not parse against the model it has). See
   * `ProfileImportResult.unsent`.
   *
   * WHY THE PAGE STILL SHOWS IT. Losing it would make an import visibly lossy,
   * which is the one thing ADR-0044 says an import may never be: a key the
   * machine really states would simply not appear, and nobody looking at the
   * page could tell that from a key the machine never stated. So it is shown,
   * as the readout WO-947 built, under `data-not-sent` - the marker that still
   * means exactly what it says. It cannot be EDITED, because an edit has to be
   * parsed against a model and there isn't one; teaching this software the key
   * is what makes it editable, and that is one catalogue entry, not a UI job.
   *
   * Operator's profile produces none of these. A `.pro` from a UCCNC version this
   * software has not been taught would.
   */
  textOnly: (key: string) => boolean
  /**
   * TRUE WHEN A NAMED FIELD ON THIS PAGE ALREADY OWNS THIS KEY, so a generic
   * box for it would be a SECOND WRITER for one machine fact.
   *
   * THE DEFECT THIS CLOSES (audit 2026-08-27). The generic
   * `IOsetupsettings.Probepin2negate` box was drawn behind
   * `read(key) !== undefined` - and `read` returns `string | null`, so the
   * guard was always true. An assigned Probe 2 therefore had TWO editable
   * polarity controls, and `exportUccncProfile` asks `settings` BEFORE the
   * named field, so the generic box silently decided the polarity the pin
   * triple was showing. One ownership check now answers it for EVERY box on
   * the page rather than one guard per call site.
   *
   * THE RULE IS THE EXPORTER'S OWN, which is what makes the surviving control
   * the one the file follows: `exportUccncProfile` asks `settings` FIRST and
   * the named field only when `settings` is silent. So a key the definition
   * carries in `settings` belongs to its box, and a key the catalogue gives an
   * owner and `settings` is NOT carrying belongs to the named field.
   *
   * BOTH HALVES ARE LOAD-BEARING. `readPin` RELEASES an unassigned pin's
   * polarity to `settings` precisely because no named field can hold one, and
   * hiding that box would lose a value the profile really states - which is
   * why the check cannot be the simpler "a key with an owner never gets a
   * box". `unsentAxisPolarityFields` has always decided the axis polarities
   * this way; this is that same rule, asked once for every box on the page
   * instead of at the call sites that remembered to ask.
   */
  ownedElsewhere: (key: string) => boolean
  /** TRUE WHEN THIS RECORD CARRIES ANY KEY THE TYPED MODEL COULD NOT TAKE -
   *  the whole-record form of `textOnly`, so the legend can say "every value
   *  is editable" only on a record where that is true. Operator's profile makes it
   *  false; a `.pro` from a UCCNC version this software has not been taught
   *  would make it true. */
  hasTextOnly: () => boolean
  /**
   * WHOSE VALUES THESE ARE - the record this source reads and writes, and the
   * ONLY thing every one of the callbacks above closes over that a comparison
   * of values cannot see.
   *
   * THE DEFECT THIS CLOSES (audit 2026-08-27, round 5). `NotSent` is memoised,
   * and its comparator asked this source about the field's label, text,
   * invalid state, text-only state and ownership - five questions about the
   * VALUE and not one about WHOSE. Two machines that agree about a key
   * therefore compared equal across a machine switch, React kept the earlier
   * render, and the `onChange` in it still wrote through the PREVIOUS
   * machine's `write` - its `patch`, its `setPending`, its record. Typing into
   * the box drawn for the second machine created the edit against the first,
   * where it sat invisible until somebody looked at that machine again.
   *
   * COMPARED BY IDENTITY, NEVER READ. It is deliberately opaque: the seam
   * stays controller-agnostic (a GRBL source would hand over its own record)
   * and `===` is the whole contract. The record OBJECT rather than its id
   * because the id is not all a callback captures - an edit built while the
   * record was replaced under the panel would be based on the old one - and
   * the object is stable under typing, which is what keeps the memo doing its
   * job: an edit in progress lives on `edit.draft`, never on the record.
   */
  owner: object

  /** WO-1263 used-only state. The legacy name is retained across the existing
   *  section API; visibility is decided by `used`, never by the stored value. */
  hideEmpty: boolean
  /** WO-1263: whether this field belongs to an explicitly hidden group and
   *  the operator has chosen to hide. */
  unused: (key: string) => boolean
}

/** How wide a value's box is, from WHAT THE SETTING IS rather than from what
 *  this machine happens to hold - a box that resizes as you type is a box that
 *  moves the row under your cursor, and this page's rule tonight is that
 *  nothing new pushes the layout around. Unmodelled keys get the text width;
 *  there is nothing else to go on. */
/** ONE STYLE OBJECT FOR ~1489 BOXES. Only the width differs, and a fresh
 *  literal per field is 1489 allocations on every render of a page that
 *  already re-renders whole. The font is inherited from the label rather than
 *  restated, which is four fewer style properties per box for the DOM to
 *  parse - measured, not guessed: it is the difference between this page
 *  mounting in a blink and in half a second. */
export const SETTING_BOX_STYLE = { flex: 'none' } as const

export function settingBoxWidth(field: ControllerSettingField | undefined): number {
  if (!field) return 130
  if (field.kind === 'tuple') return Math.min(320, 40 + 26 * (field.parts?.length ?? 1))
  if (field.kind === 'boolean') return 62
  if (field.kind === 'number') return 78
  if (field.kind === 'enum') return 118
  return 130
}

/**
 * THE HALF-TYPED VALUE PROBLEM, and why the box holds text the record does not.
 *
 * `0.03` passes through `1`, `0`, `0.` and `0.0` on its way to being typed, and
 * two of those are not the number the user is heading for while one is not a
 * number at all. If the box rendered the RECORD, every keystroke that is not
 * yet valid would be erased or silently rounded under the cursor. So the box
 * renders what was typed, and the record takes the value only when it parses.
 *
 * The pending text is keyed by setting and cleared when the edit is saved or
 * reverted, exactly like the skew box that established this pattern (WO-996).
 */
export type PendingSettings = Record<string, string>

/** THE DEFINITION WITH ONE CATALOGUED SETTING STORED, or unchanged when the
 *  store refuses it. The refusal is reported by the caller before it gets
 *  here - this is the half that makes sure a refusal cannot become a write
 *  even if some future caller forgets to ask. */
export function cataloguedPatch(
  definition: ControllerDefinition,
  controller: ControllerType,
  key: string,
  value: ControllerSettingValue | null,
): ControllerDefinition {
  const written = withUccncCataloguedSetting(definition.settings, controller, key, value)
  return written.ok ? { ...definition, settings: written.settings } : definition
}

export function createSettingSource({
  definition, unsent, controller, catalogue, field, patch, pending, setPending,
  reportAbsent, reportRefused, owner, hideEmpty, unused,
}: {
  definition: ControllerDefinition | null
  /** The keys the typed model could not take, as the controller's own text. */
  unsent: UnsentSetting[] | undefined
  /** WHAT THE MACHINE ON SCREEN IS. */
  controller: ControllerType
  /** WHOSE VOCABULARY `field` SPEAKS. Passed rather than assumed, because the
   *  bug this closes was exactly the assumption that the two are the same
   *  controller - see `SettingSource.catalogued`. */
  catalogue: ControllerType
  field: (key: string) => ControllerSettingField | undefined
  patch: (mut: (d: ControllerDefinition) => ControllerDefinition) => void
  pending: PendingSettings
  setPending: (next: (p: PendingSettings) => PendingSettings) => void
  reportAbsent: (key: string) => void
  /** Say, in the machine console, that the store would not take this key on
   *  this machine. A refused write must never be a silent one. */
  reportRefused: (key: string, reason: string) => void
  /** The record every callback below is bound to. See `SettingSource.owner`. */
  owner: object
  /** WO-1122: the hide-empty toggle. See `SettingSource.hideEmpty`. */
  hideEmpty: boolean
  /** Explicit operator choice only. Imported values carry no intent metadata,
   *  so this callback must not infer usage from whether a value is stated. */
  unused: (key: string) => boolean
}): SettingSource {
  /** The machine on screen IS this catalogue's controller. Everything below
   *  answers "nothing here" when it is not: a key from another controller's
   *  vocabulary is not absent from this machine, it is not a question this
   *  machine can be asked. */
  const catalogued = controller === catalogue
  /**
   * ONE PASS OVER THE MACHINE'S SETTINGS, NOT ONE PER BOX.
   *
   * `controllerSettingValue` walks the list, which is the right shape for a
   * caller asking about one key. This page asks about ~1489 of them on every
   * render, so the walk becomes 1489 x 1489 comparisons - measured at seconds
   * per keystroke on Operator's profile, which is a page nobody can type in.
   * Indexing once per render is the same lookup rule (`sameSettingKey` folds
   * case, so the index is keyed lower-cased) at a cost that scales with the
   * machine instead of with its square.
   */
  const index = new Map<string, ControllerSettingValue>()
  for (const setting of catalogued ? definition?.settings ?? [] : []) {
    if (setting.controller === controller) index.set(setting.key.toLowerCase(), setting.value)
  }
  const textIndex = new Map<string, string>()
  for (const setting of catalogued ? unsent ?? [] : []) {
    if (setting.controller === controller) textIndex.set(setting.key.toLowerCase(), setting.value)
  }
  const typed = (key: string): string | null => {
    const value = index.get(key.toLowerCase())
    return value === undefined ? null : formatUccncSettingValue(value)
  }
  const text = (key: string): string | null => textIndex.get(key.toLowerCase()) ?? null
  const stored = (key: string): string | null => typed(key) ?? text(key)
  const read = (key: string): string | null => (
    !catalogued ? null : key in pending ? pending[key] : stored(key)
  )
  const parseFor = (key: string, text: string): ControllerSettingValue | null => {
    const spec = field(key)
    if (!spec) return null
    const parsed = parseUccncSettingValue(spec, text)
    return parsed.ok ? parsed.value : null
  }
  return {
    owner,
    catalogued,
    hideEmpty,
    unused,
    read,
    has: (key) => read(key) !== null,
    hasPrefix: (prefix) => {
      if (!catalogued) return false
      const lower = prefix.toLowerCase()
      for (const key of index.keys()) if (key.startsWith(lower)) return true
      for (const key of textIndex.keys()) if (key.startsWith(lower)) return true
      return Object.keys(pending).some((key) => key.toLowerCase().startsWith(lower))
    },
    invalid: (key) => (
      key in pending && pending[key] !== '' && parseFor(key, pending[key]) === null
    ),
    describe: field,
    driven: (key) => axisDriveAppKey(key) !== undefined,
    // `pending` FIRST, so a box does not vanish under the cursor. Clearing a
    // released polarity takes the key off `settings`, which would hand it
    // straight back to the named field mid-keystroke; while somebody is typing
    // in a box, that box is the owner.
    ownedElsewhere: (key) => (
      !(key in pending)
      && !index.has(key.toLowerCase())
      && (field(key)?.ownedBy ?? null) !== null
    ),
    textOnly: (key) => typed(key) === null && text(key) !== null,
    hasTextOnly: () => textIndex.size > 0,
    reportAbsent,
    write: (key, text) => {
      // THE STORE ANSWERS FIRST, AND IT MAY SAY NO (audit round 6). Nothing on
      // this page can reach here on a machine that is not this catalogue's
      // controller - no box is drawn for one - but a write that arrived another
      // way must not become a setting in the wrong vocabulary, and must not
      // disappear without a word. Asked BEFORE the pending text is kept, so a
      // refused key does not sit in a box either.
      const refused = uccncCatalogueRefusal(controller, key)
      if (refused !== null) { reportRefused(key, refused); return }
      setPending((p) => ({ ...p, [key]: text }))
      if (text === '') {
        // CLEARING TAKES THE KEY BACK OFF - except that a machine which really
        // states an empty text (`Description1=` is one on Operator's profile) is
        // already showing an empty box, and re-clearing it must not un-state
        // what it said. Absence and a stated empty string are different
        // answers and this is the one place that can tell them apart.
        const current = index.get(key.toLowerCase()) ?? null
        if (current !== null && current.kind === 'text' && current.value === '') return
        patch((d) => cataloguedPatch(d, controller, key, null))
        return
      }
      const value = parseFor(key, text)
      // A value that does not parse is NOT written. The box keeps showing it,
      // `invalid` marks it, and the record keeps the last thing this machine
      // actually said - a definition must never hold something the controller
      // would not accept because somebody was mid-keystroke.
      if (value === null) return
      patch((d) => cataloguedPatch(d, controller, key, value))
    },
  }
}

/**
 * ONE SETTING THIS MACHINE CAN BE TOLD - SHOWN, EDITABLE, AND DRIVING NOTHING
 * (WO-947 built it, WO-1039 gave it a box).
 *
 * WHAT CHANGED AND WHY THE ABSENCE OF A BOX HAD TO GO. This was a readout, and
 * the missing box was its provenance: "this software read the value, shows it,
 * and cannot send it." That was honest for a year and it made
 * `tools/pro-coverage.mjs` report VISIBLE 1680 of 1680 while SENDABLE sat at
 * 191 - 100% of a measure that does not answer Operator's question. His question
 * (2026-08-26): "we have UI which can edit every UCCNC .pro field because we
 * should be able to build a full machine definition in our system from
 * scratch."
 *
 * So the value now comes off `ControllerDefinition.settings` - the typed model
 * - it is edited in place, and the edit is stored on the definition Apply
 * carries. The box is back because the field IS a control again.
 *
 * WHAT AN UNMAPPED FIELD STILL MAY NOT CLAIM, and this is the whole of the
 * remaining gap.
 * Operator's bar is PRESENT + EDIT + DRIVE FUNCTIONALITY: "if they need one of the
 * features in the other 90% and we don't present it, allow them to edit it,
 * and use it to drive functionality then the software cannot be called a UCCNC
 * replacement so we have failed." Most catalogue values still stop on the
 * definition, and `data-not-driven` says exactly that and nothing softer. A
 * field whose existing app-key mapping is consumed by the bridge instead earns
 * `data-wired`; the mapping, not this component, decides which claim is true.
 *
 * ABSENCE IS STILL ABSENCE. A key this machine never stated renders EMPTY -
 * never a zero, never a default dressed as a fact, which is the defect that
 * reached Operator's machine once already (`4dcf9701`). The reason goes to the
 * machine console the first time the field is touched rather than onto the
 * page: 1489 fields cannot each carry a sentence, and Operator's rule for this
 * page tonight was that editing happens in the fields that already exist -
 * nothing new pushing the layout around.
 *
 * CLEARING A FIELD TAKES THE KEY BACK OFF, rather than storing an empty
 * string. "The machine states nothing here" is a different answer from "the
 * machine states the empty value", and only the first one can be un-said.
 * A profile that really carries `Description1=` states an empty TEXT, and that
 * round-trips as one because the model knows the key is text.
 */
/** `True`/`False`/`1`/`0`, case-insensitively - the only spellings a checkbox
 *  needs to read back, whichever controller wrote them. */
function isUccncTrue(text: string): boolean {
  const lower = text.toLowerCase()
  return lower === 'true' || lower === '1'
}

const invalidStyle = (invalid: boolean, width: number): React.CSSProperties => (
  invalid
    ? { ...SETTING_BOX_STYLE, width, borderColor: 'var(--accent-red)' }
    : { ...SETTING_BOX_STYLE, width }
)

export function SettingBox({ label, settingKey, settings }: {
  label: string
  /** NOT named `key`: React consumes a prop called `key` as a list key and it
   *  would never reach this component. */
  settingKey: string
  settings: SettingSource
}) {
  // NOT THIS MACHINE'S VOCABULARY, so there is no box and no readout - see
  // `SettingSource.catalogued`. Here for the same reason the ownership check
  // below is: one place, ahead of all ~90 call sites.
  if (!settings.catalogued) return null
  // THE ONE OWNERSHIP CHECK, and it is here rather than at ~90 call sites
  // because that is what stops the next one: a key a named field already owns
  // gets NO box here, whichever section asked for it.
  if (settings.ownedElsewhere(settingKey)) return null
  const value = settings.read(settingKey)
  const stated = value !== null
  const field = settings.describe(settingKey)
  const invalid = settings.invalid(settingKey)
  const width = settingBoxWidth(field)
  // A capability is wired only when this definition states a value for it.
  // Absence remains absence: there is no invented value for Apply to send.
  const driven = stated && settings.driven(settingKey)
  if (settings.textOnly(settingKey)) {
    // THE ORIGINAL WO-947 READOUT, still here for the keys it was built for:
    // shown, marked as unsendable by the ABSENCE OF A BOX, and not editable
    // because there is no model to parse an edit against. See
    // `SettingSource.textOnly`.
    return (
      <span
        data-not-sent=""
        data-testid={`machine-def-setting-${settingKey}`}
        data-tooltip={`${settingKey} - read from this machine's profile. This software `
          + 'has no model for it, so it is shown but cannot be edited or sent.'}
        style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 5,
          fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)',
        }}
      >
        {label !== '' && <span style={{ flex: 'none' }}>{label}</span>}
        <span className="mform-input-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </span>
      </span>
    )
  }
  const onFocusAbsent = () => { if (!stated) settings.reportAbsent(settingKey) }
  // WO-1684 - A SETTING DRAWS AS ITS KIND, not as one universal text box:
  // COHESION-STANDARD s18, "A yes/no setting is a toggle or checkbox; a
  // choice among named values is a dropdown ... A number is a number field
  // with its unit." The write path is unchanged either way - every control
  // below still calls `settings.write(key, text)`, which parses the text
  // against the same catalogue field and refuses or stores exactly as it did
  // when the box was text.
  let control: React.ReactNode
  if (field?.kind === 'boolean') {
    control = (
      <input
        type="checkbox"
        aria-label={settingKey}
        // Carries the machine's own text as the checkbox's `value` attribute
        // (not read by the browser for anything `checked` decides) so a
        // reader asking this control for its value - as every proCoverage
        // suite already does - keeps seeing the controller's own spelling.
        value={value ?? ''}
        checked={stated && isUccncTrue(value)}
        // A key nobody has stated is UNKNOWN, never a confident "off" - the
        // same rule `PinField`'s negate checkbox already carries (WO-995).
        ref={(el) => { if (el) el.indeterminate = !stated }}
        onFocus={onFocusAbsent}
        onChange={(e) => settings.write(settingKey, e.target.checked ? 'True' : 'False')}
        style={{ margin: 0 }}
      />
    )
  } else if (field?.kind === 'enum') {
    const options = field.options ?? []
    control = (
      <select
        aria-label={settingKey}
        aria-invalid={invalid || undefined}
        value={value ?? ''}
        onFocus={onFocusAbsent}
        onChange={(e) => settings.write(settingKey, e.target.value)}
        style={invalidStyle(invalid, width)}
      >
        {!stated && <option value="" />}
        {/* An unlisted member is CARRIED, not refused (parseUccncSettingValue) -
            a newer controller may write a value this catalogue's `options`
            does not know, and the select must offer it rather than silently
            swap in whichever option sorts first. */}
        {stated && !options.includes(value) && <option value={value}>{value}</option>}
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    )
  } else if (field?.kind === 'number') {
    control = (
      <>
        <input
          className="mform-input mform-input-mono"
          // type="text" + inputMode="decimal" (not type="number"), matching
          // NumericInput: a native number input SILENTLY DISCARDS anything
          // that does not parse (jsdom and every browser alike), which is
          // exactly the half-typed / invalid text this page has to keep on
          // screen - "not a number" must survive long enough for aria-invalid
          // and the not-accepted count to say so (WO-996's rule, reasserted
          // here because a plain `type="number"` box cannot honor it).
          type="text"
          inputMode="decimal"
          aria-label={settingKey}
          aria-invalid={invalid || undefined}
          value={value ?? ''}
          onFocus={onFocusAbsent}
          onChange={(e) => settings.write(settingKey, e.target.value)}
          style={invalidStyle(invalid, width)}
        />
        {field.unit !== 'none' && (
          // data-setting-unit: a static label naming the CONTROLLER's unit
          // (e.g. "units/sec^2"), never a value this software chose - marked
          // so a reader checking for an invented number can tell this text
          // apart from the box's own value (WO-947's rule; the unit's own
          // spelling may contain a digit that is not one).
          <span
            data-setting-unit=""
            style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
          >
            {field.unit}
          </span>
        )}
      </>
    )
  } else if (field?.kind === 'tuple') {
    control = (
      <TupleParts
        settingKey={settingKey} settings={settings} field={field} value={value}
        invalid={invalid} width={width} stated={stated} onFocusAbsent={onFocusAbsent}
      />
    )
  } else {
    // Text, or a key with no catalogue model at all: the original one-box
    // editor, unchanged.
    control = (
      <input
        className="mform-input mform-input-mono"
        type="text"
        aria-label={settingKey}
        aria-invalid={invalid || undefined}
        value={value ?? ''}
        onFocus={onFocusAbsent}
        onChange={(e) => { settings.write(settingKey, e.target.value) }}
        style={invalidStyle(invalid, width)}
      />
    )
  }
  return (
    // A SPAN, NOT A LABEL, and the input's `aria-label` is what names it. 1465
    // extra `<label>` elements make every accessible-name query on this page
    // O(page) - measured at seconds on the from-scratch round trip - and buy
    // nothing a person can see: the box is already beside its own text.
    //
    // data-setting-empty (WO-1122): written on EVERY absent box, toggle on or
    // off. The CSS puts it away only in the hiding state; the box itself, its
    // testid and its provenance marker stay in the DOM either way, so the
    // coverage suites read the same page in both states and toggling off is
    // one attribute removed rather than a reconstruction.
    <span
      data-wired={driven ? '' : undefined}
      data-not-driven={driven ? undefined : ''}
      data-setting-empty={stated ? undefined : ''}
      data-setting-unused={settings.unused(settingKey) ? '' : undefined}
      data-testid={`machine-def-setting-${settingKey}`}
      data-tooltip={`${settingKey}${field ? ` - ${field.meaning}` : ''} - ${stated
        ? 'stored with this machine definition and editable here; '
          + (driven
            ? 'Apply sends it to the bridge and the bridge drives the controller with it.'
            : 'nothing in this software drives it yet.')
        : 'not in your profile. This machine has stated no value for it.'}`}
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 5,
        fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)',
      }}
    >
      {label !== '' && <span style={{ flex: 'none' }}>{label}</span>}
      {control}
    </span>
  )
}

/**
 * A `tuple`-kind setting's own boxes - one per NAMED part, in order, plus one
 * shared text box for whatever UNNAMED parts remain (WO-1684 outcome 1). Each
 * named part draws by ITS OWN kind exactly as a scalar setting would; an
 * unnamed part has no meaning to draw by; see `UnnamedSlot`.
 *
 * A tuple whose stored text does not split into exactly as many pieces as the
 * catalogue has parts - which real UCCNC text never does, but a hand-edited
 * or half-typed record could - falls back to the one whole-string box rather
 * than guess at a mapping.
 */
function TupleParts({ settingKey, settings, field, value, invalid, width, stated, onFocusAbsent }: {
  settingKey: string
  settings: SettingSource
  field: ControllerSettingField
  value: string | null
  invalid: boolean
  width: number
  stated: boolean
  onFocusAbsent: () => void
}) {
  const parts = field.parts ?? []
  const pieces = value === null ? parts.map(() => '') : value.split(',')
  if (pieces.length !== parts.length) {
    return (
      <input
        className="mform-input mform-input-mono"
        type="text"
        aria-label={settingKey}
        aria-invalid={invalid || undefined}
        value={value ?? ''}
        onFocus={onFocusAbsent}
        onChange={(e) => settings.write(settingKey, e.target.value)}
        style={invalidStyle(invalid, width)}
      />
    )
  }
  const writeAt = (index: number, text: string) => {
    const next = [...pieces]
    next[index] = text
    settings.write(settingKey, next.join(','))
  }
  const unnamedIndexes = parts
    .map((part, index) => (part.named ? -1 : index))
    .filter((index) => index !== -1)
  return (
    <>
      {parts.map((part, index) => {
        if (!part.named) return null
        const raw = pieces[index]
        const partLabel = `${settingKey} - ${part.meaning}`
        const boxStyle: React.CSSProperties = {
          ...SETTING_BOX_STYLE,
          width: part.kind === 'boolean' ? undefined : 62,
        }
        if (part.kind === 'boolean') {
          return (
            <input
              key={index}
              type="checkbox"
              aria-label={partLabel}
              data-tooltip={part.meaning}
              value={raw}
              checked={stated && isUccncTrue(raw)}
              // Unstated is UNKNOWN, never a confident "off" - same rule as the
              // scalar boolean branch above (WO-995).
              ref={(el) => { if (el) el.indeterminate = !stated }}
              onFocus={onFocusAbsent}
              onChange={(e) => writeAt(index, e.target.checked ? 'True' : 'False')}
              style={{ margin: 0 }}
            />
          )
        }
        if (part.kind === 'enum') {
          const options = part.options ?? []
          return (
            <select
              key={index}
              aria-label={partLabel}
              data-tooltip={part.meaning}
              value={raw}
              onFocus={onFocusAbsent}
              onChange={(e) => writeAt(index, e.target.value)}
              style={boxStyle}
            >
              {!stated && <option value="" />}
              {stated && !options.includes(raw) && <option value={raw}>{raw}</option>}
              {options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          )
        }
        return (
          <input
            key={index}
            className="mform-input mform-input-mono"
            // type="text" + inputMode="decimal", not type="number" - see the
            // scalar number branch above for why a native number input cannot
            // be used here either.
            type="text"
            inputMode={part.kind === 'number' ? 'decimal' : undefined}
            aria-label={partLabel}
            data-tooltip={part.meaning}
            value={raw}
            onFocus={onFocusAbsent}
            onChange={(e) => writeAt(index, e.target.value)}
            style={boxStyle}
          />
        )
      })}
      {unnamedIndexes.length > 0 && (
        <input
          className="mform-input mform-input-mono"
          type="text"
          aria-label={settingKey}
          aria-invalid={invalid || undefined}
          data-tooltip={'unnamed values - the controller\'s own position and type are known, '
            + 'their meaning is not established (see UnnamedSlot)'}
          value={stated ? unnamedIndexes.map((index) => pieces[index]).join(',') : ''}
          onFocus={onFocusAbsent}
          onChange={(e) => {
            const typed = e.target.value.split(',')
            const next = [...pieces]
            unnamedIndexes.forEach((index, position) => { next[index] = typed[position] ?? '' })
            settings.write(settingKey, next.join(','))
          }}
          style={invalidStyle(invalid, width)}
        />
      )}
    </>
  )
}

/**
 * ONE RE-RENDER PER FIELD THAT ACTUALLY CHANGED.
 *
 * A page holding ~1489 of these re-renders all of them whenever anything on it
 * is typed, because every edit goes through one draft. React reconciling 1489
 * inputs per keystroke is measurable; comparing 1489 strings is not. The
 * comparator asks the SOURCE rather than comparing props, because the source
 * object is rebuilt each render by design (it closes over the draft) and its
 * identity therefore says nothing about whether this field's value moved.
 *
 * Kept under the old name so the ~90 call sites below read unchanged; the
 * component they name is now an editor.
 *
 * AND IT ASKS WHOSE VALUE IT IS, FIRST (audit 2026-08-27, round 5). Every
 * question below is about the VALUE, and a kept render keeps its `onChange`
 * with it - so on a switch between two machines that AGREE about a key, the
 * box drawn for the second machine went on writing to the first. `owner` is
 * the record the source is bound to and it is compared by identity; it is
 * stable under a keystroke (an edit in progress lives on `edit.draft`, never
 * on the record), so this costs one full re-render on a machine switch, a
 * Save or a re-import, and nothing at all while somebody is typing.
 */
export const NotSent = memo(SettingBox, (before, after) => (
  before.settings.owner === after.settings.owner
  && before.settings.catalogued === after.settings.catalogued
  && before.settings.hideEmpty === after.settings.hideEmpty
  && before.settings.unused(before.settingKey) === after.settings.unused(after.settingKey)
  && before.label === after.label
  && before.settingKey === after.settingKey
  && before.settings.read(before.settingKey) === after.settings.read(after.settingKey)
  && before.settings.invalid(before.settingKey) === after.settings.invalid(after.settingKey)
  && before.settings.textOnly(before.settingKey) === after.settings.textOnly(after.settingKey)
  && before.settings.driven(before.settingKey) === after.settings.driven(after.settingKey)
  && before.settings.ownedElsewhere(before.settingKey)
    === after.settings.ownedElsewhere(after.settingKey)
))

/** The one sentence that names the convention on this tab, rendered ONCE per
 *  tab rather than once per field. A fact is shown once (WO-414 R7/R36), and
 *  the per-field truth is already carried by the treatment itself. It COUNTS
 *  NOTHING on purpose: `tools/pro-coverage.mjs` is this project's coverage
 *  instrument, and a second number beside it would be a second thing to keep
 *  honest and the first thing to drift.
 *
 *  `unmodelled` is why the headline sentence is conditional rather than flat.
 *  "Every value on this page is editable" is true of Operator's profile and of any
 *  record this software can model whole - but a `.pro` from a UCCNC version we
 *  have not been taught puts unmodelled keys on the page as boxless readouts,
 *  and the flat sentence would then be the page telling the user something it
 *  can see is false. */
export function NotSentLegend({
  testId,
  settings,
  includeBoxedApplyClaim = true,
  unmodelled = false,
  notAccepted = 0,
}: {
  testId: string
  /** The source whose catalogue this sentence is describing. A machine that is
   *  not this catalogue's controller has no page of catalogued boxes to
   *  describe, and "every value on this page is editable" over its own named
   *  fields would be a sentence about a page that is not there. */
  settings: SettingSource
  includeBoxedApplyClaim?: boolean
  unmodelled?: boolean
  /** How many boxes are holding text this machine's record REFUSED. Said here
   *  because this sentence is the one place per tab that already talks about
   *  what the boxes mean, and Operator's rule for this page (2026-08-26T23:55Z) is
   *  that nothing NEW pushes the layout around. It appears only while there is
   *  something to say, and it disappears the moment the text parses or goes. */
  notAccepted?: number
}) {
  if (!settings.catalogued) return null
  return (
    <div
      data-testid={testId}
      style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 6 }}
    >
      {unmodelled
        ? 'Every value on this page that has a box is editable and is stored with this '
          + 'machine definition. A value shown without a box is one this software has no '
          + 'model for, so it is kept as your profile wrote it and cannot be edited.'
        : 'Every value on this page is editable and is stored with this machine '
          + 'definition.'}
      {/* THIS SENTENCE WAS FALSE ON Operator'S OWN MACHINE, 2026-08-29. His
          LienCNCV2.pro states Stopatangle=89, Constantvelocitymode=True,
          Linearerror=0.03, Cornerserror=0.03, Lookaheadlines=300 and
          USBbuffersize=0.1 - checked in the file - and the Trajectory planner
          section showed all six blank while this line told him his profile had
          not stated them. An empty box means THIS RECORD does not carry the
          value, which is a different claim: a record imported before a field
          was modelled has nothing in it no matter what the .pro says. Do not
          put a claim about his file behind a fact about our record. */}
      {' '}An empty box means this machine record does not carry that value - which
      may be because your profile did not state it, or because the record was
      imported before this software read that setting.
      {includeBoxedApplyClaim && ' Nothing outside the named axis, homing and'
        + ' pin fields is driven by this software yet - it is kept, not acted on.'}
      {notAccepted > 0 && (
        <>
          {' '}
          <span
            data-testid={`${testId}-not-accepted`}
            role="status"
            style={{ color: 'var(--warning)' }}
          >
            {notAccepted} value{notAccepted === 1 ? '' : 's'} not accepted -
            {notAccepted === 1 ? ' it is' : ' they are'} not saved and
            {notAccepted === 1 ? ' it belongs' : ' they belong'} to this machine only.
          </span>
        </>
      )}
    </div>
  )
}

/**
 * THE PROVENANCES A CONTROL ON THIS PAGE MAY CLAIM. Exactly one each, and the
 * list is closed - a fifth needs the same argument these four had.
 *
 *   data-wired        Apply writes this value to the controller, and the
 *                     bridge acts on it (WO-947).
 *   data-not-driven   STORED WITH THIS MACHINE DEFINITION, EDITABLE HERE, AND
 *                     NOTHING READS IT BACK OUT (WO-1039). Apply carries it -
 *                     it is on the definition, and the definition is what goes
 *                     over the wire - but no code in this software or in the
 *                     bridge turns it into machine behaviour. That is the
 *                     honest name for 1489 of Operator's 1680 keys today, and it
 *                     is deliberately not `data-wired`: Operator's bar is present
 *                     + edit + DRIVE, and this marker is the two of three this
 *                     page delivers. Each capability group earns `data-wired`
 *                     by being driven, one group at a time.
 *   data-not-sent     read from this machine's profile, shown, and this
 *                     software cannot send it to the controller AT ALL - the
 *                     key has no model, so it is not on the definition and
 *                     Apply has nothing to carry. Operator's profile produces none
 *                     of these; a `.pro` from a UCCNC version we have not
 *                     modelled would.
 *   data-not-applied  LIENCAM'S OWN measurement about this machine, stored
 *                     with it, and nothing acts on it yet (WO-996). NOT the
 *                     same claim as the two above: those are about a value the
 *                     CONTROLLER has a setting for, this one is about a value
 *                     that has no controller setting to be put in - no
 *                     controller has a skew setting - and is waiting on OUR
 *                     transform.
 *   data-drives-this-app
 *                     LIENCAM'S OWN record of what this machine HAS, stored
 *                     with it, ACTED ON HERE AND NOW, and never sent anywhere
 *                     (WO-965). The fifth marker, and it took the argument the
 *                     other four took: it is the exact complement of
 *                     `data-not-applied`. That one is a value nothing acts on
 *                     yet; this one is a value something acts on already -
 *                     immediately, in this software's own surface - while
 *                     still having no controller setting to be put in and no
 *                     prospect of ever getting one. No controller has a
 *                     register that means "this machine has a mist tank".
 *                     Marking it `data-not-applied` would understate it (the
 *                     buttons really do disappear), `data-not-driven` would be
 *                     false twice over (it is read back out, and Apply does
 *                     not carry it), and `data-wired` would be the flat lie
 *                     that this reaches the board. Present + edit + DRIVE, all
 *                     three, which is Operator's own bar - and the one place on
 *                     this page that currently meets it.
 */
export const PROVENANCE_MARKERS = [
  '[data-wired]', '[data-not-sent]', '[data-not-applied]', '[data-not-driven]',
  '[data-drives-this-app]',
] as const

/**
 * EVERY VALUE CONTROL IN A SETTINGS GROUP THAT CLAIMS NO PROVENANCE.
 *
 * THE POINT OF THIS ORDER IN ONE FUNCTION. A field on this page says which of
 * the three things above it is, and THERE IS NO FOURTH STATE. The way that
 * stops being true is not malice - it is somebody adding a field in six
 * months and not knowing the rule. So the rule is checked over the RENDERED
 * DOM rather than trusted, the way WO-939's coverage test is total over the
 * record's keys.
 *
 * Exported so a test can prove it BITES - inject an unmarked control, watch
 * this return it, remove it, watch it empty. A guard nobody has watched fail
 * is one of the six instruments that lied on 2026-08-23.
 *
 * Ancestor-OR-SELF, because a `<select>` carries its own marker while the two
 * boxes of a pin triple share their wrapper's.
 */
export function unmarkedControlsIn(root: ParentNode): Element[] {
  const controls = [...root.querySelectorAll('input, select, textarea')]
  return controls.filter((el) => el.closest(PROVENANCE_MARKERS.join(', ')) === null)
}

/** Controls that claim MORE THAN ONE provenance - a contradiction rather than
 *  a gap, and impossible to see by eye, so it gets its own reading. */
export function doublyMarkedControlsIn(root: ParentNode): Element[] {
  const controls = [...root.querySelectorAll('input, select, textarea')]
  return controls.filter((el) =>
    PROVENANCE_MARKERS.filter((sel) => el.closest(sel) !== null).length > 1)
}

/** Section heading. A page, not a modal - the sections are OPEN, because the
 *  whole complaint being answered is content hidden behind a scroll. */
export function SectionHead({ title, summary, testId }: {
  title: string
  summary: string
  testId: string
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        borderBottom: '1px solid var(--border-subtle)',
        paddingBottom: 3, marginBottom: 6,
      }}
    >
      <span style={{
        fontSize: 'var(--font-size-sm)', fontWeight: 600,
        letterSpacing: '0.04em', textTransform: 'uppercase',
        color: 'var(--text-primary)',
      }}>
        {title}
      </span>
      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
        {summary}
      </span>
    </div>
  )
}

/**
 * WO-1263 - THE PIECES EVERY BOXED SECTION USES FOR THE USED-ONLY VIEW.
 *
 *   [data-setting-unused] written by `SettingBox` on generic catalog fields
 *                         in a group the operator classified as unused.
 *   [data-row-empty]      a table row whose cells are ALL unused.
 *   [data-section-empty]  a whole boxed block whose fields are all unused.
 *                         The block is put away by CSS and the section shows
 *                         its heading plus a `SectionNoneSet` count, because a
 *                         section that vanished entirely would teach Operator it
 *                         does not exist.
 *
 * A key outside the controller vocabulary was never a row here; named
 * hardware is handled by its dedicated controls and is not filtered here.
 */

/** The full keys a section's field list draws, under its `.pro` section. */
export function sectionKeys(
  fields: readonly (readonly [string, string])[],
  section: string,
): string[] {
  return fields.map(([, key]) => `${section}.${key}`)
}

/** The keys of this list a box is actually drawn for - `SettingBox` returns
 *  null for a key a named field owns, so the collapse question is asked only
 *  of what the block really draws. */
export function drawnKeys(settings: SettingSource, keys: readonly string[]): string[] {
  return keys.filter((key) => !settings.ownedElsewhere(key))
}

/** The count line an all-unused generic section collapses to. */
export function SectionNoneSet({ testId, settings, keys, noun }: {
  testId: string
  settings: SettingSource
  keys: readonly string[]
  noun: string
}) {
  if (!settings.hideEmpty) return null
  const drawn = drawnKeys(settings, keys)
  if (drawn.length === 0) return null
  if (drawn.some((key) => !settings.unused(key))) return null
  return (
    <div
      data-testid={testId}
      className="machine-def-none-set"
      data-tooltip={'The operator classified this catalog group as unused for this '
        + 'machine. Show everything, or include the group, to restore every box.'}
    >
      {drawn.length} unused {noun}
    </div>
  )
}

/** The props that put a boxed block away when every generic field is unused. */
export function emptyMarked(
  settings: SettingSource,
  keys: readonly string[],
): { 'data-section-empty': string | undefined } {
  if (!settings.hideEmpty) return { 'data-section-empty': undefined }
  const drawn = drawnKeys(settings, keys)
  const allEmpty = drawn.length > 0 && drawn.every((key) => settings.unused(key))
  return { 'data-section-empty': allEmpty ? '' : undefined }
}

/** The props that put one table row away when all of its cells are absent. */
export function rowEmptyMarked(
  settings: SettingSource,
  keys: readonly string[],
): { 'data-row-empty': string | undefined } {
  if (!settings.hideEmpty) return { 'data-row-empty': undefined }
  const drawn = drawnKeys(settings, keys)
  const allEmpty = drawn.length > 0 && drawn.every((key) => settings.unused(key))
  return { 'data-row-empty': allEmpty ? '' : undefined }
}
