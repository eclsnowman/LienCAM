// Gizmo framework public surface (WO UI-3).
export { TranslateGizmo, type TranslateGizmoProps, type Vec3Like } from './TranslateGizmo'
export {
  createDefaultTransformControlsAdapter,
  type TransformControlsAdapter,
  type CreateTransformControlsAdapter,
} from './TransformControlsAdapter'
// WO UI-5/UI-57: normal-constrained, symmetric single-axis push/pull gizmo
// (own pointer lifecycle -- no TransformControlsAdapter dependency).
export {
  PushPullGizmo,
  pushPullHandleAvoidRect,
  pushPullHandleScreenHalfExtent,
  type PushPullGizmoProps,
  type FaceFrame,
  type PushPullGizmoTestDriver,
  type CreatePushPullGizmoTestDriver,
} from './PushPullGizmo'
