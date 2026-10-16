// WO UI-6Y: resize an existing recognized hole by typing its new ABSOLUTE
// diameter.
//
// WO UI-58 (Operator verdict, T-UI5-PUSHPULL-RESIZE step 3): "Resize hole uses a
// fucking modal ... Start pulling this stuff into interactive workspace
// selectors." The PRIMARY flow is now an in-viewport armed pick (hover
// whole-hole highlight, click select, anchored on-screen value entry --
// SolidsWorkbenchPage.tsx's resizeHolePickMode + AnchoredValueEntry). This
// component is DEMOTED to a SUPPLEMENT: a plain list reachable from the armed
// hint, across every live body, whose row click is a click-select (same
// effect as clicking the hole in the viewport) -- never the first thing the
// user sees, never a second apply path. It owns no diameter/apply UI of its
// own any more; the anchored entry is the one and only apply surface.

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import type { FeatureClass, FeatureVerdict } from '../../../geom/geom-service'
import { DialogShell } from './DialogShell'

export const RESIZE_HOLE_CLASSES = ['throughHole', 'blindHole', 'counterboreStack'] as const satisfies readonly FeatureClass[]

export type ResizeHoleClass = (typeof RESIZE_HOLE_CLASSES)[number]

export interface ResizeHoleCandidate {
  featureKey: string
  featureClass: ResizeHoleClass
  currentDiameter: number
  disabledReason?: string
}

const RESIZE_HOLE_CLASS_SET = new Set<FeatureClass>(RESIZE_HOLE_CLASSES)

export const CLASS_LABEL: Record<ResizeHoleClass, string> = {
  get throughHole() { return workbenchText('ResizeHoleDialog.throughHole') },
  get blindHole() { return workbenchText('ResizeHoleDialog.blindHole') },
  get counterboreStack() { return workbenchText('ResizeHoleDialog.counterbore') },
}

/** Refusal reason for one verdict, or undefined if it is a clean resize
 *  candidate. The ONE predicate shared by every consumer of a recognizeFeatures
 *  result on this WO's feature (the viewport hover/click matcher in
 *  SolidsWorkbenchPage, this file's own list builder, and their tests) so a
 *  hover match and a list row can never disagree about eligibility. */
function resizeHoleDisabledReason(verdict: FeatureVerdict): string | undefined {
  if (!RESIZE_HOLE_CLASS_SET.has(verdict.featureClass)) return workbenchText('ResizeHoleDialog.notARecognizedHole')
  if (!verdict.removable) return verdict.refuseReason ?? workbenchText('ResizeHoleDialog.theGeometryEngineRefusedThisHoleWithoutNamingA')
  const measured = verdict.params.diameter
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) {
    return workbenchText('ResizeHoleDialog.theRecognizedHoleHasNoFinitePositiveDiameter')
  }
  return undefined
}

/** Every verdict this WO's resize surface (viewport pick OR supplement list)
 *  will ever match against, filtered down to RESIZE_HOLE_CLASSES + a clean
 *  (non-refused, finite positive diameter) verdict.removable rule exactly as
 *  the picker used to filter. Returns the RAW FeatureVerdict (faceIds intact)
 *  -- the viewport hover/click matcher needs faceIds to paint the whole
 *  feature and to resolve a picked StableId back to its owning hole; the list
 *  below derives its lighter-weight ResizeHoleCandidate DTO from this same
 *  set so the two surfaces can never drift apart on eligibility. */
export function eligibleResizeHoleVerdicts(verdicts: FeatureVerdict[]): FeatureVerdict[] {
  return verdicts.filter((verdict) => RESIZE_HOLE_CLASS_SET.has(verdict.featureClass) && resizeHoleDisabledReason(verdict) === undefined)
}

/** BK-174: `featureKey`'s doc comment claims "identical geometry -> identical
 *  key", but the engine's own hole-key builder (geom-engine's defeature.ts,
 *  `hole:${x}:${y}:${z}:${dirx}:${diry}:${dirz}:${round(minR,3)}`) bakes the
 *  RADIUS into the key's trailing segment -- so resizing a hole changes its
 *  OWN featureKey. A stored key from BEFORE a resize can therefore never
 *  string-match a fresh recognition of the SAME (now different-diameter)
 *  hole. FeatureTree Edit needs to re-find "the same hole" across exactly
 *  that size change, so it compares every segment EXCEPT the last
 *  (position + axis, which a diameter change never moves) instead of the
 *  whole key. Two genuinely distinct holes sharing the same center and axis
 *  is not a real-world case this comparison needs to guard against. */
export function sameHoleLocation(keyA: string, keyB: string): boolean {
  const dropLast = (key: string): string => key.split(':').slice(0, -1).join(':')
  return dropLast(keyA) === dropLast(keyB)
}

