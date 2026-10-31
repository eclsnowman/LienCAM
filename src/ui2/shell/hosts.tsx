// WO-3285 (UI M2 W1-H): the one place the New UI shell imports today's panels. They are hosted
// exactly as they are (same components, same store actions, same results); the shell frames them
// in cards and never edits them. Screens in later waves replace these hosts one at a time, so a
// test of the shell swaps this module for plain stand-ins.
import { lazy, Suspense } from 'react'
import { DesignTree } from '../../components/panels/DesignTree'
import { PropertiesPanel } from '../../components/panels/PropertiesPanel'
import { BottomConsole } from '../../components/panels/BottomConsole'
import { Viewport } from '../../components/viewport/Viewport'
import { ViewportErrorBoundary } from '../../components/viewport/ViewportErrorBoundary'
import { MachineStatusChip } from '../../components/toolbar/MachineStatusChip'
import { HelpCenterModal } from '../../components/modals/HelpCenterModal'
import { AboutModal } from '../../components/modals/AboutModal'
import { SetupModal } from '../../components/modals/SetupModal'
import { MachineLibraryModal } from '../../components/modals/MachineLibraryModal'
import { ToolLibraryModal } from '../../components/modals/ToolLibraryModal'
import { NewOperationModal } from '../../components/modals/NewOperationModal'
import { SketchEntryModal } from '../../components/modals/SketchEntryModal'
import { ModelEntryModal } from '../../components/modals/ModelEntryModal'
import { ConfirmModal } from '../../components/modals/ConfirmModal'
import { MultiBodyImportModal } from '../../components/modals/MultiBodyImportModal'
import { ImportStockChoiceModal } from '../../components/modals/ImportStockChoiceModal'
import { SettingsModal } from '../../components/modals/SettingsModal'
import { ExportModal } from '../../components/modals/ExportModal'
import { PostProcessModal } from '../../components/modals/PostProcessModal'
import { NestModal } from '../../components/modals/NestModal'
import { BooleanMeshDialog } from '../../components/modals/BooleanMeshDialog'
import { MeshViewerModal } from '../../components/machine/MeshViewerModal'
import { ProjectStartupFlow } from '../../components/modals/DemoExamplePickerModal'
import { GuidedSetupHost } from '../../components/modals/GuidedSetupHost'
import { ThemedTooltip } from '../../components/ui/ThemedTooltip'
import { useGlobalShortcuts } from '../../hooks/useGlobalShortcuts'
import { installAgentBridge } from '../../lib/agent/rendererBridge'
import { useEffect } from 'react'
import type { HostedWindowId } from '../registry/types'

// The Model and Control workspaces load on first entry, as in the shipped shell, and stay mounted
// afterwards (the shell hides them) so a serial session and the model state survive tab changes.
const SolidsWorkbenchPage = lazy(() =>
  import('../../components/model3d/SolidsWorkbenchPage').then(m => ({ default: m.SolidsWorkbenchPage })),
)
const ControlPage = lazy(() =>
  import('../../components/machine/ControlPage').then(m => ({ default: m.ControlPage })),
)

export function BrowserHost() { return <DesignTree /> }
export function PropertiesHost() { return <PropertiesPanel /> }
export function ConsoleHost() { return <BottomConsole /> }
export function MachineStatusHost() { return <MachineStatusChip /> }

export function ViewportHost({ suspended, resetKey }: { suspended: boolean; resetKey: string }) {
  return (
    <ViewportErrorBoundary resetKey={resetKey}>
      <Viewport suspended={suspended} />
    </ViewportErrorBoundary>
  )
}

export function ModelWorkspaceHost({ modelItemId, loading }: { modelItemId: string | undefined; loading: string }) {
  return (
    <Suspense fallback={<div data-testid="part-workspace-loading">{loading}</div>}>
      <SolidsWorkbenchPage embedded modelItemId={modelItemId} />
    </Suspense>
  )
}

export function ControlWorkspaceHost({ loading }: { loading: string }) {
  return (
    <Suspense fallback={<div data-testid="control-workspace-loading">{loading}</div>}>
      <ControlPage />
    </Suspense>
  )
}

// a hook beside the components: the shell's test stands in for this whole module
/** The shipped shell's app-level wiring that is not a panel: global shortcuts and the agent bridge. */
// eslint-disable-next-line react-refresh/only-export-components
export function useAppWiring(): void {
  useGlobalShortcuts()
  useEffect(() => installAgentBridge(), [])
}

/** Every store-driven window of the shipped shell, mounted once at the root of the New UI. A window
 *  a lane registered in its place (`replaced`) is left out. */
export function WindowHosts({ aboutOpen, onAbout, onAboutClose, replaced }: {
  aboutOpen: boolean; onAbout(): void; onAboutClose(): void; replaced?: ReadonlySet<HostedWindowId>
}) {
  const hosted = (id: HostedWindowId) => !replaced?.has(id)
  return (
    <>
      {hosted('setup') && <SetupModal />}
      {hosted('machine-library') && <MachineLibraryModal />}
      {hosted('tool-library') && <ToolLibraryModal />}
      {hosted('new-operation') && <NewOperationModal />}
      {hosted('sketch-entry') && <SketchEntryModal />}
      {hosted('model-entry') && <ModelEntryModal />}
      {hosted('settings') && <SettingsModal />}
      {hosted('export') && <ExportModal />}
      {hosted('help') && <HelpCenterModal onAbout={onAbout} aboutOpen={aboutOpen} />}
      {hosted('about') && <AboutModal isOpen={aboutOpen} onClose={onAboutClose} />}
      {hosted('post-process') && <PostProcessModal />}
      {hosted('nest') && <NestModal />}
      {hosted('project-startup') && <ProjectStartupFlow />}
      {hosted('guided-setup') && <GuidedSetupHost />}
      {hosted('boolean-mesh') && <BooleanMeshDialog />}
      {hosted('mesh-viewer') && <MeshViewerModal />}
      {hosted('confirm') && <ConfirmModal />}
      {hosted('multi-body-import') && <MultiBodyImportModal />}
      {hosted('import-stock-choice') && <ImportStockChoiceModal />}
      {hosted('tooltip') && <ThemedTooltip />}
    </>
  )
}
