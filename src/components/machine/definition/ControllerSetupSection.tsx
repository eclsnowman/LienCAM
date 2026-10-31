import { catalogChildren } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useEffect, useState, type ReactNode } from 'react'
import { bridgeProcessStatus, hasNativeMachinePathPicker } from '../../../lib/machine/bridgeHost'
import { activeVfdPortLink, rememberVfdPort } from '../../../lib/machine/bridgeTransport'
import { setMachineSerialBaud } from '../../../store'
import { MACHINE_SERIAL_BAUD_CHOICES } from '../../../store'
import { SkewField } from './SkewField'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'
import type { LinuxcncHello } from '../../../lib/machine/linuxcnc/linuxcncController'
import { LinuxcncConfigFacts } from './LinuxcncConfigFacts'
import { BuiltinCommandsSection } from './BuiltinCommandsSection'


export function SetupReadout({ label, value, testId, absent = controlText('ControllerSetupSection.unset') }: {
  label: string
  value: unknown
  testId: string
  /** What to say when the bridge reported nothing. "unset" reads as BROKEN,
   *  and for the three DLL/folder rows it is actively misleading: Operator saw
   *  "unset" against his install folder and both DLLs while the bridge was
   *  running perfectly, because a bridge started without a config file resolves
   *  those from its own directory and reports null for them. Nothing is wrong
   *  and nothing needs setting, so the row should not imply either. */
  absent?: string
}) {
  const shown = typeof value === 'string' || typeof value === 'number' ? String(value) : absent
  return (
    // Operator ruling 2026-08-29: "Bad spacing and a huge waste of space." A readout is a
    // LABEL AND A VALUE, so it is as wide as they are - it does not claim a
    // share of the row. minWidth 180 forced "unset" and "-19" to sit in a box
    // wider than this sentence; maxWidth stops the one long value (the profile
    // path) from taking the row on its own.
    <div data-testid={testId} style={{ minWidth: 0, maxWidth: 320 }}>
      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{label}</div>
      <div className="mform-input-mono" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
        {shown}
      </div>
    </div>
  )
}

export function SetupField({ label, testId, running, value, children, currentLabel = controlText('ControllerSetupSection.text001'), alwaysShowCurrent = false, note }: {
  label: string
  testId: string
  running: unknown
  /** What this field currently holds. The "Running now" line is shown ONLY
   *  when the bridge is using something else - that difference is the whole
   *  reason to say it, and it is what a Restart bridge resolves. When they
   *  agree the line is the same number twice, which is the clutter Operator
   *  ordered out on 2026-09-03 ("we don't need to tell them how the sausage
   *  is made"); the console already says a change waits for a restart. */
  value?: unknown
  children: ReactNode
  /** Profile files seed a stored definition; unlike the bridge's live
   *  resources, they must never be described as what is running now. */
  currentLabel?: string
  alwaysShowCurrent?: boolean
  note?: ReactNode
}) {
  const text = (input: unknown) => typeof input === 'string' || typeof input === 'number'
    ? String(input).trim()
    : ''
  const current = text(running)
  const showsCurrent = current !== '' && (alwaysShowCurrent || current !== text(value))
  return (
    <label className="machine-connection-field" data-testid={testId}>
      <span className="machine-connection-field-label">{label}</span>
      <span className="machine-connection-field-control">{children}</span>
      {showsCurrent && (
        <span className="machine-connection-field-current">{currentLabel}: {current}</span>
      )}
      {note && <span className="machine-connection-field-current">{note}</span>}
    </label>
  )
}

type ControllerSetupSectionProps = Pick<MachineDefinitionPanelState, 'bridgeAction' | 'bridgeCapability' | 'bridgeHello' | 'bridgePort' | 'bridgeProcessState' | 'bridgeTextBlurred' | 'bridgeTextFocused' | 'connectionBusy' | 'connectionKind' | 'connectionPhase' | 'controllerSetupHighlighted' | 'controllerSetupRef' | 'def' | 'detectedInstallRoot' | 'draft' | 'editDraft' | 'handleBridgeAction' | 'legacyBridgeStatusHost' | 'linuxcncHello' | 'linuxcncJoints' | 'linuxcncOwnsSpindle' | 'localLink' | 'noteBridgeSettingChanged' | 'rememberBridgeSetting' | 'rememberPickedPath' | 'serialBaud' | 'setMachineBridgePort' | 'setSkewTyped' | 'setupKind' | 'skewTyped' | 'source' | 'spindleLink' | 'uccnc'>

