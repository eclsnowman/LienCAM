// WO-3244: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const bodyMirror: Translation<'body-mirror.wo3244'> = {
  railLabel: 'Spiegeln',
  railTip: 'Einen Körper an einer Ebene spiegeln. Das Spiegelbild ersetzt das Original.',
  title: 'Körper spiegeln',
  editTitle: 'Spiegelung bearbeiten',
  body: 'Körper',
  plane: 'Ebene',
  result: 'Ergebnis',
  replaceOriginal: 'Original ersetzen',
  replaceOriginalTip: 'Der gespiegelte Körper tritt an die Stelle des Originals; das Original bleibt im Verlauf und kehrt zurück, wenn diese Spiegelung unterdrückt oder gelöscht wird.',
  noBody: 'Es gibt keinen Volumenkörper zum Spiegeln.',
  noPlane: 'Es gibt keine Ebene zum Spiegeln.',
  meshNeedsExactBody: 'Spiegeln braucht einen exakten Körper; dieses Netz bleibt unverändert und seine eigenen Werkzeuge gelten weiter.',
  previewReady: 'Vorschau: das Spiegelbild von {{body}} an {{plane}}.',
  previewBuilding: 'Vorschau wird erstellt...',
  defaultName: 'Spiegelung {{id}}',
  notAMirror: '{{featureId}} ist keine Spiegelung.',
  planeBuiltFromMirror: '{{choice}} entsteht aus dem Ergebnis dieser Spiegelung und kann sie daher nicht platzieren. Wählen Sie eine Ebene, die davor erstellt wurde.',
  bodyBuiltFromMirror: '{{choice}} entsteht aus dem Ergebnis dieser Spiegelung und kann daher nicht von ihr gespiegelt werden. Wählen Sie einen Körper, der davor erstellt wurde.',
  carryNotCarried: '{{feature}} folgt später auf diesem Körper und behält einen Bezug ({{reference}}), den die Spiegelung nicht auf den gespiegelten Körper übertragen kann. Die Spiegelung wurde hier nicht eingefügt. Fügen Sie sie stattdessen nach {{feature}} ein.',
  carryNoPlane: '{{feature}} speichert eine Position ({{reference}}), die gespiegelt werden muss, aber die Spiegelebene lässt sich gerade nicht platzieren. Die Spiegelung wurde hier nicht eingefügt.',
  carryBadReference: '{{feature}} hat einen Bezug ({{reference}}), der keine Fläche und keine Kante dieses Körpers ist. Die Spiegelung kann ihn nicht übertragen und wurde hier nicht eingefügt.',
  replayNotCarried: '{{feature}} hat eine Referenz ({{reference}}), die der Spiegelung {{mirror}} nicht auf den gespiegelten Körper folgen kann. Das Element wurde nicht neu aufgebaut.',
  replayNoPlane: '{{feature}} speichert eine Position ({{reference}}), die die Spiegelung {{mirror}} spiegeln muss, aber die Spiegelebene lässt sich gerade nicht platzieren. Das Element wurde nicht neu aufgebaut.',
  refusedMalformed: 'Spiegelung {{nodeId}} fehlt ihr Körper oder ihre Ebene; sie wurde nicht neu aufgebaut.',
  refusedSourceNotLive: 'Spiegelung {{nodeId}}: der gespiegelte Körper ({{sourceBodyId}}) fehlt oder wurde bereits von einem späteren Element verwendet.',
  refusedPlaneUnresolved: 'Spiegelung {{nodeId}}: ihre Ebene ({{planeNodeId}}) konnte nicht bestimmt werden, daher wurde der Körper nicht gespiegelt.',
  refusedNoTransform: 'Spiegelung {{nodeId}}: dieser Geometriedienst kann keine Körper bewegen, daher wurde der Körper nicht gespiegelt.',
}

export default bodyMirror
