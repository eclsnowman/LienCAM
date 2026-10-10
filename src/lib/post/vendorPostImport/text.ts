// Text-only scanning. Vendor source is data, never JavaScript to evaluate.
export function stripComments(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (token) => token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token)
}

export function unquote(source: string): string | undefined {
  const value = source.trim()
  if (!/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(value)) return undefined
  return value.slice(1, -1).replace(/\\([\\"'nrt])/g, (_, c: string) =>
    ({ n: '\n', r: '\r', t: '\t' }[c] ?? c))
}

export function balanced(source: string, start: number, open: string, close: string): string {
  let depth = 0
  let quote = ''
  for (let i = start; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === open) depth++
    else if (c === close && --depth === 0) return source.slice(start + 1, i)
  }
  return ''
}

export function splitArguments(source: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if ('({['.includes(c)) depth++
    else if (')}]'.includes(c)) depth--
    else if (c === ',' && depth === 0) { parts.push(source.slice(start, i).trim()); start = i + 1 }
  }
  parts.push(source.slice(start).trim())
  return parts
}

export function functionBody(source: string, name: string): string | undefined {
  const match = new RegExp(`\\bfunction\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source)
  return match ? balanced(source, match.index + match[0].length - 1, '{', '}') : undefined
}

/** Only direct statements are templates. Conditional/loop bodies cannot be
 * reconstructed without the vendor runtime, so they are reported instead. */
export function staticStatements(body: string): string[] {
  const statements: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if ('({['.includes(c)) depth++
    else if (')}]'.includes(c)) {
      depth--
      if (c === '}' && depth === 0) start = i + 1
    } else if (c === ';' && depth === 0) { statements.push(body.slice(start, i).trim()); start = i + 1 }
  }
  return statements
}
