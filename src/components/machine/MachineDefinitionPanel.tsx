import { RotateCcw } from 'lucide-react'
import { Component } from 'react'
import { Check } from 'lucide-react'
import { Search } from 'lucide-react'
import { Cpu } from 'lucide-react'
import { NumericInput } from '../ui/NumericInput'
import {
  machineReferencePositions,
  type ControllerType,
  type MachineConfig,
  type MachineKind,
  type MachineReferencePositionNumber,
} from '../../types'
import { DIALECT_OPTIONS } from '../../lib/post'
import { SkewField } from './definition/SkewField'
import { OperatorStopParkSection } from './definition/OperatorStopParkSection'
import { OverviewCards } from './definition/OverviewCards'
import { CoolantCapabilitySection } from './definition/CoolantCapabilitySection'
import { OutputsSection } from './definition/OutputsSection'
import { ChargePumpSection, DriveFaultInputsSection } from './definition/DriveSignalsSection'
import './MachineDefinitionPanel.css'
import { useMachineDefinitionPanel, type MachineDefinitionPanelProps } from './definition/useMachineDefinitionPanel'
export type { MachineDefinitionPanelProps } from './definition/useMachineDefinitionPanel'
export { unmarkedControlsIn, doublyMarkedControlsIn } from './definition/DefinitionFields'
export { definitionProblemGroup } from './definition/DefinitionNavigation'
import { ControllerSetupSection } from './definition/ControllerSetupSection'
import { ImportIssuesSection } from './definition/ImportIssuesSection'
import { MachineArea } from './definition/MachineArea'
import { SpindleArea } from './definition/SpindleArea'
import { ControllerArea } from './definition/ControllerArea'
import { ProbingArea } from './definition/ProbingArea'
import { DefinitionSectionNav, DEF_GROUPS, type DefGroup } from './definition/DefinitionNavigation'
import { Plus } from 'lucide-react'
import { ControllerDefinitionSection } from './definition/ControllerDefinitionSection'
import { AllSettingsTable } from './definition/AllSettingsTable'
import { SetupWalkthrough } from './definition/setup/SetupWalkthrough'
import { useSetupWalkthroughVisibility } from './definition/setup/useSetupWalkthroughVisibility'
// WO-939 - the CONTROL half of a machine record, laid out for a PAGE.
//
// ONE MACHINE RECORD, TWO SURFACES. `MachineConfig`'s top-level fields are the
// CAM half and live in the Machine Library modal (travel, spindle range, tool
// changer, probing defaults). `MachineConfig.controllerDefinition` is the
// CONTROL half - the `.pro` content, essentially one-for-one - and that is what
// this panel edits. There is no second data model and no second storage
// location: this writes through `updateMachineInLibrary` and also updates
// `project.machine` when Control is editing CAM's selected record, exactly as
// `MachineLibraryModal.commitDraft` does. `machineLibrary` is the Control
// carrier; `project.machine` remains CAM's project-local mirror.
//
// WHY A PANEL AT ALL. Measured in the real app, the modal hides 1473px of its
// own content behind a scroll, and two of the definition's fields
// (`enableDelayMs` and the per-axis `backlash`) are not rendered by it AT ALL -
// they exist in the record, they reach the bridge, and until now no surface
// could show or change them. Operator ruling 2026-08-24: "the modal is cramped for
// everything that lives in the .pro file to be exposed ... the control ->
// machine -> machine definitions page has much more space to expose settings."
//
// THREE RULES THIS FILE IS BUILT AROUND, none of them style preferences:
//
//   1. NOTHING HERE MAY SIT BETWEEN AN OPERATOR AND THE E-STOP. This panel
//      edits settings. It has no control that moves the machine, no control
//      that talks to the board, and no state that can gate one. The e-stop pin
//      appears here as a PIN ASSIGNMENT - a number on a wiring diagram - and
//      changing it changes the record, never the running machine.
//   2. A CONTROL THAT TALKS TO THE BOARD MUST BE EXPLICIT, AND THERE IS
//      EXACTLY ONE OF THEM (COHESION-STANDARD section 3; Operator 2026-08-23 and
//      2026-08-24). WO-941 moved "Apply to Machine" HERE from the Machine
//      Library modal and left nothing behind: SAVING is not APPLYING. Saving
//      writes the record and both surfaces may do it; APPLYING rewrites
//      steps/unit, soft limits, homing direction and pin assignments on a
//      board that may be powered, homed and holding a gantry - the same class
//      of act as commanding motion, and it belongs where an operator is
//      already attending to the machine. It is ONE call site into
//      `applyActiveMachineDefinition`, in its own labelled section, never
//      beside Save. Nothing about it gates a stop: it awaits a reply, holds no
//      lock, and disables no control but itself.
//   3. NEVER INVENT A MACHINE FACT. Every value rendered is the record's. An
//      absent value renders AS ABSENT and gets an explicit "Define" control -
//      it is never quietly replaced by a default. A default silently
//      substituted for a real value is the exact defect that reached Operator's
//      machine on 2026-08-24 and had to be reverted (4dcf9701). This is where
//      the panel deliberately differs from the modal, which falls back to
//      `createDefaultAxisHomingDefinition` while rendering a missing homing
//      block and so shows invented numbers as if someone had chosen them.
//
// A pin is TWO NUMBERS AND A NEGATE - port, pin, negate - carried, never
// computed. The one copy of the board's pin-translation table lives in the
// bridge (`AxbbPinDef`, pendant/uccnc-bridge/Machine.cs); a second copy in
// TypeScript would diverge invisibly and the board would accept, plan and count
// every move written to the wrong pin while emitting nothing.

