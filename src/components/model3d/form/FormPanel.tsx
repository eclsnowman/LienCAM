// Form - the Form palette shown while form mode is open inside the Model
// screen: name, starter segment counts, the finished body's chord tolerance,
// the soft move radius, what is selected, and Finish Form / Cancel. The
// form's tools themselves are on the rail (useFormSession railSections); the
// palette's settings sit in foldable groups named after the rail groups whose
// tools they set (Start from, Edit form, Topology, Openings, Symmetry, Display).

import { Children, useMemo, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Spline } from 'lucide-react'
import { DockedPanel } from '../workbench/DockedPanel'
import { useToolPaletteLayout, type ToolPaletteLayout } from '../../common/useToolPaletteLayout'
import { NumericInput } from '../../ui/NumericInput'
import { circularCount } from '../../../form/symmetry'
import { useFormStore, type FlattenOnto } from '../../../form/formStore'
import { selectionPoints } from '../../../form/topology'
import { MAX_SKIN_LEVEL, skinLevels } from '../../../form/formOverlay'
import type { StarterKind } from '../../../form/starters'
import type { FormSession } from './useFormSession'
import './form.css'

/** Which segment counts each starter reads, and what they are called. */
const SEGMENT_FIELDS: Record<StarterKind, Array<{ axis: 'x' | 'y' | 'z'; label: string; min: number }>> = {
  box: [{ axis: 'x', label: 'X', min: 1 }, { axis: 'y', label: 'Y', min: 1 }, { axis: 'z', label: 'Z', min: 1 }],
  cylinder: [{ axis: 'x', label: 'Around', min: 3 }, { axis: 'z', label: 'Along', min: 1 }],
  sphere: [{ axis: 'x', label: 'Per side', min: 1 }],
  torus: [{ axis: 'x', label: 'Around', min: 3 }, { axis: 'z', label: 'Tube', min: 3 }],
  plane: [{ axis: 'x', label: 'X', min: 1 }, { axis: 'y', label: 'Y', min: 1 }],
}
const MAX_SEGMENTS = 32

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function FormPanel({ session }: { session: FormSession }) {
  const thickness = useFormStore((s) => s.thickness)
  const softRadius = useFormStore((s) => s.softRadius)
  const weldDistance = useFormStore((s) => s.weldDistance)
  const flattenOnto = useFormStore((s) => s.flattenOnto)
  // an axis plane sits where it was typed, else through the centre of the selected points
  const flattenAt = useFormStore((s) => {
    if (s.flattenAt !== null || (s.flattenOnto !== 'x' && s.flattenOnto !== 'y' && s.flattenOnto !== 'z')) return s.flattenAt ?? 0
    const k = { x: 0, y: 1, z: 2 }[s.flattenOnto]
    const pts = selectionPoints(s.cage, s.selection)
    return pts.length > 0 ? +(pts.reduce((a, p) => a + s.cage.positions[p][k], 0) / pts.length).toFixed(3) : 0
  })
  const profileHeight = useFormStore((s) => s.profileHeight)
  const revolveAngle = useFormStore((s) => s.revolveAngle)
  const pipeRadius = useFormStore((s) => s.pipeRadius)
  const revolveSegments = useFormStore((s) => s.revolveSegments)
  const loopPosition = useFormStore((s) => s.loopPosition)
  const bridgeSegments = useFormStore((s) => s.bridgeSegments)
  const bridgeTwist = useFormStore((s) => s.bridgeTwist)
  const symmetry = useFormStore((s) => s.symmetry)
  const circularCopies = useFormStore((s) => s.circularCopies)
  const symmetryAt = useFormStore((s) => s.symmetryAt)
  const creaseWeight = useFormStore((s) => s.creaseWeight)
  const cage = useFormStore((s) => s.cage)
  // an opening (an edge with one face) is what Thicken closes
  const open = useMemo(() => hasOpening(cage), [cage])
  const name = useFormStore((s) => s.name)
  const tolerance = useFormStore((s) => s.tolerance)
  const starterKind = useFormStore((s) => s.starterKind)
  const segments = useFormStore((s) => s.starterSegments[s.starterKind])
  const selection = useFormStore((s) => s.selection)
  const transformMode = useFormStore((s) => s.transformMode)
  const notice = useFormStore((s) => s.notice)
  const editing = useFormStore((s) => s.featureId !== null)
  const skinLevel = useFormStore((s) => s.skinLevel)
  const levels = skinLevels(cage, skinLevel)
  const selected = [
    selection.points.length > 0 ? plural(selection.points.length, 'point') : null,
    selection.edges.length > 0 ? plural(selection.edges.length, 'edge') : null,
    selection.faces.length > 0 ? plural(selection.faces.length, 'face') : null,
  ].filter(Boolean).join(', ')
  const selectionPrompt = {
    translate: 'Move: click a point, edge or face to select it; Shift adds.',
    rotate: 'Rotate: click a point, edge or face to rotate it',
    scale: 'Scale: click a point, edge or face to scale it',
  }[transformMode]
  // the box-select hint follows on the same line (Selected: ... or the mode's sentence)
  const lineHead = selected ? `Selected: ${selected}` : selectionPrompt

  // groups fold, remembered per viewer (the rail's layout hook)
  const layout = useToolPaletteLayout('form-palette')

  // docked at the side beside the tool rail, a column of the page like the rail itself: the view narrows to make
  // room instead of being covered; its chevron folds it to a strip at the side for the whole view (DockedPanel)
  return (
    <DockedPanel
      id="form-palette"
      testId="form-palette-shell"
      className="form-palette-shell"
      title={editing ? `Edit form - ${name}` : 'Form'}
      icon={<Spline size={14} />}
      width={300}
      onClose={session.cancel}
      closeLabel="Cancel form"
      closeTestId="form-close"
      footer={<>
        <div className="form-status" data-testid="form-status">
          <div>Cage: {plural(cage.positions.length, 'point')}, {plural(cage.faces.length, 'face')}{cage.creases.length > 0 ? `, ${plural(cage.creases.length, 'creased edge')}` : ''}{cage.weights ? `, ${plural(Object.keys(cage.weights).length, 'weighted edge')}` : ''}</div>
          <div>
            <span data-testid="form-selection">{lineHead}</span>
            {lineHead.endsWith('.') ? ' ' : '. '}
            <span data-testid="form-select-hint">Drag a box to select many points; Shift adds, Ctrl removes.</span>
          </div>
          {notice && <div className="form-notice" data-testid="form-notice" title={notice}>{notice}</div>}
        </div>
        <div className="form-actions">
          <button type="button" className="modal-btn modal-btn-ghost" data-testid="form-cancel" onClick={session.cancel}>Cancel</button>
          <button type="button" className="modal-btn modal-btn-primary" data-testid="form-finish" onClick={session.finish}>Finish Form</button>
        </div>
      </>}
    >
      <div className="form-palette" data-testid="form-palette">
        <label className="form-row">
          <span className="form-row-label">Name</span>
          <input
            className="form-text"
            data-testid="form-name"
            value={name}
            onChange={(e) => useFormStore.getState().setName(e.target.value)}
          />
        </label>
        <PaletteGroup id="start" title="Start from" layout={layout}>
          <div className="form-row">
            <span className="form-row-label">Segments</span>
            {SEGMENT_FIELDS[starterKind].map(({ axis, label, min }) => (
              <span key={axis} className="form-seg" data-testid={`form-segments-${axis}`}>
                <span className="form-seg-label">{label}</span>
                <NumericInput
                  value={segments[axis]}
                  min={min}
                  max={MAX_SEGMENTS}
                  step={1}
                  decimals={0}
                  ariaLabel={`${label} segments`}
                  tooltip={`${label} segments for the next ${starterKind} start (${min} to ${MAX_SEGMENTS})`}
                  onChange={(n) => useFormStore.getState().setStarterSegments(starterKind, { ...segments, [axis]: Math.round(n) })}
                  style={{ width: '3.2rem' }}
                />
              </span>
            ))}
          </div>
          <div className="form-row">
            <span className="form-row-label">Extrude</span>
            <span className="form-seg" data-testid="form-profile-height">
              <NumericInput
                value={profileHeight}
                min={-1000}
                max={1000}
                step={1}
                decimals={2}
                ariaLabel="Extrude height"
                tooltip="How far Extrude takes the selected sketch's profile along its plane's normal (negative: the other way)"
                onChange={(n) => useFormStore.getState().setProfileHeight(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">mm tall</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">Pipe</span>
            <span className="form-seg" data-testid="form-pipe-radius">
              <NumericInput
                value={pipeRadius}
                min={0}
                max={1000}
                step={0.5}
                decimals={2}
                ariaLabel="Pipe radius"
                tooltip="The tube radius Pipe makes; 0: automatic (a twelfth of the path, well inside its tightest bend)"
                onChange={(n) => useFormStore.getState().setPipeRadius(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">{pipeRadius > 0 ? 'mm radius' : 'mm radius (0: auto)'}</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">Revolve</span>
            <span className="form-seg" data-testid="form-revolve-angle">
              <NumericInput
                value={revolveAngle}
                min={1}
                max={360}
                step={15}
                decimals={1}
                ariaLabel="Revolve angle"
                tooltip="How far Revolve turns the selected sketch's profile (1 to 360 degrees); short of a full turn a closed profile gets flat end caps"
                onChange={(n) => useFormStore.getState().setRevolveAngle(n)}
                style={{ width: '3.6rem' }}
              />
              <span className="form-seg-label">deg</span>
            </span>
            <span className="form-seg" data-testid="form-revolve-segments">
              <NumericInput
                value={revolveSegments}
                min={3}
                max={64}
                step={1}
                decimals={0}
                ariaLabel="Revolve segments"
                tooltip="Cage spans round the revolve (3 to 64)"
                onChange={(n) => useFormStore.getState().setRevolveSegments(n)}
                style={{ width: '3rem' }}
              />
              <span className="form-seg-label">round</span>
            </span>
          </div>
        </PaletteGroup>
        <PaletteGroup id="edit" title="Edit form" layout={layout}>
          <div className="form-row">
            <span className="form-row-label">Soft</span>
            <span className="form-seg" data-testid="form-soft-radius">
              <NumericInput
                value={softRadius}
                min={0}
                max={500}
                step={1}
                decimals={1}
                ariaLabel="Soft move radius"
                tooltip="Points within this distance of the selection follow a move part of the way, fading to nothing at the radius (0 = only the selection moves)"
                onChange={(n) => useFormStore.getState().setSoftRadius(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">mm radius</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">Flatten</span>
            <span className="form-seg">
              <select
                className="form-text"
                data-testid="form-flatten-onto"
                aria-label="Flatten onto"
                title="The plane Flatten puts the selected points on: their best fit, an X, Y or Z plane, the first selected face's plane, or the mirror plane"
                value={flattenOnto === 'mirror' && (symmetry === null || circularCount(symmetry) !== null) ? 'fit' : flattenOnto}
                onChange={(e) => useFormStore.getState().setFlattenOnto(e.target.value as FlattenOnto)}
                style={{ width: '5.6rem' }}
              >
                <option value="fit">best fit</option>
                <option value="x">X plane</option>
                <option value="y">Y plane</option>
                <option value="z">Z plane</option>
                <option value="face">face</option>
                {symmetry !== null && circularCount(symmetry) === null && <option value="mirror">mirror</option>}
              </select>
            </span>
            {(flattenOnto === 'x' || flattenOnto === 'y' || flattenOnto === 'z') && (
              <span className="form-seg" data-testid="form-flatten-at">
                <NumericInput
                  value={flattenAt}
                  min={-10000}
                  max={10000}
                  step={1}
                  decimals={3}
                  ariaLabel="Flatten plane position"
                  tooltip={`Where the ${flattenOnto.toUpperCase()} plane sits: through the centre of the selected points until a value is typed`}
                  onChange={(n) => useFormStore.getState().setFlattenAt(n)}
                  style={{ width: '3.6rem' }}
                />
                <span className="form-seg-label">mm</span>
              </span>
            )}
          </div>
        </PaletteGroup>
        <PaletteGroup id="topology" title="Topology" layout={layout}>
          <div className="form-row">
            <span className="form-row-label">Crease</span>
            <span className="form-seg" data-testid="form-crease-weight">
              <NumericInput
                value={creaseWeight}
                min={0}
                max={10}
                step={0.5}
                decimals={1}
                ariaLabel="Crease weight"
                tooltip="How sharp Crease makes an edge: 0 = fully sharp; a weight keeps it sharp for that many subdivision steps, then smooth (0.5 to 3 give soft to firm edges)"
                onChange={(n) => useFormStore.getState().setCreaseWeight(n)}
                style={{ width: '3.6rem' }}
              />
              <span className="form-seg-label">{creaseWeight === 0 ? 'weight (sharp)' : 'weight'}</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">Loop at</span>
            <span className="form-seg" data-testid="form-loop-position">
              <NumericInput
                value={loopPosition}
                min={0.01}
                max={0.99}
                step={0.05}
                decimals={2}
                ariaLabel="Insert loop position"
                tooltip="Where Insert loop cuts each edge of the ring: 0.5 is the middle; less is nearer the selected edge's lower end (then its -Y, then -X end)"
                onChange={(n) => useFormStore.getState().setLoopPosition(n)}
                style={{ width: '3.6rem' }}
              />
            </span>
            <input
              type="range"
              className="form-range"
              data-testid="form-loop-slider"
              aria-label="Loop position slider"
              title="Where Insert loop cuts each edge; right after Insert loop, sliding it moves that loop"
              min={0.01}
              max={0.99}
              step={0.01}
              value={loopPosition}
              onChange={(e) => useFormStore.getState().setLoopPosition(Number(e.target.value))}
              style={{ width: '7rem' }}
            />
          </div>
          <div className="form-row">
            <span className="form-row-label">Weld</span>
            <span className="form-seg" data-testid="form-weld-distance">
              <NumericInput
                value={weldDistance}
                min={0}
                max={100}
                step={0.5}
                decimals={2}
                ariaLabel="Weld close distance"
                tooltip="Weld close joins points this close to one another (among the selection, or across the form when nothing is selected)"
                onChange={(n) => useFormStore.getState().setWeldDistance(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">mm apart</span>
            </span>
          </div>
        </PaletteGroup>
        <PaletteGroup id="openings" title="Openings" layout={layout}>
          <div className="form-row">
            <span className="form-row-label">Bridge</span>
            <span className="form-seg" data-testid="form-bridge-segments">
              <NumericInput
                value={bridgeSegments}
                min={1}
                max={32}
                step={1}
                decimals={0}
                ariaLabel="Bridge segments"
                tooltip="How many rings of faces long Bridge makes the band between the two openings or face sets"
                onChange={(n) => useFormStore.getState().setBridgeSegments(n)}
                style={{ width: '3.2rem' }}
              />
              <span className="form-seg-label">long</span>
            </span>
            <span className="form-seg" data-testid="form-bridge-twist">
              <NumericInput
                value={bridgeTwist}
                min={-64}
                max={64}
                step={1}
                decimals={0}
                ariaLabel="Bridge twist"
                tooltip="How many points round a bridge between two closed openings or face sets turns, so the band spirals (0: lined up)"
                onChange={(n) => useFormStore.getState().setBridgeTwist(n)}
                style={{ width: '3.2rem' }}
              />
              <span className="form-seg-label">twist</span>
            </span>
          </div>
          {open && (
            <div className="form-row">
              <span className="form-row-label">Thicken</span>
              <span className="form-seg" data-testid="form-thickness">
                <NumericInput
                  value={thickness}
                  min={0.1}
                  max={50}
                  step={0.5}
                  decimals={2}
                  ariaLabel="Thicken wall thickness"
                  tooltip="Wall thickness Thicken gives an open form (0.1 to 50 mm)"
                  onChange={(n) => useFormStore.getState().setThickness(n)}
                  style={{ width: '4.5rem' }}
                />
                <span className="form-seg-label">mm wall</span>
              </span>
            </div>
          )}
        </PaletteGroup>
        <PaletteGroup id="symmetry" title="Symmetry" layout={layout}>
          {symmetry !== null && circularCount(symmetry) === null && (
            <div className="form-row">
              <span className="form-row-label">Mirror</span>
              <span className="form-seg" data-testid="form-mirror-at">
                <NumericInput
                  value={symmetryAt}
                  min={-10000}
                  max={10000}
                  step={1}
                  decimals={3}
                  ariaLabel="Mirror plane position"
                  tooltip={symmetry === 'p' ? 'Where the placed mirror plane sits along its normal: moving it pairs the points mirrored across the new plane' : `Where the mirror plane sits on ${symmetry.toUpperCase()}: moving it pairs the points mirrored across the new plane`}
                  onChange={(n) => useFormStore.getState().setSymmetryAt(n)}
                  style={{ width: '5rem' }}
                />
                <span className="form-seg-label">{symmetry === 'p' ? 'mm offset' : `mm on ${symmetry.toUpperCase()}`}</span>
              </span>
            </div>
          )}
          {symmetry !== null && circularCount(symmetry) !== null && (
            <div className="form-row">
              <span className="form-row-label">Circular</span>
              <span className="form-seg" data-testid="form-circular-copies">
                <NumericInput
                  value={circularCopies}
                  min={2}
                  max={24}
                  step={1}
                  decimals={0}
                  ariaLabel="Circular copies"
                  tooltip="How many copies round the Z axis circular symmetry keeps in step"
                  onChange={(n) => useFormStore.getState().setCircularCopies(n)}
                  style={{ width: '3.6rem' }}
                />
                <span className="form-seg-label">copies</span>
              </span>
            </div>
          )}
        </PaletteGroup>
        <PaletteGroup id="display" title="Display" layout={layout}>
          <div className="form-row">
            <span className="form-row-label">Tolerance</span>
            <span className="form-seg" data-testid="form-tolerance">
              <NumericInput
                value={tolerance}
                min={0.001}
                max={1}
                step={0.005}
                decimals={3}
                ariaLabel="Finished body chord tolerance"
                tooltip="How far the finished body's facets may stray from the smooth surface (0.001 to 1 mm)"
                onChange={(n) => useFormStore.getState().setTolerance(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">mm chord</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">Smooth</span>
            <span className="form-seg" data-testid="form-skin-level">
              <NumericInput
                value={skinLevel}
                min={0}
                max={MAX_SKIN_LEVEL}
                step={1}
                decimals={0}
                ariaLabel="Smooth skin display level"
                tooltip={`Subdivision level the smooth skin is drawn at (1 to ${MAX_SKIN_LEVEL}; 0 = automatic). Display only: the finished body is exact either way`}
                onChange={(n) => useFormStore.getState().setSkinLevel(n)}
                style={{ width: '3.2rem' }}
              />
              <span className="form-seg-label">{skinLevel === 0 ? 'level (auto)' : 'level'}</span>
            </span>
          </div>
        </PaletteGroup>
        <div className="form-static-status">
          <div>Smooth skin: level {levels.rest} at rest, {levels.drag} while dragging</div>
          <div className="form-hint">Alt-drag a move arrow to extrude the selected faces.{symmetry !== null && !symmetry.startsWith('c') ? ' Drag the mirror plane to slide it.' : ''}</div>
        </div>
      </div>
    </DockedPanel>
  )
}

/**
 * A group of palette rows under the same name as the rail group whose tools they set. Its header folds it
 * (remembered per viewer); a group with no row showing has no header either, so nothing is left empty.
 */
function PaletteGroup({ id, title, layout, children }: { id: string; title: string; layout: ToolPaletteLayout; children: ReactNode }) {
  if (Children.toArray(children).length === 0) return null
  const folded = layout.isCollapsed(id)
  return (
    <div className="form-group" data-testid={`form-group-${id}`}>
      <button
        type="button"
        className="form-group-header"
        data-testid={`form-group-toggle-${id}`}
        aria-expanded={!folded}
        data-tooltip={folded ? `Show the ${title} settings` : `Hide the ${title} settings`}
        onClick={() => layout.toggleSection(id)}
      >
        {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span>{title}</span>
      </button>
      {!folded && children}
    </div>
  )
}

function hasOpening(cage: { faces: number[][] }): boolean {
  const uses = new Map<string, number>()
  for (const f of cage.faces) for (let i = 0; i < f.length; i++) {
    const a = f[i], b = f[(i + 1) % f.length]
    const k = a < b ? `${a}:${b}` : `${b}:${a}`
    uses.set(k, (uses.get(k) ?? 0) + 1)
  }
  for (const n of uses.values()) if (n === 1) return true
  return false
}
