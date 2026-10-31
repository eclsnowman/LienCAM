// WO-3288: English words of the Settings > Appearance row for the New UI switch.


const ui2SettingsRow = {
  newUi: 'New interface (beta preview)',
  newUiHint: 'Switches to the redesigned interface. Your projects and settings are not changed. Turn it off to return to the current interface.',
} as const

export default ui2SettingsRow

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'ui2-settings-row.wo3288': typeof ui2SettingsRow
  }
}