/** WO-2795: two hole keys (`hole:x:y:z:dx:dy:dz:r`) on the SAME axis line,
 *  whichever end each was measured from and whichever way each points. A
 *  resize may rebuild the wall from the hole's other end, so the live key
 *  can differ from the stored one in origin and sign as well as radius. */
export function sameHoleAxis(keyA: string, keyB: string): boolean {
  const parse = (key: string): number[] | undefined => {
    const parts = key.split(':')
    if (parts.length !== 8 || parts[0] !== 'hole') return undefined
    const nums = parts.slice(1, 7).map(Number)
    return nums.every(Number.isFinite) ? nums : undefined
  }
  const a = parse(keyA)
  const b = parse(keyB)
  if (a === undefined || b === undefined) return false
  const [ax, ay, az, adx, ady, adz] = a
  const [bx, by, bz, bdx, bdy, bdz] = b
  const la = Math.hypot(adx, ady, adz)
  const lb = Math.hypot(bdx, bdy, bdz)
  if (la === 0 || lb === 0) return false
  if (Math.abs(Math.abs(adx * bdx + ady * bdy + adz * bdz) / (la * lb) - 1) > 1e-4) return false
  const [ux, uy, uz] = [adx / la, ady / la, adz / la]
  const [wx, wy, wz] = [bx - ax, by - ay, bz - az]
  return Math.hypot(wy * uz - wz * uy, wz * ux - wx * uz, wx * uy - wy * ux) < 1e-2
}

/** The one derivation used by both the dialog and its census tests. Filtering
 * here makes it impossible for a later broad recognizeFeatures result to leak
 * pocket/boss/fillet rows into this picker. Every refused verdict remains
 * visible but disabled; its engine-provided refuseReason is its title. */
export function resizeHoleCandidates(verdicts: FeatureVerdict[]): ResizeHoleCandidate[] {
  return verdicts
    .filter((verdict): verdict is FeatureVerdict & { featureClass: ResizeHoleClass } => RESIZE_HOLE_CLASS_SET.has(verdict.featureClass))
    .map((verdict) => {
      const measured = verdict.params.diameter
      const currentDiameter = typeof measured === 'number' ? measured : Number.NaN
      const disabledReason = resizeHoleDisabledReason(verdict)
      return {
        featureKey: verdict.featureKey,
        featureClass: verdict.featureClass,
        currentDiameter,
        ...(disabledReason === undefined ? {} : { disabledReason }),
      }
    })
}

export interface ResizeHoleApplyRequest {
  featureKey: string
  currentDiameter: number
  newDiameter: number
  delta: number
}

export interface ResizeHoleFeaturePayload extends Record<string, unknown> {
  opType: 'resizeHole'
  ownerId: string
  featureKey: string
  currentDiameter: number
  newDiameter: number
  delta: number
  name: string
  /** WO-2762: 'counterbore' = this edit changes the counterbore step alone
   *  (currentDiameter/newDiameter and any depth are the counterbore's); absent
   *  = the hole's pilot, as before. */
  holeStep?: 'counterbore'
}

export type ResizeDiameterValidation =
  | { ok: true; newDiameter: number; delta: number }
  | { ok: false; reason: string }

/** Strict draft validation. Number(), rather than parseFloat(), refuses partial
 * strings such as "8mm"; the finite guard independently closes Infinity/NaN's
 * comparison holes before the signed delta reaches history or the engine. */
export function validateResizeDiameter(draft: string, currentDiameter: number): ResizeDiameterValidation {
  if (draft.trim() === '') return { ok: false, reason: workbenchText('ResizeHoleDialog.enterANewDiameter') }
  const newDiameter = Number(draft)
  if (!Number.isFinite(newDiameter)) return { ok: false, reason: workbenchText('ResizeHoleDialog.newDiameterMustBeAFiniteNumber') }
  if (newDiameter <= 0) return { ok: false, reason: workbenchText('ResizeHoleDialog.newDiameterMustBeGreaterThan0Mm') }
  if (!Number.isFinite(currentDiameter) || currentDiameter <= 0) {
    return { ok: false, reason: workbenchText('ResizeHoleDialog.currentDiameterIsNotAFinitePositiveNumber') }
  }
  const delta = newDiameter - currentDiameter
  if (!Number.isFinite(delta)) return { ok: false, reason: workbenchText('ResizeHoleDialog.computedDiameterDeltaIsNotFinite') }
  if (Math.abs(delta) <= 1e-9) return { ok: false, reason: workbenchText('ResizeHoleDialog.newDiameterMustDifferFromTheCurrentDiameter') }
  return { ok: true, newDiameter, delta }
}

/** WO-2091 / WO-2117: a depth draft - mm, or "through"/"thru". The number
 *  checks are the resize-diameter ones (finite, > 0, different from now). */
