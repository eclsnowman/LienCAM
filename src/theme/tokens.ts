// WO-3275 (UI M2 Wave 0): the design tokens of the New UI, as set in our own M1 design study
// (src/tests/evidence/WO-3095/m1/tokens.mjs; docs/design/LIENCAM-DESIGN-SPEC.md sections 2 to 5
// are the written form). This is the ONE token source for src/ui2/ and src/components/kit/.
//
// A THEME owns every colour, including the accent and every icon colour; no workspace, panel or
// icon may choose a hue of its own. Sizes are theme-independent.
//
// The shipped UI does not read this file. Its theme stays in tokens.css, uiTheme.ts and
// viewportColors.ts with today's values. tokenCss() scopes every property it emits under the
// New UI root ([data-ui2]), so mounting it can never restyle the old shell, whose own
// [data-theme] attribute on <html> is a different switch.

// ---------------------------------------------------------------- scales (all themes)
export const SCALE = {
  space: [2, 4, 6, 8, 12, 16, 24],
  radius: { sm: 4, md: 6, lg: 8 },
  type: { micro: 10, caption: 11, section: 11.5, body: 12, value: 13, title: 14, display: 28 },
  height: { appBar: 36, tabRow: 30, groupBand: 86, groupCaption: 20, bigButton: 60, smallButton: 20, control: 26, row: 26, cardHeader: 40, cardFooter: 48, strip: 44, navBar: 40 },
  width: { browser: 264, properties: 316, labelMin: 76, labelMax: 112, bigButtonMin: 54, bigButtonMax: 76 },
  icon: { ribbon: 32, small: 16, row: 18, header: 20, strip: 20 },
} as const

/** Control widths the kit parts need that SCALE does not name (WO-3289, requested by W1-C), px. */
export const WIDGET = { anchoredField: 72, menu: 160, tooltip: 260, showCard: 168, viewCube: 56 } as const

// ---------------------------------------------------------------- themes
// Roles, not colours. Every theme fills every role; a role missing from a theme is a bug
// (the ThemeTokens type makes it a tsc error).
//   surfaces  app < panel < head; view = viewport ground; ctl = control field
//   borders   b1 card edge, b2 header/footer/tab rule, b3 row and group divider
//   text      tx, tx2 (labels, meta), tx3 (hints, disabled)
//   accent    acc (fill: active border, primary, pill), accSoft (tinted ground), accInk (text on panel), onAcc (text on fill)
//   status    ok, warn, err (status only; never decoration); onErr = text on an err fill
//   icon      icLine outline; icTop/icFront/icSide neutral faces; icEdge the machined-edge band;
//             icAcc accent stroke; icAccFill / icAccFill2 / icAccSide accent strokes and tags;
//             icAccTop/Left/Right + icAccLine the pale accent solid with its dark edge; icGuide; icBg (knock-out)
//   model     mTop/mFront/mSide part faces, mEdge part outline, mFloor, mHole; stock tones
export interface ThemeTokens {
  readonly name: string
  readonly app: string; readonly panel: string; readonly head: string
  readonly view: string; readonly viewGrid: string; readonly viewGrid2: string
  readonly ctl: string; readonly ctlBd: string; readonly ctlHover: string
  readonly b1: string; readonly b2: string; readonly b3: string
  readonly tx: string; readonly tx2: string; readonly tx3: string
  readonly shadow: string
  readonly acc: string; readonly accSoft: string; readonly accInk: string; readonly onAcc: string
  readonly ok: string; readonly warn: string; readonly err: string; readonly onErr: string
  readonly icLine: string; readonly icTop: string; readonly icFront: string; readonly icSide: string; readonly icEdge: string
  readonly icAcc: string; readonly icAccFill: string; readonly icAccFill2: string; readonly icAccSide: string
  readonly icAccTop: string; readonly icAccLeft: string; readonly icAccRight: string; readonly icAccLine: string
  readonly icGuide: string; readonly icBg: string
  readonly mTop: string; readonly mFront: string; readonly mSide: string; readonly mEdge: string; readonly mFloor: string; readonly mHole: string
  readonly stockTop: string; readonly stockFront: string; readonly stockSide: string
}

