// WO-3275 (UI M2 Wave 0): the component kit contract (M2-PLAN standard 1, spec section 6).
// Props for every kit part, and the four action kinds every control that acts declares
// (standard 3, spec 7.1). Focus, Escape, keyboard navigation, theming and accessibility live
// inside the kit, never in screens.
//
// Labels arrive already in the operator's language (the screen resolves its catalogue key with
// resolveMessage from src/notices; an unavailable control's tooltip text is the resolved
// availability reason);
// numbers arrive in stored units (mm, degrees, mm/min) and the kit formats them through the
// units service. Colours and sizes come only from src/theme/tokens.ts custom properties; a
// position computed at run time (AnchoredValue, Tooltip, Window) is passed as a CSS custom
// property (style={{ '--kit-x': x + 'px' }}), which the lint allows.
//
// Who fills which stub (each lane edits only its own folder; ./index.ts never changes):
//   ./inputs   W1-A  NumberField, TextField, Select, Segmented, Toggle, Slider
//   ./surfaces W1-B  Card, Section, PropRow, Pill, Tooltip, Dialog, Window, Confirm, BrowserRow
//   ./actions  W1-C  Button, RibbonGroup, PromptBar, AnchoredValue, ShowCard, ViewCube
//   Notice is the notice part of src/notices/ (W1-D); its props are here so every part is typed
//   in one place.
// Only the Wave 0 owner changes this file.
import type { ReactElement, ReactNode } from 'react'
import type { Availability, CommandId, IconId } from '../../commands/types'
import type { Notice } from '../../notices/types'
import type { Quantity } from '../../lib/units/types'

// ---------------------------------------------------------------- action kinds (spec 7.1)
/** momentary acts while pressed; latched stays on until pressed again and always shows a lamp;
 *  choice is one of several (its selected segment is its on state); transport keeps its status
 *  colours (start green, hold amber, stop red). */
export const ACTION_KINDS = ['momentary', 'latched', 'choice', 'transport'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]
export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}

/** The icon hook (WO-3289, requested by W1-C): these names are the contract for the span a part's
 *  `icon` renders, `<span class="kit-icon" data-icon="<id>">` (the parts render it in their own lanes). The icon set (W1-I) styles `.kit-icon[data-icon]`
 *  and draws the glyph; the kit never draws one. */
export const ICON_CLASS = 'kit-icon'
export const ICON_ID_ATTRIBUTE = 'data-icon'

/** The kit's part names, in the order of standard 1. The kit barrel exports each one. */
export const KIT_PARTS = [
  'Card', 'Section', 'PropRow', 'Button', 'Segmented', 'Select', 'NumberField', 'TextField',
  'Toggle', 'Slider', 'Tooltip', 'Dialog', 'Window', 'Confirm', 'Notice', 'PromptBar',
  'AnchoredValue', 'RibbonGroup', 'BrowserRow', 'Pill', 'ShowCard', 'ViewCube',
] as const
export type KitPart = (typeof KIT_PARTS)[number]

export type StatusTone = 'ok' | 'warn' | 'err'
export type Tone = 'neutral' | 'accent' | StatusTone

/** Every part takes these. testId lands as data-testid. */
export interface KitBaseProps {
  readonly testId?: string
}

// ---------------------------------------------------------------- inputs (W1-A)
interface FieldBase extends KitBaseProps {
  /** Accessible name; the PropRow label when the field sits in one. */
  readonly ariaLabel: string
  /** Not editable now; the reason shows in the tooltip (spec 7, never only greyed out). */
  readonly availability?: Availability
}

export interface NumberFieldProps extends FieldBase {
  /** In stored units; null = empty. */
  readonly value: number | null
  readonly quantity: Quantity
  onChange(value: number | null): void
  readonly min?: number
  readonly max?: number
  /** Arrow-key step in stored units. */
  readonly step?: number
  /** Decimal places shown (else the units service default). */
  readonly precision?: number
  /** Empty allowed (else an empty entry restores the last value). */
  readonly optional?: boolean
}

export interface TextFieldProps extends FieldBase {
  readonly value: string
  onChange(value: string): void
  readonly placeholder?: string
  readonly mono?: boolean
}

export interface SelectOption<T extends string = string> {
  readonly value: T
  readonly label: string
  readonly icon?: IconId
}

