// Form - the Form palette shown while form mode is open inside the Model
// screen: name, starter segment counts, the finished body's chord tolerance,
// the soft move radius, what is selected, and Finish Form / Cancel. The
// form's tools themselves are on the rail (useFormSession railSections); the
// palette's settings sit in foldable groups named after the rail groups whose
// tools they set (Start from, Edit form, Topology, Openings, Symmetry, Display).

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { Children, useMemo, type ReactNode } from 'react'
import { catalogChildren } from '../catalogChildren'
import { ChevronDown, ChevronRight, Spline } from 'lucide-react'
import { DockedPanel } from '../workbench/DockedPanel'
import { useToolPaletteLayout, type ToolPaletteLayout } from '../../common/useToolPaletteLayout'
import { NumericInput } from '../../ui/NumericInput'
import { circularCount } from '../../../form/symmetry'
import { useFormStore, type FlattenOnto, type RotationPick } from '../../../form/formStore'
import { selectionPoints } from '../../../form/topology'
import { MAX_SKIN_LEVEL, skinLevels } from '../../../form/formOverlay'
import type { StarterKind } from '../../../form/starters'
import type { FormSession } from './useFormSession'
import './form.css'

/** Which segment counts each starter reads, and what they are called. */
const SEGMENT_FIELDS: Record<StarterKind, Array<{ axis: 'x' | 'y' | 'z'; label: string; min: number }>> = {
  box: [{ axis: 'x', label: 'X', min: 1 }, { axis: 'y', label: 'Y', min: 1 }, { axis: 'z', label: 'Z', min: 1 }],
  cylinder: [{ axis: 'x', get label() { return workbenchText('FormPanel.around') }, min: 3 }, { axis: 'z', get label() { return workbenchText('FormPanel.along') }, min: 1 }],
  sphere: [{ axis: 'x', get label() { return workbenchText('FormPanel.perSide') }, min: 1 }],
  torus: [{ axis: 'x', get label() { return workbenchText('FormPanel.around') }, min: 3 }, { axis: 'z', get label() { return workbenchText('FormPanel.tube') }, min: 3 }],
  plane: [{ axis: 'x', label: 'X', min: 1 }, { axis: 'y', label: 'Y', min: 1 }],
}
const MAX_SEGMENTS = 32

function plural(n: number, word: 'point' | 'edge' | 'face' | 'creased edge' | 'weighted edge'): string {
  const keys = {
    point: ['FormPanel.pointCount', 'FormPanel.pointsCount'],
    edge: ['FormPanel.edgeCount', 'FormPanel.edgesCount'],
    face: ['FormPanel.faceCount', 'FormPanel.facesCount'],
    'creased edge': ['FormPanel.creasedEdgeCount', 'FormPanel.creasedEdgesCount'],
    'weighted edge': ['FormPanel.weightedEdgeCount', 'FormPanel.weightedEdgesCount'],
  } as const
  return workbenchText(keys[word][n === 1 ? 0 : 1], { n })
}

