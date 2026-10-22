// WO-2939: wording only; no probing plans or controller commands change.
import type { Translation } from '../../index'
const words: Translation<'probing-screens'> = {
  probingPanel1: 'Aucun décalage d’origine actif - Z0 est écrit dans le décalage actif.',
  probingPanel2: '{{value1}} Z0 : non défini depuis l’ouverture de LienCAM - la valeur Z {{value2}} enregistrée dans le contrôleur est utilisée.',
  probingPanel6: '{{value1}} Z0 utilisé : défini à {{value2}}{{value3}}.',
  probingPanel7: 'Dessus du brut', probingPanel8: 'Bord', probingPanel9: 'Une face X/Y', probingPanel10: 'Coin extérieur',
  probingPanel11: 'Deux faces extérieures', probingPanel12: 'Coin intérieur', probingPanel13: 'Deux faces intérieures',
  probingPanel14: 'Angle', probingPanel15: 'Alignement sur deux points', probingPanel16: 'Alésage', probingPanel17: 'Centre intérieur circulaire',
  probingPanel18: 'Bossage', probingPanel19: 'Centre extérieur circulaire', probingPanel20: 'Poche rectangulaire', probingPanel21: 'Quatre faces intérieures',
  probingPanel22: 'Bossage rectangulaire', probingPanel23: 'Quatre faces extérieures', probingPanel24: 'Surface Z', probingPanel25: 'Cartographier la surface de coupe',
  probingPanel26: 'Z outil', probingPanel27: 'Mesurer l’outil actif', probingPanel28: 'Étalonner', probingPanel29: 'Rayon du palpeur X / Y',
  probingPanel39: 'Écrit {{value1}} {{value2}}',
  probingPanel40: 'Arrêt - annule le cycle de palpage en cours. Ce n’est pas un arrêt d’urgence : aucun verrouillage n’est maintenu.',
  probingPanel41: 'Les limites de course machine ne sont pas encore connues - les paramètres du contrôleur n’ont pas été lus.',
  probingPanel44: 'Référencez la machine avant de planifier un cycle de palpage automatique.',
  probingPanel45: 'Référencez la machine avant de planifier les déplacements du maillage.', probingPanel55: 'Confirmer le décalage {{value1}}', probingPanel60: 'non défini',
  probingPanel78: 'Connectez d’abord la machine.', probingPanel79: 'Un cycle de palpage est en cours - attendez sa fin.',
  probingPanel80: 'Une pause (changement d’outil en attente de votre intervention) occupe la machine - appuyez sur Départ cycle pour la terminer, ou sur Arrêt, puis lancez le palpage.',
  probingPanel81: 'Un programme est en cours - appuyez sur Arrêt avance, puis Arrêt, avant de palper.',
  probingPanel82: 'La machine est {{value1}} - attendez qu’elle soit au repos.', probingPanel83: 'Lisez d’abord la position machine.', probingPanel84: 'Ce cycle n’a pas encore de plan.',
  probingPanel90: 'Résultat angulaire', probingPanel93: 'Palpage de {{value1}} points de maillage - gardez l’arrêt d’urgence à portée de main.',
  probingPanel96: 'Z0 pièce défini : {{value1}} Z0 = {{value2}} {{value3}}.',
}
export default words
