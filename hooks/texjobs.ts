// The pure half of real-LaTeX rendering: fonts, document templates, the job
// queues and the SVG clean-up. register.tsx runs latex and dvisvgm, since
// only a function in the hooks module's own file may call the engine.

export type BlockLang = 'tikz' | 'tikzcd' | 'latex'
export type Rendered = { svg: string } | { error: string }
export type MathJob = { key: string; tex: string; display: boolean }
export type BlockJob = { key: string; lang: BlockLang; source: string }

// Font packages for latex in DVI mode. Each line has been compiled with
// TeX Live 2026 and converted with dvisvgm --no-fonts.
export const FONTS = {
  cm: '\\usepackage{amssymb}',
  libertinus: '\\usepackage{libertinus-type1}\n\\usepackage[libertine]{newtxmath}',
  palatino: '\\usepackage{newpxtext,newpxmath}',
  times: '\\usepackage{newtxtext,newtxmath}',
  euler: '\\usepackage{amssymb}\n\\usepackage[euler-digits]{eulervm}',
  concrete: '\\usepackage{amssymb}\n\\usepackage{ccfonts}\n\\usepackage[euler-digits]{eulervm}',
  fourier: '\\usepackage{fourier}\n\\usepackage{eufrak}',
  stix2: '\\usepackage{stix2}',
  kpfonts: '\\usepackage{kpfonts}',
  cmbright: '\\usepackage{amssymb}\n\\usepackage{cmbright}',
} as const
export type LatexFont = keyof typeof FONTS

export function isLatexFont(name: string): name is LatexFont {
  return Object.hasOwn(FONTS, name)
}

export const BIN_CANDIDATES = [
  '/Library/TeX/texbin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/usr/texbin',
]

const mathQueue = new Map<string, MathJob>()
const blockQueue = new Map<string, BlockJob>()
const results = new Map<string, Rendered>()

// cyrb53: a fast 53-bit string hash, plenty to key a cache.
export function hashOf(...parts: string[]): string {
  const str = ['v2', ...parts].join('\n')
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

export function resultOf(key: string): Rendered | undefined {
  return results.get(key)
}

export function setResult(key: string, result: Rendered): void {
  results.set(key, result)
}

export function requestMath(job: MathJob): void {
  if (!results.has(job.key)) mathQueue.set(job.key, job)
}

export function requestBlock(job: BlockJob): void {
  if (!results.has(job.key)) blockQueue.set(job.key, job)
}

export function hasQueued(): boolean {
  return mathQueue.size > 0 || blockQueue.size > 0
}

export function takeBlock(): BlockJob | undefined {
  const next = blockQueue.values().next()
  if (next.done) return undefined
  blockQueue.delete(next.value.key)
  return next.value
}

export function takeMathBatch(max: number): MathJob[] {
  const batch = [...mathQueue.values()].slice(0, max)
  for (const job of batch) mathQueue.delete(job.key)
  return batch
}

function preamble(font: LatexFont, macros: string, extra: string[]): string[] {
  return [
    '\\usepackage{amsmath}',
    FONTS[font],
    '\\usepackage{bm,mathtools,xcolor,cancel,braket}',
    '\\usepackage[version=4]{mhchem}',
    ...extra,
    macros,
  ]
}

// Each formula is one page. An inline formula's box is padded so its
// baseline sits 0.75ex below the box's vertical centre, the same rule the
// MathJax path uses, so a row of words and formulas centred on that line
// keeps every baseline level.
export function documentForMath(jobs: MathJob[], font: LatexFont, macros: string): string {
  return [
    '\\documentclass[dvisvgm,multi=mjpage,border=0pt]{standalone}',
    ...preamble(font, macros, []),
    '\\newsavebox\\mjbox',
    '\\newlength\\mjabove \\newlength\\mjbelow \\newlength\\mjhalf',
    '\\newenvironment{mjpage}{\\hbox\\bgroup}{\\egroup}',
    '\\newcommand\\mjinline[1]{%',
    '  \\sbox\\mjbox{$#1$}%',
    '  \\setlength\\mjabove{\\dimexpr\\ht\\mjbox-0.75ex\\relax}%',
    '  \\setlength\\mjbelow{\\dimexpr\\dp\\mjbox+0.75ex\\relax}%',
    '  \\setlength\\mjhalf{\\ifdim\\mjabove>\\mjbelow\\mjabove\\else\\mjbelow\\fi}%',
    '  \\begin{mjpage}\\raisebox{0pt}[\\dimexpr\\mjhalf+0.75ex\\relax][\\dimexpr\\mjhalf-0.75ex\\relax]{\\usebox\\mjbox}\\end{mjpage}}',
    '\\newcommand\\mjdisplay[1]{\\begin{mjpage}\\kern2pt\\vbox{\\kern3pt\\hbox{$\\displaystyle #1$}\\kern3pt}\\kern2pt\\end{mjpage}}',
    '\\begin{document}',
    ...jobs.map(job => (job.display ? `\\mjdisplay{${displayBody(job.tex)}}` : `\\mjinline{${job.tex}}`)),
    '\\end{document}',
    '',
  ].join('\n')
}

// An align or gather environment cannot sit inside $...$: give it the
// inner form that can.
function displayBody(tex: string): string {
  return tex
    .replace(/\\begin\{(align|flalign|alignat)\*?\}/g, '\\begin{aligned}')
    .replace(/\\end\{(align|flalign|alignat)\*?\}/g, '\\end{aligned}')
    .replace(/\\begin\{gather\*?\}/g, '\\begin{gathered}')
    .replace(/\\end\{gather\*?\}/g, '\\end{gathered}')
    .replace(/\\begin\{(equation|multline)\*?\}/g, '')
    .replace(/\\end\{(equation|multline)\*?\}/g, '')
    .replace(/\\label\{[^}]*\}/g, '')
}

export function documentForBlock(job: BlockJob, font: LatexFont, macros: string): string {
  // Lines that belong in the preamble may lead the block.
  const lines = job.source.split('\n')
  const leading: string[] = []
  while (lines.length && /^\s*(\\usetikzlibrary|\\usepackage|\\usepgfplotslibrary|\\pgfplotsset|\\tikzset|\\newcommand|\\DeclareMathOperator|%|$)/.test(lines[0] ?? 'x')) {
    leading.push(lines.shift()!)
  }
  let body = lines.join('\n')
  if (job.lang === 'tikzcd' && !/\\begin\{tikzcd\}/.test(body)) {
    body = `\\begin{tikzcd}\n${body}\n\\end{tikzcd}`
  }
  if (job.lang === 'tikz' && !/\\begin\{tikzpicture\}|\\tikz\b/.test(body)) {
    body = `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`
  }
  const isPicture = job.lang !== 'latex'
  const tikz = [
    '\\usepackage{tikz,tikz-cd,pgfplots}',
    '\\pgfplotsset{compat=newest}',
    '\\usetikzlibrary{arrows.meta,positioning,calc,shapes.geometric,shapes.misc,decorations.pathreplacing,matrix,fit,backgrounds}',
  ]
  return [
    isPicture
      ? '\\documentclass[dvisvgm,border=3pt]{standalone}'
      : '\\documentclass[dvisvgm,varwidth=15cm,border=4pt]{standalone}',
    ...preamble(font, macros, isPicture ? tikz : []),
    ...leading,
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

// dvisvgm names pages d-1.svg ... or d-01.svg ... depending on the count.
export function pageNumber(name: string): number | undefined {
  const m = name.match(/^d-(\d+)\.svg$/)
  return m ? Number(m[1]) : undefined
}