export function validateHoleDepth(
  draft: string,
  currentDepth: number,
  currentThrough: boolean,
): { ok: true; newDepth: number | 'through'; delta: number } | { ok: false; reason: string } {
  const wantsThrough = /^\s*(?:through|thru)\s*$/i.test(draft)
  if (wantsThrough && !currentThrough) return { ok: true, newDepth: 'through', delta: 0 }
  const v = validateResizeDiameter(wantsThrough ? String(currentDepth) : draft, currentDepth)
  if (v.ok) return { ok: true, newDepth: v.newDiameter, delta: v.delta }
  return { ok: false, reason: v.reason.replace(/diameter/g, 'depth') }
}

export function formatMm(value: number): string {
  return Number.isFinite(value) ? workbenchText('ResizeHoleDialog.mm2', { value1: String(Number(value.toFixed(6))) }) : 'unreadable'
}

export function formatSignedMm(value: number): string {
  if (!Number.isFinite(value)) return 'unreadable'
  const rounded = Number(value.toFixed(6))
  return workbenchText('ResizeHoleDialog.mm', { value1: String(rounded > 0 ? '+' : ''), value2: String(rounded) })
}

// ---- Supplement list (WO UI-58: demoted from the primary flow) ------------

export interface ResizeHoleListRow {
  ownerId: string
  ownerLabel: string
  featureKey: string
  featureClass: ResizeHoleClass
  currentDiameter: number
  disabledReason?: string
}

/** Flattens a per-body verdict set (the SAME cache the armed viewport pick
 *  reads) into one cross-body row list, each row labeled with its owning
 *  body -- the supplement's whole reason to exist is reaching a hole on a
 *  body the user has not orbited to yet. */
export function buildResizeHoleListRows(bodies: Array<{ ownerId: string; ownerLabel: string; verdicts: FeatureVerdict[] }>): ResizeHoleListRow[] {
  const rows: ResizeHoleListRow[] = []
  for (const body of bodies) {
    for (const candidate of resizeHoleCandidates(body.verdicts)) {
      rows.push({ ownerId: body.ownerId, ownerLabel: body.ownerLabel, ...candidate })
    }
  }
  return rows
}

export interface ResizeHoleDialogProps {
  rows: ResizeHoleListRow[]
  /** A row click IS a click-select -- same effect as clicking the hole in the
   *  viewport (arms the anchored value entry on it). This component never
   *  applies anything itself. */
  onSelect(row: ResizeHoleListRow): void
  onClose(): void
}

export function ResizeHoleDialog({ rows, onSelect, onClose }: ResizeHoleDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  return (
    <DialogShell
      title={workbenchText('ResizeHoleDialog.recognizedHoles')}
      onApply={onClose}
      onCancel={onClose}
      applyLabel={workbenchText('ResizeHoleDialog.close')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          {workbenchText('ResizeHoleDialog.clickAHoleToSelectItSameAsClicking')}</div>
        <div role="radiogroup" aria-label={workbenchText('ResizeHoleDialog.recognizedHoles')} data-testid="resize-hole-picker" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((row, index) => {
            const disabled = row.disabledReason !== undefined
            return (
              <button
                key={`${row.ownerId}:${row.featureKey}`}
                type="button"
                role="radio"
                aria-checked={false}
                data-testid={`resize-hole-option-${index}`}
                data-owner-id={row.ownerId}
                data-feature-class={row.featureClass}
                data-feature-key={row.featureKey}
                data-current-diameter={Number.isFinite(row.currentDiameter) ? String(row.currentDiameter) : 'invalid'}
                disabled={disabled}
                data-tooltip={row.disabledReason}
                className="modal-btn modal-btn-ghost"
                style={{
                  width: '100%',
                  minHeight: 28,
                  justifyContent: 'space-between',
                  textAlign: 'left',
                  background: 'var(--surface-input)',
                  borderColor: 'var(--border-subtle)',
                  color: disabled ? 'var(--text-disabled)' : 'var(--text-secondary)',
                }}
                onClick={() => {
                  if (disabled) return
                  onSelect(row)
                }}
              >
                {/* WO-1493 (BUG-451): the feature class and diameter are the
                    operator-actionable part of this row, so they never give
                    way -- reordered class-first and both flex-shrink: 0. The
                    long, caller-supplied owner label is the free-text side:
                    min-width: 0 lets it shrink, and its own overflow/ellipsis
                    truncates it instead of pushing the class or diameter off. */}
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
                  <span style={{ flexShrink: 0 }}>{CLASS_LABEL[row.featureClass]}</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                    {row.ownerLabel}
                  </span>
                </span>
                <span style={{ flexShrink: 0, marginLeft: 8, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatMm(row.currentDiameter)}
                </span>
              </button>
            )
          })}
          {rows.length === 0 && (
            <div data-testid="resize-hole-picker-empty" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
              {workbenchText('ResizeHoleDialog.noRecognizedThroughBlindOrCounterboreHolesOnAny')}</div>
          )}
        </div>
      </div>
    </DialogShell>
  )
}