const DARK: ThemeTokens = {
  name: 'Default (dark)',
  app: '#13161b', panel: '#1e2229', head: '#252a32', view: '#2b3038', viewGrid: '#343a44', viewGrid2: '#3c434e',
  ctl: '#16191e', ctlBd: '#636c7c', ctlHover: '#2a3039',
  b1: '#3a414c', b2: '#30363f', b3: '#292e36',
  tx: '#e2e6eb', tx2: '#a1a9b5', tx3: '#8a93a0',
  shadow: '0 6px 18px rgba(0,0,0,.38)',
  acc: '#2f74c4', accSoft: '#1f3550', accInk: '#9cc8f2', onAcc: '#ffffff',
  ok: '#4cbf6e', warn: '#e0a63a', err: '#e5605a', onErr: '#13161b',
  icLine: '#3b3a37', icTop: '#e8e7e3', icFront: '#bcbab4', icSide: '#8e8b84', icEdge: '#ffffff',
  icAcc: '#5aa6ee', icAccFill: '#a9d0f5', icAccFill2: '#4792e1', icAccSide: '#2c66a8', icAccTop: '#c2ddf9', icAccLeft: '#82b6ee', icAccRight: '#4f8ad6', icAccLine: '#123a6b', icGuide: '#8796a6', icBg: '#1e2229',
  mTop: '#c3cbd4', mFront: '#8a95a3', mSide: '#a5afbb', mEdge: '#1b2027', mFloor: '#9aa5b2', mHole: '#4a525e',
  stockTop: '#d5bd92', stockFront: '#9c8158', stockSide: '#b89a6c',
}
const AMBER: ThemeTokens = {
  ...DARK,
  name: 'Amber (dark)',
  app: '#15130f', panel: '#211e19', head: '#2a2620', view: '#2e2b26', viewGrid: '#38342d', viewGrid2: '#423d35',
  ctl: '#17150f', ctlBd: '#736a5b', ctlHover: '#2f2a23',
  b1: '#433d33', b2: '#38332b', b3: '#2e2a24',
  tx: '#ece6dc', tx2: '#b2a998', tx3: '#988f80',
  acc: '#e3b24e', accSoft: '#3d3119', accInk: '#f2cf8e', onAcc: '#1a1306',
  // warnings must never read as selection: in Amber the accent IS amber, so warn moves to orange,
  // and err stays a true red (never pink) between warn and the fixed STOP red
  warn: '#f2783c', err: '#ee5a60',
  icLine: '#3f3628', icTop: '#ece5d8', icFront: '#bdb19d', icSide: '#998b74', icEdge: '#fffaf0',
  icAcc: '#f0b95c', icAccFill: '#f6dcae', icAccFill2: '#e3b24e', icAccSide: '#b0822f', icAccTop: '#f8e2b8', icAccLeft: '#eec27a', icAccRight: '#d99a3a', icAccLine: '#55380a', icGuide: '#a39886', icBg: '#211e19',
  mTop: '#cfc8bb', mFront: '#968c7c', mSide: '#b1a897', mEdge: '#1c1914', mFloor: '#a69d8e', mHole: '#544d42',
}
const LIGHT: ThemeTokens = {
  name: 'Light',
  app: '#dfe4ea', panel: '#f8f9fb', head: '#eef1f4', view: '#e3e8ee', viewGrid: '#d5dce4', viewGrid2: '#c8d0da',
  ctl: '#ffffff', ctlBd: '#86909e', ctlHover: '#eef2f6',
  b1: '#c6ced8', b2: '#d6dce3', b3: '#e5e9ee',
  tx: '#1b222c', tx2: '#536070', tx3: '#66717e',
  shadow: '0 4px 14px rgba(20,30,45,.13)',
  acc: '#1d60af', accSoft: '#dce9f8', accInk: '#1d5ea3', onAcc: '#ffffff',
  ok: '#23793f', warn: '#8a5c06', err: '#c0392f', onErr: '#ffffff',
  icLine: '#4a4842', icTop: '#e2e1dc', icFront: '#c2c0b9', icSide: '#99968e', icEdge: '#ffffff',
  icAcc: '#2668ad', icAccFill: '#bcd9f5', icAccFill2: '#3a88d4', icAccSide: '#2564a6', icAccTop: '#cfe4fa', icAccLeft: '#8dbbee', icAccRight: '#5a92d8', icAccLine: '#123a6b', icGuide: '#5f7387', icBg: '#f8f9fb',
  mTop: '#f2f4f7', mFront: '#b7c0cb', mSide: '#d3d9e0', mEdge: '#46505d', mFloor: '#c9d0d8', mHole: '#7d8896',
  stockTop: '#e8d4ac', stockFront: '#b39064', stockSide: '#c9a874',
}

export const THEMES = { dark: DARK, amber: AMBER, light: LIGHT } as const
export type Ui2ThemeId = keyof typeof THEMES
export const UI2_THEME_IDS = Object.keys(THEMES) as readonly Ui2ThemeId[]
export const DEFAULT_UI2_THEME: Ui2ThemeId = 'dark'
export function isUi2ThemeId(value: unknown): value is Ui2ThemeId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value)
}

