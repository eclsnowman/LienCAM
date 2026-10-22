// WO-2329: German Help, machine-translated and checked against
// docs/i18n/GLOSSARY.md. Every category, the title and summary of the topics
// most used first, and the full text of the getting-started topics. A topic or
// line left out here shows its English text (src/help/topics/TRANSLATING.md).
// G-code words, file extensions, shortcut letters and "." decimals stay.
import type { CatalogTree } from '../../catalogs'

const help: CatalogTree = {
  categories: {
    'getting-started': 'Erste Schritte',
    'workspaces-viewport': 'Arbeitsbereiche und Ansicht',
    'import-geometry': 'Import und Geometrie',
    'sketching': 'Skizzieren',
    'modeling': 'Modellieren',
    'setups-stock-wcs': 'Aufspannungen, Rohteil und Koordinaten',
    'cam-operations': 'CAM-Arbeitsschritte',
    'tools-holders': 'Werkzeuge und Werkzeugaufnahmen',
    'nesting': 'Verschachtelung',
    'simulation': 'Simulation',
    'posting-gcode': 'Ausgabe und G-Code',
    'machine': 'Maschine',
    'settings': 'Einstellungen',
    'troubleshooting': 'Fehlersuche',
  },
  topics: {
    'welcome-overview': {
      title: 'Was LienCAM ist',
      summary: 'Ein CAM- und CAD-Programm, das Zeichnungen und Modelle in G-Code umsetzt und in sich geschlossene Projektdateien speichert.',
      keywords: 'willkommen überblick einführung was ist browser cam cad arbeitsbereich start einsteiger über reiter werkzeugbibliothek aufspannung skizze modell werkzeugweg simulation postprozessor steuerung welcome overview introduction',
      sections: {
        0: { text: 'LienCAM setzt 2D-Zeichnungen und 3D-Modelle in G-Code für eine CNC-Fräse um. Es läuft in Ihrem Webbrowser. Projekte sind gewöhnliche .camproject-Dateien, die Sie auf Ihrem eigenen Computer speichern und von dort öffnen.' },
        1: { text: 'Die Reiter oben im Fenster führen Sie der Reihe nach durch den Auftrag: Werkzeugbibliothek, Aufspannung, Skizze, Modell, Werkzeugweg, Simulation, Postprozessor und Steuerung. Aufspannung, Skizze, Werkzeugweg und Simulation sind Ansichten des CAM-Arbeitsbereichs, in dem Sie Teile einlesen, das Rohteil festlegen, Arbeitsschritte anlegen und die Werkzeugwege prüfen. Modell öffnet den Modell-Arbeitsbereich, einen Volumenmodellierer zum Konstruieren von 3D-Teilen. Postprozessor schreibt den G-Code, und Steuerung führt ihn auf Ihrer Maschine aus.' },
        2: { text: 'Der CAM-Bildschirm hat fünf Bereiche: die Kopfleiste oben, den Strukturbaum links, die 3D-Ansicht in der Mitte, den Eigenschaftenbereich rechts sowie Konsole und Statusleiste unten. Eine Führung finden Sie unter "Die fünf Bildschirmbereiche", den kürzesten Weg zum fertigen Teil unter "Ihr erster Werkzeugweg".' },
      },
      images: {
        'app-overview': { alt: 'Das ganze Programmfenster mit geladenem Teil und sichtbarem Werkzeugweg' },
      },
    },
    'first-toolpath': {
      title: 'Ihr erster Werkzeugweg',
      summary: 'Ein Teil importieren, eine Aufspannung anlegen, einen Arbeitsschritt erstellen, den Werkzeugweg prüfen und G-Code ausgeben.',
      keywords: 'erster werkzeugweg anleitung schnellstart teil importieren aufspannung arbeitsschritt erzeugen neu erzeugen ausgeben g-code einsteiger first toolpath tutorial quick start',
      sections: {
        0: {
          steps: {
            0: 'Ein Teil importieren: Klicken Sie im Strukturbaum links auf die Schaltfläche + (Import geometry) in der Kopfzeile des Abschnitts Geometry und wählen Sie eine DXF-, SVG-, STL-, OBJ- oder STEP-Datei.',
            1: 'Eine Aufspannung anlegen: Klicken Sie auf die Schaltfläche + in der Kopfzeile des Abschnitts Setups ("Add setup"). Wählen Sie im Fenster New Setup das Rohteil, legen Sie den Werkstücknullpunkt fest und klicken Sie auf Create Setup. Die Aufspannung bestimmt, wo der Nullpunkt Ihrer Maschine auf dem Rohteil liegt.',
            2: 'Einen Arbeitsschritt erstellen: Klicken Sie auf die Schaltfläche + in der Zeile der Aufspannung ("Add operation (N)") oder drücken Sie N. Wählen Sie Art des Arbeitsschritts, Werkzeug und die zu bearbeitende Geometrie, dann klicken Sie auf Create Operation. Der Werkzeugweg wird berechnet, sobald der Arbeitsschritt angelegt ist.',
            3: 'Das Ergebnis prüfen: Klicken Sie in der Kopfleiste auf den Reiter Werkzeugweg, um die Schnittbewegungen zu sehen. Wenn Sie später etwas ändern, drücken Sie G, um den gewählten Arbeitsschritt neu zu erzeugen, Shift+G für alle, oder klicken Sie auf REGEN ALL in der Kopfzeile des Abschnitts Setups.',
            4: 'Den G-Code ausgeben: Klicken Sie in der Kopfleiste auf den Reiter Postprozessor, prüfen Sie die Ausgabe und speichern Sie die Datei für Ihre Maschine.',
          },
        },
        1: { text: 'Achten Sie auf das linke Ende der Statusleiste unten im Fenster: Dort steht "Wird berechnet...", solange Werkzeugwege berechnet werden, "Berechnung ausstehend", wenn ein Arbeitsschritt neu erzeugt werden muss, eine Anzahl wie "1 Arbeitsschritt fehlgeschlagen", wenn einer nicht erzeugt werden konnte, und "Bereit", wenn nichts zu tun ist.' },
      },
      images: {
        'first-toolpath-strip': { alt: 'Fünf kleine Bildschirmfotos: Import, Aufspannung, Arbeitsschritt, Werkzeugweg-Ansicht und Postprozessor' },
      },
    },
    'work-offsets': {
      title: 'Nullpunktverschiebungen G54-G59',
      summary: 'Jede Aufspannung wird unter einer von sechs Nullpunktverschiebungen, G54 bis G59, ausgegeben, die im Setup-Fenster gewählt wird; Aufspannungen auf demselben Rohteil dürfen sich eine teilen.',
      keywords: 'g54 g55 g56 g57 g58 g59 nullpunktverschiebung nullpunkt ausgabe g-code je rohteil je aufspannung teilen konflikt belegt getrennte dateien work offset',
      sections: {
        0: {
          steps: {
            0: 'Wählen Sie im Setup-Fenster die Verschiebung in der Liste "Setup work offset". Der Strukturbaum zeigt die Verschiebung jeder Aufspannung in ihrer Zeile.',
            1: 'Jede Aufspannung kann jede der sechs Verschiebungen verwenden, auch eine, die Aufspannungen auf einem anderen Rohteil schon verwenden (jedes Beladen des Maschinentischs kann G54 sein). Ist die gewählte Verschiebung auch anderswo in Gebrauch, sagt das Fenster, wo. Das funktioniert, wenn die Aufspannungen als getrennte Dateien ausgegeben werden; ein "Combined"-Programm lehnt es ab.',
          },
        },
        2: { text: 'Der Postprozessor schreibt jede Aufspannung unter ihrer Verschiebung. Mit "Separate files (one per setup)" im Postprozessor erhält jede Datei die Verschiebung im Namen (zum Beispiel part-G54.nc, part-G55.nc). Separate Dateien dürfen eine Verschiebung teilen, weil jede Datei für sich läuft. Ein "Combined"-Programm ist ein einziger Lauf: Eine Verschiebung, die zwei verschiedene Rohteile teilen, stoppt den Export mit einer Meldung, die die beteiligten Aufspannungen nennt und getrennte Dateien vorschlägt.' },
      },
      images: {
        'offset-dropdown': { alt: 'Die Liste Setup work offset mit G54 als von einem anderen Rohteil belegt' },
      },
    },
    'keyboard-shortcuts': { title: 'Tastenkürzel', summary: 'Tastenkürzel richten sich nach dem aktiven Arbeitsbereich und stören nicht, während Sie tippen.' },
    'projects-save-open': { title: 'Projekte speichern und öffnen', summary: 'Projekte werden als in sich geschlossene .camproject-Dateien gespeichert, die Ihre Teile, Werkzeuge, Modelle und Werkzeugwege enthalten.' },
    'units': { title: 'mm und Zoll', summary: 'Anzeigeeinheiten ändern, was Sie sehen und eingeben; Exporteinheiten legen fest, ob der ausgegebene G-Code G21 oder G20 verwendet.' },
    'undo': { title: 'Rückgängig und Verlauf', summary: 'Ctrl+Z macht die letzte Änderung rückgängig, Ctrl+Y wiederholt sie, und das Programm merkt sich die letzten 50 Änderungen.' },
    'ui-tour': { title: 'Die fünf Bildschirmbereiche', summary: 'Kopfleiste, Strukturbaum, 3D-Ansicht, Eigenschaftenbereich sowie Konsole mit Statusleiste haben jeweils eine Aufgabe.' },
    'error-details': { title: 'Wo Fehlerdetails stehen', summary: 'Die Konsole unten ist die Liste der Ereignisse, Warnungen und Fehler der aktuellen Sitzung.' },
    'viewport-navigation': { title: 'Drehen, verschieben, zoomen, Ansichtswürfel', summary: 'Die Maus dreht, verschiebt und zoomt die 3D-Ansicht nach einer Belegung, die Sie in den Einstellungen wählen; Ansichtswürfel oder Rechtsklickmenü springen zu Standardansichten.' },
    'design-tree': { title: 'Der Strukturbaum', summary: 'Der linke Bereich listet alles im Projekt unter drei Abschnitten - Rohteil, Geometrie und Aufspannungen - mit Ordnern, Umbenennen, Sichtbarkeit und Statusmarken.' },
    'setup-wcs': { title: 'Aufspannung und WKS', summary: 'Eine Aufspannung benennt das bearbeitete Rohteil, seine Nullpunktverschiebung und seinen Werkstücknullpunkt, die Spannmittel darunter und die Standardhöhen, mit denen ihre Arbeitsschritte beginnen.' },
    'wcs-origin-placement': { title: 'Den Werkstücknullpunkt festlegen', summary: 'Das Setup-Fenster bietet fünf Wege, den Werkstücknullpunkt festzulegen: eine Rohteilecke, einen gefangenen Modell-Eckpunkt, eingegebene Koordinaten, einen ziehbaren Griff in der Ansicht oder den Mittelpunkt eines runden Elements.' },
    'workholding': { title: 'Spannmittel: Schraubstöcke und Spanneisen', summary: 'Importieren Sie Schraubstock, Backen oder Spanneisen als Teil und schalten Sie Workholding ein: Der Körper wird als Spannmittel gezeichnet, ist nie Rohteil oder Schnitt, Werkzeugwege halten Abstand, und Seat in vise legt Teile daran an.' },
    'height-references': { title: 'Höhen erklärt', summary: 'Jeder Arbeitsschritt verwendet fünf Höhenebenen - Sicherheitshöhe, Rückzugshöhe, Vorschubhöhe, obere und untere Höhe - jeweils von einer gewählten Bezugsebene aus gemessen; der Reiter Heights zeigt, auf welchem WKS-Z jede liegt.' },
    'creating-operations': { title: 'Einen Arbeitsschritt anlegen', summary: 'Das Fenster New Operation führt Sie auf einem Satz Reiter durch Art, Werkzeug, Geometrie, Durchgänge, Höhen, Verbindungen und Vorschub.' },
    'contour': { title: '2D-Kontur', summary: '2D-Kontur fräst entlang eines Profils in einer oder mehreren Tiefen, mit vier Strategien, offenen Pfaden, Haltestegen und pendelndem Eintauchen.' },
    'pocket': { title: '2D-Tasche', summary: '2D-Tasche räumt einen geschlossenen Bereich in Ringen aus, lässt Inseln stehen, taucht helikal, pendelnd oder senkrecht ein und schlichtet die Wand.' },
    'drill': { title: 'Bohren', summary: 'Bohren bohrt in der Mitte jeder gewählten oder erkannten Bohrung, mit vier Bohrzyklen und einer Tiefe für jede Bohrung.' },
    'face-op': { title: '2D-Planfräsen', summary: '2D-Planfräsen fräst die Oberseite des Rohteils mit Bahnen, die über die Kanten hinauslaufen, sodass der Fräser sie vollständig freifährt.' },
    'adaptive-clearing': { title: 'Adaptives Ausräumen', summary: '2D Adaptives Ausräumen schruppt einen Bereich und hält dabei die seitliche Belastung des Werkzeugs nahe dem eingestellten Wert.' },
    'feeds-speeds': { title: 'Rangfolge von Vorschub und Drehzahl', summary: 'Arbeitsschritte übernehmen Vorschub und Drehzahl aus der Werkzeugbibliothek, sofern Sie sie nicht für einen Arbeitsschritt überschreiben, innerhalb der Grenzen der Maschine.' },
    'tool-library': { title: 'Die Werkzeugbibliothek', summary: 'Das Fenster Werkzeugbibliothek enthält jeden Fräser in benannten Bibliotheken, mit Suche, Filtern und einem Editor mit Reitern und einer Live-Werkzeugskizze.' },
    'tool-holders': { title: 'Werkzeugaufnahmen', summary: 'Werkzeugaufnahmen sind ein Stapel aus Kegel- oder Zylinderabschnitten in einer eigenen Liste; einem Werkzeug zugeordnet, zeichnet die Ansicht das ganze Werkzeug mit Aufnahme über der Auskraglänge.' },
    'stock-simulation': { title: 'Rohteilsimulation', summary: 'Der Reiter Simulation spielt erzeugte Werkzeugwege ab und trägt sie, mit Materialabtrag simulieren eingeschaltet, aus dem Rohteil der Aufspannung ab.' },
    'post-basics': { title: 'G-Code ausgeben', summary: 'Das Fenster Postprozessor macht aus berechneten Werkzeugwegen G-Code-Dateien für Ihre Steuerung, mit einer Live-Vorschau genau dessen, was geschrieben wird.' },
    'control-tab-overview': { title: 'Der Reiter Steuerung', summary: 'Steuerung macht das Programm zum Maschinen-Sender: Die Werkzeugweg-Vorschau bleibt das größte Element, umgeben von Bereichen für Verbindung, Tippbetrieb, Programm und Sicherheit.' },
    'control-jog-zero': { title: 'Tippen und Nullpunkt setzen', summary: 'Der Bereich Tippen bewegt die Maschine schrittweise oder kontinuierlich, und der Bereich Nullpunkte setzt X0/Y0/Z0 - per Schaltfläche oder für Z über das Antasten.' },
    'control-run-job': { title: 'Einen Auftrag ausführen', summary: 'Eine Aufspannung direkt in den Sender ausgeben oder eine Datei laden, auf Wunsch zuerst den Umriss abfahren, dann mit Vorschub-Stopp, Fortsetzen und Live-Overrides ausführen.' },
    'probing-tab': { title: 'Der Reiter Antasten', summary: 'Antasten findet Kanten, Ecken, Bohrungen, Zapfen, Flächen und Werkzeuglängen mit einem Tastsystem und zeigt den Plan auf einer Skizze. Z0 wird sofort geschrieben; Werkzeug Z speichert seine Messung sofort. Andere Ergebnisse prüfen Sie, bevor Sie sie übernehmen.' },
    'control-tool-setter': { title: 'Das feste Werkzeug-Tastsystem', summary: 'Ein festes Werkzeug-Tastsystem misst ein Werkzeug an einer bekannten Maschinenposition; die Werkzeugtabelle speichert den Kontakt und vergleicht ihn mit einem gemessenen Referenzwerkzeug, um die Länge zu übernehmen.' },
    'settings-tour': { title: 'Das Fenster Einstellungen', summary: 'Einstellungen enthält programmweite Vorgaben in einem scrollenden Fenster mit benannten Abschnitten - gespeichert auf diesem Computer, nicht in Ihrer Projektdatei.' },
    'outdated-after-open': { title: 'Nach dem Öffnen ist alles veraltet', summary: 'Arbeitsschritte öffnen mit einer bernsteinfarbenen Uhr, wenn ihr Werkzeugweg nicht mit zurückkommen konnte - jede Einstellung bleibt erhalten, und Neu erzeugen baut den Werkzeugweg wieder auf.' },
  },
}

export default help
