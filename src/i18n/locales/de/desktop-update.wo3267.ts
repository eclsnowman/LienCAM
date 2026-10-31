// WO-3267: desktop update offer text.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'desktop-update.wo3267'> = {
  offerAvailable: 'LienCAM {{version}} ist verfügbar (Sie haben {{currentVersion}}).',
  offerAvailableSized: 'LienCAM {{version}} ist verfügbar (Sie haben {{currentVersion}}), {{size}}.',
  notNow: 'Nicht jetzt',
  download: 'Herunterladen',
  downloadingPercent: 'LienCAM {{version}} wird heruntergeladen: {{percent}} %',
  downloading: 'LienCAM {{version}} wird heruntergeladen...',
  downloaded: 'LienCAM {{version}} ist heruntergeladen und geprüft.',
  installExplanation: 'Die Installation schließt LienCAM und die Maschinenbrücke und startet dann die neue Version. Ihre Einstellungen, Maschine, Werkzeuge und Projekte bleiben erhalten.',
  showFileExplanation: 'Diese Kopie kann sich nicht selbst ersetzen; LienCAM zeigt Ihnen stattdessen die geprüfte Datei zum Starten.',
  later: 'Später',
  installAndRestart: 'Installieren und neu starten',
  showFile: 'Datei anzeigen',
  close: 'Schließen',
  downloadAgain: 'Erneut herunterladen',
  downloadFailed: 'LienCAM konnte {{version}} nicht herunterladen ({{error}}); es wurde nichts installiert.',
  downloadedMatched: 'LienCAM {{version}} wurde heruntergeladen und stimmt mit der veröffentlichten SHA-256-Prüfsumme überein.',
  installChecking: 'LienCAM {{version}} wird vor der Installation erneut geprüft...',
  installFailed: 'LienCAM konnte {{version}} nicht installieren ({{error}}); diese Kopie ist unverändert.',
}

export default words
