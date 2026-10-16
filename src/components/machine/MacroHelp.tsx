import { liveCatalog } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

// MacroHelp - WO-1714: the macro editor's Help screen and examples library.
//
// Operator ruling 2026-09-19: "a help screen that had additional details, not just the
// ones for the API down below it. The help could have a link to examples in
// a library... a lot of additional detail for how best to utilize it."
//
// Rendered INSIDE the macro editor's own modal box (MacroEditor.tsx swaps
// this panel IN PLACE of the list/form, inside the same `.macro-editor-body`
// - never beside it) rather than as a second `.modal-backdrop` of its own -
// a new top-level overlay would need its own entry in the overlay-cohesion
// census (src/tests/ui/overlayCohesionCensus, overlayRuntimeCensus,
// support/overlayDispositions.ts - see WO-1706's owned-paths), which this
// order does not grant. Sharing the editor's existing, already-reviewed
// modal means Help adds no new screen coverage and no new dialogOpen() site:
// the editor's own backdrop already blocks jog keys and stays exactly as
// visible (or not) relative to the transport bar's Stop controls as it was
// before Help existed. A fix round (audit: "Help covers the Stop controls")
// found that widening the modal to show Help as a second column DID cover
// the Stop/Reset and E-STOP controls at 1680x900 - the modal now never
// changes width or splits into columns; Help is a pane swap at the editor's
// one, pre-WO width.
//
// API_HELP is the ONE source both this screen and the editor's own short
// reference (MacroEditor.tsx's `macro-editor-api-list`) read from - a new
// entry in MACRO_API fails to compile here until it is described once.

import { CircleHelp, X } from 'lucide-react'
import { MACRO_API } from '../../lib/machine/macros/macroRuntime'
import { MACRO_EXAMPLES } from '../../lib/machine/macros/macroExamples'

type ApiName = (typeof MACRO_API)[number]

/** One line per API call - the sandbox's own doc comment
 *  (`lib/machine/macros/macroRuntime.ts`), not a second description of it. */
export const API_HELP: Record<ApiName, string> = liveCatalog(() => ({
  line: controlText('MacroHelp.text001'),
  lines: controlText('MacroHelp.text002'),
  goTo: controlText('MacroHelp.text003'),
  output: controlText('MacroHelp.text004'),
  wait: controlText('MacroHelp.text005'),
  hold: controlText('MacroHelp.text006'),
  status: controlText('MacroHelp.text007'),
  say: controlText('MacroHelp.text008'),
  clampPause: controlText('MacroHelp.text009'),
  toolChange: controlText('MacroHelp.text010'),
  confirm: controlText('MacroHelp.text011'),
  choose: controlText('MacroHelp.text012'),
  ask: controlText('MacroHelp.text013'),
}))

/** A short, runnable line for each call - the same "one source" as
 *  API_HELP, so a new call cannot get a blurb here and no example. */
const API_EXAMPLE: Record<ApiName, string> = {
  line: "line('M8')",
  lines: "lines('G21 G90 G0 X0 Y0', 'G0 Z-5')",
  goTo: 'goTo({ x: 0, y: 0, z: 0 })',
  output: "output('Vacuum', true)",
  wait: 'wait(500)',
  hold: 'hold()',
  status: "const s = status()\nsay('Homed: ' + s.homed)",
  say: "say('Parked.')",
  clampPause: 'clampPause()',
  toolChange: 'toolChange()',
  confirm: "if (confirm('Vacuum on?')) output('Vacuum', true)",
  choose: "const side = choose('Probe which side?', ['Left', 'Right'])\nif (side === 'Left') goTo({ x: 0 })\nif (side === 'Right') goTo({ x: 100 })",
  ask: "const depth = ask('Depth in mm?', 5)\nif (depth !== null) goTo({ z: -depth }, { machine: false })",
}

export function MacroHelp({
  onInsertExample,
  onClose,
}: {
  onInsertExample: (body: string) => void
  onClose: () => void
}) {
  useText('control-screens-not-probing')
  return (
    <div className="macro-help-panel" data-testid="macro-help-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <CircleHelp size={14} />
        <span className="control-actions-label" style={{ flex: '1 1 auto' }}>{controlText('MacroHelp.text014')}</span>
        <button
          type="button"
          className="modal-close-btn"
          data-testid="macro-help-close"
          data-tooltip={controlText('MacroHelp.text015')}
          aria-label={controlText('MacroHelp.text016')}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <p style={{ margin: 0 }}>{controlText('MacroHelp.text017')}</p>
      <p style={{ margin: 0 }}>{controlText('MacroHelp.text018')}</p>
      <p style={{ margin: 0 }}>{controlText('MacroHelp.text019')}</p>
      <p style={{ margin: 0 }}>{controlText('MacroHelp.text020')}</p>

      <div>
        <span className="control-actions-label">{controlText('MacroHelp.text021')}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
          {MACRO_API.map((name) => (
            <div key={name} data-testid={`macro-help-api-${name}`}>
              <div>{API_HELP[name]}</div>
              <pre style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }} className="mform-input-mono">{API_EXAMPLE[name]}</pre>
            </div>
          ))}
        </div>
      </div>

      <div>
        <span className="control-actions-label">{controlText('MacroHelp.text022')}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
          {MACRO_EXAMPLES.map((example) => (
            <div key={example.id} data-testid={`macro-help-example-${example.id}`} className="macro-editor-item" style={{ padding: 8 }}>
              <div style={{ fontWeight: 500 }}>{example.name}</div>
              <div className="control-actions-default" style={{ paddingTop: 0 }}>{example.description}</div>
              <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }} className="mform-input-mono">{example.body}</pre>
              <button
                type="button"
                className="modal-btn modal-btn-ghost"
                data-testid={`macro-help-example-${example.id}-insert`}
                onClick={() => onInsertExample(example.body)}
              >{controlText('MacroHelp.text023')}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
