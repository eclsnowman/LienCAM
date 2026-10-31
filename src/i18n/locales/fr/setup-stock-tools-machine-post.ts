// WO-2939: machine translation; default persisted names remain English in product code.
import type { Translation } from '../../index'
const words: Translation<'setup-stock-tools-machine-post'> = {
  SetupModal: {
    shared_work_offset_note: 'G{{value1}} est aussi utilisé{{value2}}. Cela fonctionne si ces montages sont post-traités en fichiers séparés (un par montage) ; un programme combiné le refuse.',
    back_left: 'Arrière gauche', back_center: 'Arrière centre', back_right: 'Arrière droit', mid_left: 'Milieu gauche', center: 'Centre', mid_right: 'Milieu droit',
    front_left: 'Avant gauche', front_center: 'Avant centre', front_right: 'Avant droit', x_front_and_back_swap: 'X - inverser avant et arrière', y_left_and_right_swap: 'Y - inverser gauche et droite',
    spoilboard: 'Plateau martyr', vise: 'Étau', fixed_jaw: 'Mors fixe', soft_jaw: 'Mors doux', custom_riser: 'Rehausse personnalisée', machine_table: 'Table machine',
    spoilboard_top: 'Dessus du plateau martyr', vise_bed: 'Base de l’étau', fixed_jaw_shelf: 'Appui du mors fixe', soft_jaw_step: 'Épaulement du mors doux',
    stock_bottom: 'Dessous du brut', custom_plane: 'Plan personnalisé', fixture_layer: 'Couche de montage', every_fixture_layer_needs_a_name: 'Chaque couche de montage doit avoir un nom.',
    fixture_heights_must_be_finite_and_at: 'Les hauteurs de montage doivent être finies et positives ou nulles.', top: 'DESSUS', bottom: 'DESSOUS',
    setup_work_coordinate_system_changed_regenerate_this: 'Le repère pièce du montage a changé ; recalculez cette opération.',
    work_offset_changed_from_g_to_g: 'décalage d’origine modifié de G{{value1}} à G{{value2}}', work_coordinate_system_changed: 'repère pièce modifié', default_operation_heights_changed: 'hauteurs par défaut des opérations modifiées',
  },
  ToolLibraryModal: {
    carbide: 'Carbure', hss: 'HSS', cobalt: 'Cobalt', ceramic: 'Céramique', diamond_coated: 'Revêtement diamant', none_uncoated: 'Aucun (non revêtu)',
    tin_gold: 'TiN (doré)', ticn_grey_gold: 'TiCN (gris doré)', tialn_violet: 'TiAlN (violet)', dlc_black: 'DLC (noir)', zrn_pale_gold: 'ZrN (or pâle)',
    none: 'Aucun', flood: 'Arrosage', mist: 'Brouillard', air: 'Air', softwood: 'Bois tendre', hardwood: 'Bois dur', mdf_plywood: 'MDF / Contreplaqué',
    acrylic_pmma: 'Acrylique (PMMA)', hdpe_nylon: 'HDPE / Nylon', abs_pom: 'ABS / POM', foam_rigid: 'Mousse (rigide)', aluminium_6061: 'Aluminium 6061',
    brass: 'Laiton', mild_steel: 'Acier doux', carbon_fibre: 'Fibre de carbone', discard_unsaved_changes: 'Abandonner les modifications non enregistrées ?',
    this_tool_has_edits_that_were_not: 'Cet outil comporte des modifications non enregistrées.', discard: 'Abandonner', keep_editing: 'Continuer à modifier',
    new_library_name: 'Nom de la nouvelle bibliothèque :', new_library: 'Nouvelle bibliothèque', new_holder: 'Nouveau porte-outil', imported_library: 'Bibliothèque importée',
    could_not_read_the_selected_file: 'Impossible de lire le fichier sélectionné.',
  },
  PostProcessModal: {
    "no_operations_selected": "Aucune opération sélectionnée. Sélectionnez les opérations à exporter.",
    controller_not_declared: 'Contrôleur non déclaré', built_in_templates: 'Modèles intégrés', saved_posts: 'Post-processeurs enregistrés',
    name_for_this_saved_post: 'Nom de ce post-processeur enregistré :', saved: '{{value1}} enregistré', delete: 'Supprimer', cancel: 'Annuler', deleted: '{{value1}} supprimé',
    downloaded: '{{value1}} téléchargé', posted_lines: '{{value1}} généré ({{value2}} lignes)', downloaded_and: '{{value1}} et {{value2}} téléchargés',
    clipboard_access_is_unavailable_select_the_g: 'Accès au presse-papiers indisponible. Sélectionnez le texte G-code et appuyez sur Ctrl+C.',
    copied_all_g_code_to_the_clipboard: 'Tout le G-code a été copié dans le presse-papiers ({{value1}} lignes)', post_process: 'Post-traitement — {{value1}} ({{value2}})', close: 'Fermer', properties: 'Propriétés',
  },
}
export default words