// WO-1687 - the bar's Kind and Controller doors. Both are `MachineConfig`
// identity facts, not `controllerDefinition` settings, so they are not part
// of any settings group's census - the same reason the modal's own Kind/
// Controller selects (MachineLibraryModal.tsx) sit outside its disclosures.
// This page and the modal edit the SAME record (ADR-0049); duplicating the
// four-entry option list here rather than importing the modal's private
// consts keeps this order inside its owned paths.
// Exported for the setup walkthrough's step 1 (WO-1696, v2/SLICES.md T13):
// the same four-entry Kind list and the same dialect-registry Controller
// list, never a second copy typed into `setup/steps/Step1WhatIsThisMachine.tsx`.
export const MACHINE_KIND_OPTIONS: { value: MachineKind; label: string }[] = [
  { value: 'router', label: 'Router' },
  { value: 'plasma', label: 'Plasma' },
  { value: 'laser', label: 'Laser' },
  { value: 'knife', label: 'Knife' },
]
export const MACHINE_CONTROLLER_OPTIONS: { value: ControllerType; label: string }[] =
  DIALECT_OPTIONS.map((d) => ({ value: d.id as ControllerType, label: d.label }))

// WO-1713 fix round - Operator's phone screenshot showed the source line cut off
// mid-sentence with an ellipsis ("Saved profile. It becomes runtime auth...").
// A sentence is never truncated on this page; instead the pill shows a short,
// COMPLETE label and the full sentence (`authorityText`, unchanged) moves to
// `data-tooltip` - the same hover convention this page already uses for
// Revert/Save/Apply (see ThemedTooltip, src/styles/app.css ~5096). Keyed by
// `authorityState`, not by the sentence itself, so a wording change to
// `authorityText` in useMachineDefinitionPanel.tsx can never desync the two.
// "Pending - reconnect" keeps `/pending.*reconnect/i` literally true - the
// same live regex two out-of-lane suites (WO-1147, WO-1660) already read off
// this element's rendered text.
const DEF_GROUP_LABEL = Object.fromEntries(DEF_GROUPS.map(([key, label]) => [key, label])) as Record<DefGroup, string>

const AUTHORITY_TAG_TEXT: Record<string, string> = {
  saved: 'Saved profile',
  pending: 'Pending - reconnect',
  applied: 'Applied - live',
  session: 'Live this session',
}

// WO-1713 fix round - a native <select> sizes its closed box to its WIDEST
// option, not the one currently shown; one of `MACHINE_CONTROLLER_OPTIONS`'s
// entries ("Generic (linear only)", `base.ts`) is 21 characters, which is
// what forced this bar's Controller select wide enough to push Kind onto a
// separate line on a phone even after fixing the clipping bug below. This
// map only shortens what THIS bar's dropdown reads, by option value; the
// exported `MACHINE_CONTROLLER_OPTIONS` (and the setup walkthrough's own
// copy of it, Step1WhatIsThisMachine.tsx) keep the full label unchanged. A
// whole shorter WORD, not an ellipsis - never a sentence, so the "never
// truncate" rule this fix round is about does not apply to it.
const BAR_CONTROLLER_OPTION_LABEL: Record<string, string> = {
  'Generic (linear only)': 'Generic',
}

