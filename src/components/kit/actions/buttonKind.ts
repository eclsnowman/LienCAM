// WO-3275 (UI M2 Wave 0): the Button kind check (standard 3), real from Wave 0 on. W1-C keeps it.
import { isActionKind, type ButtonProps } from '../types'

/** Standard 3: every action declares its kind. tsc refuses a Button without one; this refuses an
 *  untyped caller (JS, a spread of unknown props) at render, naming what is missing. */
export function assertButtonKind(props: { kind?: unknown; label?: unknown }): asserts props is ButtonProps {
  if (!isActionKind(props.kind)) {
    throw new Error(`kit Button "${String(props.label)}" needs kind: momentary, latched, choice or transport (got ${String(props.kind)})`)
  }
}
