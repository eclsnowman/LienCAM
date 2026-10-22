// WO-2938: Spanish machine translation of current English Help.
// Coverage matches the German pilot; omitted text falls back to English.
// UI labels still in English are quoted literally so the instructions remain usable.
import type { CatalogTree } from '../../catalogs'
const words: CatalogTree = {
  categories: {
    'getting-started': 'Primeros pasos', 'workspaces-viewport': 'Espacios de trabajo y vista',
    'import-geometry': 'Importación y geometría', sketching: 'Bocetos', modeling: 'Modelado',
    'setups-stock-wcs': 'Configuraciones, material en bruto y coordenadas', 'cam-operations': 'Operaciones CAM',
    'tools-holders': 'Herramientas y portaherramientas', nesting: 'Anidado', simulation: 'Simulación',
    'posting-gcode': 'Posprocesado y código G', machine: 'Máquina', settings: 'Ajustes', troubleshooting: 'Solución de problemas',
  },
  topics: {
    'welcome-overview': {
      title: 'Qué es LienCAM',
      summary: 'Una aplicación CAM y CAD que convierte dibujos y modelos en código G y guarda archivos de proyecto autónomos.',
      keywords: 'bienvenida descripción introducción qué es navegador cam cad espacio trabajo inicio principiante acerca pestañas biblioteca herramientas configuración boceto modelo trayectoria simulación posprocesado control welcome overview introduction',
      sections: {
        0: { text: 'LienCAM convierte dibujos 2D y modelos 3D en código G para una fresadora CNC o un router CNC. Funciona en su navegador web. Los proyectos son archivos .camproject normales que guarda y abre en su propio ordenador.' },
        1: { text: 'Las pestañas de la parte superior de la ventana le guían por el trabajo en orden: Biblioteca de herramientas, Configuración, Boceto, Modelo, Trayectoria, Simulación, Posprocesado y Control. Configuración, Boceto, Trayectoria y Simulación son vistas del espacio CAM, donde importa piezas, define el material en bruto, crea operaciones y comprueba trayectorias. Modelo abre el espacio de modelado, un modelador de sólidos para construir piezas 3D. Posprocesado escribe el código G y Control lo ejecuta en su máquina.' },
        2: { text: 'La pantalla CAM tiene cinco zonas: la cabecera arriba, el árbol de diseño a la izquierda, la vista 3D en el centro, el panel de propiedades a la derecha y la consola con la barra de estado abajo. Consulte "Las cinco zonas de la pantalla" para una visita guiada y "Su primera trayectoria" para el camino más corto hasta mecanizar una pieza.' },
      },
      images: { 'app-overview': { alt: 'Ventana completa de la aplicación con una pieza cargada y una trayectoria visible' } },
    },
    'first-toolpath': {
      title: 'Su primera trayectoria', summary: 'Importe una pieza, añada una configuración, cree una operación, compruebe la trayectoria y posprocese el código G.',
      keywords: 'primera trayectoria tutorial inicio rápido importar pieza configuración operación generar regenerar posprocesar gcode g-code principiante crear first toolpath tutorial quick start',
      sections: {
        0: { steps: {
          0: 'Importe una pieza: en el árbol de diseño de la izquierda, haga clic en el botón + (Import geometry) de la cabecera de la sección Geometry y elija un archivo DXF, SVG, STL, OBJ o STEP.',
          1: 'Añada una configuración: haga clic en el botón + de la cabecera de la sección Setups ("Add setup"). En la ventana New Setup, elija el material en bruto y coloque el origen de trabajo; después haga clic en Create Setup. La configuración determina dónde se sitúa el cero de su máquina sobre el material en bruto.',
          2: 'Cree una operación: haga clic en el botón + de la fila de la configuración ("Add operation (N)") o pulse N. Elija el tipo de operación, la herramienta y la geometría que se va a cortar; después haga clic en Create Operation. La trayectoria se calcula en cuanto se crea la operación.',
          3: 'Compruebe el resultado: haga clic en la pestaña Trayectoria de la cabecera para ver los movimientos de corte. Si cambia algo después, pulse G para regenerar la operación seleccionada, Shift+G para regenerarlas todas, o haga clic en REGEN ALL en la cabecera de la sección Setups.',
          4: 'Posprocese el código G: haga clic en la pestaña Posprocesado de la cabecera, revise la salida y guarde el archivo para su máquina.',
        } },
        1: { text: 'Observe el extremo izquierdo de la barra de estado en la parte inferior de la ventana: indica "Calculando..." mientras se calculan las trayectorias, "Cálculo pendiente" cuando una operación necesita regenerarse, un recuento como "1 operación fallida" cuando alguna no pudo generarse y "Listo" cuando no hay nada que hacer.' },
      },
      images: { 'first-toolpath-strip': { alt: 'Cinco capturas pequeñas que muestran importación, configuración, operación, vista de trayectoria y posprocesado' } },
    },
    'work-offsets': {
      title: 'Desfases de trabajo G54-G59',
      summary: 'Cada configuración se posprocesa con uno de seis desfases de trabajo, de G54 a G59, elegido en su ventana; las configuraciones sobre el mismo material en bruto pueden compartir uno.',
      keywords: 'g54 g55 g56 g57 g58 g59 desfase trabajo origen cero posprocesado código g material bruto configuración compartir conflicto ocupado archivos separados work offset',
      sections: {
        0: { steps: {
          0: 'En la ventana de configuración, elija el desfase en la lista "Setup work offset". El árbol de diseño muestra el desfase de cada configuración en su fila.',
          1: 'Cualquier configuración puede usar cualquiera de los seis desfases, incluso uno que ya usen configuraciones sobre otro material en bruto (cada carga de la bancada puede ser G54). Si el desfase elegido se usa también en otro sitio, la ventana indica dónde. Eso funciona cuando las configuraciones se posprocesan como archivos separados; un programa "Combined" lo rechaza.',
        } },
        2: { text: 'El posprocesador escribe cada configuración con su desfase. Con "Separate files (one per setup)" en Posprocesado, cada archivo incluye su desfase en el nombre (por ejemplo, part-G54.nc, part-G55.nc). Los archivos separados pueden compartir un desfase, porque cada archivo se ejecuta por su cuenta. Un programa "Combined" es una sola ejecución: un desfase compartido por dos materiales en bruto diferentes detiene la exportación con un mensaje que identifica las configuraciones implicadas y sugiere archivos separados.' },
      },
      images: { 'offset-dropdown': { alt: 'Lista Setup work offset con G54 ocupado por otro material en bruto' } },
    },
    'keyboard-shortcuts': { title: 'Atajos de teclado', summary: 'Los atajos siguen el espacio de trabajo activo y no interfieren mientras escribe.' },
    'projects-save-open': { title: 'Guardar y abrir proyectos', summary: 'Los proyectos se guardan como archivos .camproject autónomos que contienen sus piezas, herramientas, modelos y trayectorias.' },
    units: { title: 'mm y pulgadas', summary: 'Las unidades de visualización cambian lo que ve y escribe; las de exportación determinan si el código G posprocesado usa G21 o G20.' },
    undo: { title: 'Deshacer e historial', summary: 'Ctrl+Z deshace el último cambio, Ctrl+Y lo rehace y la aplicación conserva los últimos 50 cambios.' },
    'ui-tour': { title: 'Las cinco zonas de la pantalla', summary: 'La cabecera, el árbol de diseño, la vista 3D, el panel de propiedades y la consola con barra de estado tienen cada uno su función.' },
    'error-details': { title: 'Dónde ver los detalles de los errores', summary: 'La consola inferior es la lista de eventos, advertencias y errores de la sesión actual dentro de la aplicación.' },
    'viewport-navigation': { title: 'Órbita, desplazamiento, zoom y cubo de vista', summary: 'El ratón orbita, desplaza y amplía la vista 3D según el esquema que elija en Ajustes; el cubo de vista o el menú contextual permiten ir a vistas estándar.' },
    'design-tree': { title: 'El árbol de diseño', summary: 'El panel izquierdo muestra todo el proyecto en tres secciones - Stock, Geometry y Setups - con carpetas, cambio de nombre, iconos de visibilidad e indicadores de estado.' },
    'setup-wcs': { title: 'Configuración y WCS', summary: 'Una configuración identifica el material en bruto que mecaniza, su desfase y origen de trabajo, el conjunto de utillaje que lo sostiene y las alturas predeterminadas de sus operaciones.' },
    'wcs-origin-placement': { title: 'Colocar el origen de trabajo', summary: 'La ventana de configuración ofrece cinco formas de colocar el origen: una esquina del material en bruto, un vértice del modelo capturado, coordenadas escritas, un manipulador arrastrable en la vista o el centro de un elemento circular.' },
    workholding: { title: 'Sujeción: mordazas y bridas', summary: 'Importe su mordaza, mordientes o bridas como pieza y active Workholding: el cuerpo se dibuja como utillaje, nunca es material en bruto ni corte, las trayectorias lo evitan y Seat in vise coloca las piezas contra él.' },
    'height-references': { title: 'Explicación de las alturas', summary: 'Cada operación usa cinco planos de altura - seguridad, retracción, avance, superior e inferior - medidos desde la referencia que elija; la pestaña Heights muestra la coordenada WCS Z de cada uno.' },
    'creating-operations': { title: 'Crear una operación', summary: 'La ventana New Operation le guía por tipo, herramienta, geometría, pasadas, alturas, enlaces y avance mediante un conjunto de pestañas.' },
    contour: { title: 'Contorno 2D', summary: 'Contorno 2D corta a lo largo de un perfil a una o varias profundidades, con cuatro estrategias de corte, trayectorias abiertas, puentes de sujeción y entrada en rampa.' },
    pocket: { title: 'Cajera 2D', summary: 'Cajera 2D vacía una región cerrada en anillos, conserva las islas, entra por hélice, rampa o penetración y realiza el acabado de la pared.' },
    drill: { title: 'Taladrado', summary: 'Taladrado perfora el centro de cada agujero seleccionado o detectado, con cuatro ciclos de taladrado y una profundidad para cada agujero.' },
    'face-op': { title: 'Planeado 2D', summary: 'Planeado 2D mecaniza la parte superior del material en bruto con pasadas que sobrepasan los bordes para que la fresa salga completamente.' },
    'adaptive-clearing': { title: 'Desbaste adaptativo', summary: 'Desbaste adaptativo 2D desbasta una región manteniendo la carga lateral de la herramienta cerca del valor establecido.' },
    'feeds-speeds': { title: 'Jerarquía de avances y velocidades', summary: 'Las operaciones toman los avances y velocidades de la biblioteca de herramientas, salvo que los sustituya para una operación, dentro de los límites de la máquina.' },
    'tool-library': { title: 'La biblioteca de herramientas', summary: 'La ventana Biblioteca de herramientas contiene todas las fresas en bibliotecas con nombre, con búsqueda, filtros y un editor por pestañas con un diagrama de herramienta en vivo.' },
    'tool-holders': { title: 'Portaherramientas', summary: 'Los portaherramientas son conjuntos de segmentos cónicos o cilíndricos guardados en su propia lista; asigne uno a una herramienta y la vista dibujará todo el conjunto sobre la longitud que sobresale.' },
    'stock-simulation': { title: 'Simulación del material en bruto', summary: 'La pestaña Simulación reproduce las trayectorias generadas y, con Simular arranque de material activado, las talla en el material en bruto de la configuración.' },
    'post-basics': { title: 'Posprocesar código G', summary: 'La ventana Posprocesado convierte las trayectorias calculadas en archivos de código G para su controlador, con una vista previa en vivo de lo que se escribirá exactamente.' },
    'control-tab-overview': { title: 'La pestaña Control', summary: 'Control convierte la aplicación en un emisor para la máquina: la vista previa de trayectoria sigue siendo el elemento principal, rodeada de paneles de conexión, movimiento manual, programa y seguridad.' },
    'control-jog-zero': { title: 'Movimiento manual y ajuste del cero', summary: 'El panel Movimiento manual mueve la máquina por pasos o continuamente y el panel Work offsets define X0/Y0/Z0 mediante botones o mediante la placa de palpado para Z.' },
    'control-run-job': { title: 'Ejecutar un trabajo', summary: 'Posprocese una configuración directamente al emisor o cargue un archivo, recorra primero el contorno del trabajo si lo desea y ejecute con pausa, reanudación y ajustes porcentuales en vivo.' },
    'probing-tab': { title: 'La pestaña Palpado', summary: 'Palpado encuentra aristas, esquinas, agujeros, salientes, superficies y longitudes de herramienta con un palpador de contacto y muestra el plan en un diagrama. Z0 se escribe inmediatamente; Z de herramienta registra su medida inmediatamente. Revise los demás resultados antes de aplicarlos.' },
    'control-tool-setter': { title: 'El medidor fijo de herramientas', summary: 'Un medidor fijo mide una herramienta en una posición de máquina conocida; la tabla de herramientas conserva el contacto y lo compara con una herramienta de referencia medida para aplicar la longitud.' },
    'settings-tour': { title: 'La ventana Ajustes', summary: 'Ajustes reúne las preferencias de toda la aplicación en una ventana desplazable con secciones tituladas; se guardan en este ordenador, no en el archivo de proyecto.' },
    'outdated-after-open': { title: 'Todo aparece desactualizado al abrir', summary: 'Las operaciones se abren con un indicador de reloj ámbar cuando no se pudo recuperar su trayectoria; todos los ajustes se conservan y regenerar reconstruye la trayectoria.' },
  },
}
export default words
