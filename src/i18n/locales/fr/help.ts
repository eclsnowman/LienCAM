// WO-2939: French machine translation from current English Help registry.
// Coverage matches German; omitted bodies remain English. No commands translated.
import type { CatalogTree } from '../../catalogs'
const help: CatalogTree = {
  categories: {
    'getting-started': 'Premiers pas', 'workspaces-viewport': 'Espaces de travail et vue', 'import-geometry': 'Import et géométrie',
    sketching: 'Esquisse', modeling: 'Modélisation', 'setups-stock-wcs': 'Montages, brut et coordonnées', 'cam-operations': 'Opérations FAO',
    'tools-holders': 'Outils et porte-outils', nesting: 'Imbrication', simulation: 'Simulation', 'posting-gcode': 'Post-traitement et G-code',
    machine: 'Machine', settings: 'Paramètres', troubleshooting: 'Dépannage',
  },
  topics: {
    'welcome-overview': {
      title: 'Présentation de LienCAM', summary: 'Une application de FAO et de CAO qui transforme dessins et modèles en G-code et enregistre des fichiers projet autonomes.',
      keywords: 'bienvenue présentation introduction navigateur FAO CAO espace travail démarrer débutant onglets bibliothèque outils montage esquisse modèle parcours simulation post-traitement commande welcome overview introduction',
      sections: {
        0: { text: 'LienCAM transforme des dessins 2D et des modèles 3D en G-code pour une fraiseuse ou une défonceuse CNC. Il fonctionne dans votre navigateur web. Les projets sont des fichiers .camproject ordinaires que vous enregistrez et ouvrez sur votre ordinateur.' },
        1: { text: 'Les onglets en haut de la fenêtre suivent les étapes du travail : Bibliothèque d’outils, Montage, Esquisse, Modèle, Parcours, Simuler, Post-traitement et Commande. Montage, Esquisse, Parcours et Simuler sont des vues de l’espace FAO, où vous importez les pièces, définissez le brut, créez les opérations et vérifiez les parcours. Modèle ouvre l’espace de modélisation solide pour construire des pièces 3D. Post-traitement écrit le G-code et Commande l’exécute sur votre machine.' },
        2: { text: 'L’écran FAO comporte cinq zones : l’en-tête en haut, l’arbre de conception à gauche, la vue 3D au centre, le panneau de propriétés à droite, puis la console et la barre d’état en bas. Consultez « Les cinq zones de l’écran » pour une visite et « Votre premier parcours » pour le chemin le plus court vers l’usinage d’une pièce.' },
      },
      images: { 'app-overview': { alt: 'La fenêtre complète de l’application avec une pièce chargée et un parcours visible' } },
    },
    'first-toolpath': {
      title: 'Votre premier parcours', summary: 'Importer une pièce, ajouter un montage, créer une opération, vérifier le parcours et générer le G-code.',
      keywords: 'premier parcours tutoriel démarrage rapide importer pièce montage opération calculer recalculer post-traitement gcode g-code débutant first toolpath tutorial quick start',
      sections: {
        0: { steps: {
          0: 'Importer une pièce : dans l’arbre de conception à gauche, cliquez sur le bouton + (Import geometry) de l’en-tête Geometry et choisissez un fichier DXF, SVG, STL, OBJ ou STEP.',
          1: 'Ajouter un montage : cliquez sur le bouton + de l’en-tête Setups (« Add setup »). Dans la fenêtre New Setup, choisissez le brut, placez l’origine pièce, puis cliquez sur Create Setup. Le montage détermine où se situe le zéro de votre machine sur le brut.',
          2: 'Créer une opération : cliquez sur le bouton + de la ligne du montage (« Add operation (N) ») ou appuyez sur N. Choisissez un type d’opération, un outil et la géométrie à usiner, puis cliquez sur Create Operation. Le parcours est calculé dès la création de l’opération.',
          3: 'Vérifier le résultat : cliquez sur l’onglet Parcours de l’en-tête pour voir les mouvements de coupe. Après une modification, appuyez sur G pour recalculer l’opération sélectionnée, Shift+G pour toutes les recalculer, ou cliquez sur REGEN ALL dans l’en-tête Setups.',
          4: 'Générer le G-code : cliquez sur l’onglet Post-traitement de l’en-tête, vérifiez le résultat et enregistrez le fichier pour votre machine.',
        } },
        1: { text: 'Surveillez l’extrémité gauche de la barre d’état en bas de la fenêtre : elle affiche « Calcul... » pendant le calcul des parcours, « Calcul en attente » lorsqu’une opération doit être recalculée, un nombre tel que « 1 opération en échec » lorsqu’une opération n’a pas pu être générée, et « Prêt » lorsqu’il n’y a rien à faire.' },
      },
      images: { 'first-toolpath-strip': { alt: 'Cinq petites captures montrant import, montage, opération, vue du parcours et post-traitement' } },
    },
    'work-offsets': {
      title: 'Décalages d’origine G54-G59', summary: 'Chaque montage est généré avec l’un des six décalages d’origine, de G54 à G59, choisi dans la fenêtre Montage ; les montages sur le même brut peuvent en partager un.',
      keywords: 'g54 g55 g56 g57 g58 g59 décalage origine montage post-traitement gcode brut partage conflit utilisé fichiers séparés work offset',
      sections: {
        0: { steps: {
          0: 'Dans la fenêtre Montage, choisissez le décalage dans la liste « Setup work offset ». L’arbre de conception affiche le décalage de chaque montage sur sa ligne.',
          1: 'Chaque montage peut utiliser n’importe lequel des six décalages, même un décalage déjà utilisé par des montages sur un autre brut (chaque chargement du plateau peut être G54). Si le décalage choisi sert aussi ailleurs, la fenêtre indique où. Cela fonctionne quand les montages sont générés en fichiers séparés ; un programme « Combined » le refuse.',
        } },
        2: { text: 'Le post-processeur écrit chaque montage avec son décalage. Avec « Separate files (one per setup) » dans Post-traitement, chaque fichier porte son décalage dans son nom (par exemple part-G54.nc, part-G55.nc). Des fichiers séparés peuvent partager un décalage, car chaque fichier s’exécute seul. Un programme « Combined » est une seule exécution : un décalage partagé par deux bruts différents interrompt l’export avec un message nommant les montages concernés et proposant des fichiers séparés.' },
      },
      images: { 'offset-dropdown': { alt: 'La liste Setup work offset avec G54 indiqué comme utilisé par un autre brut' } },
    },
    'keyboard-shortcuts': { title: 'Raccourcis clavier', summary: 'Les raccourcis suivent l’espace de travail actif et n’interfèrent pas avec votre saisie.' },
    'projects-save-open': { title: 'Enregistrer et ouvrir des projets', summary: 'Les projets s’enregistrent dans des fichiers .camproject autonomes qui contiennent pièces, outils, modèles et parcours.' },
    units: { title: 'mm et pouces', summary: 'Les unités d’affichage changent ce que vous voyez et saisissez ; les unités d’export déterminent si le G-code généré utilise G21 ou G20.' },
    undo: { title: 'Annuler et historique', summary: 'Ctrl+Z annule la dernière modification, Ctrl+Y la rétablit et l’application conserve les 50 dernières modifications.' },
    'ui-tour': { title: 'Les cinq zones de l’écran', summary: 'L’en-tête, l’arbre de conception, la vue 3D, le panneau de propriétés et la console avec barre d’état ont chacun un rôle.' },
    'error-details': { title: 'Où trouver les détails des erreurs', summary: 'La console en bas affiche les événements, avertissements et erreurs de la session actuelle.' },
    'viewport-navigation': { title: 'Orbite, déplacement, zoom et cube de vue', summary: 'La souris fait pivoter, déplace et zoome la vue 3D selon la configuration choisie dans Paramètres ; le cube de vue et le menu contextuel donnent accès aux vues standard.' },
    'design-tree': { title: 'L’arbre de conception', summary: 'Le panneau gauche répertorie le projet dans trois sections - Stock, Geometry et Setups - avec dossiers, renommage, visibilité et indicateurs d’état.' },
    'setup-wcs': { title: 'Montage et WCS', summary: 'Un montage définit le brut à usiner, son décalage et son origine pièce, les couches de montage sous le brut et les hauteurs par défaut de ses opérations.' },
    'wcs-origin-placement': { title: 'Placer l’origine pièce', summary: 'La fenêtre Montage propose cinq façons de placer l’origine pièce : un coin du brut, un sommet du modèle accroché, des coordonnées saisies, un manipulateur déplaçable dans la vue ou le centre d’un élément circulaire.' },
    workholding: { title: 'Serrage : étaux et brides', summary: 'Importez étau, mors ou brides comme pièce et activez Workholding : le corps devient un élément de serrage, jamais un brut ni une coupe ; les parcours l’évitent et Seat in vise y place les pièces en appui.' },
    'height-references': { title: 'Comprendre les hauteurs', summary: 'Chaque opération utilise cinq plans - dégagement, retrait, avance, dessus et dessous - mesurés depuis une référence choisie ; l’onglet Heights indique leur Z dans le WCS.' },
    'creating-operations': { title: 'Créer une opération', summary: 'La fenêtre New Operation vous guide dans les onglets type, outil, géométrie, passes, hauteurs, liaisons et avance.' },
    contour: { title: 'Contour 2D', summary: 'Contour 2D usine un profil à une ou plusieurs profondeurs, avec quatre stratégies de coupe, des parcours ouverts, des attaches et une entrée en rampe.' },
    pocket: { title: 'Poche 2D', summary: 'Poche 2D évide une région fermée par passes concentriques, conserve les îlots, entre en hélice, en rampe ou en plongée et finit la paroi.' },
    drill: { title: 'Perçage', summary: 'Perçage perce au centre de chaque trou sélectionné ou détecté, avec quatre cycles de perçage et une profondeur pour chaque trou.' },
    'face-op': { title: 'Surfaçage 2D', summary: 'Surfaçage 2D usine le dessus du brut avec des passes dépassant les bords pour dégager complètement la fraise.' },
    'adaptive-clearing': { title: 'Ébauche adaptative', summary: 'Ébauche adaptative 2D ébauche une région en maintenant la charge latérale de l’outil près de la valeur définie.' },
    'feeds-speeds': { title: 'Priorité des avances et vitesses', summary: 'Les opérations utilisent les avances et vitesses de la bibliothèque d’outils, sauf si vous les remplacez pour une opération, dans les limites machine.' },
    'tool-library': { title: 'La bibliothèque d’outils', summary: 'La fenêtre Bibliothèque d’outils contient les fraises dans des bibliothèques nommées, avec recherche, filtres et éditeur à onglets accompagné d’un schéma d’outil en direct.' },
    'tool-holders': { title: 'Porte-outils', summary: 'Les porte-outils sont des empilements de segments coniques ou cylindriques dans leur propre liste ; associez-en un à un outil pour afficher l’ensemble au-dessus de la longueur sortie.' },
    'stock-simulation': { title: 'Simulation du brut', summary: 'L’onglet Simuler rejoue les parcours calculés et, avec Simuler l’enlèvement de matière activé, retire la matière du brut du montage.' },
    'post-basics': { title: 'Générer le G-code', summary: 'La fenêtre Post-traitement transforme les parcours calculés en fichiers G-code pour votre contrôleur, avec un aperçu en direct du contenu exact à écrire.' },
    'control-tab-overview': { title: 'L’onglet Commande', summary: 'Commande transforme l’application en émetteur machine : l’aperçu du parcours reste central, entouré des panneaux connexion, déplacement manuel, programme et sécurité.' },
    'control-jog-zero': { title: 'Déplacement manuel et mise à zéro', summary: 'Le panneau Déplacement manuel déplace la machine par pas ou en continu et le panneau des décalages d’origine définit X0/Y0/Z0 - par bouton ou avec la plaque de palpage pour Z.' },
    'control-run-job': { title: 'Exécuter un travail', summary: 'Générez un montage directement dans l’émetteur ou chargez un fichier, tracez d’abord son contour si vous le souhaitez, puis exécutez avec pause, reprise et corrections en direct.' },
    'probing-tab': { title: 'L’onglet Palpage', summary: 'Palpage trouve bords, coins, alésages, bossages, surfaces et longueurs d’outils avec un palpeur et affiche le plan sur un schéma. Z0 est écrit immédiatement ; Z outil enregistre immédiatement sa mesure. Vérifiez les autres résultats avant de les appliquer.' },
    'control-tool-setter': { title: 'Le palpeur d’outil fixe', summary: 'Un palpeur fixe mesure l’outil à une position machine connue ; la table d’outils conserve le contact et le compare à un outil de référence mesuré pour appliquer la longueur.' },
    'settings-tour': { title: 'La fenêtre Paramètres', summary: 'Paramètres regroupe les préférences globales dans une fenêtre défilante à sections nommées - enregistrées sur cet ordinateur, pas dans le fichier projet.' },
    'outdated-after-open': { title: 'Tout est périmé après ouverture', summary: 'Les opérations s’ouvrent avec une horloge ambre quand leur parcours n’a pas pu être restauré - tous les paramètres sont conservés et Recalculer reconstruit le parcours.' },
  },
}
export default help
