import { textFor, useText } from '../../i18n'
const words = textFor('setup-stock-tools-machine-post')
// WO-2172 (workholding assemblies, slice 2): the Properties-panel screens for a
// vise - MAKE one from two workholding bodies, and SET ITS OPENING.
//
// Make: the selected workholding body is the fixed body; the operator picks
// the moving jaw (any other workholding body not already in a vise), the way
// the jaw moves as the vise opens (a signed axis of the jaw, or its clamping
// face picked in the viewport - it opens away from that face), the travel,
// and the opening the jaw sits at now.
// Nothing moves when the vise is made (lib/workholding/vise.ts buildVise).
//
// Opening: typed in the display unit, stored in mm through
// setWorkholdingJointValue, which keeps it within the travel and returns the
// value it used - the field then shows THAT value (80 on a 0-60 vise reads 60).
// No refusal, warning or disabled control anywhere (rule 11).
//
// WO-2190 (slice 4): Close on part - pick a part and a clearance; one click
// sets the opening to the part's width across the jaw plus the clearance
// (lib/workholding/closeOnPart.ts), written through the same
// setWorkholdingJointValue the Opening field uses: one undo step, saved like a
// typed opening. One-shot: later part edits leave the opening alone. The
// console line says what it set, and how far from touching when the part does
// not fit the travel.
//
// WO-2198 (slice 6): Place another and Export (./WorkholdingReuse.tsx). The
// panel shows whichever placed vise is selected - one definition placed twice
// is two vises here, each with its own opening.

import { useEffect, useRef, useState } from 'react'
import { Anchor, Minimize2, MousePointer2, Trash2 } from 'lucide-react'
import { useCamStore } from '../../store'
import type { ImportedGeometry, Units, Vec3 } from '../../types'
import { fmtDim, fromDisplay, unitLabel } from '../../lib/ui/unitFormat'
import {
  defaultViseSlideAxis, viseOpening, workholdingComponentGeometryIds,
  type ViseJawAxis, type ViseMembership, type ViseSlide,
} from '../../lib/workholding/vise'
import { closeOnPart, closeOnPartCandidates, closeOnPartMessage } from '../../lib/workholding/closeOnPart'
import { ExportWorkholdingButton, PlaceAnotherButton } from './WorkholdingReuse'

interface SeatFacePickLike { geoId: string; point: Vec3; normal: Vec3 }
type VpHandle = {
  enterSeatFacePickMode?: (
    geoIds: readonly string[],
    onPick: (pick: SeatFacePickLike) => void,
    onHover?: ((pick: SeatFacePickLike | null) => void) | null,
  ) => void
  exitSeatFacePickMode?: () => void
}
const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

function fmtLength(valueMm: number, units: Units): string {
  return parseFloat(fmtDim(valueMm, units, units === 'inch' ? 4 : 3)).toString()
}

/** A length typed in the display unit. `onCommit` receives mm and may return
 *  the mm value actually used, which the field then shows. */
