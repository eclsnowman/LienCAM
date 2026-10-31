// WO-3198: words for the Tools tab's Resume - a Measure held by Feed Hold
// carries on from here, the same resume Main's CYCLE START sends.
const measureToolResume = {
  resume: 'Resume',
  resumeTip: 'Resume the held measurement - the same as CYCLE START on Main.',
} as const

export default measureToolResume

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'measure-tool-resume.wo3198': typeof measureToolResume
  }
}
