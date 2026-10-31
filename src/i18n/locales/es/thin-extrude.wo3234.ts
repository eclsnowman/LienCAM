// WO-3234: Spanish, machine-translated and checked against docs/i18n/GLOSSARY-es.md.
import type { Translation } from '../../index'

const thinExtrude: Translation<'thin-extrude.wo3234'> = {
  wall: 'Pared',
  thin: 'Delgada',
  thickness: 'Espesor',
  side: 'Lado',
  sideInside: 'Interior',
  sideOutside: 'Exterior',
  sideCenter: 'Centrado',
  summaryInside: 'Pared delgada de {{thickness}} mm dentro del contorno del boceto, hacia el material.',
  summaryOutside: 'Pared delgada de {{thickness}} mm fuera del contorno del boceto, lejos del material.',
  summaryCenter: 'Pared delgada de {{thickness}} mm centrada en el contorno del boceto, {{half}} mm a cada lado.',
  endNotAvailable: '{{end}} aún no está disponible para pared delgada - elija Ciega o Simétrica.',
  thicknessMustBePositive: 'El espesor de pared debe ser un número positivo en mm (recibido: {{thickness}}).',
  unknownWallMode: 'Modo de pared de extrusión desconocido "{{mode}}".',
  unknownWallSide: 'Lado de pared desconocido "{{side}}" - use inside, outside o center.',
}

export default thinExtrude
