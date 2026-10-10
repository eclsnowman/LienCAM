// Model and CAM deliberately share one raw pointer lifecycle for direct
// section-plane dragging. Keep this export so the Model workspace's existing
// import path remains stable.
export {
  useSectionPlaneDrag,
  type SectionPlaneDragController,
  type UseSectionPlaneDragArgs,
} from '../../../hooks/useSectionPlaneDrag'
