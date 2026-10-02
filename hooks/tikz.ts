// The pure half of TikZ support: the queue, the results, the document
// template and the SVG clean-up. register.tsx runs latex and dvisvgm, since
// only a function in the hooks module's own file may call the engine.

export type TikzLang = 'tikz' | 'tikzcd'
export type TikzResult = { svg: string } | { error: string }

const results = new Map<string, TikzResult>()
const queue = new Map<string, { lang: TikzLang; source: string }>()

export const BIN_CANDIDATES = [
  '/Library/TeX/texbin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/usr/texbin',
]

// cyrb53: a fast 53-bit string hash, plenty to key a cache.
export function hashOf(lang: string, source: string): string {
  const str = `v1\n${lang}\n${source}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

export function tikzResult(hash: string): TikzResult | undefined {
  return results.get(hash)
}

export function requestTikz(hash: string, lang: TikzLang, source: string): void {
  if (!results.has(hash)) queue.set(hash, { lang, source })
}

export function hasQueued(): boolean {
  return queue.size > 0
}

export function documentFor(lang: TikzLang, source: string): string {
  // Lines that belong in the preamble may lead the block.
  const lines = source.split('\n')
  const preamble: string[] = []
  while (lines.length && /^\s*(\\usetikzlibrary|\\usepackage|\\usepgfplotslibrary|\\pgfplotsset|\\tikzset|%|$)/.test(lines[0] ?? 'x')) {
    preamble.push(lines.shift()!)
  }
  let body = lines.join('\n')
  if (lang === 'tikzcd' && !/\\begin\{tikzcd\}/.test(body)) {
    body = `\\begin{tikzcd}\n${body}\n\\end{tikzcd}`
  }
  if (lang === 'tikz' && !/\\begin\{tikzpicture\}|\\tikz\b/.test(body)) {
    body = `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`
  }
  return [
    '\\documentclass[dvisvgm,tikz,border=3pt]{standalone}',
    '\\usepackage{amsmath,amssymb,amsfonts,bm}',
    '\\usepackage{tikz-cd}',
    '\\usepackage{pgfplots}',
    '\\pgfplotsset{compat=newest}',
    '\\usetikzlibrary{arrows.meta,positioning,calc,shapes.geometric,shapes.misc,decorations.pathreplacing,matrix,fit,backgrounds}',
    ...preamble,
    '\\begin{document}',
    body,
    '\\end{document}',
    '',
  ].join('\n')
}

export function texError(log: string): string {
  const lines = log.split('\n')
  const at = lines.findIndex(l => l.startsWith('!'))
  if (at < 0) return 'LaTeX failed without an error line.'
  return lines.slice(at, at + 4).join('\n').trim()
}

// Black ink follows the theme. Other colours stay as written.
export function themeInk(svg: string): string {
  return svg
    .replace(/^[\s\S]*?(<svg)/, '$1')
    .replace(/(fill|stroke)='(#000|#000000|black)'/g, "$1='currentColor'")
    .replace(/(fill|stroke)="(#000|#000000|black)"/g, '$1="currentColor"')
    .replace(/^<svg /, "<svg fill='currentColor' ")
}

export function takeNext(): { hash: string; lang: TikzLang; source: string } | undefined {
  const next = queue.entries().next()
  if (next.done) return undefined
  const [hash, job] = next.value
  queue.delete(hash)
  return { hash, ...job }
}

export function setResult(hash: string, result: TikzResult): void {
  results.set(hash, result)
}
