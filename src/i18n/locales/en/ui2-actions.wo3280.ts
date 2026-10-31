// WO-3280: English words of the New UI kit actions (Prompt bar, View cube, unavailable lock).


const ui2Actions = {
  cancel: 'Cancel',
  escKey: 'Esc',
  locked: 'Locked',
  viewStyle: 'View style',
  styleShaded: 'Shaded',
  styleShadedEdges: 'Shaded with edges',
  styleWireframe: 'Wireframe',
  styleHiddenEdges: 'Hidden edges',
} as const

export default ui2Actions

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'ui2-actions.wo3280': typeof ui2Actions
  }
}