/** WO-1988 REVIEW FIX: a plain-English summary of LinuxCNC's own spindle
 *  link, never invented. `vfd` is the BRIDGE protocol's own-Modbus-VFD field
 *  (BRIDGE-PROTOCOL.md); the LinuxCNC gateway hard-codes it to
 *  `{present: false}` in every hello and never pushes an update
 *  (LINUXCNC-GATEWAY-PROTOCOL.md, Pushes: "No `vfd` push: LinuxCNC owns the
 *  spindle") - it is NOT a statement that LinuxCNC has no spindle configured.
 *  `capabilities.ownsSpindle` is the fact the gateway actually reports: on
 *  every real gateway this is `true` and spindle commands go through
 *  LinuxCNC itself, not a bridge-managed VFD link. Only a `vfd.present` block
 *  (a future gateway, or another controller reusing this reader) overrides
 *  that with a named link. */
function describeLinuxcncSpindle(vfd: LinuxcncHello['vfd'], ownsSpindle: boolean): string | undefined {
  if (vfd?.present) return vfd.name ? controlText('ControllerSetupSection.text002', { value1: String(vfd.name) }) : controlText('ControllerSetupSection.text003')
  if (ownsSpindle) return controlText('ControllerSetupSection.text004')
  return undefined
}

export function ControllerSetupSection({ bridgeAction, bridgeCapability, bridgeHello, bridgePort, bridgeProcessState, bridgeTextBlurred, bridgeTextFocused, connectionBusy, connectionKind, connectionPhase, controllerSetupHighlighted, controllerSetupRef, def, detectedInstallRoot, draft, editDraft, handleBridgeAction, legacyBridgeStatusHost, linuxcncHello, linuxcncJoints, linuxcncOwnsSpindle, localLink, noteBridgeSettingChanged, rememberBridgeSetting, rememberPickedPath, serialBaud, setMachineBridgePort, setSkewTyped, setupKind, skewTyped, source, spindleLink, uccnc }: ControllerSetupSectionProps) {
  useText('control-screens-not-probing')
  const linux = typeof navigator !== 'undefined' && /linux/i.test(navigator.platform)
  const [desktopPorts, setDesktopPorts] = useState<string[]>([])
  const refreshPorts = async () => {
    if (linux) {
      const status = await bridgeProcessStatus().catch(() => null) as { serialPorts?: string[] } | null
      setDesktopPorts(status?.serialPorts ?? [])
    }
    void activeVfdPortLink()?.listPorts()
  }
  useEffect(() => {
    if (linux) void bridgeProcessStatus().catch(() => null).then(status => {
      setDesktopPorts((status as { serialPorts?: string[] } | null)?.serialPorts ?? [])
    })
  }, [linux])
  return (
    <><div
          ref={controllerSetupRef}
          data-testid="machine-controller-setup"
          data-connection-kind={setupKind}
          data-highlighted={controllerSetupHighlighted ? '' : undefined}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 4,
            // WO-1114: the serial (GRBL) block is sized to its three rows -
            // padding 2px, one 2px gap under the title, and the flex column's
            // own 6px gap below, so the block stays within 16px of its rows'
            // summed height (measured by shoot.mjs). The bridge (UCCNC) block
            // keeps the original 12/10/12 breathing room: the order forbids
            // changing it, and its fields are readouts, not a compact row.
            padding: setupKind === 'serial' ? 2 : 12,
            marginBottom: setupKind === 'serial' ? 0 : 12,
            background: controllerSetupHighlighted ? 'var(--bg-hover)' : 'var(--bg-panel-alt)',
            boxShadow: controllerSetupHighlighted ? '0 0 0 2px var(--accent-blue)' : 'none',
            transition: 'background 160ms ease, box-shadow 160ms ease',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
            marginBottom: setupKind === 'serial' ? 2 : 10,
          }}>
            <strong data-testid="machine-controller-setup-title">{controlText('ControllerSetupSection.text005')}</strong>
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('ControllerSetupSection.text006')}</span>
          </div>

          {setupKind === 'bridge' && (
            <div data-testid="machine-controller-setup-bridge">
              {/* NOT a stretching grid. `repeat(auto-fit, minmax(180px, 1fr))`
                  split the full panel width between six readouts, so at 1568px
                  each tiny value ("unset", "-19", "8325") sat alone in a 250px
                  cell and the row read as mostly empty. These are six facts,
                  not six columns: lay them left to right, each as wide as it
                  needs, and wrap when they run out of room. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px', alignItems: 'start' }}>
                <label style={{ minWidth: 96 }}>
                  <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('ControllerSetupSection.text007')}</span>
                  <input
                    className="mform-input mform-input-mono"
                    data-testid="machine-controller-bridge-port"
                    data-wired=""
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    value={bridgePort}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber
                      if (Number.isInteger(value) && value >= 1 && value <= 65535) {
                        setMachineBridgePort(source.id, value)
                      }
                    }}
                  />
                </label>
                {legacyBridgeStatusHost ? (
                  <SetupReadout
                    label={controlText('ControllerSetupSection.text008')}
                    value="Started outside the app - the desktop app can restart it."
                    testId="machine-controller-bridge-unhosted"
                  />
                ) : bridgeProcessState.kind === 'unavailable' ? (
                  <SetupReadout
                    label={controlText('ControllerSetupSection.text009')}
                    value={bridgeCapability === 'hosted'
                      ? 'The desktop app could not read the bridge process status.'
                      : 'Install the bridge supervisor once from the LienCAM bridge setup folder.'}
                    testId="machine-controller-bridge-unhosted"
                  />
                ) : bridgeProcessState.kind === 'checking' ? (
                  <SetupReadout
                    label={controlText('ControllerSetupSection.text010')}
                    value="Checking the bridge on this computer..."
                    testId="machine-controller-bridge-state"
                  />
                ) : bridgeProcessState.kind === 'building' ? (
                  <SetupReadout
                    label={controlText('ControllerSetupSection.text011')}
                    value="Building the machine connection for your UCCNC install..."
                    testId="machine-controller-bridge-state"
                  />
                ) : bridgeProcessState.kind === 'missing-install' ? (
                  <div style={{ width: 360, minWidth: 360 }}>
                    <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('ControllerSetupSection.text012')}</span>
                    <div data-testid="machine-controller-bridge-state" style={{ marginBottom: 4 }}>{controlText('ControllerSetupSection.text013')}</div>
                    <button
                      type="button"
                      className="control-chip-btn"
                      data-testid="machine-controller-restart-bridge"
                      disabled={bridgeAction !== null}
                      onClick={() => { void handleBridgeAction('restart') }}
                    >
                      {bridgeAction === 'restart' ? 'Building...' : controlText('ControllerSetupSection.text014')}
                    </button>
                  </div>
                ) : bridgeProcessState.kind === 'build-failed' ? (
                  <div style={{ width: 520, minWidth: 420 }}>
                    <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('ControllerSetupSection.text015')}</span>
                    <div data-testid="machine-controller-bridge-state" style={{ marginBottom: 4 }}>{catalogChildren(controlText('ControllerSetupSection.text016', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: bridgeProcessState.reason, value2: bridgeProcessState.status.setup?.logPath })}</div>
                    <button
                      type="button"
                      className="control-chip-btn"
                      data-testid="machine-controller-restart-bridge"
                      disabled={bridgeAction !== null}
                      onClick={() => { void handleBridgeAction('restart') }}
                    >
                      {bridgeAction === 'restart' ? 'Building...' : controlText('ControllerSetupSection.text017')}
                    </button>
                  </div>
                ) : (
                  <div style={{
                    width: bridgeProcessState.kind === 'failing' ? 420 : 250,
                    minWidth: bridgeProcessState.kind === 'failing' ? 420 : 250,
                  }}>
                    <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('ControllerSetupSection.text018')}</span>
                    <div
                      data-testid="machine-controller-bridge-state"
                      style={{ color: 'var(--text-primary)', marginBottom: 4 }}
                    >
                      {bridgeProcessState.kind === 'not-running'
                        ? controlText('ControllerSetupSection.text019')
                        : bridgeProcessState.kind === 'not-configured'
                          ? controlText('ControllerSetupSection.text020')
                        : bridgeProcessState.kind === 'failing'
                          ? controlText('ControllerSetupSection.text021', { value1: String(bridgeProcessState.reason) })
                          : controlText('ControllerSetupSection.text022')}
                    </div>
                    {bridgeProcessState.kind === 'not-configured' ? (
                      bridgeCapability === 'hosted' ? (
                        <button
                          type="button"
                          className="control-chip-btn"
                          data-testid="machine-controller-restart-bridge"
                          disabled
                          title={controlText('ControllerSetupSection.text023')}
                        >{controlText('ControllerSetupSection.text024')}</button>
                      ) : null
                    ) : bridgeProcessState.kind === 'not-running' ? (
                      <button
                        type="button"
                        className="control-chip-btn"
                        data-testid="machine-controller-start-bridge"
                        disabled={bridgeAction !== null}
                        onClick={() => { void handleBridgeAction('start') }}
                      >
                        {bridgeAction === 'start' ? 'Starting...' : controlText('ControllerSetupSection.text025')}
                      </button>
                    ) : bridgeProcessState.kind === 'failing' || bridgeCapability === 'hosted' ? (
                      <button
                        type="button"
                        className="control-chip-btn"
                        data-testid="machine-controller-restart-bridge"
                        disabled={bridgeAction !== null}
                        onClick={() => { void handleBridgeAction('restart') }}
                      >
                        {bridgeAction === 'restart' ? 'Restarting...' : controlText('ControllerSetupSection.text026')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="control-chip-btn"
                        data-testid="machine-controller-stop-bridge"
                        disabled={bridgeAction !== null || connectionPhase !== 'disconnected'}
                        title={connectionPhase !== 'disconnected'
                          ? controlText('ControllerSetupSection.text027')
                          : controlText('ControllerSetupSection.text028')}
                        onClick={() => { void handleBridgeAction('stop') }}
                      >
                        {bridgeAction === 'stop' ? controlText('ControllerSetupSection.text029') : controlText('ControllerSetupSection.text030')}
                      </button>
                    )}
                  </div>
                )}
                {connectionKind === undefined ? (
                  <SetupReadout
                    label={controlText('ControllerSetupSection.text031')}
                    value={uccnc?.installRoot}
                    absent={uccnc ? controlText('ControllerSetupSection.notConfigured') : controlText('ControllerSetupSection.unset')}
                    testId="machine-controller-uccnc-install"
                  />
                ) : <SetupField
                  label={controlText('ControllerSetupSection.text032')}
                  running={uccnc?.installRoot}
                  value={localLink?.installRoot ?? detectedInstallRoot}
                  testId="machine-controller-uccnc-install"
                >
                  <input
                    className="mform-input mform-input-mono"
                    data-testid="machine-controller-uccnc-install-input"
                    data-wired=""
                    type="text"
                    value={localLink?.installRoot ?? detectedInstallRoot ?? ''}
                    placeholder={controlText('ControllerSetupSection.text033')}
                    onFocus={(event) => bridgeTextFocused('installRoot', event.currentTarget.value)}
                    onChange={(event) => rememberBridgeSetting('installRoot', event.currentTarget.value || undefined)}
                    onBlur={(event) => bridgeTextBlurred('installRoot', event.currentTarget.value)}
                  />
                  {hasNativeMachinePathPicker() && (
                    <button
                      type="button"
                      className="control-chip-btn"
                      data-testid="machine-controller-uccnc-install-browse"
                      onClick={() => { void rememberPickedPath('installRoot', 'install-root') }}
                    >{controlText('ControllerSetupSection.text034')}</button>
                  )}
                </SetupField>}
                {connectionKind === undefined ? (
                  <SetupReadout
                    label={controlText('ControllerSetupSection.text035')}
                    value={uccnc?.profile}
                    testId="machine-controller-uccnc-profile"
                  />
                ) : <SetupField
                  label={controlText('ControllerSetupSection.text036')}
                  running={uccnc?.profile}
                  value={localLink?.profile}
                  testId="machine-controller-uccnc-profile"
                  currentLabel="Seeded from"
                  alwaysShowCurrent
                  note="The bridge's .pro file seeds this machine once. This stored copy is the authority after that."
                >
                  {(uccnc?.profiles.length ?? 0) > 0 ? (
                    <select
                      className="mform-input mform-input-mono"
                      data-testid="machine-controller-uccnc-profile-input"
                      data-wired=""
                      value={localLink?.profile ?? ''}
                      onChange={(event) => {
                        rememberBridgeSetting('profile', event.currentTarget.value || undefined)
                        noteBridgeSettingChanged()
                      }}
                    >
                      <option value="">{controlText('ControllerSetupSection.text037')}</option>
                      {Array.from(new Set([
                        ...(uccnc?.profiles ?? []),
                        localLink?.profile,
                      ].filter((profile): profile is string => Boolean(profile)))).map((profile) => (
                        <option key={profile} value={profile}>{profile}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="mform-input mform-input-mono"
                      data-testid="machine-controller-uccnc-profile-input"
                      data-wired=""
                      type="text"
                      value={localLink?.profile ?? ''}
                      placeholder={controlText('ControllerSetupSection.text038')}
                      onFocus={(event) => bridgeTextFocused('profile', event.currentTarget.value)}
                      onChange={(event) => rememberBridgeSetting('profile', event.currentTarget.value || undefined)}
                      onBlur={(event) => bridgeTextBlurred('profile', event.currentTarget.value)}
                    />
                  )}
                </SetupField>}
                {connectionKind === undefined ? (
                  <SetupReadout
                    label={controlText('ControllerSetupSection.text039')}
                    value={uccnc?.board}
                    testId="machine-controller-uccnc-board"
                  />
                ) : <SetupField
                  label={controlText('ControllerSetupSection.text040')}
                  running={uccnc?.board}
                  value={localLink?.board}
                  testId="machine-controller-uccnc-board"
                >
                  <input
                    key={`${source.id}:${String(localLink?.board ?? 'auto')}`}
                    className="mform-input mform-input-mono machine-connection-board"
                    data-testid="machine-controller-uccnc-board-input"
                    data-wired=""
                    type="text"
                    defaultValue={String(localLink?.board ?? 'auto')}
                    onFocus={(event) => bridgeTextFocused('board', event.currentTarget.value)}
                    onInput={(event) => event.currentTarget.setCustomValidity('')}
                    onBlur={(event) => {
                      const raw = event.currentTarget.value.trim()
                      const parsed = Number(raw)
                      if (raw.toLowerCase() !== 'auto' && (!Number.isInteger(parsed) || raw === '')) {
                        event.currentTarget.setCustomValidity(controlText('ControllerSetupSection.text041'))
                        event.currentTarget.reportValidity()
                        return
                      }
                      const value = raw.toLowerCase() === 'auto' ? 'auto' : parsed
                      rememberBridgeSetting('board', value)
                      bridgeTextBlurred('board', raw)
                    }}
                  />
                </SetupField>}
                <SetupReadout label={controlText('ControllerSetupSection.text042')} value={uccnc?.uc100Dll} absent={uccnc ? controlText('ControllerSetupSection.besideBridge') : controlText('ControllerSetupSection.unset')} testId="machine-controller-uccnc-uc100-dll" />
                <SetupReadout label={controlText('ControllerSetupSection.text043')} value={uccnc?.ftd2xxDll} absent={uccnc ? controlText('ControllerSetupSection.besideBridge') : controlText('ControllerSetupSection.unset')} testId="machine-controller-uccnc-ftd2xx-dll" />
                {connectionKind !== undefined && <SetupField
                  label={controlText('ControllerSetupSection.text044')}
                  running={bridgeHello?.vfd?.name}
                  value={localLink?.vfdDefinition}
                  testId="machine-controller-vfd-definition"
                >
                  <input
                    className="mform-input mform-input-mono"
                    data-testid="machine-controller-vfd-definition-input"
                    data-wired=""
                    type="text"
                    value={localLink?.vfdDefinition ?? ''}
                    placeholder={controlText('ControllerSetupSection.text045')}
                    onFocus={(event) => bridgeTextFocused('vfdDefinition', event.currentTarget.value)}
                    onChange={(event) => rememberBridgeSetting('vfdDefinition', event.currentTarget.value || undefined)}
                    onBlur={(event) => bridgeTextBlurred('vfdDefinition', event.currentTarget.value)}
                  />
                  {hasNativeMachinePathPicker() && (
                    <button
                      type="button"
                      className="control-chip-btn"
                      data-testid="machine-controller-vfd-definition-browse"
                      onClick={() => { void rememberPickedPath('vfdDefinition', 'vfd-definition') }}
                    >{controlText('ControllerSetupSection.text046')}</button>
                  )}
                </SetupField>}
              </div>

              {/* The COM-port select is ~60px wide; a 220px label box left its
                  error message stranded in open space halfway across the row
                  ("What the hell happened middle of the page"). The label is
                  now as wide as the control, so the message sits beside it. */}
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('ControllerSetupSection.text047')}</span>
                  <select
                    className="mform-input mform-input-mono"
                    data-testid="machine-controller-vfd-port"
                    data-wired=""
                    value={spindleLink.reportedPort ?? (linux ? localLink?.vfdPort : undefined) ?? ''}
                    disabled={(!linux && (!spindleLink.connected || !spindleLink.linkPresent)) || spindleLink.busy || spindleLink.spindleRunning || spindleLink.jobActive}
                    onFocus={() => { void refreshPorts() }}
                    onChange={(event) => {
                      const port = event.currentTarget.value
                      if (linux && (!spindleLink.connected || !spindleLink.linkPresent)) rememberVfdPort(source.id, port)
                      else void activeVfdPortLink()?.selectPort(port)
                    }}
                  >
                    <option value="">{controlText('ControllerSetupSection.text048')}</option>
                    {Array.from(new Set([
                      ...desktopPorts,
                      ...(spindleLink.ports ?? []),
                      spindleLink.reportedPort,
                      localLink?.vfdPort,
                    ].filter((port): port is string => typeof port === 'string' && port.length > 0))).map((port) => (
                      <option key={port} value={port}>{port}</option>
                    ))}
                  </select>
                </label>
                {spindleLink.error && (
                  /* THE OPERATOR WAS BEING SHOWN A METHOD NAME. Operator, 2026-08-29,
                     read "the bridge does not know the method 'listSerialPorts'"
                     sitting on this page. That sentence is correct and the
                     transport is right to pass the bridge's own words through
                     unchanged (comPortPicker.wo1000, "an old bridge degrades
                     cleanly") - but it is written for us, not for him, and it
                     names an internal call as though he could act on it.
                     The COM picker's bridge half does not exist yet: neither
                     listSerialPorts nor setVfdPort is implemented in Bridge.cs
                     (MACHINE-SETTINGS-DESIGN.md S5, still outstanding). So say
                     what is true and what to do instead. The raw sentence stays
                     in `title` so it is still one hover away for us. */
                  <span
                    role="status"
                    title={spindleLink.error}
                    style={{ color: 'var(--warning)' }}
                  >
                    {/does not know the method/.test(spindleLink.error)
                      ? controlText('ControllerSetupSection.text049')
                      : spindleLink.error}
                  </span>
                )}
              </div>
            </div>
          )}

          {setupKind === 'serial' && (
            <div
              data-testid="machine-controller-setup-serial"
              style={{ display: 'flex', alignItems: 'center', gap: '10px 18px', flexWrap: 'wrap' }}
            >
              {/* ONE COMPACT HINT, NOT A READOUT ROW (WO-1114). The port is
                  chosen in the browser at Connect time, so there is no value
                  to show - the sentence is a hint and renders inline at
                  hint size, with itself as the hover explanation, instead of
                  taking a labelled value row of its own. */}
              <span
                data-testid="machine-controller-serial-port"
                data-tooltip={controlText('ControllerSetupSection.text050')}
                style={{
                  display: 'inline-flex', alignItems: 'center', fontSize: 'var(--font-size-sm)',
                  color: 'var(--text-muted)',
                }}
              >{controlText('ControllerSetupSection.text051')}</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('ControllerSetupSection.text052')}</span>
                <select
                  className="mform-input mform-input-mono"
                  data-testid="machine-controller-serial-baud"
                  data-wired=""
                  value={serialBaud}
                  disabled={connectionPhase === 'connected' || connectionBusy}
                  onChange={(event) => setMachineSerialBaud(source.id, Number(event.currentTarget.value))}
                >
                  {MACHINE_SERIAL_BAUD_CHOICES.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              {/* WO-1114: on a machine with no controller definition the skew
                  field joins the row instead of standing alone below an
                  empty band. A defined machine keeps it in Travel & Homing,
                  on the slaved axis's row, where WO-1050 put it. */}
              {!def && (
                <SkewField
                  machine={draft}
                  typed={skewTyped}
                  onTyped={setSkewTyped}
                  onChange={editDraft}
                  standalone
                />
              )}
            </div>
          )}

          {setupKind === 'simulator' && (
            <div data-testid="machine-controller-setup-simulator" style={{ color: 'var(--text-secondary)' }}>{controlText('ControllerSetupSection.text053')}</div>
          )}

          {/* WO-1988: this machine's own facts, read live from LinuxCNC
              through its gateway - never the UCCNC-shaped stored record
              every other branch here edits. Nothing is invented: with no
              gateway session, the box says so instead of showing a UCCNC
              readout with nothing behind it. */}
          {setupKind === 'gateway' && (
            <div data-testid="machine-controller-setup-gateway">
              {/* WO-2101: LienCAM on one PC, LinuxCNC on another. Stored on
                  the machine; the next Connect uses it. Blank = this PC. */}
              <label style={{ display: 'block', marginBottom: 12, maxWidth: 320 }}>
                <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('ControllerSetupSection.text054')}</span>
                <input
                  className="mform-input mform-input-mono"
                  data-testid="machine-controller-gateway-address"
                  data-wired=""
                  type="text"
                  spellCheck={false}
                  value={draft.linuxcncGatewayAddress ?? ''}
                  placeholder={controlText('ControllerSetupSection.text055')}
                  onChange={(event) => {
                    const typed = event.currentTarget.value
                    editDraft((m) => ({ ...m, linuxcncGatewayAddress: typed.trim() ? typed : undefined }))
                  }}
                />
              </label>
              {!linuxcncHello ? (
                <div
                  data-testid="machine-controller-gateway-not-connected"
                  style={{ color: 'var(--text-secondary)' }}
                >{controlText('ControllerSetupSection.text056')}</div>
              ) : (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px', alignItems: 'start' }}>
                    <SetupReadout
                      label={controlText('ControllerSetupSection.text057')}
                      value={linuxcncHello.linuxcncVersion}
                      absent="version not reported"
                      testId="machine-controller-gateway-version"
                    />
                    <SetupReadout
                      label={controlText('ControllerSetupSection.text058')}
                      value={linuxcncHello.ini}
                      absent="not reported"
                      testId="machine-controller-gateway-ini"
                    />
                    <SetupReadout
                      label={controlText('ControllerSetupSection.text059')}
                      value={linuxcncHello.coordinates}
                      testId="machine-controller-gateway-coordinates"
                    />
                    <SetupReadout
                      label={controlText('ControllerSetupSection.text060')}
                      value={describeLinuxcncSpindle(linuxcncHello.vfd, linuxcncOwnsSpindle)}
                      absent="not reported"
                      testId="machine-controller-gateway-spindle"
                    />
                    <SetupReadout
                      label={controlText('ControllerSetupSection.text061')}
                      value={linuxcncHello.readOnly ? 'yes' : 'no'}
                      testId="machine-controller-gateway-readonly"
                    />
                  </div>
                  {linuxcncJoints && linuxcncJoints.length > 0 && (
                    <table
                      className="machine-def-table"
                      data-testid="machine-controller-gateway-joints"
                      style={{ marginTop: 12 }}
                    >
                      <thead><tr><th>{controlText('ControllerSetupSection.text062')}</th><th>{controlText('ControllerSetupSection.text063')}</th><th>{controlText('ControllerSetupSection.text064')}</th><th>{controlText('ControllerSetupSection.text065')}</th></tr></thead>
                      <tbody>
                        {linuxcncJoints.map((joint) => (
                          <tr key={joint.index} data-testid={`machine-controller-gateway-joint-${joint.index}`}>
                            <th scope="row">{joint.index}</th>
                            <td>{joint.axis ?? '-'}</td>
                            <td>{joint.position === null ? '-' : joint.position}</td>
                            <td>{joint.homed === null ? 'unknown' : joint.homed ? 'yes' : 'no'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <LinuxcncConfigFacts config={linuxcncHello.config} />
                </>
              )}
              {!linuxcncHello && (
                <div
                  data-testid="machine-controller-gateway-io-note"
                  style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
                >{controlText('ControllerSetupSection.text066')}</div>
              )}
            </div>
          )}
        </div>
        {/* WO-2102: a machine with no controller definition still has stock
            spindle / coolant buttons, so Built-in commands shows on its setup
            page too. A defined machine gets it from ControllerArea. */}
        {!def && <BuiltinCommandsSection machine={draft} />}</>
  )
}
