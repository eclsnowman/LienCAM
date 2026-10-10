// WO-2319: words for choosing the interface language (Settings > Language).
//
// The pattern every area file follows: default-export the area's words, and
// register their shape with i18next below so a wrong or missing key is a
// type-check error. The registered name must equal this file's name.
const language = {
  section: 'Language',
  label: 'Interface language',
} as const

export default language

declare module 'i18next' {
  interface ResourceNamespaceMap {
    language: typeof language
  }
}
