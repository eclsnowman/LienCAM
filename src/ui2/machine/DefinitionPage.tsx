// WO-3303: one definition area of the selected machine. The area bodies are today's area
// components (the same record, the same store writes); this page lays them out in the window and
// adds the bar (kind, controller, save, revert, apply) and the area's own list of what needs fixing.
import { useText } from '../../i18n'
import { Button, Select, TextField } from '../../components/kit'
import {
  MACHINE_CONTROLLER_OPTIONS, MACHINE_KIND_OPTIONS, LinuxControllerNetworkSetup, ReferencePositionsSection,
} from '../../components/machine/MachineDefinitionPanel'
import type { MachineDefinitionPanelState } from '../../components/machine/definition/useMachineDefinitionPanel'
import { MachineArea } from '../../components/machine/definition/MachineArea'
import { SpindleArea } from '../../components/machine/definition/SpindleArea'
import { ControllerArea } from '../../components/machine/definition/ControllerArea'
import { ProbingArea } from '../../components/machine/definition/ProbingArea'
import { ControllerSetupSection } from '../../components/machine/definition/ControllerSetupSection'
import { ControllerDefinitionSection } from '../../components/machine/definition/ControllerDefinitionSection'
import { ImportIssuesSection } from '../../components/machine/definition/ImportIssuesSection'
import { AllSettingsTable } from '../../components/machine/definition/AllSettingsTable'
import { SkewField } from '../../components/machine/definition/SkewField'
import { OperatorStopParkSection } from '../../components/machine/definition/OperatorStopParkSection'
import { CoolantCapabilitySection } from '../../components/machine/definition/CoolantCapabilitySection'
import { OutputsSection } from '../../components/machine/definition/OutputsSection'
import { ChargePumpSection, DriveFaultInputsSection } from '../../components/machine/definition/DriveSignalsSection'
import { SetupWalkthrough } from '../../components/machine/definition/setup/SetupWalkthrough'
import type { ControllerType, MachineKind } from '../../types'
import type { FixingItem } from './fixing'
import { setMachinePage, type DefinitionArea } from './windowState'

type Panel = MachineDefinitionPanelState

/** What today's panel puts under its section bar on the Overview and Controller sections. */
export function LinuxSetupBlock({ panel }: { panel: Panel }) {
  return (
    <>
      <LinuxControllerNetworkSetup state={panel.linuxSetup} />
      {panel.linuxSetup.serialPermission && <p className="ui2-machine-note" role="status" data-testid="linux-serial-permission">{panel.linuxSetup.serialPermission}</p>}
    </>
  )
}

/** Whether the setup walkthrough is up on this page. The window owns it, so it outlives this page
 *  being remounted when the draft gains a controller definition (the walkthrough's first Next). */
export interface WalkthroughView { readonly show: boolean; open(): void; close(): void }

