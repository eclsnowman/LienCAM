// WO-3237: Spanish, machine-translated and checked against docs/i18n/GLOSSARY-es.md.
import type { Translation } from '../../index'

const thinOpenExtrude: Translation<'thin-open-extrude.wo3237'> = {
  source: 'Pared a lo largo de',
  sourceRegions: 'Regiones cerradas del boceto',
  chainOption: 'Cadena abierta en {{sketch}}: {{curves}}',
  reverse: 'Invertir',
  travels: 'La cadena empieza en {{curve}} y llega a {{last}}; la flecha en la vista indica el sentido.',
  sideLeft: 'Izquierda',
  sideRight: 'Derecha',
  summaryLeft: 'Pared delgada de {{thickness}} mm a la izquierda de la cadena, recorriéndola en su sentido.',
  summaryRight: 'Pared delgada de {{thickness}} mm a la derecha de la cadena, recorriéndola en su sentido.',
  summaryCenter: 'Pared delgada de {{thickness}} mm centrada en la cadena, {{half}} mm a cada lado.',
  needsThin: 'Una cadena abierta del boceto solo se extruye como pared delgada: active Delgada o elija regiones cerradas.',
  chainUnresolved: 'No se puede seguir la cadena guardada: {{message}}',
  unknownOpenSide: 'Lado de pared desconocido "{{side}}" para una cadena abierta: use izquierda, derecha o centro.',
  wrongSketch: 'La cadena pertenece al boceto {{chainSketch}}, no al boceto {{sketch}} de esta extrusión.',
}

export default thinOpenExtrude
