// WO-3282: Spanish, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const ui2Commands: Translation<'ui2-commands.wo3282'> = {
  searchLabel: 'Buscar comandos',
  placeholder: 'Escriba el nombre de un comando o un atajo',
  results: 'Comandos',
  noMatch: 'Ningún comando coincide con «{{query}}».',
  notNow: 'No disponible ahora',
  placeSetup: 'Configuración',
  placeSketch: 'Boceto',
  placeModel: 'Modelo',
  placeToolpath: 'Trayectoria',
  placeSimulate: 'Simulación',
  placeControl: 'Control',
  placeGlobal: 'En todas partes',
}

export default ui2Commands