export interface SelectProps<T extends string = string> extends FieldBase {
  readonly value: T
  readonly options: readonly SelectOption<T>[]
  onChange(value: T): void
}

/** 2 to 4 exclusive choices in one field (no radio buttons, spec 6.5). */
export interface SegmentedProps<T extends string = string> extends FieldBase {
  readonly value: T
  readonly options: readonly SelectOption<T>[]
  onChange(value: T): void
}

/** The checkbox control (independent on/off). */
export interface ToggleProps extends FieldBase {
  readonly on: boolean
  onChange(on: boolean): void
  /** Visible text beside the box. */
  readonly label: string
}

export interface SliderProps extends FieldBase {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly quantity?: Quantity
  onChange(value: number): void
}

// ---------------------------------------------------------------- surfaces (W1-B)
/** A footer or header action that is not a kit Button instance (the card draws it). */
export interface CardAction {
  readonly label: string
  onPress(): void
  readonly availability?: Availability
  readonly commandId?: CommandId
}

/** A Card with a close handler must name the close button (WO-3289, requested by W1-B). */
type CardClose =
  | { onClose?: undefined; readonly closeLabel?: string }
  | { onClose(): void; readonly closeLabel: string }

export type CardProps = CardBase & CardClose

interface CardBase extends KitBaseProps {
  readonly title: string
  readonly icon?: IconId
  readonly status?: PillProps
  /** The overflow (⋯) menu contents. */
  readonly menu?: ReactNode
  /** Accessible name of the overflow button (the screen's word for More). */
  readonly menuLabel?: string
  /** Footer, spec 6.3: at most one ghost action, Cancel, and the one primary action. */
  readonly footer?: {
    readonly ghost?: CardAction
    readonly cancel?: CardAction
    readonly primary?: CardAction
  }
  readonly children?: ReactNode
}

export interface SectionProps extends KitBaseProps {
  readonly caption: string
  /** One-line summary of the section's values, shown open or closed. */
  readonly summary?: string
  /** Controlled open state; omit for uncontrolled with defaultOpen. */
  readonly open?: boolean
  readonly defaultOpen?: boolean
  onToggle?(open: boolean): void
  readonly children?: ReactNode
}

export interface PropRowProps extends KitBaseProps {
  readonly label: string
  readonly children: ReactNode
}

export interface PillProps extends KitBaseProps {
  readonly tone: Tone
  readonly label: string
}

export interface TooltipProps extends KitBaseProps {
  readonly text: string
  readonly shortcut?: string
  /** One focusable element the tooltip describes. */
  readonly children: ReactElement
}

export interface DialogProps extends KitBaseProps {
  readonly open: boolean
  readonly title: string
  /** Escape and the close button call this (through the one dialog stack). */
  onClose(): void
  /** Accessible name of the close button (the screen's word for Close). */
  readonly closeLabel: string
  readonly footer?: CardProps['footer']
  readonly children?: ReactNode
}

export interface WindowNavItem {
  readonly id: string
  readonly label: string
  readonly icon?: IconId
}

/** Settings, Tool library, Machine: a card at 80% of the window with a left navigation list. */
export interface WindowProps extends DialogProps {
  readonly nav?: readonly WindowNavItem[]
  readonly activeNav?: string
  onNav?(id: string): void
}

/** Title, one sentence saying what will happen, Cancel, and the action named by its verb. */
export interface ConfirmProps extends KitBaseProps {
  readonly open: boolean
  readonly title: string
  readonly sentence: string
  /** The verb ("Delete 3 operations"), never "OK". */
  readonly actionLabel: string
  /** The screen's word for Cancel. */
  readonly cancelLabel: string
  readonly danger?: boolean
  onConfirm(): void
  onCancel(): void
}

export interface BrowserRowProps extends KitBaseProps {
  readonly depth: number
  readonly name: string
  readonly icon?: IconId
  readonly meta?: string
  readonly status?: StatusTone
  readonly selected?: boolean
  /** Suppressed or not yet run: name in the hint colour. */
  readonly muted?: boolean
  /** undefined = no chevron (a leaf). */
  readonly expanded?: boolean
  onToggle?(): void
  /** Accessible name of the chevron (the screen's words for expand/collapse). */
  readonly toggleLabel?: string
  onSelect?(): void
  /** Row actions; shown only on hover or selection. */
  readonly actions?: ReactNode
}

