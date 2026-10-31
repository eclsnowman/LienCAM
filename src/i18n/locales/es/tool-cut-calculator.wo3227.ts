// WO-3227: the Programmed cut group in Tool Library > Cutting Data.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'tool-cut-calculator.wo3227'> = {
  title: 'Corte programado',
  depthOfCut: 'Profundidad de corte (ap)',
  stepover: 'Paso lateral (ae)',
  engagementAngle: 'Ángulo de contacto',
  maxChip: 'Espesor máximo de viruta',
  meanChip: 'Espesor medio de viruta',
  removalRate: 'Tasa de arranque',
  degrees: '°',
  removalUnitMm: 'cm³/min',
  removalUnitInch: 'in³/min',
  rubbing: 'La viruta máxima es más fina que {{value}}: el filo puede rozar en lugar de cortar.',
  trust: 'Esto estima el corte programado; el contacto real, la rigidez de la herramienta y la fuerza de sujeción no se han verificado.',
  notApplicableShape: 'Esta calculadora modela una fresa plana cortando de costado; el modelo no se aplica a esta herramienta.',
  notApplicableDepth: 'La profundidad de corte es mayor que la longitud de los filos; el modelo no se aplica.',
  needsNumbers: 'necesita diámetro, velocidad, avance, profundidad y paso válidos',
  needsSpindle: 'necesita velocidad de husillo y filos',
  noContact: 'sin paso lateral, sin contacto',
  stepoverOverDiameter: 'el paso lateral es mayor que el diámetro',
}

export default words
