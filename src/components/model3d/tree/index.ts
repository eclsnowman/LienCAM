// Design-tree public surface (WO UI-3).
export {
  FeatureTree,
  isFeatureTreeNodeVisible,
  visibleFeatureTreeOrder,
  type FeatureTreeProps,
  type FeatureTreeDeleteControls,
  type FeatureTreeEditControls,
  type FeatureTreeEditEntry,
  type FeatureTreeFolderControls,
  type FeatureTreeHideControls,
  type FeatureTreeReorderControls,
  type FeatureTreeRollbackControls,
  type FeatureTreeSuppressControls,
  type FeatureTreeVisibilityControls,
} from './FeatureTree'
export { TreeContextMenu, DeleteConfirmDialog, type TreeContextMenuProps, type DeleteConfirmDialogProps } from './TreeContextMenu'
export { planFeatureDelete, type FeatureDeletePlan } from './featureDelete'
export { FeatureStatusBadge, type FeatureStatusBadgeProps } from './FeatureStatusBadge'
export {
  useFeatureTreeStatuses,
  type FeatureStatusSource,
  type FeatureStatusSnapshot,
} from './useFeatureTreeStatuses'