export function MachineDefinitionPanel(props: MachineDefinitionPanelProps = {}) {
  const panel = useMachineDefinitionPanel(props)
  const { applyTooltip, applying, applyIsCurrent: panelApplyIsCurrent, applyState, assignedPins, authorityState, authorityText, commit, def, dirty, draft, editDraft, editsConnectedMachine, enabledAxes, handleApply, importIssues, order, panelBodyRef, problems, revert, saved, section, setSection, setSkewTyped, settingSearch, setSettingSearch, setupKind, skewTyped, unsent, visiblePins } = panel
  const applyIsCurrent = panelApplyIsCurrent && applyState !== null

  // ---- WO-1696 (v2/SLICES.md T13): THE SETUP WALKTHROUGH -------------------
  // Entry point 2 ("the definition page when the machine has no definition")
  // is a NEW button rendered alongside `ControllerDefinitionSection`'s
  // existing "Define this machine" rather than a full replacement of it
  // (the WO's own wording). Several landed tests outside this order's owned
  // paths (`skewCompensation.wo996`, `machineDefinitionPanel.wo939`,
  // `machineDefinitionCompact.wo1114`, `machineDefinitionEditor.wo913`,
  // `applyDefinition.wo928`, `applyBoundary.wo941`) assert
  // `machine-def-panel-undefined`/`machine-def-panel-define` and that
  // pressing Define reveals the Legacy axis table immediately - rule 4 grants
  // this order `MachineDefinitionPanel.tsx` but none of those test files, so
  // replacing that branch outright would fail six suites this order has no
  // authority to re-pin. Decide-and-log (rule 3): additive, not a swap: both
  // paths reach the SAME `defineController`/record, "Define this machine"
  // keeps its old one-step behaviour, and the walkthrough is the second,
  // guided way in - not a hidden one, since it is the only door for entry
  // point 3's re-entry and for a defined machine's own "Axes and travel" etc.
  //
  // Entry point 3 ("the Controller area's 'Run the setup walkthrough again'")
  // is a re-entry this panel drives by intercepting WO-1694's stub button in
  // the capture phase - before its own `onClick` (a console-only
  // decide-and-log placeholder, `data-testid="machine-def-controller-walkthrough"`)
  // can run - because `ControllerArea.tsx` is not in this order's owned paths
  // and must stay unedited. `stopPropagation` on a capture-phase handler
  // keeps the bubble phase from ever reaching that button's own listener (the
  // DOM's ordinary capture/bubble contract), so nothing about the stub fires
  // once this order has landed. Entry point 1 (Machine Library "New machine")
  // is `MachineLibraryModal.tsx`'s own concern - see the walkthrough mounted
  // there, over the SAME record via `setControlMachineId`.
  const { showWalkthrough, openWalkthrough, closeWalkthrough } = useSetupWalkthroughVisibility()
  const handlePanelBodyClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null
    const walkthroughButton = target?.closest('[data-testid="machine-def-controller-walkthrough"]')
    if (!walkthroughButton) return
    event.preventDefault()
    event.stopPropagation()
    openWalkthrough()
  }


  return (
    <section
      className="panel control-panel machine-definition-panel"
      data-testid="machine-definition-panel"
      data-machine-id={draft.id}
      data-dirty={dirty ? '' : undefined}
      // WO-1720: no `data-hide-unused-settings` any more. The WO-1122/1263
      // toggle that set it lived on the Legacy tab, which is gone; a stored
      // "used only" choice nobody can reach must not keep hiding settings.
    >
      <div className="panel-header">
        <span className="panel-title">Machine definition</span>
        {/* WO-1713: the machine's name used to repeat here (`machine-def-panel-
            machine-name`) - Operator ruling 2026-09-19: "why do we need the second
            horizontal banner saying the machine when we've already selected
            it up above?" The one case where the name IS news - this panel
            showing a machine Control does not drive - already says so in the
            authority line below (WO-1712); this header never needs a second
            copy. */}
        <span
          data-testid="machine-def-panel-summary"
          style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginLeft: 'auto' }}
        >
          {def ? (
            <>
              {enabledAxes.map((a) => a.axis).join('') || 'no axes'}
              {/* WO-1713 fix round: on a phone this is what CSS shortens
                  first (`.machine-def-summary-home`, hidden under 640px) -
                  the words are unchanged, never cut mid-word, still fully
                  present in the DOM either way (wo913's own
                  `toContain('home Z,X,Y')` reads this same node). */}
              <span className="machine-def-summary-home">{` / home ${order.join(',') || 'none'}`}</span>
              {` / ${assignedPins} of ${visiblePins.length} pins`}
              {problems.length > 0 ? ` / ${problems.length} to fix` : ''}
            </>
          ) : 'Not defined'}
        </span>
        <button
          type="button"
          className="control-chip-btn"
          data-testid="machine-def-panel-revert"
          disabled={!dirty}
          data-tooltip={dirty ? 'Discard these edits' : 'No unsaved changes'}
          onClick={revert}
          style={{ marginLeft: 8 }}
        >
          <RotateCcw size={12} /> Revert
        </button>
        <button
          type="button"
          className="control-chip-btn"
          data-testid="machine-def-panel-save"
          data-save-state={dirty ? 'dirty' : saved ? 'saved' : 'clean'}
          data-tooltip={dirty ? 'Save to this machine' : 'No unsaved changes'}
          onClick={() => { commit() }}
        >
          {saved ? <><Check size={12} /> Saved</> : 'Save'}
        </button>
      </div>

      <div
        className="panel-body"
        style={{ display: 'flex', flexDirection: 'column' }}
        ref={panelBodyRef}
        onClickCapture={handlePanelBodyClickCapture}
      >
        {showWalkthrough && (
          <SetupWalkthrough {...panel} onExit={closeWalkthrough} />
        )}
        {!showWalkthrough && (
        <>
        {/* ---- WO-1713: THE COMPACT ROW - the bar (Kind, Controller, Find
            any setting, Apply, and now the source tag) and the seven area
            tabs, together, wrapping cleanly on a phone rather than stacking
            as separate full-width rows. Operator ruling 2026-09-19: "Need to use
            better vertical space real estate." Fix round, same day: at
            412px this was still ~5 rows (a title that wrapped into two
            lines, the tag ellipsis-cut mid-sentence, Kind/Controller
            clipped, and the tab strip running off the right edge instead
            of wrapping) - every one of those is what the rules below fix.
            Nothing here is removed - the same controls, the same tabs, the
            same authority sentence - only how much of the page's height
            they claim. */}
        <div className="machine-def-compact-row" data-testid="machine-def-compact-row">
        {/* ---- WO-1687: THE BAR - Kind, Controller, Find any setting, Apply
            to machine. v2/SLICES.md T4. Below the panel header and above
            every tab, on every tab, because Kind/Controller are facts about
            the record (not one area's settings) and Apply is the one
            hardware verb (WO-941) - it must never be one tab further from
            the settings it sends, which is exactly as true of the seven new
            areas as it was of the three old groups. */}
        <div className="machine-def-bar" data-testid="machine-def-bar">
          {/* WO-1713 fix round: each label+select is one atomic flex item
              (`.machine-def-bar-field`) so a phone's wrap never splits a
              label from its own select onto separate lines - the split is
              what left "Controller" stranded with no select beside it. */}
          <span className="machine-def-bar-field">
            <label className="mform-label" htmlFor="machine-def-bar-kind">Kind</label>
            <select
              id="machine-def-bar-kind"
              className="mform-select"
              data-testid="machine-def-bar-kind"
              data-drives-this-app=""
              aria-label="Kind"
              value={draft.kind ?? 'router'}
              onChange={(e) => { editDraft((m) => ({ ...m, kind: e.target.value as MachineKind })) }}
            >
              {MACHINE_KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </span>
          <span className="machine-def-bar-field">
            <label className="mform-label" htmlFor="machine-def-bar-controller">Controller</label>
            <select
              id="machine-def-bar-controller"
              className="mform-select"
              data-testid="machine-def-bar-controller"
              data-drives-this-app=""
              aria-label="Controller"
              value={draft.controller}
              onChange={(e) => { editDraft((m) => ({ ...m, controller: e.target.value as ControllerType })) }}
            >
              {!MACHINE_CONTROLLER_OPTIONS.some((c) => c.value === draft.controller) && (
                <option value={draft.controller}>{`${draft.controller} (legacy)`}</option>
              )}
              {MACHINE_CONTROLLER_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>{BAR_CONTROLLER_OPTION_LABEL[c.label] ?? c.label}</option>
              ))}
            </select>
          </span>

          {/* ---- WO-1713 fix round: THE SOURCE LINE, SHRUNK TO A TAG -------
              The visible text is a short, COMPLETE label
              (`AUTHORITY_TAG_TEXT`, above) - never an ellipsis mid-sentence
              - and the full sentence moves to `data-tooltip`, the same
              hover convention this page already uses for Revert/Save/
              Apply. It sits here, right after Kind/Controller, because
              that is where this bar has spare width on a phone (Kind and
              Controller together leave room here; Find any setting and
              Apply do not) - Operator's fix-round ruling was "the tag goes on
              ... the compact row instead of its own row", and this bar IS
              the compact row's own first line. The ONE exception is
              WO-1712's line: a panel showing a machine Control does not
              drive is the one case where naming it is news, so that
              sentence keeps its own full-width line here rather than
              shrinking - `.machine-def-authority-line` in
              MachineDefinitionPanel.css gives it `flex-basis: 100%` for
              exactly that reason. */}
          <span
            data-testid="machine-def-panel-authority-status"
            data-authority-state={authorityState}
            className={editsConnectedMachine ? 'machine-def-authority-tag' : 'machine-def-authority-line'}
            data-tooltip={editsConnectedMachine ? authorityText : undefined}
            style={{ color: authorityState === 'pending' ? 'var(--warning)' : undefined }}
          >
            {editsConnectedMachine ? AUTHORITY_TAG_TEXT[authorityState] : authorityText}
          </span>

          <span className="machine-def-bar-search" style={{ position: 'relative', flex: 1, minWidth: 160 }}>
            <Search size={12} style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="search"
              className="mform-input"
              data-testid="machine-def-bar-search"
              data-drives-this-app=""
              placeholder="Find any setting"
              aria-label="Find any setting"
              value={settingSearch}
              onChange={(e) => { setSettingSearch(e.target.value) }}
              style={{ width: '100%', paddingLeft: 22 }}
            />
          </span>
          {/* WO-1712: editsConnectedMachine is the same flag the setup
              walkthrough's Step 7 already reuses for this - a panel aimed at
              a machine that is not the one Control drives (the travel link,
              a pending section request) has nothing to send, and Apply
              refusing that at the wire (machineSession.ts) is not the same
              as never offering a control that can only refuse. */}
          {def && editsConnectedMachine && (
            <button
              type="button"
              className="control-chip-btn"
              data-testid="machine-def-bar-apply"
              data-apply-state={
                applying ? 'applying'
                  : applyIsCurrent ? (applyState!.ok ? 'applied' : 'failed')
                    : 'idle'
              }
              disabled={applying}
              data-tooltip={applyTooltip}
              onClick={() => { void handleApply() }}
              style={{ minWidth: 148, justifyContent: 'center' }}
            >
              {applying
                ? 'Applying...'
                : applyIsCurrent && applyState!.ok
                  ? <><Check size={12} /> Applied</>
                  : applyIsCurrent
                    ? <><Cpu size={12} /> Apply failed</>
                    : <><Cpu size={12} /> Apply to Machine</>}
            </button>
          )}
        </div>

        <DefinitionSectionNav {...panel} />
        </div>

        {/* ---- A MACHINE WITH NO CONTROLLER DEFINITION ------------------------
            WO-1720: the seven areas all read the definition, so a machine
            without one gets the page the Legacy tab used to draw for it, on
            whichever tab is open: its link setup (a GRBL serial row is primary
            setup and must not start collapsed), what the import could not
            read, "Define this machine" and the guided walkthrough (WO-1696
            entry point 2), and the facts that do not wait for a definition -
            gantry skew, coolant, the G30 parks. Nothing here is assumed on
            the machine's behalf. */}
        {/* WO-1981: that page used to draw under EVERY tab, so no button
            seemed to do anything (Operator, 2026-09-25). Now: Controller shows
            the link setup and import notes, Overview keeps the full landing
            page (the old suites read it there), and every other section
            says in one line it has nothing yet, with the same Define action. */}
        {!def && section === 'controller' && (
          <>
            <ControllerSetupSection {...panel} />
            {importIssues.length > 0 && <ImportIssuesSection {...panel} />}
          </>
        )}
        {!def && section !== 'overview' && section !== 'controller' && (
          <div
            className="panel-empty"
            data-testid="machine-def-section-undefined"
            data-section={section}
          >
            {`${draft.name} has no controller definition, so ${DEF_GROUP_LABEL[section]} has nothing to show yet.`}
            <button
              type="button"
              className="control-chip-btn"
              data-testid="machine-def-section-define"
              data-tooltip="Describe this machine's axes, homing cycle and pin assignments"
              onClick={panel.defineController}
            >
              <Plus size={12} /> Define this machine
            </button>
          </div>
        )}
        {!def && section === 'overview' && (
          <>
            <ControllerSetupSection {...panel} />
            {importIssues.length > 0 && <ImportIssuesSection {...panel} />}
            <ControllerDefinitionSection {...panel} />
            <button
              type="button"
              className="control-chip-btn"
              data-testid="machine-def-panel-run-walkthrough"
              data-tooltip="Answer seven short questions instead - imports a .pro or a connected board, and every step can be skipped"
              onClick={openWalkthrough}
              style={{ marginTop: 8 }}
            >
              Run the setup walkthrough
            </button>
            {/* WO-1114: a GRBL machine's skew sits in the serial setup row
                above; the standalone copy is for controllers whose block has
                no row to join (bridge, simulator). */}
            {setupKind !== 'serial' && (
              <SkewField
                machine={draft}
                typed={skewTyped}
                onTyped={setSkewTyped}
                onChange={editDraft}
                standalone
              />
            )}
            {/* WO-965: a machine has or has not got coolant whether or not
                anybody has typed its pins yet. */}
            <CoolantCapabilitySection machine={draft} onChange={editDraft} />
            <ReferencePositionsSection machine={draft} onChange={editDraft} />
            <OperatorStopParkSection machine={draft} onChange={editDraft} />
          </>
        )}

        {/* ---- WO-1689: ALL SETTINGS ------------------------------------------
            T6 (v2/SLICES.md). WO-1720: every setting this machine carries -
            every catalogue key with its value, every named field the areas
            edit, and the app-kept facts - searchable by the bar's box above. */}
        {def && section === 'allSettings' && (
          <AllSettingsTable {...panel} />
        )}

        {/* ---- WO-1691: THE SPINDLE AREA ------------------------------------
            Drive, RPM range, direction and the collapsed VFD link, in one
            place - v2/SLICES.md T8. */}
        {def && section === 'spindle' && (
          <SpindleArea {...panel} />
        )}

        {/* ---- WO-1688: THE OVERVIEW, THE FIRST OF THE SEVEN TO GET A BODY.
            v2/SLICES.md T5. Five read-only cards, one pure read
            (`overviewFacts`) over the record - see OverviewCards.tsx. */}
        {def && section === 'overview' && (
          <OverviewCards draft={draft} setSection={setSection} />
        )}

        {/* ---- WO-1693 (T10): THE FIRST OF THE SEVEN TO LAND ---------------
            Probe/tool-setter pins and MachineProbeDefaults, in one place,
            instead of the WO-1687 placeholder below. Audit, 2026-09-19: a
            component owned by this order but reachable from nowhere is not a
            landed feature, so this wiring is this order's own fix, made
            through the section this order already owns (`ProbingSection.tsx`
            is what this same `{...panel}` spread already reaches at line
            521; `section === 'probing'` picks the same spread's other half). */}
        {def && section === 'probing' && (
          <ProbingArea {...panel} def={def} />
        )}

        {/* ---- WO-1694: THE CONTROLLER AREA ---------------------------------
            This computer's link, profile import/export, e-stop pin, faults,
            trajectory basics - v2/SLICES.md T11. */}
        {def && section === 'controller' && (
          <>
            <ControllerArea {...panel} />
            <DriveFaultInputsSection machine={draft} onChange={editDraft} />
            {/* WO-1720: a GRBL machine's board-side $-table - "Read from
                board" and "Apply stored" - was reachable only from the Legacy
                tab. It talks to the board, so it lives with the board link.
                Its offline edits write through the same `recordGrblSettings`
                All settings uses. */}
            <ControllerDefinitionSection {...panel} />
          </>
        )}

        {/* ---- WO-1690: THE MACHINE AREA - axes, travel, homing, pins ----- */}
        {def && section === 'machine' && (
          <MachineArea {...panel} def={def} />
        )}

        {/* ---- WO-1692: OUTPUTS & COOLANT --------------------------------
            T9. The list WO-1651 built, with coolant folded into its CAM role
            column (outcome 2) - the same two sections MotionSection renders
            on Legacy today, moved to their own door rather than duplicated. */}
        {def && section === 'outputs' && (
          <>
            <CoolantCapabilitySection machine={draft} onChange={editDraft} settings={unsent} />
            <ChargePumpSection machine={draft} onChange={editDraft} />
            <OutputsSection machine={draft} onChange={editDraft} />
          </>
        )}

        </>
        )}
      </div>
    </section>
  )

}

