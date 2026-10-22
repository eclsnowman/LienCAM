// WO-2938: Spanish machine translation; see docs/i18n/GLOSSARY-es.md.
// Stored default setup/tool names stay English: they appear in posted files.
import type { Translation } from '../../index'
const words: Translation<'setup-stock-tools-machine-post'> = {
  SetupModal: {
    shared_work_offset_note: 'G{{value1}} también está en uso{{value2}}. Funciona si estas configuraciones se posprocesan como archivos separados (uno por configuración); un programa combinado lo rechaza.',
    back_left: 'Atrás izquierda', back_center: 'Atrás centro', back_right: 'Atrás derecha', mid_left: 'Centro izquierda',
    center: 'Centro', mid_right: 'Centro derecha', front_left: 'Delante izquierda', front_center: 'Delante centro', front_right: 'Delante derecha',
    x_front_and_back_swap: 'X - intercambiar delante y atrás', y_left_and_right_swap: 'Y - intercambiar izquierda y derecha',
    spoilboard: 'Tablero de sacrificio', vise: 'Mordaza', fixed_jaw: 'Mordiente fijo', soft_jaw: 'Mordiente blando',
    custom_riser: 'Elevador personalizado', machine_table: 'Mesa de máquina', spoilboard_top: 'Cara superior del tablero de sacrificio',
    vise_bed: 'Base de mordaza', fixed_jaw_shelf: 'Apoyo del mordiente fijo', soft_jaw_step: 'Escalón del mordiente blando',
    stock_bottom: 'Parte inferior del material en bruto', custom_plane: 'Plano personalizado', fixture_layer: 'Capa de utillaje',
    every_fixture_layer_needs_a_name: 'Cada capa de utillaje necesita un nombre.',
    fixture_heights_must_be_finite_and_at: 'Las alturas del utillaje deben ser finitas y al menos cero.',
    top: 'SUPERIOR', bottom: 'INFERIOR',
    setup_work_coordinate_system_changed_regenerate_this: 'Se cambió el sistema de coordenadas de trabajo de la configuración; regenere esta operación.',
    work_offset_changed_from_g_to_g: 'Desfase de trabajo cambiado de G{{value1}} a G{{value2}}',
    work_coordinate_system_changed: 'Sistema de coordenadas de trabajo modificado', default_operation_heights_changed: 'Alturas predeterminadas de operación modificadas',
  },
  ToolLibraryModal: {
    carbide: 'Carburo', hss: 'HSS', cobalt: 'Cobalto', ceramic: 'Cerámica', diamond_coated: 'Recubrimiento de diamante',
    none_uncoated: 'Ninguno (sin recubrimiento)', tin_gold: 'TiN (dorado)', ticn_grey_gold: 'TiCN (gris dorado)',
    tialn_violet: 'TiAlN (violeta)', dlc_black: 'DLC (negro)', zrn_pale_gold: 'ZrN (dorado pálido)',
    none: 'Ninguno', flood: 'Inundación', mist: 'Niebla', air: 'Aire', softwood: 'Madera blanda', hardwood: 'Madera dura',
    mdf_plywood: 'MDF / contrachapado', acrylic_pmma: 'Acrílico (PMMA)', hdpe_nylon: 'HDPE / nailon', abs_pom: 'ABS / POM',
    foam_rigid: 'Espuma rígida', aluminium_6061: 'Aluminio 6061', brass: 'Latón', mild_steel: 'Acero dulce', carbon_fibre: 'Fibra de carbono',
    discard_unsaved_changes: '¿Descartar los cambios sin guardar?', this_tool_has_edits_that_were_not: 'Esta herramienta tiene cambios sin guardar.',
    discard: 'Descartar', keep_editing: 'Seguir editando', new_library_name: 'Nombre de la nueva biblioteca:', new_library: 'Nueva biblioteca',
    new_holder: 'Nuevo portaherramientas', imported_library: 'Biblioteca importada', could_not_read_the_selected_file: 'No se pudo leer el archivo seleccionado.',
  },
  PostProcessModal: {
    controller_not_declared: 'Controlador sin especificar', built_in_templates: 'Plantillas incluidas', saved_posts: 'Posprocesadores guardados',
    name_for_this_saved_post: 'Nombre para este posprocesador guardado:', saved: '{{value1}} guardado', delete: 'Eliminar', cancel: 'Cancelar',
    deleted: '{{value1}} eliminado', downloaded: '{{value1}} descargado', posted_lines: '{{value1}} posprocesado ({{value2}} líneas)',
    downloaded_and: '{{value1}} y {{value2}} descargados',
    clipboard_access_is_unavailable_select_the_g: 'El portapapeles no está disponible. Seleccione el texto del código G y pulse Ctrl+C.',
    copied_all_g_code_to_the_clipboard: 'Todo el código G copiado al portapapeles ({{value1}} líneas)',
    post_process: 'Posprocesado — {{value1}} ({{value2}})', close: 'Cerrar', properties: 'Propiedades',
  },
}
export default words
