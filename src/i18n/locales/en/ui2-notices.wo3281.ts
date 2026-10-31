// WO-3281: words of the New UI's notice part and the reasons the units service gives a field
// that cannot read what was typed. Every operator message of the New UI is a key like these.
const ui2Notices = {
  levels: {
    info: 'Information',
    warning: 'Warning',
    cannotDoThis: 'Not available now',
    error: 'Error',
  },
  units: {
    wrongUnit: 'This field does not take that unit.',
    wrongMark: 'Use the decimal mark set in Settings.',
  },
} as const

export default ui2Notices

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'ui2-notices.wo3281': typeof ui2Notices
  }
}