const REFERENCE_POINT_NUMBERS = [1, 2, 3, 4] as const

/** App-owned G30 parameters. UCCNC has no G30 position register, so these are
 * marked as driving this app: the reader turns them into checked G53 rapids,
 * while Apply to Machine sends none of them. */
class ReferencePositionsSection extends Component<{
  machine: MachineConfig
  onChange: (mut: (machine: MachineConfig) => MachineConfig) => void
}, { editing: boolean }> {
  state = { editing: false }

  private addPoint = (pointNumber: MachineReferencePositionNumber): void => {
    this.props.onChange((current) => ({
      ...current,
      referencePositions: {
        ...machineReferencePositions(current),
        [pointNumber]: { x: 0, y: 0, z: 0 },
      },
    }))
  }

  private setAxis = (
    pointNumber: MachineReferencePositionNumber,
    axis: 'x' | 'y' | 'z',
    value: number,
  ): void => {
    const { machine, onChange } = this.props
    const positions = machineReferencePositions(machine)
    const point = positions?.[pointNumber]
    if (!point) return
    onChange((current) => ({
      ...current,
      referencePositions: {
        ...machineReferencePositions(current),
        [pointNumber]: { ...point, [axis]: value },
      },
    }))
  }

  render() {
    const positions = machineReferencePositions(this.props.machine)
    const hasPositions = positions && REFERENCE_POINT_NUMBERS.some((number) => positions[number])
    return (
      <div data-testid="machine-def-reference-positions" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 'var(--font-size-sm)' }}>G30 reference positions</strong>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
            Machine coordinates (mm). G30.1 stores point 1 at the current position.
          </span>
          <details open={this.state.editing}>
            <summary
              data-testid="machine-def-reference-edit"
              onClick={(event) => {
                event.preventDefault()
                this.setState(({ editing }) => ({ editing: !editing }))
              }}
            >
              {this.state.editing ? 'Done editing' : 'Edit positions'}
            </summary>
          </details>
        </div>
        {hasPositions || this.state.editing ? (
          <table className="machine-def-table" data-testid="machine-def-reference-table">
            <thead><tr><th>Point</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
            <tbody>
              {REFERENCE_POINT_NUMBERS.map((pointNumber) => {
                const point = positions?.[pointNumber]
                return (
                  <tr key={pointNumber} data-testid={`machine-def-reference-point-${pointNumber}`}>
                    <th scope="row">P{pointNumber}</th>
                    {point ? (['x', 'y', 'z'] as const).map((axis) => (
                      <td key={axis} data-drives-this-app="">
                        {this.state.editing ? (
                          <NumericInput
                            value={point[axis]}
                            step={0.1}
                            ariaLabel={`G30 point ${pointNumber} ${axis.toUpperCase()} machine coordinate`}
                            className="mform-input mform-input-mono"
                            style={{ width: 90 }}
                            onChange={(value) => this.setAxis(pointNumber, axis, value)}
                          />
                        ) : point[axis]}
                      </td>
                    )) : (
                      <td colSpan={3} style={{ color: 'var(--text-muted)' }}>
                        {this.state.editing ? (
                          <button
                            type="button"
                            className="control-chip-btn"
                            data-testid={`machine-def-reference-add-${pointNumber}`}
                            onClick={() => { this.addPoint(pointNumber) }}
                          >
                            Add P{pointNumber}
                          </button>
                        ) : 'Not stored'}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div data-testid="machine-def-reference-none" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            No reference positions stored. Jog to the first park position and enter G30.1 in MDI.
          </div>
        )}
      </div>
    )
  }
}
