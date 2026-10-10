// WO SKC-8: relocated to src/components/sketch3d-shared/draftEntities.ts (share-do-not-fork,
// criterion 3) -- this file is now a thin re-export shim so every pre-existing import path
// (including this lab's own tests) keeps working unmodified. makeArcEntity's signature/semantics
// changed (WO SKC-8 A2: start/end/through-point, not center/start/end) -- see the shared module
// for the full rationale.
export * from '../sketch3d-shared/draftEntities'
