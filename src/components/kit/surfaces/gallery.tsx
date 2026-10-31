// WO-3279: one example of every surface part and state. Mounted by the kit gallery route (W1-H)
// under a [data-ui2] root; the three M1 themes come from that root's data-ui2-theme. Example
// words are sample content, not catalogue strings.
import { useState } from 'react'
import { BrowserRow, Card, Confirm, Dialog, Pill, PropRow, Section, Tooltip, Window } from '.'
import { Button } from '..'

const SAMPLE_FOOTER = {
  ghost: { label: 'Reset', onPress: () => {} },
  cancel: { label: 'Cancel', onPress: () => {} },
  primary: { label: 'Generate', onPress: () => {} },
}

/** A footer whose primary action cannot run now: its reason shows in a tooltip on hover or focus. */
const BLOCKED_FOOTER = {
  cancel: { label: 'Cancel', onPress: () => {} },
  primary: { label: 'Apply', onPress: () => {}, availability: { ready: false, reason: 'app-shell-settings-menus:closeHelp' } as const },
}

export function SurfacesGallery() {
  const [dialog, setDialog] = useState(false)
  const [win, setWin] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [nav, setNav] = useState('general')
  const [rows, setRows] = useState({ setup: true, pocket: false })
  const [picked, setPicked] = useState('pocket')
  return (
    <div className="kit-gallery" data-testid="surfaces-gallery">
      <h3>Pill</h3>
      <div className="kit-gallery-row">
        {(['neutral', 'accent', 'ok', 'warn', 'err'] as const).map(t => <Pill key={t} tone={t} label={t} />)}
      </div>

      <h3>Card</h3>
      <div className="kit-gallery-row">
        <Card title="Pocket" icon="pocket" status={{ tone: 'ok', label: 'Ready' }} menu={<button type="button">Duplicate</button>} onClose={() => {}} closeLabel="Close" footer={SAMPLE_FOOTER}>
          <PropRow label="Stepover"><span>45 %</span></PropRow>
          <PropRow label="Depth"><span>3.0 mm</span></PropRow>
        </Card>
        <Card title="Blocked" footer={{ cancel: { label: 'Cancel', onPress: () => {} }, primary: { label: 'Generate', onPress: () => {}, availability: { ready: false, reason: 'app-shell-settings-menus:closeHelp', lock: true } } }}>
          <p>An unavailable action is dashed and says why on hover.</p>
        </Card>
      </div>

      <h3>Section</h3>
      <div className="kit-gallery-row">
        <Section caption="Depths" summary="3 mm / 2 passes"><PropRow label="Final"><span>3.0 mm</span></PropRow></Section>
        <Section caption="Entry" summary="Ramp 3 deg" defaultOpen={false}><span>hidden</span></Section>
      </div>

      <h3>BrowserRow</h3>
      <div role="tree" className="kit-gallery-tree">
        <BrowserRow depth={0} name="Setup 1" icon="setup" expanded={rows.setup} onToggle={() => setRows(r => ({ ...r, setup: !r.setup }))} toggleLabel="Toggle" />
        <BrowserRow depth={1} name="Pocket" icon="pocket" meta="12 min" status="ok" selected={picked === 'pocket'} onSelect={() => setPicked('pocket')} actions={<button type="button">Hide</button>} />
        <BrowserRow depth={1} name="Contour" icon="contour" meta="4 min" status="warn" selected={picked === 'contour'} onSelect={() => setPicked('contour')} />
        <BrowserRow depth={1} name="Suppressed" muted status="err" onSelect={() => {}} />
        <BrowserRow depth={0} name="Setup 2" expanded={rows.pocket} onToggle={() => setRows(r => ({ ...r, pocket: !r.pocket }))} toggleLabel="Toggle" />
      </div>

      <h3>Tooltip, Dialog, Window, Confirm</h3>
      <div className="kit-gallery-row">
        <span data-gallery="tooltip">
          <Tooltip text="Generate toolpath" shortcut="G"><button type="button">Hover me</button></Tooltip>
        </span>
        <span data-gallery="dialog"><Button kind="momentary" label="Open dialog" onPress={() => setDialog(true)} /></span>
        <span data-gallery="window"><Button kind="momentary" label="Open window" onPress={() => setWin(true)} /></span>
        <span data-gallery="confirm"><Button kind="momentary" label="Open confirm" onPress={() => setConfirm(true)} /></span>
      </div>
      <Dialog open={dialog} title="Dialog" onClose={() => setDialog(false)} closeLabel="Close" footer={BLOCKED_FOOTER}><p>Escape closes the top dialog only.</p></Dialog>
      <Window open={win} title="Settings" onClose={() => setWin(false)} closeLabel="Close" footer={BLOCKED_FOOTER} nav={[{ id: 'general', label: 'General' }, { id: 'units', label: 'Units' }]} activeNav={nav} onNav={setNav}>
        <p>Drag the header, or focus it and use the arrow keys.</p>
      </Window>
      <Confirm open={confirm} title="Delete operations" sentence="Three operations will be removed from this setup." actionLabel="Delete 3 operations" cancelLabel="Cancel" danger onConfirm={() => setConfirm(false)} onCancel={() => setConfirm(false)} />
    </div>
  )
}
