// WO-2329: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
// A sample of Setup, the Tool Library and Post Process. A key left out here
// shows its English text. G/M words, file extensions and Ctrl letters stay.
// Default setup and tool names ("Setup 2", "New Tool") are deliberately left
// out: they become the setup's and tool's stored names, which the post writes
// into the program (section comment, LienCAM context), and posted files stay
// English. germanPilot.wo2329 pins this.
import type { Translation } from '../../index'

const setupStockToolsMachinePost: Translation<'setup-stock-tools-machine-post'> = {
  "SetupModal": {
    "shared_work_offset_note": "G{{value1}} wird auch verwendet{{value2}}. Das geht, wenn diese Aufspannungen als getrennte Dateien (eine pro Aufspannung) ausgegeben werden; ein kombiniertes Programm lehnt es ab.",
    "back_left": "Hinten links",
    "back_center": "Hinten Mitte",
    "back_right": "Hinten rechts",
    "mid_left": "Mitte links",
    "center": "Mitte",
    "mid_right": "Mitte rechts",
    "front_left": "Vorne links",
    "front_center": "Vorne Mitte",
    "front_right": "Vorne rechts",
    "x_front_and_back_swap": "X - vorne und hinten tauschen",
    "y_left_and_right_swap": "Y - links und rechts tauschen",
    "spoilboard": "Opferplatte",
    "vise": "Schraubstock",
    "fixed_jaw": "Feste Backe",
    "soft_jaw": "Weiche Backe",
    "custom_riser": "Eigene Unterlage",
    "machine_table": "Maschinentisch",
    "spoilboard_top": "Opferplatte oben",
    "vise_bed": "Schraubstockboden",
    "fixed_jaw_shelf": "Absatz der festen Backe",
    "soft_jaw_step": "Stufe der weichen Backe",
    "stock_bottom": "Rohteil unten",
    "custom_plane": "Eigene Ebene",
    "fixture_layer": "Spannmittel-Ebene",
    "every_fixture_layer_needs_a_name": "Jede Spannmittel-Ebene braucht einen Namen.",
    "fixture_heights_must_be_finite_and_at": "Spannmittelhöhen müssen endlich und mindestens null sein.",
    "top": "OBEN",
    "bottom": "UNTEN",
    "setup_work_coordinate_system_changed_regenerate_this": "Werkstückkoordinatensystem der Aufspannung geändert; diesen Arbeitsschritt neu erzeugen.",
    "work_offset_changed_from_g_to_g": "Nullpunktverschiebung von G{{value1}} auf G{{value2}} geändert",
    "work_coordinate_system_changed": "Werkstückkoordinatensystem geändert",
    "default_operation_heights_changed": "Standardhöhen der Arbeitsschritte geändert"
  },
  "ToolLibraryModal": {
    "carbide": "Hartmetall",
    "hss": "HSS",
    "cobalt": "Kobalt",
    "ceramic": "Keramik",
    "diamond_coated": "Diamantbeschichtet",
    "none_uncoated": "Keine (unbeschichtet)",
    "tin_gold": "TiN (gold)",
    "ticn_grey_gold": "TiCN (graugold)",
    "tialn_violet": "TiAlN (violett)",
    "dlc_black": "DLC (schwarz)",
    "zrn_pale_gold": "ZrN (hellgold)",
    "none": "Keine",
    "flood": "Flutkühlung",
    "mist": "Minimalmengenschmierung",
    "air": "Druckluft",
    "softwood": "Weichholz",
    "hardwood": "Hartholz",
    "mdf_plywood": "MDF / Sperrholz",
    "acrylic_pmma": "Acrylglas (PMMA)",
    "hdpe_nylon": "HDPE / Nylon",
    "abs_pom": "ABS / POM",
    "foam_rigid": "Hartschaum",
    "aluminium_6061": "Aluminium 6061",
    "brass": "Messing",
    "mild_steel": "Baustahl",
    "carbon_fibre": "Kohlefaser",
    "discard_unsaved_changes": "Ungespeicherte Änderungen verwerfen?",
    "this_tool_has_edits_that_were_not": "Dieses Werkzeug hat Änderungen, die nicht gespeichert wurden.",
    "discard": "Verwerfen",
    "keep_editing": "Weiter bearbeiten",
    "new_library_name": "Name der neuen Bibliothek:",
    "new_library": "Neue Bibliothek",
    "new_holder": "Neue Werkzeugaufnahme",
    "imported_library": "Importierte Bibliothek",
    "could_not_read_the_selected_file": "Die gewählte Datei konnte nicht gelesen werden."
  },
  "PostProcessModal": {
    "controller_not_declared": "Steuerung nicht angegeben",
    "built_in_templates": "Eingebaute Vorlagen",
    "saved_posts": "Gespeicherte Postprozessoren",
    "name_for_this_saved_post": "Name für diesen gespeicherten Postprozessor:",
    "saved": "{{value1}} gespeichert",
    "delete": "Löschen",
    "cancel": "Abbrechen",
    "deleted": "{{value1}} gelöscht",
    "downloaded": "{{value1}} heruntergeladen",
    "posted_lines": "{{value1}} ausgegeben ({{value2}} Zeilen)",
    "downloaded_and": "{{value1}} und {{value2}} heruntergeladen",
    "clipboard_access_is_unavailable_select_the_g": "Kein Zugriff auf die Zwischenablage. Den G-Code-Text markieren und stattdessen Ctrl+C drücken.",
    "copied_all_g_code_to_the_clipboard": "Gesamten G-Code in die Zwischenablage kopiert ({{value1}} Zeilen)",
    "post_process": "Postprozessor — {{value1}} ({{value2}})",
    "close": "Schließen",
    "properties": "Eigenschaften"
  }
}

export default setupStockToolsMachinePost
