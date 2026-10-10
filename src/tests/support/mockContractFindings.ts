export interface MockContractFinding {
  key: string
  class: string
  reason: string
  seam: string
}

function findings(
  keys: readonly string[],
  findingClass: string,
  reason: string,
  seam: string,
): MockContractFinding[] {
  return keys.map((key) => ({ key, class: findingClass, reason, seam }))
}

const CNCVIEWPORT_KEYS = [
  'src/tests/components/ViewErrorBoundaryAppIntegration.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/components/ViewportCarvedStockCensus.sim7.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/components/ViewportContextMenuGesture.wo1503.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/controlTabDeclutter.wo414.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/controlTabDeclutterBatch3.wo414.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/dashToDefine.wo994.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/droGoto.wo303.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/intendedStockControl.wo380.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/intendedStockMultiSetup.wo412.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/meshViewer.wo416.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/noDatumConsole.wo1016.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/programPreviewEnvelopeFit.wo377.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/programPreviewGrid.wo224.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/programPreviewViews.wo383.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/setMachinePosition.wo986.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/switchlessMode.wo985.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/switchlessWording.wo988.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/unitsSyncCapability.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/machine/workZeroBeforeMove.wo1017.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/store/staleModelBody.wo370.test.ts::../../lib/viewport/CNCViewport',
  'src/tests/store/stepModelRendersAfterReload.wo243.test.ts::../../lib/viewport/CNCViewport',
  'src/tests/ui/overlayRuntimeCensus.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/viewport/int17cC1ViewportPlacementSeam.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/viewport/owningStockViewportPick.ui64.test.tsx::../../lib/viewport/CNCViewport',
  'src/tests/workspace/int15.camHostListeners.test.tsx::../../lib/viewport/CNCViewport',
] as const

const RECORDER_UNOBSERVED_KEYS = [
  'src/tests/components/projectOpenTiming.ui86.test.tsx::../../components/model3d/SolidsWorkbenchPage',
  'src/tests/examples/_exampleGenerate.probe.test.ts::../../cam3d/input/stepTessellatorWorker',
  'src/tests/viewport/modeTabStripSketchSelectedOpen.navSketchTabSelection.test.tsx::../../components/model3d/SolidsWorkbenchPage',
] as const

export const MOCK_CONTRACT_FINDINGS: ReadonlyArray<MockContractFinding> = [
  ...findings(
    CNCVIEWPORT_KEYS,
    'cncviewport-class-fake',
    'TS2740: a fake class cannot satisfy typeof CNCViewport because private static members make the class nominal; extending it would run the WebGLRenderer-backed constructor that these jsdom fixtures avoid.',
    'Have viewport consumers depend on a public ViewportLike interface, or expose a test-safe CNCViewport construction seam.',
  ),
  ...findings(
    RECORDER_UNOBSERVED_KEYS,
    'recorder-unobserved-typed-factory',
    'The source factory already returns through typedMock, but the recorder conservatively retains the key because the lazy or opt-in path never executes the factory in its ordinary run.',
    'Teach the recorder to recognize typedMock-wrapped factories without executing them, or add a focused recorder mode that exercises the lazy and opt-in paths.',
  ),
  ...findings(
    ['src/tests/evidence/WO-459/_probe.test.ts::../../../lib/cam/adaptiveClearing2d/engine/wallCleanLoop'],
    'out-of-grant-evidence-mock',
    'The recorder observes this untyped mock, but src/tests/evidence is explicitly outside WO-1052 owned paths.',
    'The follow-on that owns src/tests/evidence must type the wallCleanLoop module factory and regenerate the baseline.',
  ),
  ...findings(
    ['src/tests/geom/geom-worker.transfer.test.ts::../../geom/worker/geom-engine.ts'],
    'geomengine-private-class-fake',
    'TS2322: the lightweight GeomEngine fake cannot satisfy the exported class because the real class has ECMAScript private fields and initializing it would load the OCCT kernel this unit test excludes.',
    'Have geom-worker consume a public GeomEngineLike interface or inject a kernel-free engine factory.',
  ),
  ...findings(
    ['src/tests/geom/geom-worker.transfer.test.ts::comlink'],
    'comlink-generic-transfer-sentinel',
    'TS2322: Comlink transfer is generic <T>(obj: T) => T, while this test must return a distinguishable sentinel wrapper to prove the worker propagates the transfer result.',
    'Inject a narrow transferTag function whose contract permits an observable wrapper in tests.',
  ),
  ...findings(
    ['src/tests/model3d/planegcsLoaderMemoRecovery.wo091.test.ts::@salusoft89/planegcs'],
    'planegcs-private-class-fake',
    'TS2322: the GcsWrapper fixture cannot satisfy the real class because it has private fields and a GcsSystem constructor contract that this memo-lifecycle test deliberately does not instantiate.',
    'Inject a narrow PlanegcsModuleLike loader result into planegcsLoader instead of consuming the concrete vendor class.',
  ),
  ...findings(
    [
      'src/tests/store/brepRestoreDisplay.ui86.test.ts::../../store',
      'src/tests/store/brepRetessellate.test.ts::../../store',
    ],
    'zustand-callable-store-fake',
    'TS2322: the fixture is a plain object with getState, but useCamStore is a callable zustand hook with attached StoreApi and persist members.',
    'Pass a narrow settings reader into restoreScene, or construct a real isolated zustand store for these tests.',
  ),
  ...findings(
    [
      'src/tests/ui/overlayAttachGuard.test.tsx::react/jsx-dev-runtime',
      'src/tests/ui/overlayGatePair.test.tsx::react/jsx-dev-runtime',
      'src/tests/ui/overlayRuntimeCensus.test.tsx::react/jsx-dev-runtime',
    ],
    'jsxdev-instrumentation-signature',
    'TS2322: wrapJsxDev currently returns (...args: unknown[]) => unknown, which cannot satisfy jsxDEV returning ReactElement without a forbidden narrowing cast.',
    'Give wrapJsxDev a generic signature that preserves the exact input function type.',
  ),
  ...findings(
    [
      'src/tests/ui/overlayRuntimeCensus.test.tsx::three',
      'src/tests/viewport/axisColourTokens.wo961.test.ts::three',
    ],
    'webglrenderer-class-fake',
    'TS2322: the WebGLRenderer fake cannot satisfy the real class private members, and extending WebGLRenderer invokes a constructor that requires a WebGL context unavailable in jsdom.',
    'Inject a narrow renderer interface or renderer factory into ViewCube and the viewport environment.',
  ),
]
