// WO SKC-8: the shared sketch3d UI module -- the ONE place the draw-tool state machine
// (POINTS_NEEDED etc.), grab-site resolution, entity construction/translation, and the
// screen<->world helpers live. Consumed by BOTH src/components/sketch3dlab/Sketch3dLabPage.tsx
// and src/components/model3d/SolidsWorkbenchPage.tsx's editing session -- neither page forks its
// own copy of this logic (share-do-not-fork, criterion 3).
export * from './geometry2d'
export * from './picking'
export * from './draftEntities'
export * from './drawTool'
