// WO-3267: desktop update offer text.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'desktop-update.wo3267'> = {
  offerAvailable: 'LienCAM {{version}} est disponible (vous avez {{currentVersion}}).',
  offerAvailableSized: 'LienCAM {{version}} est disponible (vous avez {{currentVersion}}), {{size}}.',
  notNow: 'Pas maintenant',
  download: 'Télécharger',
  downloadingPercent: 'Téléchargement de LienCAM {{version}} : {{percent}} %',
  downloading: 'Téléchargement de LienCAM {{version}}...',
  downloaded: 'LienCAM {{version}} est téléchargé et vérifié.',
  installExplanation: 'L\'installation ferme LienCAM et le pont machine, puis démarre la nouvelle version. Vos réglages, machine, outils et projets sont conservés.',
  showFileExplanation: 'Cette copie ne peut pas se remplacer elle-même ; LienCAM vous montre à la place le fichier vérifié à lancer.',
  later: 'Plus tard',
  installAndRestart: 'Installer et redémarrer',
  showFile: 'Afficher le fichier',
  close: 'Fermer',
  downloadAgain: 'Télécharger à nouveau',
  downloadFailed: 'LienCAM n\'a pas pu télécharger {{version}} ({{error}}) ; rien n\'a été installé.',
  downloadedMatched: 'LienCAM {{version}} a été téléchargé et correspond à sa somme de contrôle SHA-256 publiée.',
  installChecking: 'Nouvelle vérification de LienCAM {{version}} avant l\'installation...',
  installFailed: 'LienCAM n\'a pas pu installer {{version}} ({{error}}) ; cette copie est inchangée.',
}

export default words