export function FormPanel({ session }: { session: FormSession }) {
  const workbenchText = useText('sketch-and-model-workbench')
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
  const rotationAxis = useFormStore((s) => s.rotationAxis)
  const rotationPick = useFormStore((s) => s.rotationPick)
  const rotationAngle = useFormStore((s) => s.rotationAngle)
  const rotationCentreAxis = useFormStore((s) => s.rotationCentreAxis)
  const dragging = useFormStore((s) => s.dragging)
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
    translate: workbenchText('FormPanel.moveSelectionPrompt'),
    rotate: workbenchText('FormPanel.rotateSelectionPrompt'),
    scale: workbenchText('FormPanel.scaleSelectionPrompt'),
  }[transformMode]
  // the box-select hint follows on the same line (Selected: ... or the mode's sentence)
  const lineHead = selected ? workbenchText('FormPanel.selected', { selected }) : selectionPrompt

  // groups fold, remembered per viewer (the rail's layout hook)
  const layout = useToolPaletteLayout('form-palette')

  // docked at the side beside the tool rail, a column of the page like the rail itself: the view narrows to make
  // room instead of being covered; its chevron folds it to a strip at the side for the whole view (DockedPanel)
  return (
    <DockedPanel
      id="form-palette"
      testId="form-palette-shell"
      className="form-palette-shell"
      title={editing ? workbenchText('FormPanel.editForm', { name: String(name) }) : workbenchText('FormPanel.form')}
      icon={<Spline size={14} />}
      width={300}
      onClose={session.cancel}
      closeLabel={workbenchText('FormPanel.cancelForm')}
      closeTestId="form-close"
      footer={<>
        <div className="form-status" data-testid="form-status">
          <div>{catalogChildren(workbenchText('FormPanel.cage', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000', value4: '\u0000value4\u0000' }), { value1: plural(cage.positions.length, 'point'), value2: plural(cage.faces.length, 'face'), value3: cage.creases.length > 0 ? `, ${plural(cage.creases.length, 'creased edge')}` : '', value4: cage.weights ? `, ${plural(Object.keys(cage.weights).length, 'weighted edge')}` : '' })}</div>
          <div>
            <span data-testid="form-selection">{lineHead}</span>
            {lineHead.endsWith('.') ? ' ' : '. '}
            <span data-testid="form-select-hint">{workbenchText('FormPanel.boxSelectionHint')}</span>
          </div>
          {notice && <div className="form-notice" data-testid="form-notice" title={notice}>{notice}</div>}
        </div>
        <div className="form-actions">
          <button type="button" className="modal-btn modal-btn-ghost" data-testid="form-cancel" onClick={session.cancel}>{workbenchText('FormPanel.cancel')}</button>
          <button type="button" className="modal-btn modal-btn-primary" data-testid="form-finish" onClick={session.finish}>{workbenchText('FormPanel.finishForm')}</button>
        </div>
      </>}
    >
      <div className="form-palette" data-testid="form-palette">
        <label className="form-row">
          <span className="form-row-label">{workbenchText('FormPanel.name')}</span>
          <input
            className="form-text"
            data-testid="form-name"
            value={name}
            onChange={(e) => useFormStore.getState().setName(e.target.value)}
          />
        </label>
        <PaletteGroup id="start" title={workbenchText('FormPanel.startFrom')} layout={layout}>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.segments')}</span>
            {SEGMENT_FIELDS[starterKind].map(({ axis, label, min }) => (
              <span key={axis} className="form-seg" data-testid={`form-segments-${axis}`}>
                <span className="form-seg-label">{label}</span>
                <NumericInput
                  value={segments[axis]}
                  min={min}
                  max={MAX_SEGMENTS}
                  step={1}
                  decimals={0}
                  ariaLabel={workbenchText('FormPanel.segments2', { label: String(label) })}
                  tooltip={workbenchText('FormPanel.segmentsForTheNextStartTo', { label: String(label), starterKind: String(starterKind), min: String(min), MAX_SEGMENTS: String(MAX_SEGMENTS) })}
                  onChange={(n) => useFormStore.getState().setStarterSegments(starterKind, { ...segments, [axis]: Math.round(n) })}
                  style={{ width: '3.2rem' }}
                />
              </span>
            ))}
          </div>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.extrude')}</span>
            <span className="form-seg" data-testid="form-profile-height">
              <NumericInput
                value={profileHeight}
                min={-1000}
                max={1000}
                step={1}
                decimals={2}
                ariaLabel={workbenchText('FormPanel.extrudeHeight')}
                tooltip={workbenchText('FormPanel.howFarExtrudeTakesTheSelectedSketchSProfile')}
                onChange={(n) => useFormStore.getState().setProfileHeight(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">{workbenchText('FormPanel.mmTall')}</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.pipe')}</span>
            <span className="form-seg" data-testid="form-pipe-radius">
              <NumericInput
                value={pipeRadius}
                min={0}
                max={1000}
                step={0.5}
                decimals={2}
                ariaLabel={workbenchText('FormPanel.pipeRadius')}
                tooltip={workbenchText('FormPanel.theTubeRadiusPipeMakes0AutomaticATwelfth')}
                onChange={(n) => useFormStore.getState().setPipeRadius(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">{pipeRadius > 0 ? workbenchText('FormPanel.mmRadius') : workbenchText('FormPanel.mmRadius0Auto')}</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.revolve')}</span>
            <span className="form-seg" data-testid="form-revolve-angle">
              <NumericInput
                value={revolveAngle}
                min={1}
                max={360}
                step={15}
                decimals={1}
                ariaLabel={workbenchText('FormPanel.revolveAngle')}
                tooltip={workbenchText('FormPanel.howFarRevolveTurnsTheSelectedSketchSProfile')}
                onChange={(n) => useFormStore.getState().setRevolveAngle(n)}
                style={{ width: '3.6rem' }}
              />
              <span className="form-seg-label">{workbenchText('FormPanel.deg')}</span>
            </span>
            <span className="form-seg" data-testid="form-revolve-segments">
              <NumericInput
                value={revolveSegments}
                min={3}
                max={64}
                step={1}
                decimals={0}
                ariaLabel={workbenchText('FormPanel.revolveSegments')}
                tooltip={workbenchText('FormPanel.cageSpansRoundTheRevolve3To64')}
                onChange={(n) => useFormStore.getState().setRevolveSegments(n)}
                style={{ width: '3rem' }}
              />
              <span className="form-seg-label">{workbenchText('FormPanel.round')}</span>
            </span>
          </div>
        </PaletteGroup>
        <PaletteGroup id="edit" title={workbenchText('FormPanel.editForm2')} layout={layout}>
          {transformMode === 'rotate' && <>
            <div className="form-row">
              <span className="form-row-label">{workbenchText('FormPanel.axis')}</span>
              <select className="form-text" data-testid="form-rotation-axis" aria-label={workbenchText('FormPanel.rotationAxis')}
                disabled={dragging} value={rotationPick ?? (rotationAxis ? 'picked' : 'centre')}
                onChange={(e) => useFormStore.getState().chooseRotationAxis(e.target.value === 'centre' ? null : e.target.value as RotationPick)}>
                <option value="centre">{workbenchText('FormPanel.selectionCentre')}</option>
                {rotationAxis && <option value="picked">{rotationAxis.label}</option>}
                <option value="edge">{workbenchText('FormPanel.pickCageEdge')}</option>
                <option value="x">{workbenchText('FormPanel.xThroughPoint')}</option>
                <option value="y">{workbenchText('FormPanel.yThroughPoint')}</option>
                <option value="z">{workbenchText('FormPanel.zThroughPoint')}</option>
              </select>
            </div>
            {rotationPick && <div data-testid="form-rotation-prompt">{workbenchText('FormPanel.rotationPickPrompt', { target: rotationPick === 'edge' ? workbenchText('FormPanel.aCageEdge') : workbenchText('FormPanel.aCagePoint') })}</div>}
            <div className="form-row" style={{ gap: 'var(--space-1)' }}>
              <span className="form-row-label" style={{ width: 'auto', flexShrink: 0 }}>{workbenchText('FormPanel.rotate')}</span>
              {!rotationAxis && !rotationPick && <select className="form-text" aria-label={workbenchText('FormPanel.centreRotationAxis')}
                style={{ flex: '0 0 3.2rem', minWidth: '3.2rem' }}
                value={rotationCentreAxis} onChange={(e) => useFormStore.getState().setRotationCentreAxis(e.target.value as 'x' | 'y' | 'z')}>
                <option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
              </select>}
              <NumericInput value={rotationAngle} step={15} decimals={2} ariaLabel={workbenchText('FormPanel.rotationAngle')}
                tooltip={workbenchText('FormPanel.rotationAngleHint')}
                onChange={(n) => useFormStore.getState().setRotationAngle(n)} style={{ width: '3.6rem' }} />
              <span className="form-seg-label">{workbenchText('FormPanel.deg')}</span>
              <button type="button" className="modal-btn modal-btn-ghost" data-testid="form-rotation-apply"
                disabled={dragging || rotationPick !== null || !selected} onClick={() => useFormStore.getState().rotateSelection()}>{workbenchText('FormPanel.apply')}</button>
            </div>
          </>}
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.soft')}</span>
            <span className="form-seg" data-testid="form-soft-radius">
              <NumericInput
                value={softRadius}
                min={0}
                max={500}
                step={1}
                decimals={1}
                ariaLabel={workbenchText('FormPanel.softMoveRadius')}
                tooltip={workbenchText('FormPanel.pointsWithinThisDistanceOfTheSelectionFollowA')}
                onChange={(n) => useFormStore.getState().setSoftRadius(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">{workbenchText('FormPanel.mmRadius')}</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.flatten')}</span>
            <span className="form-seg">
              <select
                className="form-text"
                data-testid="form-flatten-onto"
                aria-label={workbenchText('FormPanel.flattenOnto')}
                title={workbenchText('FormPanel.thePlaneFlattenPutsTheSelectedPointsOnTheir')}
                value={flattenOnto === 'mirror' && (symmetry === null || circularCount(symmetry) !== null) ? 'fit' : flattenOnto}
                onChange={(e) => useFormStore.getState().setFlattenOnto(e.target.value as FlattenOnto)}
                style={{ width: '5.6rem' }}
              >
                <option value="fit">{workbenchText('FormPanel.bestFit')}</option>
                <option value="x">{workbenchText('FormPanel.xPlane')}</option>
                <option value="y">{workbenchText('FormPanel.yPlane')}</option>
                <option value="z">{workbenchText('FormPanel.zPlane')}</option>
                <option value="face">{workbenchText('FormPanel.face')}</option>
                {symmetry !== null && circularCount(symmetry) === null && <option value="mirror">{workbenchText('FormPanel.mirror')}</option>}
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
                  ariaLabel={workbenchText('FormPanel.flattenPlanePosition')}
                  tooltip={workbenchText('FormPanel.whereThePlaneSitsThroughTheCentreOfThe', { value1: String(flattenOnto.toUpperCase()) })}
                  onChange={(n) => useFormStore.getState().setFlattenAt(n)}
                  style={{ width: '3.6rem' }}
                />
                <span className="form-seg-label">{workbenchText('FormPanel.mm')}</span>
              </span>
            )}
          </div>
        </PaletteGroup>
        <PaletteGroup id="topology" title={workbenchText('FormPanel.topology')} layout={layout}>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.crease')}</span>
            <span className="form-seg" data-testid="form-crease-weight">
              <NumericInput
                value={creaseWeight}
                min={0}
                max={10}
                step={0.5}
                decimals={1}
                ariaLabel={workbenchText('FormPanel.creaseWeight')}
                tooltip={workbenchText('FormPanel.howSharpCreaseMakesAnEdge0FullySharp')}
                onChange={(n) => useFormStore.getState().setCreaseWeight(n)}
                style={{ width: '3.6rem' }}
              />
              <span className="form-seg-label">{creaseWeight === 0 ? workbenchText('FormPanel.weightSharp') : workbenchText('FormPanel.weight')}</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.loopAt')}</span>
            <span className="form-seg" data-testid="form-loop-position">
              <NumericInput
                value={loopPosition}
                min={0.01}
                max={0.99}
                step={0.05}
                decimals={2}
                ariaLabel={workbenchText('FormPanel.insertLoopPosition')}
                tooltip={workbenchText('FormPanel.whereInsertLoopCutsEachEdgeOfTheRing')}
                onChange={(n) => useFormStore.getState().setLoopPosition(n)}
                style={{ width: '3.6rem' }}
              />
            </span>
            <input
              type="range"
              className="form-range"
              data-testid="form-loop-slider"
              aria-label={workbenchText('FormPanel.loopPositionSlider')}
              title={workbenchText('FormPanel.whereInsertLoopCutsEachEdgeRightAfterInsert')}
              min={0.01}
              max={0.99}
              step={0.01}
              value={loopPosition}
              onChange={(e) => useFormStore.getState().setLoopPosition(Number(e.target.value))}
              style={{ width: '7rem' }}
            />
          </div>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.weld')}</span>
            <span className="form-seg" data-testid="form-weld-distance">
              <NumericInput
                value={weldDistance}
                min={0}
                max={100}
                step={0.5}
                decimals={2}
                ariaLabel={workbenchText('FormPanel.weldCloseDistance')}
                tooltip={workbenchText('FormPanel.weldCloseJoinsPointsThisCloseToOneAnother')}
                onChange={(n) => useFormStore.getState().setWeldDistance(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">{workbenchText('FormPanel.mmApart')}</span>
            </span>
          </div>
        </PaletteGroup>
        <PaletteGroup id="openings" title={workbenchText('FormPanel.openings')} layout={layout}>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.bridge')}</span>
            <span className="form-seg" data-testid="form-bridge-segments">
              <NumericInput
                value={bridgeSegments}
                min={1}
                max={32}
                step={1}
                decimals={0}
                ariaLabel={workbenchText('FormPanel.bridgeSegments')}
                tooltip={workbenchText('FormPanel.howManyRingsOfFacesLongBridgeMakesThe')}
                onChange={(n) => useFormStore.getState().setBridgeSegments(n)}
                style={{ width: '3.2rem' }}
              />
              <span className="form-seg-label">{workbenchText('FormPanel.long')}</span>
            </span>
            <span className="form-seg" data-testid="form-bridge-twist">
              <NumericInput
                value={bridgeTwist}
                min={-64}
                max={64}
                step={1}
                decimals={0}
                ariaLabel={workbenchText('FormPanel.bridgeTwist')}
                tooltip={workbenchText('FormPanel.howManyPointsRoundABridgeBetweenTwoClosed')}
                onChange={(n) => useFormStore.getState().setBridgeTwist(n)}
                style={{ width: '3.2rem' }}
              />
              <span className="form-seg-label">{workbenchText('FormPanel.twist')}</span>
            </span>
          </div>
          {open && (
            <div className="form-row">
              <span className="form-row-label">{workbenchText('FormPanel.thicken')}</span>
              <span className="form-seg" data-testid="form-thickness">
                <NumericInput
                  value={thickness}
                  min={0.1}
                  max={50}
                  step={0.5}
                  decimals={2}
                  ariaLabel={workbenchText('FormPanel.thickenWallThickness')}
                  tooltip={workbenchText('FormPanel.wallThicknessThickenGivesAnOpenForm01')}
                  onChange={(n) => useFormStore.getState().setThickness(n)}
                  style={{ width: '4.5rem' }}
                />
                <span className="form-seg-label">{workbenchText('FormPanel.mmWall')}</span>
              </span>
            </div>
          )}
        </PaletteGroup>
        <PaletteGroup id="symmetry" title={workbenchText('FormPanel.symmetry')} layout={layout}>
          {symmetry !== null && circularCount(symmetry) === null && (
            <div className="form-row">
              <span className="form-row-label">{workbenchText('FormPanel.mirror2')}</span>
              <span className="form-seg" data-testid="form-mirror-at">
                <NumericInput
                  value={symmetryAt}
                  min={-10000}
                  max={10000}
                  step={1}
                  decimals={3}
                  ariaLabel={workbenchText('FormPanel.mirrorPlanePosition')}
                  tooltip={symmetry === 'p' ? workbenchText('FormPanel.whereThePlacedMirrorPlaneSitsAlongItsNormal') : workbenchText('FormPanel.whereTheMirrorPlaneSitsOnMovingItPairs', { value1: String(symmetry.toUpperCase()) })}
                  onChange={(n) => useFormStore.getState().setSymmetryAt(n)}
                  style={{ width: '5rem' }}
                />
                <span className="form-seg-label">{symmetry === 'p' ? workbenchText('FormPanel.mmOffset') : workbenchText('FormPanel.mmOn', { value1: String(symmetry.toUpperCase()) })}</span>
              </span>
            </div>
          )}
          {symmetry !== null && circularCount(symmetry) !== null && (
            <div className="form-row">
              <span className="form-row-label">{workbenchText('FormPanel.circular')}</span>
              <span className="form-seg" data-testid="form-circular-copies">
                <NumericInput
                  value={circularCopies}
                  min={2}
                  max={24}
                  step={1}
                  decimals={0}
                  ariaLabel={workbenchText('FormPanel.circularCopies')}
                  tooltip={workbenchText('FormPanel.howManyCopiesRoundTheZAxisCircularSymmetry')}
                  onChange={(n) => useFormStore.getState().setCircularCopies(n)}
                  style={{ width: '3.6rem' }}
                />
                <span className="form-seg-label">{workbenchText('FormPanel.copies')}</span>
              </span>
            </div>
          )}
        </PaletteGroup>
        <PaletteGroup id="display" title={workbenchText('FormPanel.display')} layout={layout}>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.tolerance')}</span>
            <span className="form-seg" data-testid="form-tolerance">
              <NumericInput
                value={tolerance}
                min={0.001}
                max={1}
                step={0.005}
                decimals={3}
                ariaLabel={workbenchText('FormPanel.finishedBodyChordTolerance')}
                tooltip={workbenchText('FormPanel.howFarTheFinishedBodySFacetsMayStray')}
                onChange={(n) => useFormStore.getState().setTolerance(n)}
                style={{ width: '4.5rem' }}
              />
              <span className="form-seg-label">{workbenchText('FormPanel.mmChord')}</span>
            </span>
          </div>
          <div className="form-row">
            <span className="form-row-label">{workbenchText('FormPanel.smooth')}</span>
            <span className="form-seg" data-testid="form-skin-level">
              <NumericInput
                value={skinLevel}
                min={0}
                max={MAX_SKIN_LEVEL}
                step={1}
                decimals={0}
                ariaLabel={workbenchText('FormPanel.smoothSkinDisplayLevel')}
                tooltip={workbenchText('FormPanel.subdivisionLevelTheSmoothSkinIsDrawnAt1', { MAX_SKIN_LEVEL: String(MAX_SKIN_LEVEL) })}
                onChange={(n) => useFormStore.getState().setSkinLevel(n)}
                style={{ width: '3.2rem' }}
              />
              <span className="form-seg-label">{skinLevel === 0 ? workbenchText('FormPanel.levelAuto') : workbenchText('FormPanel.level')}</span>
            </span>
          </div>
        </PaletteGroup>
        <div className="form-static-status">
          <div>{catalogChildren(workbenchText('FormPanel.combinedSmoothSkinLevelAtRestWhileDragging', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: levels.rest, value2: levels.drag })}</div>
          <div className="form-hint">{workbenchText('FormPanel.altDragAMoveArrowToExtrudeTheSelected', { value1: String((symmetry !== null && !symmetry.startsWith('c') ? workbenchText('FormPanel.dragTheMirrorPlaneToSlideIt') : '')) })}</div>
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
  const workbenchText = useText('sketch-and-model-workbench')
  if (Children.toArray(children).length === 0) return null
  const folded = layout.isCollapsed(id)
  return (
    <div className="form-group" data-testid={`form-group-${id}`}>
      <button
        type="button"
        className="form-group-header"
        data-testid={`form-group-toggle-${id}`}
        aria-expanded={!folded}
        data-tooltip={folded ? workbenchText('FormPanel.showTheSettings', { title: String(title) }) : workbenchText('FormPanel.hideTheSettings', { title: String(title) })}
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
