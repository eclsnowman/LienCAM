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
export const API_HELP: Record<ApiName, string> = {
  line: 'line(text) - send one typed line, the same door a typed MDI line uses',
  lines: 'lines(a, b, ...) - send several lines the way a configured button does (consecutive moves staged as one program)',
  goTo: 'goTo({x,y,z}, opts) - a G53 rapid; opts.machine:false moves in work coordinates, opts.zFirst:false moves X/Y first',
  output: 'output(name, on) - switch a definition output on or off, by its own name',
  wait: 'wait(ms) - pause',
  hold: 'hold() - wait for CYCLE START',
  status: 'status() - the live DRO / homed / E-STOP snapshot',
  say: 'say(text) - print one console row',
  clampPause: "clampPause() - from a program's M-code: park and open the clamp pause; its Continue runs the rest of the program",
  toolChange: "toolChange(tool?) - from a program's M-code: the guided tool change an M6 runs (park, fit, probe, resume); the tool is the file's last T unless given. In a macro on M6 it just ends the macro: a program's M6 always runs its own tool change after the macro",
  confirm: 'confirm(text) - pop up a question with OK / Cancel and wait for it; true for OK, false for Cancel',
  choose: 'choose(text, [options]) - pop up one button per option and wait; the option picked, or null for Cancel. A decision tree is an if on the answer',
  ask: 'ask(text, default?) - pop up a field (pre-filled with the default) and wait; what was typed - a number when it reads as one - or null for Cancel',
}

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
  return (
    <div className="macro-help-panel" data-testid="macro-help-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <CircleHelp size={14} />
        <span className="control-actions-label" style={{ flex: '1 1 auto' }}>Macro help</span>
        <button
          type="button"
          className="modal-close-btn"
          data-testid="macro-help-close"
          data-tooltip="Close help"
          aria-label="Close help"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <p style={{ margin: 0 }}>
        A macro is a short JavaScript program saved on this machine. It moves and checks the machine one call at a
        time, top to bottom, through the same doors every other control on this page uses - it never reaches the
        machine any other way.
      </p>
      <p style={{ margin: 0 }}>
        A macro runs two ways: click its button on the Macros panel, or bind it to an M-code and type (or post) that
        word. A program keeps every built-in M-code's standard meaning (M3, M6, M7, ...) no matter what is bound to
        it. Of those, only M6 also runs a bound macro on its own - first, as a prelude, with the programmed tool
        change following however the macro ends. A macro bound to any other built-in code (M3, M7, ...) does not run
        by itself from a program; it only runs from its button or a typed M-code. A macro bound to a code the
        dialect gives no meaning of its own does run by itself, when a program's boundary reaches it.
      </p>
      <p style={{ margin: 0 }}>
        hold() pauses the macro exactly where CYCLE START waits in a program - press CYCLE START to continue it, the
        same button that resumes a held program. Stop, a feed hold then Stop, the E-STOP, a controller reset or a
        lost connection all end a running macro at once: nothing further is sent, and the console says why.
      </p>
      <p style={{ margin: 0 }}>
        confirm(), choose() and ask() pop up a question and pause the macro the same way hold() does - nothing is
        sent and the jog keys stay off until the operator answers. Cancel (or Escape, or closing the question) is an
        answer too: false from confirm(), null from choose() and ask(), and the macro decides what to do with it. The
        question's own Stop macro button ends the run, the same as Stop on the Macros panel. From a program, a
        question is asked the one way a program runs a macro at all: bind the macro to an M-code.
      </p>

      <div>
        <span className="control-actions-label">Macro API</span>
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
        <span className="control-actions-label">Examples</span>
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
              >
                Insert into this macro
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
