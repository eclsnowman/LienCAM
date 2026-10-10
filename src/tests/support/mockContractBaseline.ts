// WO-960: THE DEBT THE TYPED-MOCK RATCHET STARTS FROM, AND IT MAY ONLY SHRINK.
//
// Every entry is a test file that mocks a module with a factory whose return
// value does NOT come through `typedMock` - so the factory's literal is its own
// contract, invented at the mock site, and `tsc` checks the TEST against it
// instead of checking the PRODUCT against it. See src/tests/support/typedMock.ts
// for the three real defects that went through exactly that gap.
//
// A key is `<test file>::<module specifier>`. The number is how many DISTINCT
// CALL SITES in that file mock that module untyped - not how many CALLS: a
// `vi.doMock` in a `beforeEach` runs once per test, and an allowance that moved
// with the test filter would be the very flake this order was raised about. The
// key deliberately carries NO line number, for the same reason: a line moves
// whenever anything above it is edited, and a guard that goes red for an
// unrelated edit is one people learn to wave through.
//
// RECORDED, NOT PARSED. Two earlier rounds derived this list by reading test
// source and the audit found spellings the parser could not see. It is now
// produced the same way it is enforced - by running the tests with
// src/tests/support/mockContractGuard.ts in recording mode:
//
//   node src/tests/evidence/WO-960/record-mock-baseline.mjs --run --write
//
// ENFORCED IN BOTH DIRECTIONS by that guard:
//
//   - a module mocked untyped from MORE sites than recorded here goes red the
//     moment the factory runs, so NEW untyped debt cannot be written; and
//   - a file that RAN and now needs FEWER than recorded here also goes red, and
//     says the number to write - so a paid-off allowance cannot sit here
//     forever waiting for the next mock to inherit it.
//
// WO-1052 converts these and drives the list to zero.

export const MOCK_CONTRACT_BASELINE: Record<string, number> = {
  'src/tests/components/ViewErrorBoundaryAppIntegration.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/components/ViewportCarvedStockCensus.sim7.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/components/ViewportContextMenuGesture.wo1503.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/components/projectOpenTiming.ui86.test.tsx::../../components/model3d/SolidsWorkbenchPage': 1,
  'src/tests/evidence/WO-459/_probe.test.ts::../../../lib/cam/adaptiveClearing2d/engine/wallCleanLoop': 1,
  'src/tests/examples/_exampleGenerate.probe.test.ts::../../cam3d/input/stepTessellatorWorker': 1,
  'src/tests/geom/geom-worker.transfer.test.ts::../../geom/worker/geom-engine.ts': 1,
  'src/tests/geom/geom-worker.transfer.test.ts::comlink': 1,
  'src/tests/machine/controlTabDeclutter.wo414.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/controlTabDeclutterBatch3.wo414.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/dashToDefine.wo994.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/droGoto.wo303.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/intendedStockControl.wo380.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/intendedStockMultiSetup.wo412.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/meshViewer.wo416.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/noDatumConsole.wo1016.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/programPreviewEnvelopeFit.wo377.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/programPreviewGrid.wo224.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/programPreviewViews.wo383.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/setMachinePosition.wo986.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/switchlessMode.wo985.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/switchlessWording.wo988.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/unitsSyncCapability.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/machine/workZeroBeforeMove.wo1017.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/model3d/planegcsLoaderMemoRecovery.wo091.test.ts::@salusoft89/planegcs': 1,
  'src/tests/store/brepRestoreDisplay.ui86.test.ts::../../store': 1,
  'src/tests/store/brepRetessellate.test.ts::../../store': 1,
  'src/tests/store/staleModelBody.wo370.test.ts::../../lib/viewport/CNCViewport': 1,
  'src/tests/store/stepModelRendersAfterReload.wo243.test.ts::../../lib/viewport/CNCViewport': 1,
  'src/tests/ui/overlayAttachGuard.test.tsx::react/jsx-dev-runtime': 1,
  'src/tests/ui/overlayGatePair.test.tsx::react/jsx-dev-runtime': 1,
  'src/tests/ui/overlayRuntimeCensus.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/ui/overlayRuntimeCensus.test.tsx::react/jsx-dev-runtime': 1,
  'src/tests/ui/overlayRuntimeCensus.test.tsx::three': 1,
  'src/tests/viewport/axisColourTokens.wo961.test.ts::three': 1,
  'src/tests/viewport/int17cC1ViewportPlacementSeam.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/viewport/modeTabStripSketchSelectedOpen.navSketchTabSelection.test.tsx::../../components/model3d/SolidsWorkbenchPage': 1,
  'src/tests/viewport/owningStockViewportPick.ui64.test.tsx::../../lib/viewport/CNCViewport': 1,
  'src/tests/workspace/int15.camHostListeners.test.tsx::../../lib/viewport/CNCViewport': 1,
}