export function LengthField({
  valueMm, units, onCommit, testId, ariaLabel,
}: {
  valueMm: number
  units: Units
  onCommit: (mm: number) => number | null | void
  testId: string
  ariaLabel: string
}) {
  const [draft, setDraft] = useState(() => fmtLength(valueMm, units))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(fmtLength(valueMm, units))
  }, [valueMm, units])
  const commit = (text: string) => {
    const n = parseFloat(text)
    if (!Number.isFinite(n)) { setDraft(fmtLength(valueMm, units)); return }
    const used = onCommit(fromDisplay(n, units))
    setDraft(fmtLength(typeof used === 'number' ? used : fromDisplay(n, units), units))
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      className="props-number-input"
      data-testid={testId}
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => { focused.current = true; e.currentTarget.select() }}
      onBlur={(e) => { focused.current = false; commit(e.currentTarget.value) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(fmtLength(valueMm, units))
          focused.current = false
          e.currentTarget.value = fmtLength(valueMm, units)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** Workholding bodies a vise can be made with besides `fixedId`: marked, and not already in a vise. */
export function viseJawCandidates(
  geometry: readonly ImportedGeometry[],
  used: ReadonlySet<string>,
  fixedId: string,
): ImportedGeometry[] {
  return geometry.filter((g) => g.workholding === true && g.id !== fixedId && !used.has(g.id))
}

type SlideChoice = ViseJawAxis | 'picked'

const jawAxisLabels = (): ReadonlyArray<[ViseJawAxis, string]> => [
  ['x', words("ViseEditor.jaw_x")], ['-x', words("ViseEditor.jaw_x_2")], ['y', words("ViseEditor.jaw_y")], ['-y', words("ViseEditor.jaw_y_2")], ['z', words("ViseEditor.jaw_z")], ['-z', words("ViseEditor.jaw_z_2")],
]

// ---- Make a vise ----
export function MakeViseForm({ fixedGeo, onDone }: { fixedGeo: ImportedGeometry; onDone: () => void }) {
  const words = useText('setup-stock-tools-machine-post')
  const units = useCamStore((s) => s.appSettings.displayUnits)
  const geometry = useCamStore((s) => s.project.geometry)
  const workholding = useCamStore((s) => s.project.workholding)
  const activeSetupId = useCamStore((s) => s.project.activeSetupId)
  const makeVise = useCamStore((s) => s.makeVise)
  const candidates = viseJawCandidates(geometry, workholdingComponentGeometryIds(workholding), fixedGeo.id)

  const [jawId, setJawId] = useState(candidates[0]?.id ?? '')
  const [slide, setSlide] = useState<SlideChoice>(() =>
    candidates[0] ? defaultViseSlideAxis(useCamStore.getState().project, fixedGeo.id, candidates[0].id) : 'x')
  const [picked, setPicked] = useState<Vec3 | null>(null)
  const [picking, setPicking] = useState(false)
  const [name, setName] = useState<string>(words("ViseEditor.vise"))
  const [minMm, setMinMm] = useState(0)
  const [maxMm, setMaxMm] = useState(100)
  const [openingMm, setOpeningMm] = useState(0)

  // Face picking lives only while armed; closing the form disarms it.
  useEffect(() => {
    if (!picking || !jawId) return
    const vp = getVp()
    if (!vp?.enterSeatFacePickMode) return
    vp.enterSeatFacePickMode([jawId], (pick) => {
      setPicked({ ...pick.normal })
      setSlide('picked')
      setPicking(false)
    })
    return () => { vp.exitSeatFacePickMode?.() }
  }, [picking, jawId])

  const canPickFace = typeof getVp()?.enterSeatFacePickMode === 'function'

  if (candidates.length === 0) {
    return (
      <div className="props-group" data-testid="make-vise-form">
        <div className="props-value" style={{ whiteSpace: 'normal', textAlign: 'left' }}>{words("ViseEditor.a_vise_is_made_from_two_workholding")}</div>
      </div>
    )
  }

  const chooseJaw = (id: string) => {
    setJawId(id)
    setPicked(null)
    setPicking(false)
    setSlide(defaultViseSlideAxis(useCamStore.getState().project, fixedGeo.id, id))
  }

  const make = () => {
    const slideInput: ViseSlide = slide === 'picked' && picked
      ? { kind: 'clamping-face', normal: picked }
      : { kind: 'jaw-axis', axis: slide === 'picked' ? 'x' : slide }
    const id = makeVise({
      name, fixedGeometryId: fixedGeo.id, jawGeometryId: jawId, slide: slideInput,
      minMm, maxMm, openingNowMm: openingMm, setupId: activeSetupId ?? null,
    })
    if (id) onDone()
  }

  const u = unitLabel(units)
  return (
    <div data-testid="make-vise-form" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="props-group">
        <div className="props-label">{words("ViseEditor.name")}</div>
        <div className="props-value">
          <input
            className="props-text-input"
            data-testid="make-vise-name"
            aria-label={words("ViseEditor.vise_name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      <div className="props-group">
        <div className="props-label" data-tooltip={words("ViseEditor.the_body_that_stays_put")}>{words("ViseEditor.fixed_body")}</div>
        <div className="props-value" data-testid="make-vise-fixed">{fixedGeo.name}</div>
      </div>
      <div className="props-group">
        <div className="props-label" data-tooltip={words("ViseEditor.the_body_that_slides")}>{words("ViseEditor.moving_jaw")}</div>
        <div className="props-value">
          <select
            className="props-number-input"
            data-testid="make-vise-jaw"
            aria-label={words("ViseEditor.moving_jaw")}
            value={jawId}
            onChange={(e) => chooseJaw(e.target.value)}
          >
            {candidates.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
      </div>
      <div className="props-group">
        <div
          className="props-label"
          data-tooltip={words("ViseEditor.the_way_the_jaw_moves_as_the")}
        >{words("ViseEditor.opens_along")}</div>
        <div className="props-value">
          <select
            className="props-number-input"
            data-testid="make-vise-axis"
            aria-label={words("ViseEditor.opens_along")}
            value={slide}
            onChange={(e) => { setSlide(e.target.value as SlideChoice); setPicking(false) }}
          >
            {jawAxisLabels().map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            {picked && <option value="picked">{words("ViseEditor.away_from_picked_face")}</option>}
          </select>
        </div>
      </div>
      {canPickFace && (
        <div className="props-group props-btn-row">
          <button
            type="button"
            className="props-btn"
            data-testid="make-vise-pick-face"
            data-tooltip={words("ViseEditor.click_the_jaw_s_clamping_face_in")}
            onClick={() => setPicking((p) => !p)}
          >
            <MousePointer2 size={12} /> {picking ? words("ViseEditor.click_the_clamping_face") : words("ViseEditor.pick_clamping_face")}
          </button>
        </div>
      )}
      <div className="props-group">
        <div className="props-label">{words("ViseEditor.travel", { value1: u })}</div>
        <div className="props-value" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <LengthField valueMm={minMm} units={units} testId="make-vise-min" ariaLabel={words("ViseEditor.minimum_travel")} onCommit={(mm) => { setMinMm(mm) }} />
          <span>{words("ViseEditor.to")}</span>
          <LengthField valueMm={maxMm} units={units} testId="make-vise-max" ariaLabel={words("ViseEditor.maximum_travel")} onCommit={(mm) => { setMaxMm(mm) }} />
        </div>
      </div>
      <div className="props-group">
        <div
          className="props-label"
          data-tooltip={words("ViseEditor.the_opening_the_jaw_is_at_where")}
        >{words("ViseEditor.opening_now", { value1: u })}</div>
        <div className="props-value">
          <LengthField valueMm={openingMm} units={units} testId="make-vise-opening" ariaLabel={words("ViseEditor.opening_now_2")} onCommit={(mm) => { setOpeningMm(mm) }} />
        </div>
      </div>
      <div className="props-group props-btn-row">
        <button type="button" className="props-btn" data-testid="make-vise-create" onClick={make}>
          <Anchor size={12} />{words("ViseEditor.make_vise")}</button>
        <button type="button" className="props-btn" data-testid="make-vise-cancel" onClick={onDone}>{words("ViseEditor.cancel")}</button>
      </div>
    </div>
  )
}

// ---- A placed vise ----
export function ViseProperties({ membership }: { membership: ViseMembership }) {
  const words = useText('setup-stock-tools-machine-post')
  const units = useCamStore((s) => s.appSettings.displayUnits)
  const geometry = useCamStore((s) => s.project.geometry)
  const setups = useCamStore((s) => s.project.setups)
  const setWorkholdingJointValue = useCamStore((s) => s.setWorkholdingJointValue)
  const renameWorkholding = useCamStore((s) => s.renameWorkholding)
  const removeWorkholding = useCamStore((s) => s.removeWorkholding)
  const { instance, definition, moving } = membership
  const parts = closeOnPartCandidates(geometry)
  const [partId, setPartId] = useState('')
  const [clearanceMm, setClearanceMm] = useState(0)
  const chosenPart = parts.find((g) => g.id === partId) ?? parts[0]

  const closeOnChosenPart = async () => {
    if (!moving || !chosenPart) return
    const result = await closeOnPart(useCamStore.getState().project, membership, chosenPart.id, clearanceMm)
    if (!result) return
    const store = useCamStore.getState()
    const used = store.setWorkholdingJointValue(instance.id, moving.id, result.openingMm)
    if (used == null) return
    store.addConsoleEvent({
      severity: 'info',
      source: 'workholding',
      message: closeOnPartMessage(definition.name, chosenPart.name, { ...result, openingMm: used }, units),
      entityRef: { kind: 'geometry', id: chosenPart.id },
    })
  }
  const opening = moving ? viseOpening(instance, moving) : null
  const u = unitLabel(units)
  const bodyName = (geometryId: string) => geometry.find((g) => g.id === geometryId)?.name ?? geometryId
  const placedIn = instance.setupScope.kind === 'all'
    ? words("ViseEditor.every_setup")
    : instance.setupScope.setupIds.map((id) => setups.find((s) => s.id === id)?.name ?? id).join(', ')

  return (
    <div className="props-section" data-testid="vise-props">
      <div className="props-group">
        <div className="props-label"><Anchor size={11} style={{ display: 'inline', marginRight: 5 }} />{words("ViseEditor.vise")}</div>
        <div className="props-value">
          <input
            key={`${instance.id}:${definition.name}`}
            className="props-text-input"
            data-testid="vise-name-input"
            aria-label={words("ViseEditor.vise_name")}
            defaultValue={definition.name}
            onBlur={(e) => {
              const next = e.currentTarget.value.trim()
              if (next) renameWorkholding(instance.id, next)
              else e.currentTarget.value = definition.name
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') { e.currentTarget.value = definition.name; e.currentTarget.blur() }
            }}
          />
        </div>
      </div>
      {moving && opening && (
        <>
          <div className="props-group">
            <div className="props-label" data-tooltip={words("ViseEditor.how_far_the_jaw_is_opened_within")}>{words("ViseEditor.opening", { value1: u })}</div>
            <div className="props-value">
              <LengthField
                valueMm={opening.valueMm}
                units={units}
                testId="vise-opening-input"
                ariaLabel={words("ViseEditor.vise_opening")}
                onCommit={(mm) => setWorkholdingJointValue(instance.id, moving.id, mm)}
              />
            </div>
          </div>
          <div className="props-group">
            <div className="props-label">{words("ViseEditor.travel_2")}</div>
            <div className="props-value" data-testid="vise-travel">{words("ViseEditor.to_2", { value1: fmtLength(opening.minMm, units), value2: fmtLength(opening.maxMm, units), value3: u })}</div>
          </div>
          {chosenPart && (
            <>
              <div className="props-group">
                <div className="props-label" data-tooltip={words("ViseEditor.the_part_close_on_part_sets_the")}>{words("ViseEditor.part")}</div>
                <div className="props-value">
                  <select
                    className="props-number-input"
                    data-testid="vise-close-part"
                    aria-label={words("ViseEditor.part_to_close_on")}
                    value={chosenPart.id}
                    onChange={(e) => setPartId(e.target.value)}
                  >
                    {parts.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label" data-tooltip={words("ViseEditor.added_to_the_part_s_width_across")}>{words("ViseEditor.clearance", { value1: u })}</div>
                <div className="props-value">
                  <LengthField
                    valueMm={clearanceMm}
                    units={units}
                    testId="vise-close-clearance"
                    ariaLabel={words("ViseEditor.close_on_part_clearance")}
                    onCommit={(mm) => { setClearanceMm(mm) }}
                  />
                </div>
              </div>
              <div className="props-group props-btn-row">
                <button
                  type="button"
                  className="props-btn"
                  data-testid="vise-close-on-part"
                  data-tooltip={words("ViseEditor.set_the_opening_once_to_the_part")}
                  onClick={() => { void closeOnChosenPart() }}
                >
                  <Minimize2 size={12} />{words("ViseEditor.close_on_part")}</button>
              </div>
            </>
          )}
        </>
      )}
      {definition.components.map((c) => (
        <div className="props-group" key={c.id}>
          <div className="props-label">{c.joint ? words("ViseEditor.moving_jaw") : words("ViseEditor.fixed_body")}</div>
          <div className="props-value" data-testid={`vise-body-${c.id}`}>{bodyName(c.geometryId)}</div>
        </div>
      ))}
      <div className="props-group">
        <div className="props-label">{words("ViseEditor.placed_in")}</div>
        <div className="props-value" data-testid="vise-setups">{placedIn}</div>
      </div>
      {/* WO-2198: where this vise sits (its fixed body's origin) and its turn about Z -
          each vise from one definition has its own. One undo step per field. */}
      {(['x', 'y', 'z'] as const).map((axis) => (
        <div className="props-group" key={axis}>
          <div className="props-label">{axis.toUpperCase()}{words("ViseEditor.symbol")}{u}{words("ViseEditor.symbol_2")}</div>
          <div className="props-value">
            <LengthField
              valueMm={instance.worldPose.position[axis]}
              units={units}
              testId={`vise-position-${axis}`}
              ariaLabel={words("ViseEditor.vise_position", { value1: axis.toUpperCase() })}
              onCommit={(mm) => { moveVise(instance.id, { [axis]: mm }) }}
            />
          </div>
        </div>
      ))}
      <div className="props-group">
        <div className="props-label" data-tooltip={words("ViseEditor.turn_about_z")}>{words("ViseEditor.turn_deg")}</div>
        <div className="props-value">
          <input
            key={`${instance.id}:${instance.worldPose.rotation.z}`}
            type="text"
            inputMode="decimal"
            className="props-number-input"
            data-testid="vise-turn-input"
            aria-label={words("ViseEditor.vise_turn_about_z")}
            defaultValue={parseFloat(instance.worldPose.rotation.z.toFixed(3)).toString()}
            onBlur={(e) => {
              const n = parseFloat(e.currentTarget.value)
              if (Number.isFinite(n)) moveVise(instance.id, {}, n)
              else e.currentTarget.value = parseFloat(instance.worldPose.rotation.z.toFixed(3)).toString()
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
        </div>
      </div>
      <div className="props-group props-btn-row">
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="vise-remove"
          data-tooltip={words("ViseEditor.remove_the_vise_its_two_bodies_stay")}
          onClick={() => removeWorkholding(instance.id)}
        >
          <Trash2 size={12} />{words("ViseEditor.remove_vise")}</button>
      </div>
      <div className="props-group props-btn-row">
        <PlaceAnotherButton instanceId={instance.id} />
        <ExportWorkholdingButton instanceId={instance.id} testId="vise-export" />
      </div>
    </div>
  )
}

/** WO-2198: move a placed vise to a new position and/or turn about Z (one undo step; no change writes nothing). */
function moveVise(instanceId: string, position: Partial<Vec3>, turnDeg?: number) {
  const store = useCamStore.getState()
  const current = store.project.workholding?.instances.find((i) => i.id === instanceId)
  if (!current) return
  store.updateWorkholdingInstance(instanceId, {
    worldPose: {
      position: { ...current.worldPose.position, ...position },
      rotation: { ...current.worldPose.rotation, ...(turnDeg !== undefined ? { z: turnDeg } : {}) },
    },
  })
}

/** Display helper for the tree: the opening in the display unit with its label. */
export function viseOpeningLabel(membership: Pick<ViseMembership, 'instance' | 'moving'>, units: Units): string | null {
  const opening = membership.moving ? viseOpening(membership.instance, membership.moving) : null
  return opening ? `${fmtLength(opening.valueMm, units)} ${unitLabel(units)}` : null
}