export function DefinitionPage({ panel, page, items, walkthrough }: { panel: Panel; page: DefinitionArea; items: readonly FixingItem[]; walkthrough: WalkthroughView }) {
  const t = useText('ui2-machine.wo3303')
  const { show: showWalkthrough, open: openWalkthrough, close: closeWalkthrough } = walkthrough
  const { def, draft, editDraft, dirty, saved, commit, revert, handleApply, applying, editsConnectedMachine, setupKind } = panel
  // the areas' own links (GRBL table, fault settings) navigate the window, not the hook's hidden section
  const state = { ...panel, section: page, setSection: (area: Panel['section']) => setMachinePage(area) } as Panel
  const here = items.filter(i => i.area === page)
  // the controller area's "run the setup walkthrough again" stub opens the walkthrough from here
  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('[data-testid="machine-def-controller-walkthrough"]')) return
    event.preventDefault()
    event.stopPropagation()
    openWalkthrough()
  }
  return (
    <div className="ui2-machine-definition" data-testid="machine-definition" data-page={page} data-machine-id={draft.id} onClickCapture={onClickCapture}>
      <div className="ui2-machine-bar" data-testid="machine-def-bar">
        <Select
          testId="machine-def-kind" ariaLabel={t('kind')} value={draft.kind ?? 'router'}
          options={MACHINE_KIND_OPTIONS.map(k => ({ value: k.value, label: k.label }))}
          onChange={v => editDraft(m => ({ ...m, kind: v as MachineKind }))}
        />
        <Select
          testId="machine-def-controller" ariaLabel={t('controllerLabel')} value={draft.controller}
          options={[
            ...(MACHINE_CONTROLLER_OPTIONS.some(c => c.value === draft.controller) ? [] : [{ value: draft.controller, label: draft.controller }]),
            ...MACHINE_CONTROLLER_OPTIONS.map(c => ({ value: c.value, label: c.label })),
          ]}
          onChange={v => editDraft(m => ({ ...m, controller: v as ControllerType }))}
        />
        {page === 'allSettings' && (
          <TextField testId="machine-def-search" ariaLabel={t('findSetting')} placeholder={t('findSetting')} value={panel.settingSearch} onChange={panel.setSettingSearch} />
        )}
        <span className="ui2-machine-bar-spacer" />
        <Button kind="momentary" testId="machine-def-revert" label={t('revert')} onPress={() => { if (dirty) revert() }} availability={dirty ? undefined : { ready: false, reason: 'ui2-machine.wo3303:nothingToRevert' }} />
        <Button kind="momentary" testId="machine-def-save" emphasis="primary" label={saved && !dirty ? t('saved') : t('save')} onPress={() => { commit() }} />
        {def && editsConnectedMachine && (
          <Button kind="momentary" testId="machine-def-apply" label={applying ? t('applying') : t('apply')} onPress={() => { void handleApply() }} />
        )}
      </div>
      {here.length > 0 && (
        <ul className="ui2-machine-fixing ui2-machine-fixing-here" data-testid="machine-def-fixing">
          {here.map(i => <li key={i.id} data-testid="machine-def-fixing-item">{i.text}</li>)}
        </ul>
      )}
      {showWalkthrough ? <SetupWalkthrough {...state} onExit={closeWalkthrough} /> : (
        <div className="ui2-machine-area" data-testid={`machine-area-${page}`}>
          {page === 'controller' && <LinuxSetupBlock panel={panel} />}
          {!def && page === 'controller' && (<><ControllerSetupSection {...state} />{panel.importIssues.length > 0 && <ImportIssuesSection {...state} />}</>)}
          {!def && page !== 'controller' && page !== 'overview' && (
            <div className="ui2-machine-undefined" data-testid="machine-def-section-undefined">
              <p className="ui2-machine-note">{t('undefinedNote', { name: draft.name })}</p>
              <Button kind="momentary" testId="machine-def-section-define" label={t('defineMachine')} onPress={panel.defineController} />
              <Button kind="momentary" testId="machine-def-run-walkthrough" label={t('runWalkthrough')} onPress={openWalkthrough} />
            </div>
          )}
          {!def && page === 'overview' && (
            <>
              <ControllerSetupSection {...state} />
              {panel.importIssues.length > 0 && <ImportIssuesSection {...state} />}
              <ControllerDefinitionSection {...state} />
              <Button kind="momentary" testId="machine-def-panel-run-walkthrough" label={t('runWalkthrough')} onPress={openWalkthrough} />
              {setupKind !== 'serial' && (
                <SkewField machine={draft} typed={panel.skewTyped} onTyped={panel.setSkewTyped} onChange={editDraft} standalone />
              )}
              <CoolantCapabilitySection machine={draft} onChange={editDraft} />
              <ReferencePositionsSection machine={draft} onChange={editDraft} />
              <OperatorStopParkSection machine={draft} onChange={editDraft} />
            </>
          )}
          {def && page === 'allSettings' && <AllSettingsTable {...state} />}
          {def && page === 'spindle' && <SpindleArea {...state} />}
          {def && page === 'probing' && <ProbingArea {...state} def={def} />}
          {def && page === 'machine' && <MachineArea {...state} def={def} />}
          {def && page === 'controller' && (
            <>
              <ControllerArea {...state} />
              <DriveFaultInputsSection machine={draft} onChange={editDraft} />
              <ControllerDefinitionSection {...state} />
            </>
          )}
          {def && page === 'outputs' && (
            <>
              <CoolantCapabilitySection machine={draft} onChange={editDraft} settings={panel.unsent} />
              <ChargePumpSection machine={draft} onChange={editDraft} />
              <OutputsSection machine={draft} onChange={editDraft} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
