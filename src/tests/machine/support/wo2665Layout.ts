// WO-2764: WO-2665 (landed 2026-10-11, "console at the bottom of the probing
// screen") deliberately moved three things the older byte pins recorded:
//  - the step card now sits inside a `probing-center` column with Main's console;
//  - the probe picture sits inside a wrapper that scales it to fit (scale(1) when
//    nothing has to shrink, which is every jsdom render);
//  - four setup sentences were shortened (probeScene.ts, 155e16fef).
// These helpers undo exactly those moves so every other byte keeps the approved
// baseline. A console inside the column, or a picture scaled to anything but 1,
// is left in place and still fails the pin.

function unwrap(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes))
}

/** Removes WO-2665's center column and identity picture-scale wrappers in place. */
export function removeWo2665Wrappers(root: Element): void {
  for (const center of Array.from(root.querySelectorAll('[data-testid="probing-center"]'))) unwrap(center)
  for (const box of Array.from(root.querySelectorAll('[data-testid="probing-picture-box"]'))) {
    const wrapper = box.firstElementChild
    if (wrapper instanceof HTMLElement && wrapper.tagName === 'DIV' && wrapper.style.transform === 'scale(1)'
      && wrapper.firstElementChild?.getAttribute('data-testid') === 'probe-picture') unwrap(wrapper)
  }
}

/** The same, for serialized markup. */
export function withoutWo2665Wrappers(html: string): string {
  const holder = document.createElement('div')
  holder.innerHTML = html
  removeWo2665Wrappers(holder)
  return holder.innerHTML
}

// [before WO-2665, after WO-2665]; the tests render G54 and the 50 mm default reach.
const WO2665_SETUP_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['Set Z0 on this part first (G54): the probe descends from it. Then jog', 'Set part Z0 (G54), then jog'],
  ['Load the program. Jog up to a safe start height, clear of the clamps and less than 50 mm above the top. The routine moves over point 1 itself.',
    'Load the program; jog up clear of the clamps, less than 50 mm above the top.'],
  ["Put the tool in the spindle and press Start probing. It goes to the setter's saved position itself and measures the tool length. Work Z0 is not needed or changed.",
    'Fit the tool; Start probing measures its length at the saved setter without using or changing work Z0.'],
  ...(['bore', 'reference', 'pocket', 'boss'] as const).map((what) =>
    [`over the middle of the ${what} (by eye is fine), `, `over the middle of the ${what}, `] as const),
]

/** WO-2665's four shortened setup sentences, applied to a recorded (pre-WO-2665) text. */
export const wo2665SetupWords = (text: string): string =>
  WO2665_SETUP_WORDS.reduce((out, [before, after]) => out.replaceAll(before, after), text)

/**
 * A step card recorded before WO-2665, as WO-2665 draws it: the setup words
 * shortened, and a paused/stopped run line moved from the end of the step strip
 * into the sentence row in place of the step's sentence.
 */
export function wo2665RecordedCard(html: string): string {
  const holder = document.createElement('div')
  holder.innerHTML = wo2665SetupWords(html)
  const line = holder.querySelector('.pbn-strip > [data-testid="probing-run-line"]')
  const sentence = holder.querySelector('[data-testid="probing-step-sentence"]')
  if (line && sentence) {
    line.classList.remove('pbn-run-line-why')
    sentence.replaceChildren(line)
  }
  return holder.innerHTML
}

/** The inverse, for pins recorded only as hashes: puts the pre-WO-2665 sentences back. */
export const wo2665OldSetupWords = (text: string): string =>
  WO2665_SETUP_WORDS.reduce((out, [before, after]) => out.replaceAll(after, before), text)
