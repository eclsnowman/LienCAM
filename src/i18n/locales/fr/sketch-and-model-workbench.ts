// WO-2939: machine translation; docs/i18n/GLOSSARY-fr.md.
import type { Translation } from '../../index'
const words: Translation<'sketch-and-model-workbench'> = {
  ModelWorkspaceHeader: {
    designTree: 'Arbre de conception', doubleClickToRenameThisModel: 'Double-cliquer pour renommer ce modèle', switchModel: 'Changer de modèle', newModel: 'Nouveau modèle', finish: 'Terminer',
  },
  DialogShell: { apply: 'Appliquer', cancel: 'Annuler' },
  ExtrudeDialog: {
    editExtrude: 'Modifier l’extrusion', extrude3: 'Extrusion', stopPicking: 'Arrêter la sélection', cancel: 'Annuler', donePicking: 'Terminer la sélection',
    pickProfileInViewport: 'Sélectionner un profil dans la vue', sketch: 'Esquisse : ', useWholeSketch: 'Utiliser toute l’esquisse', profile: 'Profil', region: 'Région ',
    end: 'Fin', direction: 'Direction', distance: 'Distance', offset: 'Décalage', pickFaceOrPlane: 'Sélectionner une face ou un plan', pickPartOrBody: 'Sélectionner une pièce ou un corps',
    pickVertexOrPoint: 'Sélectionner un sommet ou un point', none: 'aucun', result: 'Résultat', pickBodyInViewport: 'Sélectionner un corps dans la vue', target: 'Cible',
    noBodyAvailable: '(aucun corps disponible)', updatingPreview: 'Mise à jour de l’aperçu...', livePreviewReady: 'Aperçu en direct prêt',
  },
  FilletDialog: {
    editFilletCommand: 'Modifier la commande Congé', filletCommand: 'Commande Congé', fillet3: 'Congé', selectEdgesInTheViewport: 'Sélectionner des arêtes dans la vue',
    clickEdgesToAddOrRemove: 'Cliquer sur les arêtes pour les ajouter ou les retirer', radius: 'Rayon', filletRadius: 'Rayon du congé', updating: 'Mise à jour...', ready: 'Prêt',
    applyFillet: 'Appliquer le congé', applyFilletEnter: 'Appliquer le congé (Enter)', apply: 'Appliquer', cancelFillet: 'Annuler le congé', cancelFilletEscape: 'Annuler le congé (Escape)', cancel: 'Annuler',
  },
  WorkbenchToolRail: {
    create: 'Créer', line: 'Ligne', rectangle: 'Rectangle', centerRect: 'Rectangle centré', circle: 'Cercle', '3PtCircle': 'Cercle par 3 points', ellipse: 'Ellipse',
    spline: 'Spline', controlSpline: 'Spline de contrôle', bezier: 'Bézier', conicArc: 'Arc conique', '3PtArc': 'Arc par 3 points', tangentArc: 'Arc tangent', centerArc: 'Arc centré',
    gear: 'Engrenage', polygon: 'Polygone', slot: 'Rainure', point: 'Point', modify: 'Modifier', smartDim: 'Cote intelligente', trim: 'Ajuster', split: 'Scinder', extend: 'Prolonger',
    fillet: 'Congé', chamfer: 'Chanfrein', offset: 'Décalage', mirror: 'Symétrie', linearPat: 'Répétition linéaire', circularPat: 'Répétition circulaire', pathPat: 'Répétition sur trajectoire',
    move: 'Déplacer', rotate: 'Pivoter', scale: 'Échelle', coincident: 'Coïncident', concentric: 'Concentrique', parallel: 'Parallèle', perpendicular: 'Perpendiculaire',
    collinear: 'Colinéaire', horizontal: 'Horizontal', vertical: 'Vertical', tangent: 'Tangent', resizeToolRail: 'Redimensionner la barre d’outils', select: 'Sélectionner', utility: 'Utilitaires', projectUse: 'Projeter / Utiliser',
  },
  SketchToolbox: {
    create: 'Créer', line: 'Ligne', rectangle: 'Rectangle', centerRect: 'Rectangle centré', circle: 'Cercle', '3PtCircle': 'Cercle par 3 points', ellipse: 'Ellipse', ellipticalArc: 'Arc elliptique',
    spline: 'Spline', controlSpline: 'Spline de contrôle', bezier: 'Bézier', conicArc: 'Arc conique', text: 'Texte', '3PtArc': 'Arc par 3 points', tangentArc: 'Arc tangent', centerArc: 'Arc centré',
    gear: 'Engrenage', polygon: 'Polygone', slot: 'Rainure', arcSlot: 'Rainure en arc', point: 'Point', construction: 'Construction', modify: 'Modifier', smartDim: 'Cote intelligente', reference: 'Référence',
    trim: 'Ajuster', split: 'Scinder', extend: 'Prolonger', fillet: 'Congé', chamfer: 'Chanfrein', offset: 'Décalage', mirror: 'Symétrie', linearPat: 'Répétition linéaire', circularPat: 'Répétition circulaire',
    pathPat: 'Répétition sur trajectoire', move: 'Déplacer', rotate: 'Pivoter', scale: 'Échelle', delete: 'Supprimer', constraints: 'Contraintes', coincident: 'Coïncident', concentric: 'Concentrique',
    parallel: 'Parallèle', perpendicular: 'Perpendiculaire', collinear: 'Colinéaire', horizontal: 'Horizontal', vertical: 'Vertical', tangent: 'Tangent',
  },
  AgentCommands: { setParameter: 'Agent : définir {{name}} = {{expression}}', extrude: 'Agent : Extruder', deleteFeature: 'Agent : Supprimer', revolve: 'Agent : Révolution', fillet: 'Agent : Congé', chamfer: 'Agent : Chanfrein', hole: 'Agent : Perçage', sketch: 'Agent : Esquisse' },
}
export default words
