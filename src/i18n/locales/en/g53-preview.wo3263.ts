// WO-3263: the Control preview of a program whose G53 feed moves it cannot place yet.

const words = {
  machineMovesUnplaced: 'This program moves in machine coordinates (G53); the preview draws it once the controller reports the work offset.',
}

export default words

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'g53-preview.wo3263': typeof words
  }
}
