// WO-3244: Spanish, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const bodyMirror: Translation<'body-mirror.wo3244'> = {
  railLabel: 'Simetría',
  railTip: 'Refleja un cuerpo respecto a un plano. El reflejo sustituye al original.',
  title: 'Simetría de cuerpo',
  editTitle: 'Editar simetría',
  body: 'Cuerpo',
  plane: 'Plano',
  result: 'Resultado',
  replaceOriginal: 'Sustituir original',
  replaceOriginalTip: 'El cuerpo reflejado ocupa el lugar del original; el original se conserva en el historial y vuelve si esta simetría se suprime o se elimina.',
  noBody: 'No hay ningún cuerpo sólido para reflejar.',
  noPlane: 'No hay ningún plano respecto al que reflejar.',
  meshNeedsExactBody: 'La simetría necesita un cuerpo exacto; esta malla se deja como está y sus propias herramientas siguen disponibles.',
  previewReady: 'Vista previa: el reflejo de {{body}} respecto a {{plane}}.',
  previewBuilding: 'Creando la vista previa...',
  defaultName: 'Simetría {{id}}',
  notAMirror: '{{featureId}} no es una simetría.',
  planeBuiltFromMirror: '{{choice}} se crea a partir del resultado de esta simetría, así que no puede situarla. Elija un plano creado antes.',
  bodyBuiltFromMirror: '{{choice}} se crea a partir del resultado de esta simetría, así que ella no puede reflejarlo. Elija un cuerpo creado antes.',
  carryNotCarried: '{{feature}} viene después en este cuerpo y conserva una referencia ({{reference}}) que la simetría no puede pasar al cuerpo reflejado, así que la simetría no se añadió aquí. Añádala después de {{feature}}.',
  carryNoPlane: '{{feature}} guarda una posición ({{reference}}) que hay que reflejar, pero ahora no se puede situar el plano de simetría, así que la simetría no se añadió aquí.',
  carryBadReference: '{{feature}} tiene una referencia ({{reference}}) que no es una cara ni una arista de este cuerpo, así que la simetría no puede pasarla y no se añadió aquí.',
  replayNotCarried: '{{feature}} guarda una referencia ({{reference}}) que no puede seguir a la simetría {{mirror}} hasta el cuerpo reflejado, así que no se reconstruyó.',
  replayNoPlane: '{{feature}} guarda una posición ({{reference}}) que la simetría {{mirror}} tiene que reflejar, pero ahora no se puede situar el plano de simetría, así que no se reconstruyó.',
  refusedMalformed: 'A la simetría {{nodeId}} le falta su cuerpo o su plano y no se ha reconstruido.',
  refusedSourceNotLive: 'Simetría {{nodeId}}: el cuerpo que refleja ({{sourceBodyId}}) ya no existe o ya lo usó una operación posterior.',
  refusedPlaneUnresolved: 'Simetría {{nodeId}}: no se pudo situar su plano ({{planeNodeId}}), así que el cuerpo no se reflejó.',
  refusedNoTransform: 'Simetría {{nodeId}}: este servicio de geometría no puede mover cuerpos, así que el cuerpo no se reflejó.',
}

export default bodyMirror
