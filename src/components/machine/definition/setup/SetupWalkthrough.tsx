import { liveCatalog } from '../catalogText'
import { textFor, useText } from '../../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useState } from 'react'
import { AXIS_NAMES, createDefaultControllerDefinition } from '../../../../types'
import type { MachineDefinitionPanelState } from '../useMachineDefinitionPanel'
import type { OverviewFacts } from '../../../../lib/machine/overviewFacts'
import { StepRail, type SetupStepRailItem } from './StepRail'
import { Step1WhatIsThisMachine } from './steps/Step1WhatIsThisMachine'
import { Step2AxesAndTravel } from './steps/Step2AxesAndTravel'
import { Step3WhereIsHome } from './steps/Step3WhereIsHome'
import { Step4Spindle } from './steps/Step4Spindle'
import { Step5OutputsAndCoolant } from './steps/Step5OutputsAndCoolant'
import { Step6ProbeAndToolSetter } from './steps/Step6ProbeAndToolSetter'
import { Step7CheckAndSave } from './steps/Step7CheckAndSave'
import './SetupWalkthrough.css'

// WO-1696 (v2/SLICES.md T13) - "try again to make this intuitive and clean
// to setup in the first place" (Operator, README.md 2026-09-18). Seven steps,
// Back/Skip/Next on each, every step reachable from the rail at any time
// (rule 11: nothing here refuses a jump). Steps 2-6 render the SAME editors
// WO-1690..1693 built - the same `draft`/`editDraft`/patch callbacks this
// panel already carries - so a value typed here is the record field an area
// edits later, never a second copy.

const STEP_KEYS = ['what', 'axes', 'home', 'spindle', 'outputs', 'probing', 'review'] as const
type StepKey = typeof STEP_KEYS[number]

const STEP_LABELS: Record<StepKey, string> = liveCatalog(() => ({
  what: controlText('SetupWalkthrough.text001'),
  axes: controlText('SetupWalkthrough.text002'),
  home: controlText('SetupWalkthrough.text003'),
  spindle: controlText('SetupWalkthrough.text004'),
  outputs: controlText('SetupWalkthrough.text005'),
  probing: controlText('SetupWalkthrough.text006'),
  review: controlText('SetupWalkthrough.text007'),
}))

// AUDIT FIX (fix round 2): the review step's five Open buttons (WO-1688's
// OverviewCards, reused verbatim per outcome 4) were wired to a no-op - five
// inert controls. Decide-and-log: Open jumps back to the walkthrough step
// that edits that card, rather than closing the walkthrough and switching
// the definition page's own tab the way WO-1709 wired the Overview tab's
// Open buttons. Both were live options; "jump to the step" is the one that
// works the same way for all three entry points and never drops an unsaved
// edit silently:
//   - Entry points 2/3 (the definition page, no definition / Controller
//     area "Run again") mount the walkthrough inside the SAME
//     useMachineDefinitionPanel() the page's own tabs read, so closing the
//     walkthrough there would not lose anything by itself.
//   - Entry point 1 (Machine Library "New machine") does NOT: it mounts a
//     second, independent useMachineDefinitionPanel() instance
//     (`MachineLibraryWalkthroughHost` in MachineLibraryModal.tsx) with its
//     own draft, and the modal has no per-area tabs to send it to at all -
//     closing early there means Exit's fix-round-1 refresh only restores
//     what commit() already saved, dropping whatever the operator had typed
//     on the step since the last save.
// One mechanism, same five keys `overviewFacts`/OverviewCards/WO-1709 already
// use (machine/spindle/outputs/probing/controller), used everywhere.
const OVERVIEW_CARD_STEP: Record<keyof OverviewFacts, StepKey> = {
  // The Machine card states axes+travel+home together (overviewFacts.ts
  // machineLines); the walkthrough splits that into two steps, so Open lands
  // on the first.
  machine: 'axes',
  spindle: 'spindle',
  outputs: 'outputs',
  probing: 'probing',
  // The Controller card's facts (e-stop pin, faults) are not asked by any
  // walkthrough step - outcome 1 leaves what a step doesn't ask "reachable
  // later under All settings". "what" (controller type/identity) is the
  // closest step this walkthrough has for that card.
  controller: 'what',
}

type StepStatus = 'pending' | 'done' | 'skipped'

export type SetupWalkthroughProps = MachineDefinitionPanelState & {
  /** Called once Save (step 7) or an explicit close has run. Undefined is a
   *  valid, no-op exit for a caller with nothing else to do afterwards. */
  onExit?: () => void
}

