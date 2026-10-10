// WO B3-2: test queries for the shared themed tooltip.
//
// The title= sweep migrated every user-facing hint from the native `title`
// attribute to `data-tooltip` (read by the ThemedTooltip singleton). Tests that
// used to locate a control by its native title (`screen.getByTitle(...)`) query
// `data-tooltip` instead through these helpers - a mechanical, behaviour-
// preserving swap (same string/RegExp matching semantics as ByTitle).

function matches(el: Element, text: string | RegExp): boolean {
  const t = el.getAttribute('data-tooltip') ?? ''
  return typeof text === 'string' ? t === text : text.test(t)
}

function all(text: string | RegExp): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-tooltip]')).filter((el) => matches(el, text))
}

/** ByTitle -> data-tooltip: throws when nothing matches (getBy semantics). */
export function getByTooltip(text: string | RegExp): HTMLElement {
  const found = all(text)
  if (found.length === 0) throw new Error(`getByTooltip: no element with data-tooltip matching ${String(text)}`)
  if (found.length > 1) throw new Error(`getByTooltip: ${found.length} elements match data-tooltip ${String(text)}`)
  return found[0]
}

/** query semantics: null when nothing matches. */
export function queryByTooltip(text: string | RegExp): HTMLElement | null {
  const found = all(text)
  return found[0] ?? null
}

/** find semantics: async, retries briefly like testing-library's findBy. */
export async function findByTooltip(text: string | RegExp): Promise<HTMLElement> {
  for (let i = 0; i < 20; i++) {
    const found = all(text)
    if (found.length > 0) return found[0]
    await new Promise((r) => setTimeout(r, 25))
  }
  return getByTooltip(text)
}
