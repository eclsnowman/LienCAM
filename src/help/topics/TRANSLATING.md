# Help translations (WO-2327)

The 15 English topic modules remain the readable source catalog. Their text
is registered by `localizeHelpTopics`; eager titles, summaries and keywords
are registered by `localizeHelpIndex`. Bodies remain lazy category chunks.
`loadEnglishHelpCatalog()` exports the complete English `help` namespace for
translation tooling, including category labels and picture/video captions.

Put a translation in `src/i18n/locales/<language>/help.ts`, default-exporting
a tree of strings. The existing language loader discovers and loads that
namespace along with the other interface catalogs. Example keys:

```
categories.getting-started
topics.welcome-overview.title
topics.welcome-overview.summary
topics.welcome-overview.keywords
topics.welcome-overview.sections.0.text
topics.first-toolpath.sections.0.steps.0
topics.welcome-overview.images.app-overview.alt
```

Table keys are `sections.<index>.columns.<index>` and
`sections.<index>.rows.<index>.cells.<index>`. Section, step, column and row
indices follow the English module; update translations if that order changes.
The topic id and image slot stay stable. Omitted or empty translations fall
back to the exact English string. Regional variants use the UI language's
fallback chain. Strings are read literally, without interpolation or escaping.

Translate prose, titles, headings, keywords and captions. Keep embedded
G-code, posted files, controller messages, dialect names, file extensions,
keyboard shortcut letters and decimal points unchanged. Structural ids,
context keys, anchors, categories, image slots and asset paths are never
translated. The offline wiki exporter continues to use English without
initializing the app or i18next.
