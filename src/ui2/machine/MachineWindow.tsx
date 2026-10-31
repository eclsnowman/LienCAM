// WO-3303: the Machine window (spec 5.1, windows: Settings, Tool library, Machine). Opened from the
// machine pill, `machine.open` and `machine.openDefinition`. A left list of pages (the library and
// the seven definition areas, each with the number of things still to fix) and the page itself.
import { useState } from 'react'
import { useText } from '../../i18n'
import { Window } from '../../components/kit'
import type { WindowNavItem } from '../../components/kit'
import { useCamStore } from '../../store'
import { useMachineDefinitionPanel } from '../../components/machine/definition/useMachineDefinitionPanel'
import { controllerDefinitionPins } from '../../types'
import { DefinitionPage, LinuxSetupBlock, type WalkthroughView } from './DefinitionPage'
import { LibraryPage } from './LibraryPage'
import { OverviewPage } from './OverviewPage'
import { fixingCounts, fixingItems } from './fixing'
import {
  closeMachineWindow, MACHINE_PAGES, setMachinePage, useMachineWindowState, type DefinitionArea, type MachinePage,
} from './windowState'

const NAV_KEY = {
  library: 'navLibrary', overview: 'navOverview', machine: 'navMachine', spindle: 'navSpindle',
  outputs: 'navOutputs', probing: 'navProbing', controller: 'navController', allSettings: 'navAllSettings',
} as const satisfies Record<MachinePage, string>

export function MachineWindow() {
  const { open } = useMachineWindowState()
  return open ? <OpenMachineWindow /> : null
}

function OpenMachineWindow() {
  const t = useText('ui2-machine.wo3303')
  const { page, machineId } = useMachineWindowState()
  const projectMachineId = useCamStore(s => s.project.machine.id)
  const setProjectMachine = useCamStore(s => s.setProjectMachine)
  const openModal = useCamStore(s => s.openModal)
  // null = the PROJECT machine (never the one Control drives, which the hook falls back to)
  const panel = useMachineDefinitionPanel({ machineId: machineId ?? projectMachineId })
  const { draft, def } = panel
  // the page the setup walkthrough is up on; kept here so it outlives the page remounting when the
  // draft gains a controller definition, and is left behind when the window goes to another page
  const [walkthroughOnPage, setWalkthroughOnPage] = useState<DefinitionArea | null>(null)
  const walkthroughPage = walkthroughOnPage === page ? page : null
  const walkthroughOn = (area: DefinitionArea): WalkthroughView => ({
    show: walkthroughPage === area,
    open: () => setWalkthroughOnPage(area),
    close: () => setWalkthroughOnPage(null),
  })
  const items = fixingItems({
    problems: panel.problems,
    pinLabels: def ? controllerDefinitionPins(def).map(p => p.label) : [],
    importIssues: panel.importIssues,
  })
  const counts = fixingCounts(items)
  const label = (id: MachinePage) => t(NAV_KEY[id])
  const nav: WindowNavItem[] = MACHINE_PAGES.map(id => ({
    id,
    label: id !== 'library' && counts[id] > 0 ? t('navFix', { label: label(id), count: counts[id] }) : label(id),
  }))
  const areaLabel = (area: DefinitionArea) => label(area)
  const shown = machineId ?? projectMachineId
  return (
    <Window
      testId="machine-window"
      open
      title={t('windowTitle', { name: draft.name })}
      closeLabel={t('close')}
      onClose={closeMachineWindow}
      nav={nav}
      activeNav={page}
      onNav={id => setMachinePage(id as MachinePage)}
      footer={{
        ghost: { label: t('openEditor'), onPress: () => openModal('machine-config') },
        cancel: { label: t('close'), onPress: closeMachineWindow },
        primary: { label: t('useThisMachine'), onPress: () => { setProjectMachine({ ...(useCamStore.getState().machineLibrary.find(m => m.id === shown) ?? draft) }); closeMachineWindow() } },
      }}
    >
      <div className="ui2-machine-window" data-testid="machine-window-body" data-page={page} data-machine-id={shown} data-in-project={shown === projectMachineId ? '' : undefined}>
        {page === 'library' && <LibraryPage selectedId={shown} />}
        {page === 'overview' && (
          <>
            <LinuxSetupBlock panel={panel} />
            <OverviewPage machine={draft} items={items} areaLabel={areaLabel} open={setMachinePage} />
            {/* a machine with no controller definition yet: today's setup, G30 and park editors live here */}
            {(!panel.def || walkthroughPage === 'overview') && <DefinitionPage panel={panel} page="overview" items={items} walkthrough={walkthroughOn('overview')} />}
          </>
        )}
        {page !== 'library' && page !== 'overview' && <DefinitionPage panel={panel} page={page} items={items} walkthrough={walkthroughOn(page)} />}
      </div>
    </Window>
  )
}