// The one safety token: E-STOP and the ALARM state wear this red in every theme, and no theme
// may restyle it (spec 2.4). Status err stays themable; stop does not. A fill or an edge, never text.
export const STOP = { stop: '#e5484d', onStop: '#13161b' } as const

// The tool body in Simulate and in Control's preview (spec 9): the app's own collision-review
// colours (src/theme/viewportColors.ts). Flutes green = may cut; shank, collet, holder and spindle
// red = must never touch. Drawn see-through. Fixed across themes, viewport only.
export const TOOL_BODY = { flutes: '#33cc44', noncut: '#cc3333', alpha: 0.55 } as const

// Viewport colours fixed across themes and never used by chrome (docs/ui-ux/COLOR-ROLES.md).
export const VIEWPORT_FIXED = {
  vpCut: '#00e5ff', vpRapid: '#ff4444', vpPlunge: '#ff44ff',
  axisX: '#e5605a', axisY: '#4cbf6e', axisZ: '#4c8fe0',
} as const

// Toolpath move roles: the app's own viewport hues (tokens.css); viewport only, never chrome.
// The light theme draws on a pale canvas, so it has its own darker set, as in the app.
export interface MoveRole {
  readonly id: string
  readonly label: string
  readonly dark: string
  readonly light: string
  readonly dashed?: boolean
}
export const MOVES: readonly MoveRole[] = [
  { id: 'cut', label: 'Cut', dark: '#00e5ff', light: '#044e5c' },
  { id: 'rapid', label: 'Rapid', dark: '#ff4444', light: '#c6281c', dashed: true },
  { id: 'fast', label: 'Fast traverse', dark: '#5ea0ff', light: '#1a5b9c' },
  { id: 'ramp', label: 'Helix and ramp', dark: '#ff8c00', light: '#c96a00' },
  { id: 'plunge', label: 'Plunge', dark: '#ff44ff', light: '#81158a' },
  { id: 'retract', label: 'Retract', dark: '#c6ff00', light: '#4d7a00' },
  { id: 'finish', label: 'Finish', dark: '#ff85a8', light: '#8e1d4e' },
  { id: 'stepover', label: 'Stepover', dark: '#44ff88', light: '#16693a' },
  { id: 'wall', label: 'Wall follow', dark: '#00d0a0', light: '#00865c' },
  { id: 'lead', label: 'Lead in and out', dark: '#a78bfa', light: '#49339f' },
]

// Window size classes (spec 5.1). Sizes are logical px AFTER interface scale, so a 4K screen at
// the auto 1.5 scale is the 2560 x 1440 target.
export const LAYOUT = {
  compactBelow: 1280, wideFrom: 1920, shortBelow: 760,
  targets: [
    { width: 1024, height: 600, name: 'Machine-side touch panel' },
    { width: 1280, height: 720, name: 'Small laptop; 1080p at 150 %' },
    { width: 1366, height: 768, name: 'Common laptop' },
    { width: 1440, height: 900, name: 'Reference' },
    { width: 1920, height: 1080, name: 'Desktop monitor' },
    { width: 2560, height: 1440, name: 'QHD; 4K at auto scale 1.5' },
  ],
  wide: { browser: 300, properties: 360 },
  compact: { rail: 44, properties: 280 },
  short: { groupBand: 72, strip: 36 },
  rules: { clearWidth: 0.5, clearHeight: 0.55, minHit: 20 },
} as const

export type WidthClass = 'compact' | 'regular' | 'wide'
export interface SizeClass {
  readonly width: WidthClass
  readonly short: boolean
}
/** The size class of a window, from its logical size after interface scale (spec 5.1). */
export function sizeClassFor(width: number, height: number): SizeClass {
  const w: WidthClass = width < LAYOUT.compactBelow ? 'compact' : width >= LAYOUT.wideFrom ? 'wide' : 'regular'
  return { width: w, short: height < LAYOUT.shortBelow }
}

// ---------------------------------------------------------------- CSS custom properties
/** The CSS selector of the New UI root; every emitted property lives under it. */
export const UI2_ROOT_SELECTOR = '[data-ui2]'
/** The attribute on the New UI root that names its theme. */
export const UI2_THEME_ATTRIBUTE = 'data-ui2-theme'

const kebab = (k: string) => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())

/** The CSS variable name of a theme role: icon roles become --ic-*, model roles --m-*,
 *  the rest keep their short names (accSoft -> --acc-soft). */
export function roleVar(role: Exclude<keyof ThemeTokens, 'name'>): string {
  if (role.startsWith('ic')) return '--ic-' + kebab(role.slice(2)).replace(/^-/, '')
  if (/^m[A-Z]/.test(role)) return '--m-' + kebab(role.slice(1)).replace(/^-/, '')
  return '--' + kebab(role)
}