export function SetupWalkthrough(props: SetupWalkthroughProps) {
  useText('control-screens-not-probing')
  const { def, draft, editDraft, onExit } = props
  const [stepIndex, setStepIndex] = useState(0)
  const [status, setStatus] = useState<Record<StepKey, StepStatus>>(() => {
    // A machine that already carries a controller definition (re-entering the
    // walkthrough via "Run the setup walkthrough again", WO-1694) has already
    // answered steps 2-6 - the rail says so rather than presenting them as
    // untouched.
    const already: StepStatus = def ? 'done' : 'pending'
    return { what: 'pending', axes: already, home: already, spindle: already, outputs: already, probing: already, review: 'pending' }
  })

  const markFilled = (keys: string[]) => {
    setStatus((current) => {
      const next = { ...current }
      for (const key of keys) {
        if ((STEP_KEYS as readonly string[]).includes(key)) next[key as StepKey] = 'done'
      }
      return next
    })
  }

  const ensureDefinition = () => {
    if (draft.controllerDefinition) return
    editDraft((m) => ({ ...m, controllerDefinition: createDefaultControllerDefinition(AXIS_NAMES) }))
  }

  const goTo = (index: number) => {
    if (index >= 1) ensureDefinition()
    setStepIndex(Math.max(0, Math.min(STEP_KEYS.length - 1, index)))
  }

  const back = () => { goTo(stepIndex - 1) }
  const skip = () => {
    setStatus((current) => ({ ...current, [STEP_KEYS[stepIndex]]: 'skipped' }))
    goTo(stepIndex + 1)
  }
  const next = () => {
    setStatus((current) => (current[STEP_KEYS[stepIndex]] === 'pending'
      ? { ...current, [STEP_KEYS[stepIndex]]: 'done' }
      : current))
    goTo(stepIndex + 1)
  }

  const rail: SetupStepRailItem[] = STEP_KEYS.map((key, index) => ({
    key,
    label: STEP_LABELS[key],
    status: index === stepIndex ? 'current' : status[key],
  }))

  const currentKey = STEP_KEYS[stepIndex]
  const isLast = stepIndex === STEP_KEYS.length - 1

  return (
    <section className="setup-walkthrough" data-testid="setup-walkthrough">
      <div className="setup-walkthrough-body" style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        <StepRail steps={rail} onSelect={goTo} />
        <div className="setup-walkthrough-step" style={{ flex: 1, minWidth: 0 }}>
          {currentKey === 'what' && (
            <Step1WhatIsThisMachine draft={draft} editDraft={editDraft} onFilled={markFilled} />
          )}
          {currentKey === 'axes' && def && (
            <Step2AxesAndTravel
              def={def}
              draft={draft}
              patchAxis={props.patchAxis}
              patchAxisSoftLimit={props.patchAxisSoftLimit}
              toggleAxisEnabled={props.toggleAxisEnabled}
            />
          )}
          {currentKey === 'home' && def && (
            <Step3WhereIsHome
              def={def}
              draft={draft}
              editDraft={editDraft}
              order={props.order}
              setHomingOrderAt={props.setHomingOrderAt}
              patchHoming={props.patchHoming}
              defineHoming={props.defineHoming}
              enabledAxes={props.enabledAxes}
              skewTyped={props.skewTyped}
              setSkewTyped={props.setSkewTyped}
            />
          )}
          {currentKey === 'spindle' && (
            <Step4Spindle
              draft={draft}
              editDraft={editDraft}
              source={props.source}
              unsent={props.unsent}
              spindleLink={props.spindleLink}
              spindleLinkIsForeign={props.spindleLinkIsForeign}
              spindleLinkOtherMachine={props.spindleLinkOtherMachine}
              spindleStoredIsStated={props.spindleStoredIsStated}
              vfdEdit={props.vfdEdit}
            />
          )}
          {currentKey === 'outputs' && (
            <Step5OutputsAndCoolant draft={draft} editDraft={editDraft} unsent={props.unsent} />
          )}
          {currentKey === 'probing' && def && (
            <Step6ProbeAndToolSetter
              def={def}
              draft={draft}
              editDraft={editDraft}
              patchIoPin={props.patchIoPin}
              pinProblem={props.pinProblem}
              polarityBoxFor={props.polarityBoxFor}
            />
          )}
          {currentKey === 'review' && (
            <Step7CheckAndSave
              draft={draft}
              applying={props.applying}
              applyState={props.applyState}
              applyTooltip={props.applyTooltip}
              applyIsCurrent={props.applyIsCurrent}
              handleApply={props.handleApply}
              commit={props.commit}
              connectionPhase={props.connectionPhase}
              editsConnectedMachine={props.editsConnectedMachine}
              onOpenArea={(key) => { goTo(STEP_KEYS.indexOf(OVERVIEW_CARD_STEP[key])) }}
              onSaved={() => { onExit?.() }}
            />
          )}

          <div className="setup-walkthrough-footer" style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <button
              type="button"
              className="control-chip-btn"
              data-testid="setup-walkthrough-back"
              disabled={stepIndex === 0}
              onClick={back}
            >{controlText('SetupWalkthrough.text008')}</button>
            {!isLast && (
              <button type="button" className="control-chip-btn" data-testid="setup-walkthrough-skip" onClick={skip}>{controlText('SetupWalkthrough.text009')}</button>
            )}
            {!isLast && (
              <button type="button" className="control-chip-btn" data-testid="setup-walkthrough-next" onClick={next}>{controlText('SetupWalkthrough.text010')}</button>
            )}
            {onExit && (
              <button
                type="button"
                className="control-chip-btn"
                data-testid="setup-walkthrough-exit"
                style={{ marginLeft: 'auto' }}
                onClick={onExit}
              >{controlText('SetupWalkthrough.text011')}</button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