// ---------------------------------------------------------------- notice (W1-D)
export interface NoticeProps extends KitBaseProps {
  readonly notice: Notice
  onDismiss?(id: string): void
  /** Accessible name of the dismiss button (the screen's word for Close). */
  readonly closeLabel?: string
}

// ---------------------------------------------------------------- actions (W1-C)
export type ButtonForm = 'big' | 'small' | 'text' | 'icon'
export type ButtonEmphasis = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonBase extends KitBaseProps {
  readonly label: string
  readonly icon?: IconId
  readonly form?: ButtonForm
  readonly emphasis?: ButtonEmphasis
  /** Not ready = the unavailable look (dashed edge, reason in the tooltip; lock glyph when
   *  availability.lock). The press does nothing. */
  readonly availability?: Availability
  /** The registry command this button runs, when it comes from the registry. */
  readonly commandId?: CommandId
}

export interface MomentaryButtonProps extends ButtonBase {
  readonly kind: 'momentary'
  onPress(): void
  /** For press-and-hold actions (a jog key); called when the press ends. The press starts on
   *  pointer down or Enter/Space key down and ends on pointer up, pointer leave or key up. */
  onRelease?(): void
}

export interface LatchedButtonProps extends ButtonBase {
  readonly kind: 'latched'
  /** Drives the lamp: hollow when off, lit when on. */
  readonly on: boolean
  onToggle(next: boolean): void
}

export interface ChoiceButtonProps extends ButtonBase {
  readonly kind: 'choice'
  readonly selected: boolean
  onSelect(): void
}

export interface TransportButtonProps extends ButtonBase {
  readonly kind: 'transport'
  readonly transport: 'start' | 'hold' | 'stop'
  /** Lit while the machine is in this state (Feed hold while held). */
  readonly active?: boolean
  onPress(): void
  onRelease?(): void
}

/** A button without a kind is refused (standard 3): tsc rejects it, and the kit throws for an
 *  untyped caller. */
export type ButtonProps = MomentaryButtonProps | LatchedButtonProps | ChoiceButtonProps | TransportButtonProps

export interface RibbonGroupProps extends KitBaseProps {
  readonly caption: string
  /** The ▾ on the caption opens the group's full menu. */
  onOpenMenu?(): void
  readonly children: ReactNode
}

export interface PromptBarProps extends KitBaseProps {
  /** What the tool waits for now ("Pick the floor face"). */
  readonly prompt: string
  /** Step n of m, when the tool has steps. */
  readonly step?: { readonly index: number; readonly count: number }
  readonly actions?: ReactNode
  onCancel?(): void
}

/** A value typed at a point in the viewport (sketch dimension entry). */
export interface AnchoredValueProps extends KitBaseProps {
  /** Screen position in CSS px, relative to the viewport. */
  readonly anchor: { readonly x: number; readonly y: number }
  readonly value: number | null
  readonly quantity: Quantity
  readonly ariaLabel: string
  onCommit(value: number): void
  onCancel(): void
}

export interface ShowItem {
  readonly id: string
  readonly label: string
  readonly visible: boolean
  /** A CSS custom property name from tokens.ts for the colour key (e.g. '--mv-cut'). */
  readonly swatchVar?: `--${string}`
}

/** The Show card: bottom right, header is the button, list opens upward. */
export interface ShowCardProps extends KitBaseProps {
  readonly title: string
  readonly items: readonly ShowItem[]
  onToggle(id: string, visible: boolean): void
  readonly open?: boolean
  onOpenChange?(open: boolean): void
}

export type ViewPreset = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'
export type ViewStyle = 'shaded' | 'shaded-edges' | 'wireframe' | 'hidden-edges'

/** The view cube, lower left, with the view style flyout. */
export const VIEW_PRESETS: readonly ViewPreset[] = ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso']

export interface ViewCubeProps extends KitBaseProps {
  onView(view: ViewPreset): void
  /** Accessible names of the faces, in the operator's language. */
  readonly faceLabels: Readonly<Record<ViewPreset, string>>
  readonly style: ViewStyle
  onStyle(style: ViewStyle): void
}
