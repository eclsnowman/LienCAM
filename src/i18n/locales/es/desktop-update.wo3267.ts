// WO-3267: desktop update offer text.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'desktop-update.wo3267'> = {
  offerAvailable: 'LienCAM {{version}} está disponible (tiene {{currentVersion}}).',
  offerAvailableSized: 'LienCAM {{version}} está disponible (tiene {{currentVersion}}), {{size}}.',
  notNow: 'Ahora no',
  download: 'Descargar',
  downloadingPercent: 'Descargando LienCAM {{version}}: {{percent}} %',
  downloading: 'Descargando LienCAM {{version}}...',
  downloaded: 'LienCAM {{version}} está descargado y comprobado.',
  installExplanation: 'La instalación cierra LienCAM y el puente de la máquina, y luego inicia la nueva versión. Se conservan sus ajustes, máquina, herramientas y proyectos.',
  showFileExplanation: 'Esta copia no puede reemplazarse a sí misma; en su lugar, LienCAM le muestra el archivo comprobado para que lo inicie.',
  later: 'Más tarde',
  installAndRestart: 'Instalar y reiniciar',
  showFile: 'Mostrar el archivo',
  close: 'Cerrar',
  downloadAgain: 'Descargar de nuevo',
  downloadFailed: 'LienCAM no pudo descargar {{version}} ({{error}}); no se instaló nada.',
  downloadedMatched: 'LienCAM {{version}} se descargó y coincide con su suma de comprobación SHA-256 publicada.',
  installChecking: 'Comprobando LienCAM {{version}} de nuevo antes de instalar...',
  installFailed: 'LienCAM no pudo instalar {{version}} ({{error}}); esta copia no ha cambiado.',
}

export default words
