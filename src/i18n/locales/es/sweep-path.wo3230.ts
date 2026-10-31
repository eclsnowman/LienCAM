// WO-3230: Spanish, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const sweepPath: Translation<'sweep-path.wo3230'> = {
  pathSource: 'Trayectoria',
  modeAxis: 'Eje',
  modeSketch: 'Trayectoria de croquis',
  followPath: 'Seguir trayectoria',
  chain: 'Curvas',
  choosePath: 'Elija una cadena abierta de líneas o arcos',
  chainOption: '{{sketch}}: {{curves}}',
  curveLine: 'línea {{id}}',
  curveArc: 'arco {{id}}',
  startsAt: 'Empieza en ({{x}}, {{y}}, {{z}}) mm, dirección ({{dx}}, {{dy}}, {{dz}})',
  reverse: 'Invertir',
  noChains: 'Ningún croquis anterior a este barrido tiene una cadena abierta de líneas o arcos que seguir.',
  notListed: '{{sketch}} no aparece: {{message}}',
  branched: '{{sketch}} no aparece: sus curvas {{curves}} se ramifican, así que no forman una sola cadena abierta.',
  savedPathUnresolved: 'No se puede seguir la trayectoria guardada: {{message}}',
  pathUnresolved: 'Trayectoria del barrido ({{code}}): {{message}}',
  pathSketchMissing: 'El croquis de trayectoria {{sketchId}} no existe en este punto del modelo (eliminado o detrás de la marca de retroceso). Restáuralo o elige otra trayectoria.',
  pathCycle: '{{sketch}} se construye a partir de {{feature}}, así que no puede ser su trayectoria: formaría un bucle.',
  savedAsPath: 'Croquis guardado como trayectoria abierta: no tiene perfil cerrado y el barrido puede seguirlo.',
}

export default sweepPath