function themeVars(t: ThemeTokens): string {
  return (Object.keys(t) as (keyof ThemeTokens)[])
    .filter((k): k is Exclude<keyof ThemeTokens, 'name'> => k !== 'name')
    .map(k => `${roleVar(k)}:${t[k]}`)
    .join(';')
}

/** Every token as CSS custom properties, scoped under the New UI root. Sizes, the safety token,
 *  the tool body and the viewport colours are on the root itself; each theme is a
 *  [data-ui2-theme=<id>] block on the same element. */
export function tokenCss(root: string = UI2_ROOT_SELECTOR): string {
  const s = SCALE
  const fixed = [
    `--f-micro:${s.type.micro}px`, `--f-cap:${s.type.caption}px`, `--f-sec:${s.type.section}px`, `--f-body:${s.type.body}px`,
    `--f-val:${s.type.value}px`, `--f-title:${s.type.title}px`, `--f-display:${s.type.display}px`,
    `--r-sm:${s.radius.sm}px`, `--r-md:${s.radius.md}px`, `--r-lg:${s.radius.lg}px`,
    ...s.space.map((v, i) => `--sp${i + 1}:${v}px`),
    `--h-app:${s.height.appBar}px`, `--h-tab:${s.height.tabRow}px`, `--h-band:${s.height.groupBand}px`, `--h-cap:${s.height.groupCaption}px`,
    `--h-big:${s.height.bigButton}px`, `--h-small:${s.height.smallButton}px`, `--h-ctl:${s.height.control}px`, `--h-row:${s.height.row}px`,
    `--h-head:${s.height.cardHeader}px`, `--h-foot:${s.height.cardFooter}px`, `--h-strip:${s.height.strip}px`, `--h-nav:${s.height.navBar}px`,
    `--w-browser:${s.width.browser}px`, `--w-props:${s.width.properties}px`, `--w-label:${s.width.labelMin}px`,
    `--w-label-max:${s.width.labelMax}px`, `--w-big-min:${s.width.bigButtonMin}px`, `--w-big-max:${s.width.bigButtonMax}px`,
    `--ic-size-ribbon:${s.icon.ribbon}px`, `--ic-size-small:${s.icon.small}px`, `--ic-size-row:${s.icon.row}px`,
    `--ic-size-header:${s.icon.header}px`, `--ic-size-strip:${s.icon.strip}px`,
    `--w-browser-wide:${LAYOUT.wide.browser}px`, `--w-props-wide:${LAYOUT.wide.properties}px`,
    `--w-rail-compact:${LAYOUT.compact.rail}px`, `--w-props-compact:${LAYOUT.compact.properties}px`,
    `--h-band-short:${LAYOUT.short.groupBand}px`, `--h-strip-short:${LAYOUT.short.strip}px`, `--min-hit:${LAYOUT.rules.minHit}px`,
    `--w-anchored:${WIDGET.anchoredField}px`, `--w-menu:${WIDGET.menu}px`, `--w-tooltip:${WIDGET.tooltip}px`,
    `--w-showcard:${WIDGET.showCard}px`, `--w-cube:${WIDGET.viewCube}px`,
    `--sans:'DM Sans',system-ui,sans-serif`, `--mono:'JetBrains Mono',ui-monospace,monospace`,
    `--vp-cut:${VIEWPORT_FIXED.vpCut}`, `--vp-rapid:${VIEWPORT_FIXED.vpRapid}`, `--vp-plunge:${VIEWPORT_FIXED.vpPlunge}`,
    `--axis-x:${VIEWPORT_FIXED.axisX}`, `--axis-y:${VIEWPORT_FIXED.axisY}`, `--axis-z:${VIEWPORT_FIXED.axisZ}`,
    `--stop:${STOP.stop}`, `--on-stop:${STOP.onStop}`,
    `--tool-flutes:${TOOL_BODY.flutes}`, `--tool-noncut:${TOOL_BODY.noncut}`, `--tool-alpha:${TOOL_BODY.alpha}`,
    ...MOVES.map(m => `--mv-${m.id}:${m.dark}`),
  ]
  const lightMoves = MOVES.map(m => `--mv-${m.id}:${m.light}`).join(';')
  const themes = UI2_THEME_IDS.map(id => `${root}[${UI2_THEME_ATTRIBUTE}=${id}]{${themeVars(THEMES[id])}}`)
  return [
    `${root}{${fixed.join(';')}}`,
    ...themes,
    `${root}[${UI2_THEME_ATTRIBUTE}=light]{${lightMoves}}`,
  ].join('\n')
}
