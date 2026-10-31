// WO-3244: words for Model > Modify > Mirror (replace original) and its
// replay refusals, shared by the Model screen and the background replay.
const bodyMirror = {
  railLabel: 'Mirror',
  railTip: 'Mirror one body across a plane. The reflection replaces the original.',
  title: 'Mirror body',
  editTitle: 'Edit mirror',
  body: 'Body',
  plane: 'Plane',
  result: 'Result',
  replaceOriginal: 'Replace original',
  replaceOriginalTip: 'The reflected body takes the original body\'s place; the original is kept in the history and comes back if this mirror is suppressed or deleted.',
  noBody: 'There is no solid body to mirror.',
  noPlane: 'There is no plane to mirror across.',
  meshNeedsExactBody: 'Mirror needs an exact body; this mesh is left as it is and its own tools still apply.',
  previewReady: 'Preview: the reflection of {{body}} across {{plane}}.',
  previewBuilding: 'Building the preview...',
  defaultName: 'Mirror {{id}}',
  notAMirror: '{{featureId}} is not a mirror.',
  planeBuiltFromMirror: '{{choice}} is built from this mirror\'s result, so it cannot place the mirror. Pick a plane made before it.',
  bodyBuiltFromMirror: '{{choice}} is built from this mirror\'s result, so the mirror cannot reflect it. Pick a body made before it.',
  carryNotCarried: '{{feature}} comes later on this body and keeps a reference ({{reference}}) the mirror cannot carry onto the reflected body, so the mirror was not added here. Add the mirror after {{feature}} instead.',
  carryNoPlane: '{{feature}} stores a position ({{reference}}) that has to be reflected, but the mirror plane cannot be placed right now, so the mirror was not added here.',
  carryBadReference: '{{feature}} has a reference ({{reference}}) that is not a face or edge of this body, so the mirror cannot carry it and was not added here.',
  replayNotCarried: '{{feature}} keeps a reference ({{reference}}) that cannot follow mirror {{mirror}} onto the reflected body, so it was not rebuilt.',
  replayNoPlane: '{{feature}} stores a position ({{reference}}) that mirror {{mirror}} has to reflect, but the mirror plane cannot be placed right now, so it was not rebuilt.',
  refusedMalformed: 'Mirror {{nodeId}} is missing its body or plane and was not rebuilt.',
  refusedSourceNotLive: 'Mirror {{nodeId}}: the body it mirrors ({{sourceBodyId}}) is gone or was already used by a later feature.',
  refusedPlaneUnresolved: 'Mirror {{nodeId}}: its plane ({{planeNodeId}}) could not be placed, so the body was not mirrored.',
  refusedNoTransform: 'Mirror {{nodeId}}: this geometry service cannot move bodies, so the body was not mirrored.',
} as const

export default bodyMirror

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'body-mirror.wo3244': typeof bodyMirror
  }
}
