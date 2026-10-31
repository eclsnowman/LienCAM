// WO-3267: desktop update offer text.

const words = {
  offerAvailable: 'LienCAM {{version}} is available (you have {{currentVersion}}).',
  offerAvailableSized: 'LienCAM {{version}} is available (you have {{currentVersion}}), {{size}}.',
  notNow: 'Not now',
  download: 'Download',
  downloadingPercent: 'Downloading LienCAM {{version}}: {{percent}}%',
  downloading: 'Downloading LienCAM {{version}}...',
  downloaded: 'LienCAM {{version}} is downloaded and checked.',
  installExplanation: 'Installing closes LienCAM and the machine bridge, then starts the new version. Your settings, machine, tools and projects are kept.',
  showFileExplanation: 'This copy cannot replace itself; LienCAM shows you the checked file to start instead.',
  later: 'Later',
  installAndRestart: 'Install and restart',
  showFile: 'Show the file',
  close: 'Close',
  downloadAgain: 'Download again',
  downloadFailed: 'LienCAM could not download {{version}} ({{error}}); nothing was installed.',
  downloadedMatched: 'LienCAM {{version}} downloaded and matched its published SHA-256 checksum.',
  installChecking: 'Checking LienCAM {{version}} again before installing...',
  installFailed: 'LienCAM could not install {{version}} ({{error}}); this copy is unchanged.',
}

export default words

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'desktop-update.wo3267': typeof words
  }
}
